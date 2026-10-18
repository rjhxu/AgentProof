/**
 * GitHub App authentication for the code-fix agent (docs/CODEFIX.md section 2).
 *
 * The runner acts as a GitHub App, so it can read private repositories and open draft pull requests
 * without ever holding a user's personal token:
 *
 *   config    loadGitHubAppConfig / saveGitHubAppConfig: app id and private key, from the environment or
 *             from a file written with mode 0600 in a 0700 directory
 *   jwt       createAppJwt: RS256, backdated 60 s, valid 9 min (GitHub's ceiling is 10)
 *   install   findInstallation: GET /repos/{o}/{r}/installation with the app JWT
 *   list      listInstallations / listInstallationRepositories: the installations of this app, and the
 *             repositories each one covers, so the dashboard can offer them. The repository list is read
 *             with a token minted for metadata only and for no single repository; that token never leaves
 *             the function.
 *   token     mintInstallationToken: POST /app/installations/{id}/access_tokens, scoped at mint time to
 *             one repository and the minimal permissions of one operation. Minted per operation, never
 *             cached, never persisted.
 *   register  buildAppManifest / renderManifestForm / convertManifestCode: GitHub's manifest flow, so
 *             the owner creates the app with one click and the key goes straight to disk
 *
 * The two authenticated calls go through GitHubClient and its operation allowlist, which this file does
 * not widen. The manifest conversion is unauthenticated and is the one call made with fetch directly.
 *
 * The private key never reaches a log, an error, an HTTP response or the record. Every error message in
 * this file is fixed text, an identifier the caller already has, or GitHub's own short message (with PEM
 * blocks and token-shaped strings redacted); nothing parsed from the key, the JWT or a token is ever
 * interpolated. Callers must not log a GitHubAppConfig: use describeGitHubApp() for anything shown.
 */
import { createPrivateKey, randomBytes, sign } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { GitHubClient, GitHubRequestError } from './github';
import type { GitHubRepoRef } from './github';

// ---------------------------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------------------------

const API_BASE_URL = 'https://api.github.com';
const WEB_BASE_URL = 'https://github.com';
const API_VERSION = '2022-11-28';
const USER_AGENT = 'AgentProof';
const MAX_MESSAGE_CHARS = 300;

/**
 * Letters, digits, '.', '_' and '-' only. Anything interpolated into an API path must match this:
 * no '/', '%' (a URL parser turns '%2e%2e' into '..'), '?', '#' (fetch drops it), whitespace or controls.
 */
const SAFE_SEGMENT = /^[A-Za-z0-9._-]{1,100}$/;
/** App slugs and organization logins. */
const SAFE_HANDLE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

const KEY_FORMAT = 'an RSA key in PEM format (PKCS#1 or PKCS#8)';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSafeSegment(value: unknown): value is string {
  return typeof value === 'string' && SAFE_SEGMENT.test(value) && value !== '.' && value !== '..';
}

/** A positive integer from a number or a string of digits; undefined for anything else. */
function positiveInteger(value: unknown): number | undefined {
  if (typeof value === 'string' && /^[0-9]{1,15}$/.test(value.trim())) value = Number(value.trim());
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function stringRecord(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (isRecord(value)) {
    for (const [key, entry] of Object.entries(value))
      if (typeof entry === 'string') out[key] = entry;
  }
  return out;
}

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);
}

const PEM_BLOCK = /-----BEGIN [A-Z0-9 ]+-----[\s\S]*?(?:-----END [A-Z0-9 ]+-----|$)/g;
const TOKEN_LIKE = /\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{16,}/g;

/** Text taken from a remote body, made safe to put in an error: redacted first, then capped. */
function safeExcerpt(text: string): string {
  return text
    .replace(PEM_BLOCK, '[redacted]')
    .replace(TOKEN_LIKE, '[redacted]')
    .slice(0, MAX_MESSAGE_CHARS);
}

/**
 * An http(s) URL without credentials, query or fragment, as origin plus path with no trailing slash.
 * Used for URLs this module builds other URLs from.
 */
