import { generateKeyPairSync, createPrivateKey, verify, type KeyObject } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { GitHubRequestError } from './github';
import {
  APP_JWT_TTL_SECONDS,
  DELIVER_SCOPE,
  MANIFEST_CODE,
  MANIFEST_STATE,
  READ_SCOPE,
  buildAppManifest,
  convertManifestCode,
  createAppJwt,
  describeGitHubApp,
  findInstallation,
  installUrl,
  loadGitHubAppConfig,
  mintInstallationToken,
  renderManifestForm,
  saveGitHubAppConfig,
  type GitHubAppConfig,
} from './github-app';

const NOW_MS = 1_760_000_000_000;
const NOW_S = NOW_MS / 1000;
const IS_WINDOWS = process.platform === 'win32';
const STATE = 'abcdef0123456789abcdef0123456789';
const REF = { owner: 'o', repo: 'r', fullName: 'o/r' };

let privateKey: KeyObject;
let publicKey: KeyObject;
let pkcs8: string;
let pkcs1: string;
let config: GitHubAppConfig;

beforeAll(() => {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  privateKey = pair.privateKey;
  publicKey = pair.publicKey;
  pkcs8 = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  pkcs1 = pair.privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
  config = { appId: 12345, slug: 'agentproof-test', clientId: 'Iv1.abc123', privateKeyPem: pkcs8 };
});

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentproof-ghapp-'));
  tempDirs.push(dir);
  return dir;
}

/** Slices of a PEM's base64 body: if any of them shows up in a string, key material leaked. */
function keySlices(pem: string): string[] {
  const body = pem
    .split('\n')
    .filter((line) => line !== '' && !line.startsWith('-----'))
    .join('');
  const slices: string[] = [];
  for (let i = 0; i + 20 <= body.length; i += 40) slices.push(body.slice(i, i + 20));
  return slices;
}

function expectNoKeyMaterial(text: string, ...pems: string[]): void {
  expect(text).not.toContain('PRIVATE KEY');
  expect(text).not.toContain('BEGIN');
  for (const pem of pems) for (const slice of keySlices(pem)) expect(text).not.toContain(slice);
}

function decodeSegment(segment: string | undefined): Record<string, unknown> {
  const text = Buffer.from(segment ?? '', 'base64url').toString('utf8');
  return JSON.parse(text) as Record<string, unknown>;
}

function jwtVerifies(jwt: string): boolean {
  const [header, payload, signature] = jwt.split('.');
  return verify(
    'RSA-SHA256',
    Buffer.from(`${header}.${payload}`),
    publicKey,
    Buffer.from(signature ?? '', 'base64url'),
  );
}

function bearer(call: Recorded): string {
  const header = call.headers.Authorization ?? '';
  expect(header.startsWith('Bearer ')).toBe(true);
  return header.slice('Bearer '.length);
}

interface Recorded {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
  body: string | undefined;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function mockFetch(respond: (call: Recorded) => Response) {
  const calls: Recorded[] = [];
  const impl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const call: Recorded = {
      url: String(input),
      method: init?.method,
      headers: { ...(init?.headers as Record<string, string> | undefined) },
      body: typeof init?.body === 'string' ? init.body : undefined,
    };
    calls.push(call);
    return respond(call);
  });
  return { fetch: impl as unknown as typeof fetch, impl, calls };
}

describe('createAppJwt', () => {
  it('has three base64url segments and an RS256 header', () => {
    const segments = createAppJwt(config, NOW_MS).split('.');
    expect(segments).toHaveLength(3);
    for (const segment of segments) expect(segment).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeSegment(segments[0])).toEqual({ alg: 'RS256', typ: 'JWT' });
  });

  it('claims the app id as a string, backdates iat 60 s and stays inside GitHub 10 minute limit', () => {
    const payload = decodeSegment(createAppJwt(config, NOW_MS).split('.')[1]);
    expect(Object.keys(payload).sort()).toEqual(['exp', 'iat', 'iss']);
    expect(payload.iss).toBe('12345');
    expect(payload.iat).toBe(NOW_S - 60);
    expect(payload.exp).toBe(NOW_S + APP_JWT_TTL_SECONDS);
    expect((payload.exp as number) - (payload.iat as number)).toBe(60 + APP_JWT_TTL_SECONDS);
    expect(payload.exp as number).toBeLessThanOrEqual(NOW_S + 600);
    expect(APP_JWT_TTL_SECONDS).toBeLessThanOrEqual(600 - 60);
  });

  it('works in whole seconds', () => {
    const payload = decodeSegment(createAppJwt(config, NOW_MS + 999).split('.')[1]);
    expect(payload.iat).toBe(NOW_S - 60);
    expect(Number.isInteger(payload.exp)).toBe(true);
  });

  it('verifies against the public key, and a tampered payload does not', () => {
    const jwt = createAppJwt(config, NOW_MS);
    expect(jwtVerifies(jwt)).toBe(true);

    const [header, payload, signature] = jwt.split('.');
    const forged = Buffer.from(
      JSON.stringify({ ...decodeSegment(payload), iss: '99999' }),
      'utf8',
    ).toString('base64url');
    const tampered = `${header}.${forged}.${signature}`;
    expect(tampered).not.toBe(jwt);
    expect(jwtVerifies(tampered)).toBe(false);
  });

  it('signs with PKCS#1 and PKCS#8 keys alike', () => {
    expect(jwtVerifies(createAppJwt({ ...config, privateKeyPem: pkcs1 }, NOW_MS))).toBe(true);
    expect(jwtVerifies(createAppJwt({ ...config, privateKeyPem: pkcs8 }, NOW_MS))).toBe(true);
  });

  it('uses the current time when none is given', () => {
    const before = Math.floor(Date.now() / 1000);
    const payload = decodeSegment(createAppJwt(config).split('.')[1]);
    const after = Math.floor(Date.now() / 1000);
    expect(payload.iat as number).toBeGreaterThanOrEqual(before - 60);
    expect(payload.iat as number).toBeLessThanOrEqual(after - 60);
  });

  it('refuses a bad key without echoing it', () => {
    const body = keySlices(pkcs8).slice(0, 3).join('');
    const bad = `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\n`;
    let message = '';
    try {
      createAppJwt({ ...config, privateKeyPem: bad }, NOW_MS);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain('RSA key in PEM format');
    expectNoKeyMaterial(message, bad);
  });

  it('refuses a key that is not RSA, and an unusable app id', () => {
    const { privateKey: ec } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const ecPem = ec.export({ type: 'pkcs8', format: 'pem' }).toString();
    expect(() => createAppJwt({ ...config, privateKeyPem: ecPem }, NOW_MS)).toThrow(
      'RSA key in PEM format',
    );
    for (const appId of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) {
      expect(() => createAppJwt({ ...config, appId }, NOW_MS)).toThrow('positive integer');
    }
  });
});

