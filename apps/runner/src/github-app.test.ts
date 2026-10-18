import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';

/**
 * The runner's GitHub App identity: status never leaks the key, the manifest flow stores what
 * GitHub returns, and credential resolution prefers a scoped installation token over a request
 * token. GitHub itself is stubbed; the key handling, file permissions and routes are real.
 */
const stubs = vi.hoisted(() => ({
  installation: undefined as
    | {
        installationId: number;
        account: string;
        permissions: Record<string, string>;
        repositorySelection: 'all' | 'selected';
      }
    | undefined,
  findInstallation: vi.fn(),
  mintInstallationToken: vi.fn(),
  convertManifestCode: vi.fn(),
}));
vi.mock('@agentproof/codefix', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agentproof/codefix')>();
  return {
    ...actual,
    findInstallation: stubs.findInstallation,
    mintInstallationToken: stubs.mintInstallationToken,
    convertManifestCode: stubs.convertManifestCode,
  };
});

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentproof-github-app-'));
process.env.AGENTPROOF_DATA_DIR = dataDir;
process.env.AGENTPROOF_ENV_FILE = path.join(dataDir, '.env');
const { DELIVER_SCOPE, READ_SCOPE } = await import('@agentproof/codefix');
const { githubAppEnvFile, githubAppStatus, resetGitHubAppCache, resolveGitHubCredential } =
  await import('./github-app');
const { registerGitHubAppRoutes } = await import('./github-app-routes');

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

async function server() {
  const app = Fastify();
  await registerGitHubAppRoutes(app);
  return app;
}

const APP_VARS = [
  'AGENTPROOF_GITHUB_APP_ID',
  'AGENTPROOF_GITHUB_APP_PRIVATE_KEY',
  'AGENTPROOF_GITHUB_APP_PRIVATE_KEY_FILE',
  'AGENTPROOF_GITHUB_APP_SLUG',
  'AGENTPROOF_GITHUB_APP_CLIENT_ID',
];

/** Configure the app the way a shared .env does: through the process environment. */
function configureApp(values: { appId: number; slug?: string; clientId?: string }) {
  vi.stubEnv('AGENTPROOF_GITHUB_APP_ID', String(values.appId));
  vi.stubEnv('AGENTPROOF_GITHUB_APP_PRIVATE_KEY', pem);
  if (values.slug) vi.stubEnv('AGENTPROOF_GITHUB_APP_SLUG', values.slug);
  if (values.clientId) vi.stubEnv('AGENTPROOF_GITHUB_APP_CLIENT_ID', values.clientId);
  resetGitHubAppCache();
}

beforeEach(() => {
  vi.unstubAllEnvs();
  for (const name of APP_VARS) delete process.env[name];
  fs.rmSync(githubAppEnvFile(), { force: true });
  fs.writeFileSync(githubAppEnvFile(), 'ANTHROPIC_API_KEY=sk-ant-test\nSTOREFRONT_PORT=5050\n');
  resetGitHubAppCache();
  stubs.findInstallation.mockReset();
  stubs.mintInstallationToken.mockReset();
  stubs.convertManifestCode.mockReset();
});