function normalizeHttpUrl(value: string, label: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error(`${label} must be an http(s) URL`);
  }
  const plain = url.protocol === 'http:' || url.protocol === 'https:';
  if (!plain || url.username || url.password || url.search || url.hash) {
    throw new Error(`${label} must be an http(s) URL without credentials, query or fragment`);
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

// ---------------------------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------------------------

export interface GitHubAppConfig {
  appId: number;
  slug?: string;
  clientId?: string;
  /** PEM, PKCS#1 or PKCS#8 */
  privateKeyPem: string;
}
export type GitHubAppConfigSource = 'env' | 'file';
export interface LoadedGitHubAppConfig {
  config?: GitHubAppConfig;
  source?: GitHubAppConfigSource;
  error?: string;
}

/** A configuration problem whose message is safe to show: fixed text, never key material. */
class ConfigProblem extends Error {}

/**
 * Env files and CI secrets often carry a PEM on one line with literal "\n" sequences. A PEM that
 * already has real newlines is returned untouched.
 */
function normalizePem(text: string): string {
  if (text.includes('\n')) return text;
  return text.trim().replace(/\\n/g, '\n');
}

/** The key as an RSA KeyObject, or undefined when it is not one. Never throws, never echoes. */
function parsePrivateKey(pem: string): KeyObject | undefined {
  try {
    const key = createPrivateKey(normalizePem(pem));
    return key.asymmetricKeyType === 'rsa' ? key : undefined;
  } catch {
    return undefined;
  }
}

interface FieldLabels {
  appId: string;
  slug: string;
  clientId: string;
  key: string;
}

const FILE_LABELS: FieldLabels = {
  appId: 'appId',
  slug: 'slug',
  clientId: 'clientId',
  key: 'privateKeyPem',
};

/** Validate raw values and build a config. Every message names the field and nothing else. */
function buildConfig(
  raw: { appId: unknown; slug: unknown; clientId: unknown; privateKeyPem: unknown },
  labels: FieldLabels,
): GitHubAppConfig {
  if (raw.appId === undefined) throw new ConfigProblem(`${labels.appId} is required`);
  const appId = positiveInteger(raw.appId);
  if (appId === undefined) throw new ConfigProblem(`${labels.appId} must be a positive integer`);

  if (typeof raw.privateKeyPem !== 'string' || raw.privateKeyPem.trim() === '') {
    throw new ConfigProblem(`${labels.key} is missing or empty`);
  }
  const privateKeyPem = normalizePem(raw.privateKeyPem);
  if (!parsePrivateKey(privateKeyPem)) {
    throw new ConfigProblem(`${labels.key} is not ${KEY_FORMAT}`);
  }

  const config: GitHubAppConfig = { appId, privateKeyPem };
  if (raw.slug !== undefined && raw.slug !== null && raw.slug !== '') {
    if (typeof raw.slug !== 'string' || !SAFE_HANDLE.test(raw.slug)) {
      throw new ConfigProblem(`${labels.slug} is not a valid GitHub App slug`);
    }
    config.slug = raw.slug;
  }
  if (raw.clientId !== undefined && raw.clientId !== null && raw.clientId !== '') {
    if (typeof raw.clientId !== 'string' || !SAFE_SEGMENT.test(raw.clientId)) {
      throw new ConfigProblem(`${labels.clientId} is not a valid GitHub App client id`);
    }
    config.clientId = raw.clientId;
  }
  return config;
}

function readText(path: string, label: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    const code = isRecord(err) && typeof err.code === 'string' ? err.code : 'read error';
    throw new ConfigProblem(`Cannot read ${label} (${path}): ${code}`);
  }
}

function configFromEnv(env: NodeJS.ProcessEnv): GitHubAppConfig | undefined {
  const id = nonEmpty(env.AGENTPROOF_GITHUB_APP_ID);
  const inlineKey = nonEmpty(env.AGENTPROOF_GITHUB_APP_PRIVATE_KEY);
  const keyFile = nonEmpty(env.AGENTPROOF_GITHUB_APP_PRIVATE_KEY_FILE);
  // Blank variables count as unset, so a template with empty placeholders configures nothing.
  if (id === undefined && inlineKey === undefined && keyFile === undefined) return undefined;

  let pem: string | undefined;
  let keyLabel = 'AGENTPROOF_GITHUB_APP_PRIVATE_KEY or AGENTPROOF_GITHUB_APP_PRIVATE_KEY_FILE';
  if (inlineKey !== undefined) {
    pem = inlineKey;
    keyLabel = 'AGENTPROOF_GITHUB_APP_PRIVATE_KEY';
  } else if (keyFile !== undefined) {
    pem = readText(keyFile, 'AGENTPROOF_GITHUB_APP_PRIVATE_KEY_FILE');
    keyLabel = 'AGENTPROOF_GITHUB_APP_PRIVATE_KEY_FILE';
  }
  return buildConfig(
    {
      appId: id,
      slug: nonEmpty(env.AGENTPROOF_GITHUB_APP_SLUG),
      clientId: nonEmpty(env.AGENTPROOF_GITHUB_APP_CLIENT_ID),
      privateKeyPem: pem,
    },
    {
      appId: 'AGENTPROOF_GITHUB_APP_ID',
      slug: 'AGENTPROOF_GITHUB_APP_SLUG',
      clientId: 'AGENTPROOF_GITHUB_APP_CLIENT_ID',
      key: keyLabel,
    },
  );
}