describe('loadGitHubAppConfig', () => {
  const idVar = 'AGENTPROOF_GITHUB_APP_ID';
  const keyVar = 'AGENTPROOF_GITHUB_APP_PRIVATE_KEY';
  const keyFileVar = 'AGENTPROOF_GITHUB_APP_PRIVATE_KEY_FILE';

  it('reads the environment, unescaping literal \\n sequences in the PEM', () => {
    const escaped = pkcs8.trim().replace(/\n/g, '\\n');
    expect(escaped).not.toContain('\n');
    const loaded = loadGitHubAppConfig({
      [idVar]: '12345',
      [keyVar]: escaped,
      AGENTPROOF_GITHUB_APP_SLUG: 'agentproof-test',
      AGENTPROOF_GITHUB_APP_CLIENT_ID: 'Iv1.abc123',
    });
    expect(loaded.error).toBeUndefined();
    expect(loaded.source).toBe('env');
    expect(loaded.config).toMatchObject({
      appId: 12345,
      slug: 'agentproof-test',
      clientId: 'Iv1.abc123',
    });
    expect(loaded.config?.privateKeyPem).toContain('\n');
    expect(createPrivateKey(loaded.config!.privateKeyPem).equals(privateKey)).toBe(true);
    expect(jwtVerifies(createAppJwt(loaded.config!, NOW_MS))).toBe(true);
  });

  it('reads a PEM that already has real newlines, PKCS#1 or PKCS#8', () => {
    for (const pem of [pkcs1, pkcs8]) {
      const loaded = loadGitHubAppConfig({ [idVar]: '7', [keyVar]: pem });
      expect(loaded.error).toBeUndefined();
      expect(loaded.config?.privateKeyPem).toBe(pem.trim()); // env values are trimmed
      expect(jwtVerifies(createAppJwt(loaded.config!, NOW_MS))).toBe(true);
    }
  });

  it('reads the key from a file named in the environment', () => {
    const dir = tempDir();
    const keyFile = join(dir, 'app.private-key.pem');
    writeFileSync(keyFile, pkcs1);
    const loaded = loadGitHubAppConfig({ [idVar]: ' 12345 ', [keyFileVar]: keyFile });
    expect(loaded.error).toBeUndefined();
    expect(loaded.source).toBe('env');
    expect(loaded.config?.appId).toBe(12345);
    expect(jwtVerifies(createAppJwt(loaded.config!, NOW_MS))).toBe(true);
  });

  it('reads the JSON file when the environment is empty', () => {
    const file = join(tempDir(), 'github-app.json');
    writeFileSync(file, JSON.stringify({ ...config, privateKeyPem: pkcs8 }));
    const loaded = loadGitHubAppConfig({}, file);
    expect(loaded.error).toBeUndefined();
    expect(loaded.source).toBe('file');
    expect(loaded.config).toEqual(config);
  });

  it('prefers the environment over the file', () => {
    const file = join(tempDir(), 'github-app.json');
    writeFileSync(file, JSON.stringify({ appId: 222, privateKeyPem: pkcs8 }));
    const loaded = loadGitHubAppConfig({ [idVar]: '111', [keyVar]: pkcs1 }, file);
    expect(loaded.source).toBe('env');
    expect(loaded.config?.appId).toBe(111);
  });

  it('prefers the inline key over the key file when both are set', () => {
    const missing = join(tempDir(), 'does-not-exist.pem');
    const loaded = loadGitHubAppConfig({ [idVar]: '5', [keyVar]: pkcs8, [keyFileVar]: missing });
    expect(loaded.error).toBeUndefined();
    expect(loaded.config?.appId).toBe(5);
  });

  it('returns {} when nothing is configured', () => {
    expect(loadGitHubAppConfig({})).toEqual({});
    expect(loadGitHubAppConfig({}, undefined)).toEqual({});
    expect(loadGitHubAppConfig({}, join(tempDir(), 'missing.json'))).toEqual({});
  });

  it('treats blank variables as unset and falls through to the file', () => {
    const file = join(tempDir(), 'github-app.json');
    writeFileSync(file, JSON.stringify({ appId: 9, privateKeyPem: pkcs8 }));
    const blank = { [idVar]: '', [keyVar]: '   ', [keyFileVar]: '\n' };
    expect(loadGitHubAppConfig(blank)).toEqual({});
    const loaded = loadGitHubAppConfig(blank, file);
    expect(loaded.source).toBe('file');
    expect(loaded.config?.appId).toBe(9);
  });

  it('reports a half-configured environment instead of falling back to the file', () => {
    const file = join(tempDir(), 'github-app.json');
    writeFileSync(file, JSON.stringify({ appId: 9, privateKeyPem: pkcs8 }));
    const noKey = loadGitHubAppConfig({ [idVar]: '12345' }, file);
    expect(noKey.config).toBeUndefined();
    expect(noKey.error).toContain('AGENTPROOF_GITHUB_APP_PRIVATE_KEY');
    const noId = loadGitHubAppConfig({ [keyVar]: pkcs8 }, file);
    expect(noId.config).toBeUndefined();
    expect(noId.error).toContain(idVar);
  });

  it('rejects an app id that is not a positive integer', () => {
    for (const id of ['abc', '12.5', '-3', '0', '1e3', '0x10', '12 34', '9'.repeat(20)]) {
      const loaded = loadGitHubAppConfig({ [idVar]: id, [keyVar]: pkcs8 });
      expect(loaded.config, id).toBeUndefined();
      expect(loaded.error, id).toContain(idVar);
    }
  });

  it('rejects an invalid PEM with text that holds no key material', () => {
    const body = 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=';
    const fake = `-----BEGIN RSA PRIVATE KEY-----\n${body}\n-----END RSA PRIVATE KEY-----\n`;
    for (const value of [fake, fake.trim().replace(/\n/g, '\\n'), 'hunter2-not-a-pem']) {
      const loaded = loadGitHubAppConfig({ [idVar]: '12345', [keyVar]: value });
      expect(loaded.config).toBeUndefined();
      expect(loaded.error).toContain('RSA key in PEM format');
      expect(loaded.error).not.toContain('PRIVATE KEY');
      expect(loaded.error).not.toContain(body);
      expect(loaded.error).not.toContain('hunter2');
      expect(loaded.error).not.toMatch(/[A-Za-z0-9+/]{32,}/);
    }
  });

  it('rejects a truncated real key, an encrypted key and a non-RSA key without echoing them', () => {
    const truncated = pkcs8.slice(0, Math.floor(pkcs8.length / 2));
    const encrypted = privateKey
      .export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: 'correct horse' })
      .toString();
    const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' })
      .privateKey.export({ type: 'pkcs8', format: 'pem' })
      .toString();
    for (const pem of [truncated, encrypted, ec]) {
      const loaded = loadGitHubAppConfig({ [idVar]: '12345', [keyVar]: pem });
      expect(loaded.config).toBeUndefined();
      expect(loaded.error).toBeDefined();
      expectNoKeyMaterial(loaded.error ?? '', pem, pkcs8);
      expect(loaded.error).not.toContain('correct horse');
    }
  });

  it('reports an unreadable key file by path and error code only', () => {
    const missing = join(tempDir(), 'nope.pem');
    const loaded = loadGitHubAppConfig({ [idVar]: '12345', [keyFileVar]: missing });
    expect(loaded.config).toBeUndefined();
    expect(loaded.error).toContain(missing);
    expect(loaded.error).toContain('ENOENT');
  });

  it('rejects a config file that is not JSON without quoting it', () => {
    const file = join(tempDir(), 'github-app.json');
    writeFileSync(file, pkcs8); // somebody pasted the raw PEM instead of JSON
    const loaded = loadGitHubAppConfig({}, file);
    expect(loaded.config).toBeUndefined();
    expect(loaded.error).toContain('not valid JSON');
    expectNoKeyMaterial(loaded.error ?? '', pkcs8);
  });

  it('rejects config files with missing or malformed fields', () => {
    const file = join(tempDir(), 'github-app.json');
    const cases: Array<[unknown, string]> = [
      [['not', 'an', 'object'], 'JSON object'],
      [{ privateKeyPem: pkcs8 }, 'appId is required'],
      [{ appId: 'x', privateKeyPem: pkcs8 }, 'appId must be a positive integer'],
      [{ appId: 5 }, 'privateKeyPem is missing'],
      [{ appId: 5, privateKeyPem: 12 }, 'privateKeyPem is missing'],
      [{ appId: 5, privateKeyPem: 'nope' }, 'privateKeyPem is not an RSA key'],
      [{ appId: 5, privateKeyPem: pkcs8, slug: 'a/b' }, 'slug is not a valid'],
      [{ appId: 5, privateKeyPem: pkcs8, clientId: 'a b' }, 'clientId is not a valid'],
    ];
    for (const [content, expected] of cases) {
      writeFileSync(file, JSON.stringify(content));
      const loaded = loadGitHubAppConfig({}, file);
      expect(loaded.config, expected).toBeUndefined();
      expect(loaded.error, expected).toContain(expected);
      expect(loaded.error, expected).toContain(file);
      expectNoKeyMaterial(loaded.error ?? '', pkcs8);
    }
  });
});

