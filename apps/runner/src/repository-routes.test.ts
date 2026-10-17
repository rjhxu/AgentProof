import { beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { alphaFailedRun } from '@agentproof/shared/fixtures';
import type { RepositoryConnection, Run } from '@agentproof/shared';

const state = vi.hoisted(() => ({
  run: undefined as Run | undefined,
  repository: undefined as RepositoryConnection | undefined,
  connect: vi.fn(),
  remove: vi.fn(),
}));
vi.mock('./db', () => ({
  getRun: (id: string) => (state.run?.id === id ? state.run : undefined),
  getRepository: () => state.repository,
  saveRepository: (repository: RepositoryConnection) => {
    state.repository = repository;
  },
  deleteRepository: () => {
    state.repository = undefined;
  },
}));
vi.mock('./repositories', async () => {
  const original = await vi.importActual<typeof import('./repositories')>('./repositories');
  return { ...original, connectRepository: state.connect, removeRepository: state.remove };
});
import { registerRepositoryRoutes } from './repository-routes';
import { RepositoryConnectionError } from './repositories';

const url = 'https://github.com/owner/shop';
const secret = 'github_pat_test123';
const metadata = {
  url,
  fullName: 'owner/shop',
  defaultBranch: 'main',
  commitSha: 'a'.repeat(40),
  connectedAt: new Date().toISOString(),
  files: ['src/cart.ts'],
  fileCount: 1,
  truncated: false,
};
const endpoint = `/runs/${alphaFailedRun.id}/repository`;

beforeEach(() => {
  state.run = { ...alphaFailedRun, agent: { ...alphaFailedRun.agent, kind: 'gamma_structured' } };
  state.repository = undefined;
  state.connect.mockReset().mockImplementation(async (_input, id) => ({ ...metadata, id }));
  state.remove.mockReset().mockResolvedValue(undefined);
});

async function server() {
  const app = Fastify();
  await registerRepositoryRoutes(app);
  return app;
}

describe('repository connection HTTP lifecycle', () => {
  it('connects to a failed run, persists metadata without a token, and disconnects', async () => {
    const app = await server();
    expect((await app.inject({ url: endpoint })).json()).toEqual({ repository: null });
    const response = await app.inject({
      method: 'POST',
      url: endpoint,
      payload: { url, token: secret, consent: true },
    });
    expect(response.statusCode).toBe(200);
    const { repository } = response.json();
    expect(repository).toMatchObject({ ...metadata, runId: state.run!.id });
    expect(response.body).not.toContain(secret);
    expect(JSON.stringify(state.repository)).not.toContain(secret);
    expect(state.connect).toHaveBeenCalledWith(
      { url, token: secret, consent: true },
      repository.id,
    );
    expect((await app.inject({ url: endpoint })).json().repository).toEqual(repository);
    expect(
      (await app.inject({ method: 'POST', url: endpoint, payload: { url, consent: true } }))
        .statusCode,
    ).toBe(409);
    expect((await app.inject({ method: 'DELETE', url: endpoint })).json()).toEqual({
      repository: null,
    });
    expect(state.remove).toHaveBeenCalledWith(repository.id);
    expect((await app.inject({ url: endpoint })).json()).toEqual({ repository: null });
    await app.close();
  });

  it('requires explicit consent and a completed failed Gamma run', async () => {
    const app = await server();
    expect((await app.inject({ method: 'POST', url: endpoint, payload: { url } })).statusCode).toBe(
      400,
    );
    state.run!.status = 'running';
    expect(
      (await app.inject({ method: 'POST', url: endpoint, payload: { url, consent: true } }))
        .statusCode,
    ).toBe(409);
    state.run!.status = 'failed';
    state.run!.agent.kind = 'alpha_semantic';
    expect(
      (await app.inject({ method: 'POST', url: endpoint, payload: { url, consent: true } }))
        .statusCode,
    ).toBe(409);
    expect(state.connect).not.toHaveBeenCalled();
    await app.close();
  });

  it('blocks other websites and network clients from accessing local repository data', async () => {
    const app = await server();
    expect(
      (await app.inject({ url: endpoint, headers: { host: 'attacker.example:4000' } })).statusCode,
    ).toBe(403);
    expect(
      (await app.inject({ url: endpoint, headers: { origin: 'https://attacker.example' } }))
        .statusCode,
    ).toBe(403);
    expect((await app.inject({ url: endpoint, remoteAddress: '10.1.2.3' })).statusCode).toBe(403);
    expect(
      (await app.inject({ url: endpoint, headers: { origin: 'http://localhost:3000' } }))
        .statusCode,
    ).toBe(200);
    await app.close();
  });

  it('returns a retryable safe authentication error without saving a connection', async () => {
    state.connect.mockRejectedValueOnce(
      new RepositoryConnectionError('Could not access the repository.', 502),
    );
    const app = await server();
    const response = await app.inject({
      method: 'POST',
      url: endpoint,
      payload: { url, token: secret, consent: true },
    });
    expect(response.statusCode).toBe(502);
    expect(response.body).not.toContain(secret);
    expect(state.repository).toBeUndefined();
    expect(
      (await app.inject({ method: 'POST', url: endpoint, payload: { url, consent: true } }))
        .statusCode,
    ).toBe(200);
    await app.close();
  });

  it('serializes connection attempts and disconnects for the same run', async () => {
    let finish!: (value: unknown) => void;
    let started!: () => void;
    const pending = new Promise<void>((resolve) => {
      started = resolve;
    });
    state.connect.mockImplementationOnce((_input, id) => {
      started();
      return new Promise((resolve) => {
        finish = () => resolve({ ...metadata, id });
      });
    });
    const app = await server();
    const first = app
      .inject({ method: 'POST', url: endpoint, payload: { url, consent: true } })
      .then((response) => response);
    await pending;
    expect(
      (await app.inject({ method: 'POST', url: endpoint, payload: { url, consent: true } }))
        .statusCode,
    ).toBe(409);
    expect((await app.inject({ method: 'DELETE', url: endpoint })).statusCode).toBe(409);
    finish(undefined);
    expect((await first).statusCode).toBe(200);
    await app.close();
  });
});