function configFromFile(file: string): GitHubAppConfig | undefined {
  if (!existsSync(file)) return undefined;
  const where = `GitHub App config file ${file}`;
  const text = readText(file, 'GitHub App config file');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Not the parser's message: V8 quotes the start of the input in it.
    throw new ConfigProblem(`${where} is not valid JSON`);
  }
  if (!isRecord(parsed)) throw new ConfigProblem(`${where} must contain a JSON object`);
  try {
    return buildConfig(
      {
        appId: parsed.appId,
        slug: parsed.slug,
        clientId: parsed.clientId,
        privateKeyPem: parsed.privateKeyPem,
      },
      FILE_LABELS,
    );
  } catch (err) {
    if (err instanceof ConfigProblem) throw new ConfigProblem(`${where}: ${err.message}`);
    throw err;
  }
}

/**
 * Env first: AGENTPROOF_GITHUB_APP_ID (integer), AGENTPROOF_GITHUB_APP_PRIVATE_KEY (PEM; literal "\n"
 * sequences are unescaped) or AGENTPROOF_GITHUB_APP_PRIVATE_KEY_FILE (path), optional
 * AGENTPROOF_GITHUB_APP_SLUG and AGENTPROOF_GITHUB_APP_CLIENT_ID. Values are trimmed. If any of the id
 * and key variables is set, the environment decides: a half-configured environment is an error, never a
 * silent fallback to the file, and when both key variables are set the inline key wins. Otherwise the
 * JSON file at `file` (default none): { appId, slug?, clientId?, privateKeyPem }.
 *
 * Returns {} (no config, no error) when nothing is configured. On any problem returns { error } with
 * fixed text that never contains key material.
 */
export function loadGitHubAppConfig(
  env: NodeJS.ProcessEnv = process.env,
  file?: string,
): LoadedGitHubAppConfig {
  try {
    const fromEnv = configFromEnv(env);
    if (fromEnv) return { config: fromEnv, source: 'env' };
    const fromFile = file ? configFromFile(file) : undefined;
    if (fromFile) return { config: fromFile, source: 'file' };
    return {};
  } catch (err) {
    return {
      error:
        err instanceof ConfigProblem ? err.message : 'Could not load the GitHub App configuration',
    };
  }
}

/**
 * Write the config as JSON with mode 0600. The directory is created (recursively) with mode 0700; a
 * directory that already exists is left alone. The file is written to a temporary name created
 * exclusively with mode 0600 and then renamed into place, so a previous file with looser permissions
 * never exposes the new key and a crash never leaves a torn file. Refuses to write a config that
 * loadGitHubAppConfig would reject.
 */