describe('saveGitHubAppConfig', () => {
  it('writes the file with mode 0600 inside a directory with mode 0700', () => {
    const file = join(tempDir(), 'nested', 'deeper', 'github-app.json');
    saveGitHubAppConfig(file, config);
    expect(existsSync(file)).toBe(true);
    if (IS_WINDOWS) return;
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(file)).mode & 0o777).toBe(0o700);
    expect(statSync(dirname(dirname(file))).mode & 0o077).toBe(0);
  });

  it.skipIf(IS_WINDOWS)('narrows a looser existing file to 0600 and leaves no temp files', () => {
    const dir = tempDir();
    const file = join(dir, 'github-app.json');
    writeFileSync(file, '{"appId":1}', { mode: 0o644 });
    chmodSync(file, 0o644);
    saveGitHubAppConfig(file, config);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(['github-app.json']);
    expect((JSON.parse(readFileSync(file, 'utf8')) as { appId: number }).appId).toBe(12345);
  });

  it.skipIf(IS_WINDOWS)(
    'does not change the permissions of a directory that already exists',
    () => {
      const dir = join(tempDir(), 'shared');
      mkdirSync(dir, { mode: 0o755 });
      chmodSync(dir, 0o755);
      saveGitHubAppConfig(join(dir, 'github-app.json'), config);
      expect(statSync(dir).mode & 0o777).toBe(0o755);
    },
  );

  it('round-trips through loadGitHubAppConfig', () => {
    const file = join(tempDir(), 'github-app.json');
    saveGitHubAppConfig(file, config);
    const loaded = loadGitHubAppConfig({}, file);
    expect(loaded.source).toBe('file');
    expect(loaded.config).toEqual(config);
    expect(jwtVerifies(createAppJwt(loaded.config!, NOW_MS))).toBe(true);

    const minimal = { appId: 3, privateKeyPem: pkcs1 };
    saveGitHubAppConfig(file, minimal);
    expect(loadGitHubAppConfig({}, file).config).toEqual(minimal);
  });

  it('stores only the four documented fields', () => {
    const file = join(tempDir(), 'github-app.json');
    saveGitHubAppConfig(file, { ...config, extra: 'ignored' } as GitHubAppConfig);
    const stored = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect(Object.keys(stored).sort()).toEqual(['appId', 'clientId', 'privateKeyPem', 'slug']);
  });

  it('refuses to store a config that could not be loaded again', () => {
    const base = tempDir();
    const file = join(base, 'fresh', 'github-app.json');
    expect(() => saveGitHubAppConfig(file, { appId: 5, privateKeyPem: 'nope' })).toThrow(
      'privateKeyPem is not an RSA key',
    );
    expect(() => saveGitHubAppConfig(file, { appId: 0, privateKeyPem: pkcs8 })).toThrow(
      'positive integer',
    );
    expect(existsSync(file)).toBe(false);
    expect(existsSync(dirname(file))).toBe(false);
  });

  it('does not put the key in an I/O error', () => {
    const base = tempDir();
    const blocker = join(base, 'a-file');
    writeFileSync(blocker, 'x');
    let message = '';
    try {
      saveGitHubAppConfig(join(blocker, 'github-app.json'), config);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).not.toBe('');
    expectNoKeyMaterial(message, pkcs8);
  });
});