afterAll(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('GitHub App status and registration', () => {
  it('reports "not configured" without leaking anything, and localhost-only', async () => {
    const app = await server();
    const res = await app.inject({ url: '/github/app' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ app: { configured: false } });
    const remote = await app.inject({ url: '/github/app', remoteAddress: '10.0.0.9' });
    expect(remote.statusCode).toBe(403);
    await app.close();
  });

  it('describes a configured app from the environment without the private key', async () => {
    configureApp({ appId: 77, slug: 'agentproof-test' });
    const status = githubAppStatus();
    expect(status).toEqual({
      configured: true,
      appId: 77,
      slug: 'agentproof-test',
      source: 'env',
      installUrl: 'https://github.com/apps/agentproof-test/installations/new',
    });
    expect(JSON.stringify(status)).not.toContain('PRIVATE');
  });

  it('registers through the manifest flow: setup page, callback with a one-time state, stored config', async () => {
    const app = await server();
    const setup = await app.inject({ url: '/github/app/setup?name=AgentProof%20Test' });
    expect(setup.statusCode).toBe(200);
    expect(setup.headers['content-type']).toContain('text/html');
    expect(setup.body).toContain('name="manifest"');
    expect(setup.body).not.toContain('<script');
    const state = /settings\/apps\/new\?state=([0-9a-f]{32})/.exec(setup.body)?.[1];
    expect(state).toBeTruthy();

    stubs.convertManifestCode.mockResolvedValue({
      config: { appId: 4242, slug: 'agentproof-ab12', clientId: 'Iv1.abc', privateKeyPem: pem },
      htmlUrl: 'https://github.com/settings/apps/agentproof-ab12',
    });
    const bad = await app.inject({ url: `/github/app/callback?code=abc&state=${'0'.repeat(32)}` });
    expect(bad.statusCode).toBe(400);
    const ok = await app.inject({ url: `/github/app/callback?code=abc_123&state=${state}` });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toContain('agentproof-ab12');
    expect(ok.body).toContain('installations/new');
    expect(ok.body).not.toContain('PRIVATE KEY');
    expect(stubs.convertManifestCode).toHaveBeenCalledWith('abc_123');
    // Written into .env: other lines kept, the key on one line with escaped newlines, mode 0600.
    const env = fs.readFileSync(githubAppEnvFile(), 'utf8');
    expect(env).toContain('ANTHROPIC_API_KEY=sk-ant-test');
    expect(env).toContain('AGENTPROOF_GITHUB_APP_ID="4242"');
    expect(env).toContain('AGENTPROOF_GITHUB_APP_SLUG="agentproof-ab12"');
    expect(env).toMatch(
      /AGENTPROOF_GITHUB_APP_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\\n[^\n]*-----END PRIVATE KEY-----(\\n)?"/,
    );
    expect(
      env.split('\n').filter((l) => l.startsWith('AGENTPROOF_GITHUB_APP_PRIVATE_KEY=')).length,
    ).toBe(1);
    if (process.platform !== 'win32') {
      expect(fs.statSync(githubAppEnvFile()).mode & 0o777).toBe(0o600);
    }
    // The running process sees it at once.
    expect((await app.inject({ url: '/github/app' })).json().app).toMatchObject({
      configured: true,
      appId: 4242,
      slug: 'agentproof-ab12',
      source: 'env',
    });
    // The state is single-use.
    const replay = await app.inject({ url: `/github/app/callback?code=abc_123&state=${state}` });
    expect(replay.statusCode).toBe(400);
    await app.close();
  });
});

describe('credential resolution', () => {
  const repoUrl = 'https://github.com/o/r';

  it('mints a scoped installation token when the app is installed on the repository', async () => {
    configureApp({ appId: 77, slug: 's' });
    stubs.findInstallation.mockResolvedValue({
      installationId: 42,
      account: 'o',
      permissions: { contents: 'write', pull_requests: 'write' },
      repositorySelection: 'selected',
    });
    stubs.mintInstallationToken.mockResolvedValue({
      token: 'ghs_minted',
      expiresAt: '2026-10-18T00:00:00Z',
      permissions: { contents: 'read' },
      repositories: ['r'],
    });
    const read = await resolveGitHubCredential(repoUrl, 'read', 'ghp_request');
    expect(read).toMatchObject({ kind: 'github_app', token: 'ghs_minted', installationId: 42 });
    expect(stubs.mintInstallationToken).toHaveBeenLastCalledWith(42, expect.anything(), {
      repository: 'r',
      permissions: READ_SCOPE,
    });
    await resolveGitHubCredential(repoUrl, 'deliver');
    expect(stubs.mintInstallationToken).toHaveBeenLastCalledWith(42, expect.anything(), {
      repository: 'r',
      permissions: DELIVER_SCOPE,
    });
  });

  it('falls back to the request token, then to anonymous with an install hint', async () => {
    configureApp({ appId: 77, slug: 'agentproof-s' });
    stubs.findInstallation.mockResolvedValue(undefined);
    const withToken = await resolveGitHubCredential(repoUrl, 'deliver', 'ghp_request');
    expect(withToken.kind).toBe('token');
    expect(withToken.token).toBe('ghp_request');
    expect(stubs.mintInstallationToken).not.toHaveBeenCalled();
    const anonymous = await resolveGitHubCredential(repoUrl, 'read');
    expect(anonymous.kind).toBe('none');
    expect(anonymous.token).toBeUndefined();
    expect(anonymous.note).toContain('installations/new');
  });

  it('degrades to the request token when GitHub cannot be reached', async () => {
    configureApp({ appId: 77 });
    stubs.findInstallation.mockRejectedValue(
      new Error('GitHub GET /repos/o/r/installation failed with 500'),
    );
    const result = await resolveGitHubCredential(repoUrl, 'read', 'ghp_request');
    expect(result.kind).toBe('token');
    expect(result.note).toContain('could not be used');
  });

  it('uses no app when none is configured', async () => {
    const result = await resolveGitHubCredential(repoUrl, 'read');
    expect(result).toEqual({
      kind: 'none',
      note: expect.stringContaining('no GitHub App configured'),
    });
    expect(stubs.findInstallation).not.toHaveBeenCalled();
  });
});