export function saveGitHubAppConfig(file: string, config: GitHubAppConfig): void {
  const checked = buildConfig(
    {
      appId: config.appId,
      slug: config.slug,
      clientId: config.clientId,
      privateKeyPem: config.privateKeyPem,
    },
    FILE_LABELS,
  );
  const dir = dirname(file);
  // mkdir's mode is masked by the umask, so pin the directory we just created to exactly 0700.
  const created = mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (created !== undefined) chmodSync(dir, 0o700);

  const document = {
    appId: checked.appId,
    slug: checked.slug,
    clientId: checked.clientId,
    privateKeyPem: checked.privateKeyPem,
  };
  const temporary = join(dir, `.${basename(file)}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    chmodSync(temporary, 0o600);
    renameSync(temporary, file);
  } catch (err) {
    rmSync(temporary, { force: true });
    throw err;
  }
}

// ---------------------------------------------------------------------------------------------
// App JWT
// ---------------------------------------------------------------------------------------------

/** GitHub rejects a JWT that expires more than 10 minutes from now; iat is backdated 60 s for clock skew. */
export const APP_JWT_TTL_SECONDS = 9 * 60;
const JWT_BACKDATE_SECONDS = 60;

function base64url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

/**
 * RS256 JWT for authenticating as the app: header {alg:'RS256',typ:'JWT'}, payload
 * {iat: now-60, exp: now+APP_JWT_TTL_SECONDS, iss: String(appId)}. Created fresh for every request and
 * never stored.
 */
export function createAppJwt(config: GitHubAppConfig, nowMs: number = Date.now()): string {
  if (!Number.isSafeInteger(config.appId) || config.appId <= 0) {
    throw new Error('The GitHub App id must be a positive integer');
  }
  const key = parsePrivateKey(config.privateKeyPem);
  if (!key) throw new Error(`The GitHub App key is not ${KEY_FORMAT}`);

  const now = Math.floor(nowMs / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iat: now - JWT_BACKDATE_SECONDS,
    exp: now + APP_JWT_TTL_SECONDS,
    iss: String(config.appId),
  };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signature = sign('RSA-SHA256', Buffer.from(signingInput, 'utf8'), key);
  return `${signingInput}.${signature.toString('base64url')}`;
}

// ---------------------------------------------------------------------------------------------
// Installation lookup and installation tokens
// ---------------------------------------------------------------------------------------------

export interface InstallationLookup {
  installationId: number;
  /** account login the app is installed on */
  account: string;
  permissions: Record<string, string>;
  repositorySelection: 'all' | 'selected';
}

export interface GitHubAppDeps {
  /** Inject a fetch (tests, or one with a timeout). Defaults to the global. */
  fetch?: typeof fetch;
  /** API base, default https://api.github.com */
  baseUrl?: string;
  /** Clock for the JWT, default Date.now() */
  nowMs?: number;
}

/** A GitHubClient that authenticates as the app, with a JWT created for this one call. */
function appClient(config: GitHubAppConfig, deps: GitHubAppDeps): GitHubClient {
  return new GitHubClient({
    token: createAppJwt(config, deps.nowMs),
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    ...(deps.baseUrl ? { baseUrl: deps.baseUrl } : {}),
  });
}

/**
 * GET /repos/{owner}/{repo}/installation with a fresh app JWT. A 404 means the app is not installed
 * there and gives undefined. Every other failure propagates as GitHubRequestError.
 */
export async function findInstallation(
  ref: GitHubRepoRef,
  config: GitHubAppConfig,
  deps: GitHubAppDeps = {},
): Promise<InstallationLookup | undefined> {
  if (!isSafeSegment(ref.owner) || !isSafeSegment(ref.repo)) {
    throw new Error('Not a valid GitHub repository reference');
  }
  const client = appClient(config, deps);
  let response: unknown;
  try {
    response = await client.request('GET', `/repos/${ref.owner}/${ref.repo}/installation`);
  } catch (err) {
    if (err instanceof GitHubRequestError && err.status === 404) return undefined;
    throw err;
  }

  const installationId = isRecord(response) ? positiveInteger(response.id) : undefined;
  if (!isRecord(response) || installationId === undefined) {
    throw new Error('GitHub returned an unexpected installation response');
  }
  const account = isRecord(response.account) ? response.account : {};
  const login = [account.login, account.slug].find((v) => typeof v === 'string' && v !== '');
  return {
    installationId,
    account: typeof login === 'string' ? login : ref.owner,
    permissions: stringRecord(response.permissions),
    repositorySelection: response.repository_selection === 'all' ? 'all' : 'selected',
  };
}

export type InstallationPermission = 'read' | 'write';
export interface InstallationScope {
  /** repository name only (not owner/name): GitHub's `repositories` field takes names */
  repository: string;
  permissions: Partial<Record<'contents' | 'pull_requests' | 'metadata', InstallationPermission>>;
}
/** Clone and read: the least an installation token needs to fetch a repository. */
export const READ_SCOPE: InstallationScope['permissions'] = Object.freeze({
  contents: 'read',
  metadata: 'read',
});
/** Push an agentproof/* branch and open a draft pull request. */
export const DELIVER_SCOPE: InstallationScope['permissions'] = Object.freeze({
  contents: 'write',
  pull_requests: 'write',
  metadata: 'read',
});

export interface InstallationToken {
  token: string;
  expiresAt: string;
  permissions: Record<string, string>;
  repositories: string[];
}

const PERMISSION_NAMES: ReadonlySet<string> = new Set(['contents', 'pull_requests', 'metadata']);
const PERMISSION_RANK: Readonly<Record<string, number>> = { read: 1, write: 2, admin: 3 };

function levelRank(level: string | undefined): number {
  return level === undefined ? 0 : (PERMISSION_RANK[level] ?? 0);
}

/** A validated copy of the permissions to request; unknown names and levels are refused at runtime too. */
function requestedPermissions(
  input: InstallationScope['permissions'],
): Record<string, InstallationPermission> {
  const requested: Record<string, InstallationPermission> = {};
  for (const [name, level] of Object.entries(input)) {
    if (level === undefined) continue;
    if (!PERMISSION_NAMES.has(name) || (level !== 'read' && level !== 'write')) {
      throw new Error(`Unsupported installation permission: ${name}`);
    }
    requested[name] = level;
  }
  if (Object.keys(requested).length === 0) {
    throw new Error('An installation token needs at least one permission');
  }
  return requested;
}

function reinstallHint(config: GitHubAppConfig): string {
  return config.slug && SAFE_HANDLE.test(config.slug)
    ? `Approve the app's new permissions or reinstall it: ${installUrl(config.slug)}`
    : "Approve the app's new permissions or reinstall it from the app's settings page on GitHub";
}

/**
 * POST /app/installations/{id}/access_tokens with { repositories: [scope.repository], permissions } and a
 * fresh app JWT. The token is scoped at mint time to that one repository and those permissions; it is
 * never cached or stored, so call this once per operation. The response is checked: every requested
 * permission must have been granted at least at the requested level (write >= read), and the token must
 * cover exactly the requested repository. Otherwise this throws without including the token.
 */
export async function mintInstallationToken(
  installationId: number,
  config: GitHubAppConfig,
  scope: InstallationScope,
  deps: GitHubAppDeps = {},
): Promise<InstallationToken> {
  if (!Number.isSafeInteger(installationId) || installationId <= 0) {
    throw new Error('Invalid GitHub App installation id');
  }
  if (!isSafeSegment(scope.repository)) {
    throw new Error(
      'Invalid repository name for an installation token (the name only, not owner/name)',
    );
  }
  const requested = requestedPermissions(scope.permissions);

  const client = appClient(config, deps);
  const response = await client.request<unknown>(
    'POST',
    `/app/installations/${installationId}/access_tokens`,
    { repositories: [scope.repository], permissions: requested },
  );
  if (!isRecord(response) || typeof response.token !== 'string' || response.token === '') {
    throw new Error('GitHub returned an installation token response without a token');
  }
  if (typeof response.expires_at !== 'string' || response.expires_at === '') {
    throw new Error('GitHub returned an installation token response without an expiry');
  }

  const granted = stringRecord(response.permissions);
  const short = Object.entries(requested).filter(
    ([name, level]) => levelRank(granted[name]) < levelRank(level),
  );
  if (short.length > 0) {
    const detail = short
      .map(([name, level]) => `${name} (${level} requested, ${granted[name] ?? 'none'} granted)`)
      .join(', ');
    throw new Error(
      `GitHub did not grant the requested permissions on installation ${installationId}: ${detail}. ${reinstallHint(config)}`,
    );
  }

  const repositories = Array.isArray(response.repositories)
    ? response.repositories.flatMap((entry: unknown) =>
        isRecord(entry) && typeof entry.name === 'string' ? [entry.name] : [],
      )
    : [];
  const wanted = scope.repository.toLowerCase();
  if (repositories.length !== 1 || repositories[0]?.toLowerCase() !== wanted) {
    throw new Error(
      `GitHub returned an installation token that is not scoped to ${scope.repository} alone, so it was discarded`,
    );
  }
  return {
    token: response.token,
    expiresAt: response.expires_at,
    permissions: granted,
    repositories,
  };
}

const LIST_PAGE_SIZE = 100;
/** One thousand repositories or installations is past anything this dashboard lists. */
const LIST_MAX_PAGES = 10;

export interface AppInstallation {
  installationId: number;
  /** account login the app is installed on */
  account: string;
  repositorySelection: 'all' | 'selected';
}

/**
 * GET /app/installations with a fresh app JWT, one page at a time. An entry without a usable id is
 * skipped. Stops at a short page or LIST_MAX_PAGES.
 */
export async function listInstallations(
  config: GitHubAppConfig,
  deps: GitHubAppDeps = {},
): Promise<AppInstallation[]> {
  const client = appClient(config, deps);
  const found: AppInstallation[] = [];
  for (let page = 1; page <= LIST_MAX_PAGES; page++) {
    const response = await client.request<unknown>(
      'GET',
      `/app/installations?per_page=${LIST_PAGE_SIZE}&page=${page}`,
    );
    if (!Array.isArray(response)) {
      throw new Error('GitHub returned an unexpected installations response');
    }
    for (const entry of response) {
      if (!isRecord(entry)) continue;
      const installationId = positiveInteger(entry.id);
      if (installationId === undefined) continue;
      const account = isRecord(entry.account) ? entry.account : {};
      const login = [account.login, account.slug].find((v) => typeof v === 'string' && v !== '');
      found.push({
        installationId,
        account: typeof login === 'string' ? login : String(installationId),
        repositorySelection: entry.repository_selection === 'all' ? 'all' : 'selected',
      });
    }
    if (response.length < LIST_PAGE_SIZE) break;
  }
  return found;
}

export interface InstalledRepository {
  fullName: string;
  url: string;
  private: boolean;
  defaultBranch: string;
}

const FULL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9._-]{1,100}$/;