describe('findInstallation', () => {
  const installation = {
    id: 42,
    account: { login: 'o' },
    permissions: { contents: 'write', pull_requests: 'write', metadata: 'read' },
    repository_selection: 'selected',
  };

  it('GETs the repository installation as the app, with a fresh JWT', async () => {
    const m = mockFetch(() => jsonResponse(200, installation));
    await findInstallation(REF, config, { fetch: m.fetch, nowMs: NOW_MS });

    expect(m.calls).toHaveLength(1);
    const call = m.calls[0]!;
    expect(call.url).toBe('https://api.github.com/repos/o/r/installation');
    expect(call.method).toBe('GET');
    expect(call.body).toBeUndefined();
    expect(call.headers.Accept).toBe('application/vnd.github+json');
    expect(call.headers['X-GitHub-Api-Version']).toBe('2022-11-28');
    const jwt = bearer(call);
    expect(jwt.split('.')).toHaveLength(3);
    expect(jwtVerifies(jwt)).toBe(true);
    expect(decodeSegment(jwt.split('.')[1])).toMatchObject({
      iss: '12345',
      iat: NOW_S - 60,
      exp: NOW_S + APP_JWT_TTL_SECONDS,
    });
  });

  it('maps the installation', async () => {
    const m = mockFetch(() => jsonResponse(200, installation));
    await expect(findInstallation(REF, config, { fetch: m.fetch })).resolves.toEqual({
      installationId: 42,
      account: 'o',
      permissions: { contents: 'write', pull_requests: 'write', metadata: 'read' },
      repositorySelection: 'selected',
    });
  });

  it('maps an all-repositories installation and falls back to the owner without a login', async () => {
    const m = mockFetch(() =>
      jsonResponse(200, { id: 7, account: null, repository_selection: 'all' }),
    );
    await expect(findInstallation(REF, config, { fetch: m.fetch })).resolves.toEqual({
      installationId: 7,
      account: 'o',
      permissions: {},
      repositorySelection: 'all',
    });
  });

  it('gives undefined when the app is not installed there (404)', async () => {
    const m = mockFetch(() => jsonResponse(404, { message: 'Not Found' }));
    await expect(findInstallation(REF, config, { fetch: m.fetch })).resolves.toBeUndefined();
  });

  it('propagates other failures as GitHubRequestError', async () => {
    for (const status of [401, 403, 500]) {
      const m = mockFetch(() => jsonResponse(status, { message: 'nope' }));
      const failure = await findInstallation(REF, config, { fetch: m.fetch }).catch((e) => e);
      expect(failure).toBeInstanceOf(GitHubRequestError);
      expect((failure as GitHubRequestError).status).toBe(status);
      expectNoKeyMaterial((failure as Error).message, pkcs8);
      expect((failure as Error).message).not.toContain(bearer(m.calls[0]!));
    }
    const html = mockFetch(() => new Response('<html>Bad gateway</html>', { status: 502 }));
    await expect(findInstallation(REF, config, { fetch: html.fetch })).rejects.toBeInstanceOf(
      GitHubRequestError,
    );
  });

  it('rejects a response without an installation id', async () => {
    const m = mockFetch(() => jsonResponse(200, { account: { login: 'o' } }));
    await expect(findInstallation(REF, config, { fetch: m.fetch })).rejects.toThrow(
      'unexpected installation response',
    );
  });

  it('honours baseUrl', async () => {
    const m = mockFetch(() => jsonResponse(200, installation));
    await findInstallation(REF, config, { fetch: m.fetch, baseUrl: 'https://ghe.example/api/v3' });
    expect(m.calls[0]!.url).toBe('https://ghe.example/api/v3/repos/o/r/installation');
  });

  it('refuses repository references that are not plain names, before any request', async () => {
    const m = mockFetch(() => jsonResponse(200, installation));
    const bad = [
      { owner: 'o', repo: '%2e%2e' },
      { owner: '%2e%2e', repo: 'r' },
      { owner: 'o#x', repo: 'r' },
      { owner: 'o', repo: 'r?x=1' },
      { owner: 'o/p', repo: 'r' },
      { owner: 'o', repo: '..' },
      { owner: 'o', repo: '.' },
      { owner: '', repo: 'r' },
      { owner: 'o', repo: 'r r' },
      { owner: 'o', repo: 'a'.repeat(101) },
    ];
    for (const { owner, repo } of bad) {
      const ref = { owner, repo, fullName: `${owner}/${repo}` };
      await expect(findInstallation(ref, config, { fetch: m.fetch }), ref.fullName).rejects.toThrow(
        'Not a valid GitHub repository reference',
      );
    }
    expect(m.impl).not.toHaveBeenCalled();
  });

  it('accepts the characters GitHub allows in names', async () => {
    const m = mockFetch(() => jsonResponse(200, installation));
    const ref = { owner: 'octo-cat_1', repo: 'my.repo_name-2', fullName: 'x' };
    await findInstallation(ref, config, { fetch: m.fetch });
    expect(m.calls[0]!.url).toBe(
      'https://api.github.com/repos/octo-cat_1/my.repo_name-2/installation',
    );
  });

  it('refuses a bad key before any request', async () => {
    const m = mockFetch(() => jsonResponse(200, installation));
    await expect(
      findInstallation(REF, { ...config, privateKeyPem: 'nope' }, { fetch: m.fetch }),
    ).rejects.toThrow('RSA key in PEM format');
    expect(m.impl).not.toHaveBeenCalled();
  });
});

