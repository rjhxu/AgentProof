import fs from 'node:fs';
import path from 'node:path';
import {
  DELIVER_SCOPE,
  READ_SCOPE,
  describeGitHubApp,
  findInstallation,
  installUrl,
  loadGitHubAppConfig,
  mintInstallationToken,
  parseRepoFullName,
  type GitHubAppConfig,
  type LoadedGitHubAppConfig,
} from '@agentproof/codefix';
import type { GitHubAppStatus } from '@agentproof/shared';
import { REPO_ROOT } from './config';

/**
 * The runner's GitHub App identity (docs/CODEFIX.md section 2). Credentials live in `.env`
 * (AGENTPROOF_GITHUB_APP_ID, AGENTPROOF_GITHUB_APP_PRIVATE_KEY, optional _SLUG and _CLIENT_ID),
 * which the dev scripts load into the process environment, so one shared `.env` gives every
 * teammate the same app. The one-click manifest flow writes those lines into `.env` itself.
 * The private key never leaves this process: status reports describe the app without it, and
 * every token minted from it is short-lived, scoped to one repository and the one operation,
 * and never persisted.
 */

export const GITHUB_APP_ENV = {
  id: 'AGENTPROOF_GITHUB_APP_ID',
  key: 'AGENTPROOF_GITHUB_APP_PRIVATE_KEY',
  slug: 'AGENTPROOF_GITHUB_APP_SLUG',
  clientId: 'AGENTPROOF_GITHUB_APP_CLIENT_ID',
} as const;

/** The env file the registration writes: AGENTPROOF_ENV_FILE, else <repo root>/.env. */
export function githubAppEnvFile(): string {
  return process.env.AGENTPROOF_ENV_FILE?.trim() || path.join(REPO_ROOT, '.env');
}

let cached: LoadedGitHubAppConfig | undefined;

export function githubAppState(reload = false): LoadedGitHubAppConfig {
  if (!cached || reload) cached = loadGitHubAppConfig(process.env);
  return cached;
}

/**
 * Persist a registration into `.env` and into this process's environment, so the app works at
 * once and survives a restart. Existing AGENTPROOF_GITHUB_APP_* lines are replaced in place.
 */
export function storeGitHubApp(app: GitHubAppConfig): void {
  const values: Record<string, string> = {
    [GITHUB_APP_ENV.id]: String(app.appId),
    [GITHUB_APP_ENV.key]: app.privateKeyPem,
    ...(app.slug ? { [GITHUB_APP_ENV.slug]: app.slug } : {}),
    ...(app.clientId ? { [GITHUB_APP_ENV.clientId]: app.clientId } : {}),
  };
  writeEnvValues(githubAppEnvFile(), values);
  for (const [name, value] of Object.entries(values)) process.env[name] = value;
  delete process.env.AGENTPROOF_GITHUB_APP_PRIVATE_KEY_FILE;
  cached = undefined;
}

/** `"..."` with real newlines written as `\n`, which both Node's env-file loader and our key loader accept. */
function encodeEnvValue(value: string): string {
  return `"${value.replace(/\r?\n/g, '\\n')}"`;
}

/**
 * Replace or append `NAME=value` lines in a dotenv file. The file is written atomically with
 * mode 0600 (it holds the private key); a file that already exists keeps its other lines.
 */
export function writeEnvValues(file: string, values: Record<string, string>): void {
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const seen = new Set<string>();
  const lines = existing.split('\n').map((line) => {
    const match = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=/.exec(line);
    const name = match?.[1];
    if (name && name in values) {
      seen.add(name);
      return `${name}=${encodeEnvValue(values[name] ?? '')}`;
    }
    return line;
  });
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const missing = Object.keys(values).filter((name) => !seen.has(name));
  if (missing.length > 0) {
    lines.push(
      '',
      '# GitHub App identity written by the runner (GET /github/app/setup); share .env out of band',
    );
    for (const name of missing) lines.push(`${name}=${encodeEnvValue(values[name] ?? '')}`);
  }
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${lines.join('\n')}\n`, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

/** For tests: forget the cached configuration. */
export function resetGitHubAppCache(): void {
  cached = undefined;
}

export function githubAppStatus(): GitHubAppStatus {
  const state = githubAppState();
  if (!state.config) {
    return { configured: false, ...(state.error ? { error: state.error } : {}) };
  }
  const described = describeGitHubApp(state.config);
  return {
    configured: true,
    appId: described.appId,
    ...(described.slug ? { slug: described.slug, installUrl: installUrl(described.slug) } : {}),
    ...(state.source ? { source: state.source } : {}),
  };
}

export type CredentialKind = 'github_app' | 'token' | 'none';
export type CredentialScope = 'read' | 'deliver';

export interface ResolvedCredential {
  kind: CredentialKind;
  /** Memory-only; never persisted or logged */
  token?: string;
  installationId?: number;
  expiresAt?: string;
  /** Human-readable, safe to show: what was used and why */
  note: string;
}

/**
 * Prefer the GitHub App: when it is configured and installed on the repository, mint a token
 * scoped to that repository and to the operation (read for a clone, write for a push and a
 * draft pull request). Otherwise use the request token, if any; otherwise anonymous.
 */
export async function resolveGitHubCredential(
  repoUrl: string,
  scope: CredentialScope,
  requestToken?: string,
): Promise<ResolvedCredential> {
  const state = githubAppState();
  let appNote = 'no GitHub App configured';
  if (state.config) {
    const ref = parseRepoFullName(repoUrl);
    try {
      const installation = await findInstallation(ref, state.config);
      if (installation) {
        const minted = await mintInstallationToken(installation.installationId, state.config, {
          repository: ref.repo,
          permissions: scope === 'read' ? READ_SCOPE : DELIVER_SCOPE,
        });
        return {
          kind: 'github_app',
          token: minted.token,
          installationId: installation.installationId,
          expiresAt: minted.expiresAt,
          note: `GitHub App installation ${installation.installationId} on ${installation.account} (${scope} scope, expires ${minted.expiresAt})`,
        };
      }
      appNote = `the GitHub App is not installed on ${ref.fullName}${
        state.config.slug ? ` (install it at ${installUrl(state.config.slug)})` : ''
      }`;
    } catch (err) {
      appNote = `the GitHub App could not be used: ${err instanceof Error ? err.message : String(err)}`;
    }
  } else if (state.error) {
    appNote = `the GitHub App configuration is invalid: ${state.error}`;
  }
  if (requestToken)
    return { kind: 'token', token: requestToken, note: `request token (${appNote})` };
  return { kind: 'none', note: `anonymous (${appNote}; no token given)` };
}