/**
 * A token for reading which repositories an installation covers. Unlike mintInstallationToken this
 * names no repository, so GitHub scopes it to every repository the installation can see, and it asks
 * only for metadata: read. The token is returned to the caller in this file and nowhere else.
 */
async function mintListingToken(
  installationId: number,
  config: GitHubAppConfig,
  deps: GitHubAppDeps,
): Promise<string> {
  if (!Number.isSafeInteger(installationId) || installationId <= 0) {
    throw new Error('Invalid GitHub App installation id');
  }
  const requested = requestedPermissions({ metadata: 'read' });
  const client = appClient(config, deps);
  const response = await client.request<unknown>(
    'POST',
    `/app/installations/${installationId}/access_tokens`,
    { permissions: requested },
  );
  if (!isRecord(response) || typeof response.token !== 'string' || response.token === '') {
    throw new Error('GitHub returned an installation token response without a token');
  }
  const granted = stringRecord(response.permissions);
  if (levelRank(granted.metadata) < levelRank('read')) {
    throw new Error(
      `GitHub did not grant metadata read on installation ${installationId}. ${reinstallHint(config)}`,
    );
  }
  return response.token;
}

function installedRepository(entry: unknown): InstalledRepository | undefined {
  if (!isRecord(entry) || typeof entry.full_name !== 'string' || !FULL_NAME.test(entry.full_name)) {
    return undefined;
  }
  const url = httpUrlOrUndefined(entry.html_url) ?? `${WEB_BASE_URL}/${entry.full_name}`;
  const branch = typeof entry.default_branch === 'string' ? entry.default_branch.trim() : '';
  if (branch === '') return undefined;
  return {
    fullName: entry.full_name,
    url,
    private: entry.private === true,
    defaultBranch: branch,
  };
}