describe('mintInstallationToken', () => {
  const granted = {
    token: 'ghs_x',
    expires_at: '2026-10-18T01:00:00Z',
    permissions: { contents: 'write', pull_requests: 'write', metadata: 'read' },
    repositories: [{ name: 'r' }],
  };

  it('POSTs a token request scoped to one repository and the minimal permissions', async () => {
    const m = mockFetch(() => jsonResponse(201, granted));
    const minted = await mintInstallationToken(
      42,
      config,
      { repository: 'r', permissions: DELIVER_SCOPE },
      { fetch: m.fetch, nowMs: NOW_MS },
    );

    expect(m.calls).toHaveLength(1);
    const call = m.calls[0]!;
    expect(call.url).toBe('https://api.github.com/app/installations/42/access_tokens');
    expect(call.method).toBe('POST');
    expect(call.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(call.body ?? 'null')).toEqual({
      repositories: ['r'],
      permissions: DELIVER_SCOPE,
    });
    expect(jwtVerifies(bearer(call))).toBe(true);
    expect(bearer(call)).not.toBe('ghs_x');

    expect(minted).toEqual({
      token: 'ghs_x',
      expiresAt: '2026-10-18T01:00:00Z',
      permissions: { contents: 'write', pull_requests: 'write', metadata: 'read' },
      repositories: ['r'],
    });
  });

  it('asks for read-only access for a clone', async () => {
    const m = mockFetch(() =>
      jsonResponse(201, { ...granted, permissions: { contents: 'read', metadata: 'read' } }),
    );
    await mintInstallationToken(42, config, { repository: 'r', permissions: READ_SCOPE }, m);
    expect(JSON.parse(m.calls[0]!.body ?? 'null')).toEqual({
      repositories: ['r'],
      permissions: { contents: 'read', metadata: 'read' },
    });
  });

  it('defines the scopes as frozen constants', () => {
    expect(READ_SCOPE).toEqual({ contents: 'read', metadata: 'read' });
    expect(DELIVER_SCOPE).toEqual({ contents: 'write', pull_requests: 'write', metadata: 'read' });
    expect(Object.isFrozen(READ_SCOPE)).toBe(true);
    expect(Object.isFrozen(DELIVER_SCOPE)).toBe(true);
  });

  it('mints a new token every time and keeps nothing', async () => {
    let n = 0;
    const m = mockFetch(() => jsonResponse(201, { ...granted, token: `ghs_${(n += 1)}` }));
    const scope = { repository: 'r', permissions: DELIVER_SCOPE };
    const first = await mintInstallationToken(42, config, scope, m);
    const second = await mintInstallationToken(42, config, scope, m);
    expect([first.token, second.token]).toEqual(['ghs_1', 'ghs_2']);
    expect(m.calls).toHaveLength(2);
    expect(m.calls[0]!.headers.Authorization).not.toContain('ghs_');
    expect(m.calls[1]!.headers.Authorization).not.toContain('ghs_');
  });

  it('throws naming the missing permission, without the token, when GitHub grants less', async () => {
    const m = mockFetch(() =>
      jsonResponse(201, { ...granted, permissions: { contents: 'read', metadata: 'read' } }),
    );
    const failure = await mintInstallationToken(
      42,
      config,
      { repository: 'r', permissions: DELIVER_SCOPE },
      m,
    ).catch((e) => e);
    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toContain('pull_requests');
    expect(message).toContain('contents');
    expect(message).toContain('write requested, none granted');
    expect(message).toContain('write requested, read granted');
    expect(message).toContain('https://github.com/apps/agentproof-test/installations/new');
    expect(message).not.toContain('ghs_x');
    expectNoKeyMaterial(message, pkcs8);
  });

  it('still names the missing permission when the response says nothing about repositories', async () => {
    const m = mockFetch(() =>
      jsonResponse(201, { token: 'ghs_x', expires_at: 'soon', permissions: { contents: 'read' } }),
    );
    await expect(
      mintInstallationToken(42, config, { repository: 'r', permissions: DELIVER_SCOPE }, m),
    ).rejects.toThrow('pull_requests');
  });

  it('points at the app settings when the config has no slug', async () => {
    const m = mockFetch(() => jsonResponse(201, { ...granted, permissions: {} }));
    const noSlug = { appId: 1, privateKeyPem: pkcs8 };
    const failure = await mintInstallationToken(
      42,
      noSlug,
      { repository: 'r', permissions: READ_SCOPE },
      m,
    ).catch((e) => e);
    expect((failure as Error).message).toContain("app's settings page");
  });

  it('treats write as satisfying read, and admin as satisfying write', async () => {
    const m = mockFetch(() =>
      jsonResponse(201, {
        ...granted,
        permissions: { contents: 'admin', metadata: 'write', pull_requests: 'write' },
      }),
    );
    await expect(
      mintInstallationToken(42, config, { repository: 'r', permissions: DELIVER_SCOPE }, m),
    ).resolves.toMatchObject({ token: 'ghs_x' });
  });

  it('refuses a token that is not scoped to exactly the requested repository', async () => {
    const wrong: unknown[] = [
      { ...granted, repositories: [{ name: 'other' }] },
      { ...granted, repositories: [{ name: 'r' }, { name: 'other' }] },
      { ...granted, repositories: [] },
      { token: granted.token, expires_at: granted.expires_at, permissions: granted.permissions },
    ];
    for (const body of wrong) {
      const m = mockFetch(() => jsonResponse(201, body));
      const failure = await mintInstallationToken(
        42,
        config,
        { repository: 'r', permissions: DELIVER_SCOPE },
        m,
      ).catch((e) => e);
      expect((failure as Error).message).toContain('not scoped to r alone');
      expect((failure as Error).message).not.toContain('ghs_x');
    }
  });

  it('matches the repository name case-insensitively', async () => {
    const m = mockFetch(() => jsonResponse(201, { ...granted, repositories: [{ name: 'repo' }] }));
    await expect(
      mintInstallationToken(42, config, { repository: 'Repo', permissions: DELIVER_SCOPE }, m),
    ).resolves.toMatchObject({ repositories: ['repo'] });
  });

  it('rejects malformed token responses without echoing them', async () => {
    const bodies: unknown[] = [
      {},
      { token: '', expires_at: 'x' },
      { token: 5, expires_at: 'x' },
      { token: 'ghs_x' },
      'ghs_x',
    ];
    for (const body of bodies) {
      const m = mockFetch(() => jsonResponse(201, body));
      const failure = await mintInstallationToken(
        42,
        config,
        { repository: 'r', permissions: READ_SCOPE },
        m,
      ).catch((e) => e);
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).not.toContain('ghs_x');
    }
  });

  it('propagates GitHub errors as GitHubRequestError', async () => {
    const m = mockFetch(() =>
      jsonResponse(422, { message: 'There is at least one repository that does not exist.' }),
    );
    const failure = await mintInstallationToken(
      42,
      config,
      { repository: 'r', permissions: READ_SCOPE },
      m,
    ).catch((e) => e);
    expect(failure).toBeInstanceOf(GitHubRequestError);
    expect((failure as GitHubRequestError).status).toBe(422);
  });

  it('validates the request before any network call', async () => {
    const m = mockFetch(() => jsonResponse(201, granted));
    const scope = { repository: 'r', permissions: READ_SCOPE };
    const bad: Array<[() => Promise<unknown>, string]> = [
      [() => mintInstallationToken(0, config, scope, m), 'installation id'],
      [() => mintInstallationToken(-5, config, scope, m), 'installation id'],
      [() => mintInstallationToken(1.5, config, scope, m), 'installation id'],
      [() => mintInstallationToken(1e21, config, scope, m), 'installation id'],
      [() => mintInstallationToken(42, config, { ...scope, repository: 'o/r' }, m), 'repository'],
      [
        () => mintInstallationToken(42, config, { ...scope, repository: '%2e%2e' }, m),
        'repository',
      ],
      [() => mintInstallationToken(42, config, { ...scope, repository: '' }, m), 'repository'],
      [() => mintInstallationToken(42, config, { ...scope, permissions: {} }, m), 'at least one'],
      [
        () =>
          mintInstallationToken(
            42,
            config,
            { ...scope, permissions: { administration: 'write' } as never },
            m,
          ),
        'Unsupported installation permission: administration',
      ],
      [
        () =>
          mintInstallationToken(
            42,
            config,
            { ...scope, permissions: { contents: 'admin' } as never },
            m,
          ),
        'Unsupported installation permission: contents',
      ],
    ];
    for (const [call, expected] of bad) await expect(call()).rejects.toThrow(expected);
    expect(m.impl).not.toHaveBeenCalled();
  });

  it('honours baseUrl', async () => {
    const m = mockFetch(() => jsonResponse(201, granted));
    await mintInstallationToken(
      42,
      config,
      { repository: 'r', permissions: DELIVER_SCOPE },
      { fetch: m.fetch, baseUrl: 'https://ghe.example/api/v3' },
    );
    expect(m.calls[0]!.url).toBe('https://ghe.example/api/v3/app/installations/42/access_tokens');
  });
});