/**
 * The repositories one installation covers. Mints a metadata-only token (no repository named, so it
 * covers the installation), pages GET /installation/repositories, and drops the token. A repository
 * without a name and a default branch is skipped.
 */
export async function listInstallationRepositories(
  installationId: number,
  config: GitHubAppConfig,
  deps: GitHubAppDeps = {},
): Promise<InstalledRepository[]> {
  const token = await mintListingToken(installationId, config, deps);
  const client = new GitHubClient({
    token,
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    ...(deps.baseUrl ? { baseUrl: deps.baseUrl } : {}),
  });
  const found: InstalledRepository[] = [];
  for (let page = 1; page <= LIST_MAX_PAGES; page++) {
    const response = await client.request<unknown>(
      'GET',
      `/installation/repositories?per_page=${LIST_PAGE_SIZE}&page=${page}`,
    );
    if (!isRecord(response) || !Array.isArray(response.repositories)) {
      throw new Error('GitHub returned an unexpected installation repositories response');
    }
    for (const entry of response.repositories) {
      const repository = installedRepository(entry);
      if (repository) found.push(repository);
    }
    if (response.repositories.length < LIST_PAGE_SIZE) break;
  }
  return found;
}

// ---------------------------------------------------------------------------------------------
// Registration from a manifest
// ---------------------------------------------------------------------------------------------

export interface ManifestOptions {
  name: string;
  runnerUrl: string;
  description?: string;
}

const DEFAULT_APP_DESCRIPTION =
  'AgentProof opens draft pull requests that fix what AI shopping agents found broken. It never merges.';

/**
 * The GitHub App manifest (https://docs.github.com/apps/sharing-github-apps/registering-a-github-app-from-a-manifest).
 * The app is private, asks for Contents and Pull requests (write) and Metadata (read), subscribes to no
 * events and has its webhook switched off. `runnerUrl` must be http(s) and is used without a trailing slash.
 */
export function buildAppManifest(opts: ManifestOptions): Record<string, unknown> {
  const name = opts.name.trim();
  if (name === '' || name.length > 100 || /\p{Cc}/u.test(name)) {
    throw new Error('Invalid GitHub App name');
  }
  const runnerUrl = normalizeHttpUrl(opts.runnerUrl, 'runnerUrl');
  const callback = `${runnerUrl}/github/app/callback`;
  return {
    name,
    url: runnerUrl,
    redirect_url: callback,
    callback_urls: [callback],
    public: false,
    default_permissions: { contents: 'write', pull_requests: 'write', metadata: 'read' },
    default_events: [],
    // No webhook block at all: GitHub refuses a hook URL that is not publicly reachable even
    // when the hook is inactive, and AgentProof receives no events.
    description: opts.description?.trim() || DEFAULT_APP_DESCRIPTION,
  };
}

/** The anti-CSRF `state` of the manifest round trip: 16 random bytes as hex. */
export const MANIFEST_STATE = /^[0-9a-f]{32}$/;

const PERMISSION_TITLES: Readonly<Record<string, string>> = {
  contents: 'Contents',
  pull_requests: 'Pull requests',
  metadata: 'Metadata',
};
const PERMISSION_WORDS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  contents: {
    read: 'Read the code in the repositories you install the app on.',
    write:
      'Read the code, and push new branches named agentproof/... that hold a proposed fix. Pushing to a branch is how a pull request gets its changes.',
  },
  pull_requests: {
    read: 'See pull requests and their status.',
    write: 'Open pull requests (AgentProof always opens them as drafts) and see their status.',
  },
  metadata: {
    read: 'See basic repository information such as the default branch. GitHub always requires this.',
  },
};