describe('buildAppManifest', () => {
  const runnerUrl = 'http://localhost:4000';

  it('has exactly the documented shape', () => {
    const manifest = buildAppManifest({
      name: 'AgentProof Test',
      runnerUrl,
      description: 'Opens draft pull requests.',
    });
    expect(manifest).toStrictEqual({
      name: 'AgentProof Test',
      url: 'http://localhost:4000',
      redirect_url: 'http://localhost:4000/github/app/callback',
      callback_urls: ['http://localhost:4000/github/app/callback'],
      public: false,
      default_permissions: { contents: 'write', pull_requests: 'write', metadata: 'read' },
      default_events: [],
      description: 'Opens draft pull requests.',
    });
  });

  it('asks for exactly what a delivery token needs', () => {
    expect(buildAppManifest({ name: 'x', runnerUrl }).default_permissions).toEqual(DELIVER_SCOPE);
  });

  it('removes trailing slashes from the runner URL', () => {
    for (const url of ['http://localhost:4000/', 'http://localhost:4000///']) {
      const manifest = buildAppManifest({ name: 'x', runnerUrl: url });
      expect(manifest.url).toBe('http://localhost:4000');
      expect(manifest.redirect_url).toBe('http://localhost:4000/github/app/callback');
    }
    expect(buildAppManifest({ name: 'x', runnerUrl: 'https://runner.example/base/' }).url).toBe(
      'https://runner.example/base',
    );
  });

  it('supplies a description when none is given', () => {
    const description = buildAppManifest({ name: 'x', runnerUrl }).description;
    expect(typeof description).toBe('string');
    expect(description).toContain('never merges');
  });

  it('refuses a runner URL that is not a plain http(s) URL', () => {
    const bad = [
      'ftp://localhost:4000',
      'javascript:alert(1)',
      'file:///etc/passwd',
      'localhost:4000',
      'not a url',
      '',
      'http://user:secret@localhost:4000',
      'http://localhost:4000?x=1',
      'http://localhost:4000/#frag',
    ];
    for (const runner of bad) {
      expect(() => buildAppManifest({ name: 'x', runnerUrl: runner }), runner).toThrow('runnerUrl');
    }
  });

  it('refuses an empty, oversized or control-character name', () => {
    for (const name of ['', '   ', 'x'.repeat(101), 'a\nb', 'a\u0000b']) {
      expect(() => buildAppManifest({ name, runnerUrl })).toThrow('Invalid GitHub App name');
    }
  });
});

describe('renderManifestForm', () => {
  const manifest = buildAppManifest({
    name: 'AgentProof Test',
    runnerUrl: 'http://localhost:4000',
  });

  function unescapeHtml(text: string): string {
    return text
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');
  }

  it('posts the escaped manifest to GitHub with the state', () => {
    const html = renderManifestForm({ manifest, state: STATE });
    expect(html).toContain(
      '<form method="post" action="https://github.com/settings/apps/new?state=',
    );
    expect(html).toContain(`action="https://github.com/settings/apps/new?state=${STATE}"`);
    expect(html).toContain('&quot;name&quot;');
    expect(html).not.toContain('"name":');

    expect(html.match(/<input /g)).toHaveLength(1);
    const value = /<input type="hidden" name="manifest" value="([^"]*)">/.exec(html)?.[1];
    expect(value).toBeDefined();
    expect(JSON.parse(unescapeHtml(value ?? ''))).toEqual(manifest);
  });

  it('has a heading, the permissions in plain words and the submit button', () => {
    const html = renderManifestForm({ manifest, state: STATE });
    expect(html).toMatch(/<h1>[^<]*AgentProof[^<]*<\/h1>/);
    expect(html).toContain('<strong>Contents: write.</strong>');
    expect(html).toContain('<strong>Pull requests: write.</strong>');
    expect(html).toContain('<strong>Metadata: read.</strong>');
    expect(html).toContain('draft');
    expect(html).toContain('branch protection');
    expect(html).toContain('<button type="submit">Create the GitHub App on GitHub</button>');
    expect(html).toContain('http://localhost:4000/github/app/callback');
  });

  it('runs no script, has no event handlers, loads nothing and never submits itself', () => {
    const html = renderManifestForm({ manifest, state: STATE });
    expect(html).not.toContain('<script');
    expect(html).not.toMatch(/on[a-z]+=/); // the naive form of the check
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
    expect(html).not.toMatch(/\b(?:src|href|srcset|data)\s*=/i);
    expect(html).not.toMatch(/<(?:link|img|iframe|object|embed|base|meta http-equiv)\b/i);
    expect(html).not.toMatch(/@import|url\(|javascript:/i);
    expect(html).not.toMatch(/\.submit\(|autofocus/i);
  });

  it('uses the organization path for an organization', () => {
    const html = renderManifestForm({ manifest, state: STATE, organization: 'my-org' });
    expect(html).toContain(
      `action="https://github.com/organizations/my-org/settings/apps/new?state=${STATE}"`,
    );
    expect(renderManifestForm({ manifest, state: STATE, organization: '' })).toContain(
      `action="https://github.com/settings/apps/new?state=${STATE}"`,
    );
  });

  it('can target another GitHub host', () => {
    const html = renderManifestForm({ manifest, state: STATE, githubUrl: 'https://ghe.example/' });
    expect(html).toContain(`action="https://ghe.example/settings/apps/new?state=${STATE}"`);
  });

  it('refuses a state that is not 32 lowercase hex characters', () => {
    expect(MANIFEST_STATE.test(STATE)).toBe(true);
    const bad = [
      '',
      'xyz',
      STATE.toUpperCase(),
      STATE.slice(1),
      `${STATE}0`,
      `${STATE.slice(0, 31)}"`,
      `${STATE.slice(0, 20)}&x=1${STATE.slice(25)}`,
      '<script>alert(1)</script>',
    ];
    for (const state of bad) {
      expect(() => renderManifestForm({ manifest, state }), state).toThrow(
        'Invalid manifest state',
      );
    }
  });

  it('refuses organizations and GitHub URLs that are not plain', () => {
    for (const organization of ['a/b', '../x', 'a b', 'a"b', '-x', 'x?y=1']) {
      expect(
        () => renderManifestForm({ manifest, state: STATE, organization }),
        organization,
      ).toThrow('Invalid GitHub organization');
    }
    for (const githubUrl of ['javascript:alert(1)', 'ftp://github.com', 'github.com', '']) {
      expect(() => renderManifestForm({ manifest, state: STATE, githubUrl }), githubUrl).toThrow(
        'githubUrl',
      );
    }
  });

  it('escapes everything it interpolates', () => {
    const hostile = {
      ...manifest,
      name: `x"><img src=x onerror=alert(1)>'&`,
      redirect_url: `http://localhost:4000/"><b>`,
      default_permissions: { '<i>weird</i>': '"><u>' },
    };
    const html = renderManifestForm({ manifest: hostile, state: STATE });
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<b>');
    expect(html).not.toContain('<i>');
    expect(html).not.toContain('<u>');
    expect(html).not.toContain('"><');
    expect(html.match(/<input /g)).toHaveLength(1);
    const value = /<input type="hidden" name="manifest" value="([^"]*)">/.exec(html)?.[1];
    expect(JSON.parse(unescapeHtml(value ?? ''))).toEqual(hostile);
  });
});