const FORM_PAGE_CSS = `
:root { color-scheme: light dark; }
body { font: 16px/1.55 system-ui, sans-serif; margin: 0; padding: 2.5rem 1rem; }
main { max-width: 40rem; margin: 0 auto; }
h1 { font-size: 1.6rem; margin: 0 0 1rem; }
h2 { font-size: 1.1rem; margin: 1.75rem 0 0.5rem; }
code { font: 0.9em ui-monospace, monospace; padding: 0.1em 0.35em; border-radius: 4px; background: rgba(127, 127, 127, 0.18); }
li { margin: 0.4rem 0; }
.note { opacity: 0.8; font-size: 0.92rem; }
button { font: inherit; font-weight: 600; margin-top: 1.5rem; padding: 0.65rem 1.1rem; border: 0; border-radius: 6px; background: #1f6feb; color: #fff; cursor: pointer; }
button:hover { background: #1a5fd0; }
button:focus-visible { outline: 3px solid #79b8ff; outline-offset: 2px; }
`;

function permissionItem(name: string, level: unknown): string {
  const levelText = typeof level === 'string' ? level : 'unknown';
  const title = PERMISSION_TITLES[name] ?? name;
  const words = PERMISSION_WORDS[name]?.[levelText] ?? `${levelText} access.`;
  return `<li><strong>${escapeHtml(title)}: ${escapeHtml(levelText)}.</strong> ${escapeHtml(words)}</li>`;
}

/**
 * A self-contained page whose one form POSTs the manifest to GitHub's "register a GitHub App from a
 * manifest" endpoint (https://github.com/settings/apps/new, or the organization's equivalent) with the
 * anti-CSRF `state`. The user presses the button and confirms on GitHub; nothing is submitted
 * automatically. No scripts, no event handlers, no external resources. Everything interpolated is
 * HTML-escaped; `state` must match MANIFEST_STATE and `organization` must be a plain login.
 */