describe('convertManifestCode', () => {
  const conversion = {
    id: 4242,
    slug: 'agentproof-ab12',
    client_id: 'Iv1.abc123',
    client_secret: 'client-secret-value',
    webhook_secret: 'webhook-secret-value',
    pem: '',
    html_url: 'https://github.com/apps/agentproof-ab12',
  };
  const okBody = () => ({ ...conversion, pem: pkcs1 });

  it('trades the code for the app credentials, unauthenticated', async () => {
    const m = mockFetch(() => jsonResponse(201, okBody()));
    const result = await convertManifestCode('abc_DEF-123', { fetch: m.fetch });

    expect(m.calls).toHaveLength(1);
    const call = m.calls[0]!;
    expect(call.url).toBe('https://api.github.com/app-manifests/abc_DEF-123/conversions');
    expect(call.method).toBe('POST');
    expect(call.body).toBeUndefined();
    expect(call.headers.Accept).toBe('application/vnd.github+json');
    expect(call.headers['X-GitHub-Api-Version']).toBe('2022-11-28');
    expect(call.headers['User-Agent']).toBe('AgentProof');
    expect(Object.keys(call.headers).map((key) => key.toLowerCase())).not.toContain(
      'authorization',
    );

    expect(result).toEqual({
      config: {
        appId: 4242,
        slug: 'agentproof-ab12',
        clientId: 'Iv1.abc123',
        privateKeyPem: pkcs1,
      },
      htmlUrl: 'https://github.com/apps/agentproof-ab12',
    });
    expect(JSON.stringify(result)).not.toContain('secret-value');
  });

  it('hands back a config that can be saved, loaded and used to sign', async () => {
    const m = mockFetch(() => jsonResponse(201, okBody()));
    const { config: converted } = await convertManifestCode('abc', { fetch: m.fetch });
    const file = join(tempDir(), 'data', 'github-app.json');
    saveGitHubAppConfig(file, converted);
    const loaded = loadGitHubAppConfig({}, file);
    expect(loaded.config).toEqual(converted);
    expect(jwtVerifies(createAppJwt(loaded.config!, NOW_MS))).toBe(true);
  });

  it('rejects a code that is not URL-safe before any network call', async () => {
    const m = mockFetch(() => jsonResponse(201, okBody()));
    expect(MANIFEST_CODE.test('abc_DEF-123')).toBe(true);
    for (const code of ['bad code!', '', '../x', 'a/b', 'a?b=1', 'a#b', 'x'.repeat(201), 'é']) {
      await expect(convertManifestCode(code, { fetch: m.fetch }), code).rejects.toThrow(
        'Invalid manifest code',
      );
    }
    expect(m.impl).not.toHaveBeenCalled();
  });

  it('throws a GitHubRequestError with the status and never the body on failure', async () => {
    const m = mockFetch(() => jsonResponse(404, { message: 'Not Found', pem: pkcs1 }));
    const failure = await convertManifestCode('abc', { fetch: m.fetch }).catch((e) => e);
    expect(failure).toBeInstanceOf(GitHubRequestError);
    expect((failure as GitHubRequestError).status).toBe(404);
    expect((failure as Error).message).toContain('404');
    expect((failure as Error).message).toContain('Not Found');
    expect((failure as Error).message).not.toContain('abc');
    expectNoKeyMaterial((failure as Error).message, pkcs1);
    expect((failure as Error).message.toLowerCase()).not.toContain('pem');
  });

  it('does not repeat a non-JSON failure body, and redacts what a message might carry', async () => {
    const raw = mockFetch(() => new Response(`oops\n${pkcs1}`, { status: 500 }));
    const rawFailure = await convertManifestCode('abc', { fetch: raw.fetch }).catch((e) => e);
    expect((rawFailure as GitHubRequestError).status).toBe(500);
    expect((rawFailure as Error).message).toBe(
      'GitHub POST /app-manifests/{code}/conversions failed with 500',
    );

    const sneaky = mockFetch(() =>
      jsonResponse(422, { message: `bad ${pkcs1} and ghp_${'a'.repeat(30)} ${'z'.repeat(1000)}` }),
    );
    const failure = await convertManifestCode('abc', { fetch: sneaky.fetch }).catch((e) => e);
    const message = (failure as Error).message;
    expectNoKeyMaterial(message, pkcs1);
    expect(message).not.toContain('ghp_');
    expect(message).toContain('[redacted]');
    expect(message.length).toBeLessThanOrEqual(300 + 100);
  });

  it('keeps the key when only a cosmetic field is odd', async () => {
    const m = mockFetch(() =>
      jsonResponse(201, { id: 9, pem: pkcs8, slug: 'bad slug/!', client_id: 42, html_url: 'x' }),
    );
    const result = await convertManifestCode('abc', { fetch: m.fetch });
    expect(result.config).toEqual({ appId: 9, privateKeyPem: pkcs8 });
    expect(result.htmlUrl).toBe('https://github.com');
    saveGitHubAppConfig(join(tempDir(), 'github-app.json'), result.config);

    const hostile = mockFetch(() =>
      jsonResponse(201, { id: 9, pem: pkcs8, slug: 'fine-slug', html_url: 'javascript:alert(1)' }),
    );
    const second = await convertManifestCode('abc', { fetch: hostile.fetch });
    expect(second.htmlUrl).toBe('https://github.com/apps/fine-slug');
  });

  it('rejects a success response without a usable id or key, without echoing it', async () => {
    const bodies: unknown[] = [
      { id: 'x', pem: pkcs1 },
      { id: 0, pem: pkcs1 },
      { id: 5 },
      { id: 5, pem: 12 },
      { id: 5, pem: 'junk' },
      { id: 5, pem: pkcs1.slice(0, 200) },
      [],
      'text',
    ];
    for (const body of bodies) {
      const m = mockFetch(() => jsonResponse(201, body));
      const failure = await convertManifestCode('abc', { fetch: m.fetch }).catch((e) => e);
      expect(failure, JSON.stringify(body).slice(0, 40)).toBeInstanceOf(Error);
      expectNoKeyMaterial((failure as Error).message, pkcs1);
      // The app exists on GitHub by now, so the error says how to recover.
      expect((failure as Error).message).toContain('The app was created on GitHub');
      expect((failure as Error).message).toContain('generate a new private key');
    }
    const notJson = mockFetch(() => new Response(`-----BEGIN RSA PRIVATE KEY-----\n${pkcs1}`));
    const failure = await convertManifestCode('abc', { fetch: notJson.fetch }).catch((e) => e);
    expect((failure as Error).message).toContain('unreadable');
    expectNoKeyMaterial((failure as Error).message, pkcs1);
  });

  it('honours baseUrl and propagates network failures', async () => {
    const m = mockFetch(() => jsonResponse(201, okBody()));
    await convertManifestCode('abc', { fetch: m.fetch, baseUrl: 'https://ghe.example/api/v3/' });
    expect(m.calls[0]!.url).toBe('https://ghe.example/api/v3/app-manifests/abc/conversions');

    const down = vi.fn(async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    await expect(convertManifestCode('abc', { fetch: down })).rejects.toThrow('fetch failed');
  });
});

describe('installUrl and describeGitHubApp', () => {
  it('builds the install URL', () => {
    expect(installUrl('agentproof')).toBe('https://github.com/apps/agentproof/installations/new');
    expect(installUrl('a/b?c')).toBe('https://github.com/apps/a%2Fb%3Fc/installations/new');
    expect(() => installUrl('')).toThrow('slug is required');
  });

  it('describes the app without the key', () => {
    const described = describeGitHubApp(config);
    expect(described).toEqual({
      appId: 12345,
      slug: 'agentproof-test',
      clientId: 'Iv1.abc123',
      hasPrivateKey: true,
    });
    const text = JSON.stringify(described);
    expect(text).not.toContain('PRIVATE');
    expect(text).not.toContain('BEGIN');
    for (const slice of keySlices(pkcs8)) expect(text).not.toContain(slice);
  });

  it('omits what is not set and reports a missing key honestly', () => {
    expect(describeGitHubApp({ appId: 1, privateKeyPem: pkcs8 })).toStrictEqual({
      appId: 1,
      hasPrivateKey: true,
    });
    expect(describeGitHubApp({ appId: 1, privateKeyPem: '  ' }).hasPrivateKey).toBe(false);
  });
});