export function renderManifestForm(opts: {
  manifest: Record<string, unknown>;
  state: string;
  githubUrl?: string;
  organization?: string;
}): string {
  if (!MANIFEST_STATE.test(opts.state)) throw new Error('Invalid manifest state');
  const githubUrl = normalizeHttpUrl(opts.githubUrl ?? WEB_BASE_URL, 'githubUrl');
  let settingsPath = '/settings/apps/new';
  if (opts.organization !== undefined && opts.organization !== '') {
    if (!SAFE_HANDLE.test(opts.organization)) throw new Error('Invalid GitHub organization');
    settingsPath = `/organizations/${opts.organization}/settings/apps/new`;
  }
  const action = `${githubUrl}${settingsPath}?state=${opts.state}`;

  const { manifest } = opts;
  const appName = typeof manifest.name === 'string' ? manifest.name : undefined;
  const returnUrl = typeof manifest.redirect_url === 'string' ? manifest.redirect_url : undefined;
  const permissions = isRecord(manifest.default_permissions)
    ? Object.entries(manifest.default_permissions)
    : [];
  const permissionList =
    permissions.length > 0
      ? permissions.map(([name, level]) => permissionItem(name, level)).join('\n')
      : '<li>No permissions are requested.</li>';
  const title = 'Create the AgentProof GitHub App';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>${FORM_PAGE_CSS}</style>
</head>
<body>
<main>
<h1>${escapeHtml(title)}</h1>
<p>AgentProof can work as its own GitHub App instead of using your personal access token. Its pull requests are then authored by the app, not by you, and the credentials it uses expire within an hour. The button below sends the app's definition to GitHub. You review it there and confirm; nothing is created before that.</p>
${appName ? `<p>App name: <code>${escapeHtml(appName)}</code>. You can change it on GitHub.</p>` : ''}
<h2>What the app asks GitHub for</h2>
<ul>
${permissionList}
</ul>
<p class="note">The app is private: only the account or organization that creates it can install it, and you choose the repositories when you install it. AgentProof opens pull requests as drafts and never merges, approves or deletes anything. GitHub's permissions are broader than what AgentProof does with them (Contents: write, for example, covers every branch), so turn on branch protection for your default branch if you want GitHub itself to enforce that.</p>
<h2>What happens next</h2>
<ol>
<li>GitHub shows you the app and asks you to confirm.</li>
<li>GitHub sends you back${returnUrl ? ` to <code>${escapeHtml(returnUrl)}</code>` : ' to this runner'} with a one-time code.</li>
<li>The runner exchanges the code for the app's key and keeps it on this machine. The key is not shown on any page and not written to logs.</li>
<li>You install the app on the repositories AgentProof may work on.</li>
</ol>
<form method="post" action="${escapeHtml(action)}">
<input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(manifest))}">
<button type="submit">Create the GitHub App on GitHub</button>
</form>
</main>
</body>
</html>
`;
}

/** The one-time `code` GitHub appends to the redirect after a manifest registration. */
export const MANIFEST_CODE = /^[A-Za-z0-9_-]{1,200}$/;

function bodyMessage(text: string): string {
  try {
    const json: unknown = JSON.parse(text);
    if (isRecord(json) && typeof json.message === 'string') return safeExcerpt(json.message);
  } catch {
    // Not JSON: say nothing about a body we cannot vouch for.
  }
  return '';
}

/**
 * GitHub shows an app's private key once, in the conversion response. When that response is unusable the
 * app already exists, so say how to recover instead of leaving the owner with a bare error.
 */
function unusableConversion(problem: string): Error {
  return new Error(
    `${problem}. The app was created on GitHub: generate a new private key on its settings page, or delete the app and register again.`,
  );
}

function httpUrlOrUndefined(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const protocol = new URL(value).protocol;
    return protocol === 'https:' || protocol === 'http:' ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * POST {baseUrl}/app-manifests/{code}/conversions: trades the one-time code for the new app's id, slug,
 * client id and private key. Unauthenticated by design (the code is the credential), and the only call
 * in this file made with fetch directly. GitHub returns the key exactly once, so a response is rejected
 * only when the id or the key is unusable; a cosmetic field that looks wrong is dropped, never fatal.
 * The webhook and client secrets in the response are not read. A non-2xx response throws a
 * GitHubRequestError carrying the status and a capped excerpt of GitHub's own message, never the body.
 */
export async function convertManifestCode(
  code: string,
  deps: { fetch?: typeof fetch; baseUrl?: string } = {},
): Promise<{ config: GitHubAppConfig; htmlUrl: string }> {
  if (!MANIFEST_CODE.test(code)) throw new Error('Invalid manifest code');
  const baseUrl = (deps.baseUrl ?? API_BASE_URL).replace(/\/+$/, '');
  const doFetch = deps.fetch ?? fetch;
  const response = await doFetch(`${baseUrl}/app-manifests/${code}/conversions`, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': API_VERSION,
      'User-Agent': USER_AGENT,
    },
  });
  const text = await response.text();

  if (!response.ok) {
    const message = bodyMessage(text);
    throw new GitHubRequestError(
      response.status,
      `GitHub POST /app-manifests/{code}/conversions failed with ${response.status}${message ? `: ${message}` : ''}`,
    );
  }

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw unusableConversion('GitHub returned an unreadable response to the manifest conversion');
  }
  if (!isRecord(body) || positiveInteger(body.id) === undefined || typeof body.pem !== 'string') {
    throw unusableConversion('GitHub did not return an app id and key for the manifest conversion');
  }
  const slug = typeof body.slug === 'string' && SAFE_HANDLE.test(body.slug) ? body.slug : undefined;
  const clientId =
    typeof body.client_id === 'string' && SAFE_SEGMENT.test(body.client_id)
      ? body.client_id
      : undefined;
  let config: GitHubAppConfig;
  try {
    config = buildConfig({ appId: body.id, slug, clientId, privateKeyPem: body.pem }, FILE_LABELS);
  } catch (err) {
    if (!(err instanceof ConfigProblem)) throw err;
    throw unusableConversion(`GitHub's response was rejected: ${err.message}`);
  }
  const htmlUrl =
    httpUrlOrUndefined(body.html_url) ?? (slug ? `${WEB_BASE_URL}/apps/${slug}` : WEB_BASE_URL);
  return { config, htmlUrl };
}

// ---------------------------------------------------------------------------------------------
// Presentation helpers
// ---------------------------------------------------------------------------------------------

/** https://github.com/apps/<slug>/installations/new, where the owner picks the repositories. */
export function installUrl(slug: string): string {
  if (typeof slug !== 'string' || slug === '') throw new Error('A GitHub App slug is required');
  return `${WEB_BASE_URL}/apps/${encodeURIComponent(slug)}/installations/new`;
}

/** Safe for status endpoints: { appId, slug, clientId, hasPrivateKey }; never the key. */
export function describeGitHubApp(config: GitHubAppConfig): {
  appId: number;
  slug?: string;
  clientId?: string;
  hasPrivateKey: boolean;
} {
  return {
    appId: config.appId,
    ...(config.slug ? { slug: config.slug } : {}),
    ...(config.clientId ? { clientId: config.clientId } : {}),
    hasPrivateKey: config.privateKeyPem.trim() !== '',
  };
}
