import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import {
  AGENT_LABELS,
  AgentConfig,
  AgentReport,
  Mission,
  MissionReport,
  Run,
  type LlmUsage,
  type ObservedCart,
  type RunEvent,
} from '@agentproof/shared';
import { alphaFailedRun, hoodieMission } from '@agentproof/shared/fixtures';

/**
 * Browser and store boundaries are stubbed; everything else (verifier, report builders, the
 * runner's own wiring) is real. No browser is launched and nothing touches the network.
 */
const stubs = vi.hoisted(() => ({
  cart: undefined as ObservedCart | undefined,
  cookies: [{ name: 'nw_session', value: 'stub-session', domain: 'localhost', path: '/' }],
}));

vi.mock('@agentproof/agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agentproof/agent')>();
  const usage: LlmUsage = {
    calls: 2,
    inputTokens: 5000,
    outputTokens: 200,
    reasoningTokens: 0,
    cachedInputTokens: 0,
    imageInputs: 0,
    estimatedCostUsd: 0.0067,
    llmLatencyMs: 3000,
  };
  return {
    ...actual,
    runBrowserAgent: vi.fn(
      async (
        mission: Mission,
        _config: unknown,
        _artifactDir: string,
        cb: {
          onStep: (s: Run['steps'][number]) => void;
          onEvidence: (e: Run['evidence'][number]) => void;
          onLog: (m: string) => void;
        },
      ) => {
        cb.onLog('stub browser agent started');
        cb.onStep({
          index: 0,
          at: new Date().toISOString(),
          url: `${mission.storeUrl}/products/black-hoodie`,
          action: { type: 'click', target: 'button:Add to cart', reason: 'Proceed with default' },
          outcome: 'ok',
          durationMs: 500,
          usage: { ...usage, calls: 1 },
        });
        return {
          outcome: 'done' as const,
          summary: 'Added the hoodie and reached checkout review',
          finalUrl: `${mission.storeUrl}/checkout`,
          visitedUrls: [mission.storeUrl, `${mission.storeUrl}/checkout`],
          cookies: stubs.cookies,
          usage,
          resolvedModel: 'grok-4.3',
          provider: 'mock',
          effort: 'low',
          stepsUsed: 1,
          durationMs: 1200,
          tracePath: undefined,
        };
      },
    ),
    fetchCartWithCookies: vi.fn(async () => stubs.cart),
    // Real by default; the Gamma test scripts it so nothing touches the network.
    runGamma: vi.fn(actual.runGamma),
    // Real: it reads the store feed through global fetch, which the POST /missions tests stub.
    deriveMissionFromStore: actual.deriveMissionFromStore,
  };
});

import { createMockLlm, runBrowserAgent, runGamma, setLlmForTests } from '@agentproof/agent';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentproof-routes-'));
process.env.AGENTPROOF_DATA_DIR = dataDir;
const { config } = await import('./config');
const db = await import('./db');
const { isTerminalStatus, registerErrorHandler, registerRoutes } = await import('./routes');
const { executeRun } = await import('./jobs');
const { subscribe } = await import('./events');
const { generateRunReport } = await import('./reports');

afterAll(() => {
  setLlmForTests(undefined);
  db.getDb().close(); // Windows refuses to remove the dir while the SQLite handle is open
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* a leftover temp dir is not a test failure */
  }
});

/** The app as server.ts assembles it: the root error handler first, then the routes. */
async function server() {
  const app = Fastify();
  registerErrorHandler(app);
  await registerRoutes(app);
  return app;
}

const narratorText = 'Stub narrative: the agent added the default size.';
function narrator() {
  return createMockLlm([{ text: narratorText, json: { narrative: narratorText } }]);
}

/** Fails loudly instead of hanging the suite when a stream never ends. */
function withinMs<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not finish within ${ms}ms`)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/** Resolves with the run's terminal status: now if it has one, else when the queue publishes it. */
function finished(runId: string): Promise<Run['status']> {
  return new Promise((resolve) => {
    const current = db.getRun(runId)?.status;
    if (current && isTerminalStatus(current)) {
      resolve(current);
      return;
    }
    const unsubscribe = subscribe(runId, (event) => {
      if (event.type === 'status' && isTerminalStatus(event.status)) {
        unsubscribe();
        resolve(event.status);
      }
    });
  });
}

/** The SSE body as the JSON events it carried. */
function sseEvents(body: string): RunEvent[] {
  return body
    .split('\n\n')
    .filter((chunk) => chunk.startsWith('data: '))
    .map((chunk) => JSON.parse(chunk.slice('data: '.length)) as RunEvent);
}

/** What a client polling GET /runs/:id saw at the moment of each published event. */
interface PolledState {
  event: RunEvent['type'];
  status: Run['status'];
  reportPath?: string;
}

function recordPolled(runId: string, events: RunEvent[], polled: PolledState[]): () => void {
  return subscribe(runId, (event) => {
    events.push(event);
    const stored = db.getRun(runId)!;
    polled.push({
      event: event.type,
      status: stored.status,
      ...(stored.reportPath ? { reportPath: stored.reportPath } : {}),
    });
  });
}

/** No poller may ever see a terminal status without the report that goes with it. */
function expectReportWithVerdict(polled: PolledState[], reportPath: string): void {
  for (const seen of polled) {
    if (seen.status === 'passed' || seen.status === 'failed' || seen.status === 'error')
      expect(seen, `${seen.event} event`).toMatchObject({ reportPath });
  }
  expect(polled.find((p) => p.event === 'report')).toMatchObject({ reportPath });
}

const STUB_USAGE: LlmUsage = {
  calls: 1,
  inputTokens: 2500,
  outputTokens: 100,
  reasoningTokens: 0,
  cachedInputTokens: 0,
  imageInputs: 0,
  estimatedCostUsd: 0.0033,
  llmLatencyMs: 1500,
};

const BUGS = ['A', 'B', 'C', 'D', 'E', 'control'] as const;

describe('POST /missions/fixture', () => {
  it('inserts every scenario as a valid Mission on the configured store', async () => {
    const app = await server();
    for (const bug of BUGS) {
      const res = await app.inject({ method: 'POST', url: '/missions/fixture', payload: { bug } });
      expect(res.statusCode).toBe(200);
      const { mission } = res.json();
      expect(Mission.safeParse(mission).success).toBe(true);
      expect(mission.storeUrl).toBe(config.storeUrl);
      expect(mission.paymentAuthorized).toBe(false);
      expect(db.getMission(mission.id)?.rawPrompt).toBe(mission.rawPrompt);
    }
    await app.close();
  });

  it('honours an explicit storeUrl and rejects unknown scenarios', async () => {
    const app = await server();
    const res = await app.inject({
      method: 'POST',
      url: '/missions/fixture',
      payload: { bug: 'A', storeUrl: 'http://localhost:5050' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().mission.storeUrl).toBe('http://localhost:5050');
    expect(
      (await app.inject({ method: 'POST', url: '/missions/fixture', payload: { bug: 'Z' } }))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/missions/fixture',
          payload: { bug: 'A', storeUrl: 'not a url' },
        })
      ).statusCode,
    ).toBe(400);
    await app.close();
  });

  it('/demo/hoodie uses the configured store URL', async () => {
    const app = await server();
    const res = await app.inject({ method: 'POST', url: '/demo/hoodie' });
    expect(res.statusCode).toBe(200);
    expect(res.json().mission.storeUrl).toBe(config.storeUrl);
    await app.close();
  });
});

describe('POST /missions', () => {
  // The Northwind feed as the store serves it, cut to the hoodie: what the stubbed fetch returns.
  const catalog = {
    store: 'Northwind Threads',
    currency: 'USD',
    products: [
      {
        id: 'HOODIE-001',
        slug: 'black-hoodie',
        name: 'Black Hoodie',
        category: 'apparel',
        basePrice: 49,
        url: '/products/black-hoodie',
        image: '/images/black-hoodie.jpeg',
        variants: [
          {
            id: 'HOODIE-001-S',
            attributes: { color: 'black', size: 'S' },
            price: 49,
            inStock: true,
          },
          {
            id: 'HOODIE-001-M',
            attributes: { color: 'black', size: 'M' },
            price: 49,
            inStock: true,
          },
          {
            id: 'HOODIE-001-L',
            attributes: { color: 'black', size: 'L' },
            price: 49,
            inStock: true,
          },
        ],
      },
    ],
  };
  type FetchArgs = [input: string | URL | Request, init?: RequestInit];
  const neverFetch = () =>
    vi.fn(async (..._args: FetchArgs): Promise<Response> => {
      throw new Error('fetch must not be called');
    });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('derives the mission from the store feed when no prompt is given, with no model call', async () => {
    const fetchStub = vi.fn(async (..._args: FetchArgs) => Response.json(catalog));
    vi.stubGlobal('fetch', fetchStub);
    const app = await server();
    const res = await app.inject({
      method: 'POST',
      url: '/missions',
      payload: { storeUrl: config.storeUrl },
    });
    expect(res.statusCode).toBe(200);
    const mission = Mission.parse(res.json().mission);
    expect(mission.storeUrl).toBe(config.storeUrl);
    expect(mission.requirements.attributes.size).toBe('M');
    expect(mission.rawPrompt).toContain('Black Hoodie');
    expect(mission.paymentAuthorized).toBe(false);
    expect(db.getMission(mission.id)?.rawPrompt).toBe(mission.rawPrompt);
    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(String(fetchStub.mock.calls[0]?.[0])).toBe(
      `${new URL(config.storeUrl).origin}/api/catalog.json`,
    );
    await app.close();
  });

  it('answers 422 when the store publishes no readable feed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (..._args: FetchArgs): Promise<Response> => {
        throw new TypeError('fetch failed');
      }),
    );
    const app = await server();
    const res = await app.inject({
      method: 'POST',
      url: '/missions',
      payload: { storeUrl: config.storeUrl },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toContain('No product feed');
    expect(res.json().error).toContain('/api/catalog.json');
    await app.close();
  });

  it('refuses a store host outside the allowlist before any feed or model call, with or without a prompt', async () => {
    vi.stubEnv('AGENTPROOF_ALLOWED_HOSTS', 'localhost,127.0.0.1');
    const fetchStub = neverFetch();
    vi.stubGlobal('fetch', fetchStub);
    const app = await server();
    for (const payload of [
      { storeUrl: 'https://shop.example.com' },
      { storeUrl: 'https://shop.example.com', prompt: 'Find a black hoodie in medium.' },
    ]) {
      const res = await app.inject({ method: 'POST', url: '/missions', payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(res.json().error).toContain('allowed');
      expect(res.json().error).toContain('localhost, 127.0.0.1');
    }
    expect(fetchStub).not.toHaveBeenCalled();
    await app.close();
  });

  it('refuses a store address without an http(s) scheme', async () => {
    const fetchStub = neverFetch();
    vi.stubGlobal('fetch', fetchStub);
    const app = await server();
    for (const storeUrl of ['localhost:5000', 'ftp://localhost:5000']) {
      const res = await app.inject({ method: 'POST', url: '/missions', payload: { storeUrl } });
      expect(res.statusCode, storeUrl).toBe(400);
      expect(res.json().error).toContain('http://');
    }
    expect(
      (await app.inject({ method: 'POST', url: '/missions', payload: { storeUrl: 'not a url' } }))
        .statusCode,
    ).toBe(400);
    expect(fetchStub).not.toHaveBeenCalled();
    await app.close();
  });
});

describe('POST /missions/:id/runs', () => {
  it('labels every new run with its agent profile the moment it is created', async () => {
    setLlmForTests(narrator());
    // The queue starts the runs at once; Gamma is scripted so nothing touches the network.
    vi.mocked(runGamma).mockImplementationOnce(async () => ({
      checkpoints: [
        {
          id: 'product_discovered',
          status: 'failed',
          detail: 'No in-stock catalog variant satisfies the mission and budget.',
          evidenceIds: [],
        },
      ],
      notes: ['No cart mutation attempted.'],
    }));
    const app = await server();
    const mission = Mission.parse(
      (
        await app.inject({ method: 'POST', url: '/missions/fixture', payload: { bug: 'control' } })
      ).json().mission,
    );
    const kinds = ['alpha_semantic', 'beta_vision', 'gamma_structured', 'sigma_hybrid'] as const;
    const res = await app.inject({
      method: 'POST',
      url: `/missions/${mission.id}/runs`,
      payload: { agents: kinds },
    });
    expect(res.statusCode).toBe(200);
    const runs = (res.json().runs as unknown[]).map((run) => Run.parse(run));
    expect(runs.map((run) => run.agent.kind)).toEqual([...kinds]);
    for (const run of runs) {
      const summary = run.agentSummary;
      expect(summary, run.agent.kind).toBeDefined();
      expect(summary?.kind).toBe(run.agent.kind);
      expect(summary?.name).toBe(AGENT_LABELS[run.agent.kind].name);
      expect(summary?.model).toBeTruthy();
      expect(summary?.provider).toBeTruthy();
      expect(db.getRun(run.id)?.agentSummary).toEqual(summary);
    }
    const summaryOf = (kind: Run['agent']['kind']) =>
      runs.find((run) => run.agent.kind === kind)?.agentSummary;
    expect(summaryOf('gamma_structured')).toMatchObject({
      model: 'none',
      provider: 'none',
      targetGrammars: [],
    });
    expect(summaryOf('alpha_semantic')).toMatchObject({
      targetGrammars: ['role:name'],
      effort: 'low',
    });
    expect(summaryOf('alpha_semantic')?.model).not.toBe('none');
    expect(summaryOf('beta_vision')).toMatchObject({ targetGrammars: ['x,y'] });
    expect(summaryOf('sigma_hybrid')).toMatchObject({ targetGrammars: ['role:name', 'x,y'] });
    // Let the queued runs finish so nothing outlives this test.
    await withinMs(Promise.all(runs.map((run) => finished(run.id))), 20_000, 'the four runs');
    await app.close();
  });
});

describe('run reports over HTTP', () => {
  it('404s until the report exists, then serves JSON and Markdown', async () => {
    const app = await server();
    const mission = { ...structuredClone(hoodieMission), id: 'mis_routes_run' };
    db.saveMission(mission);
    const run: Run = {
      ...structuredClone(alphaFailedRun),
      id: 'run_routes_alpha',
      missionId: mission.id,
    };
    db.saveRun(run);

    expect((await app.inject({ url: '/runs/run_missing/report' })).statusCode).toBe(404);
    let res = await app.inject({ url: `/runs/${run.id}/report` });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'report not ready' });
    expect((await app.inject({ url: `/runs/${run.id}/report.md` })).statusCode).toBe(404);

    const { relativeJsonPath } = await generateRunReport(run, mission, {
      narrativeLlm: narrator(),
    });
    db.saveRun({ ...run, reportPath: relativeJsonPath });

    res = await app.inject({ url: `/runs/${run.id}/report` });
    expect(res.statusCode).toBe(200);
    const parsed = AgentReport.safeParse(res.json().report);
    expect(parsed.success).toBe(true);
    expect(parsed.data?.runId).toBe(run.id);

    res = await app.inject({ url: `/runs/${run.id}/report.md` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/markdown');
    expect(res.body).toContain('Agent Alpha');
    await app.close();
  });
});

describe('GET /artifacts/*', () => {
  it('serves files under the artifacts dir and nothing else', async () => {
    const app = await server();
    const dir = path.join(config.artifactsDir, 'run_routes_artifact');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'step-000.png'), 'png-bytes');
    fs.writeFileSync(path.join(dir, 'step-000.aria.txt'), '- button "Add to cart"');

    let res = await app.inject({ url: '/artifacts/run_routes_artifact/step-000.png' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('image/png');
    expect(res.body).toBe('png-bytes');

    res = await app.inject({ url: '/artifacts/run_routes_artifact/step-000.aria.txt' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Add to cart');

    expect(
      (await app.inject({ url: '/artifacts/run_routes_artifact/missing.png' })).statusCode,
    ).toBe(404);
    // Directory reads and `..` segments are refused by @fastify/static with a 403; they answer
    // 404 so a probe learns nothing. Dotfiles are not served. Null bytes are a 400. Never a 500.
    fs.writeFileSync(path.join(config.artifactsDir, '.gitkeep'), '');
    for (const url of [
      '/artifacts/',
      '/artifacts/run_routes_artifact/',
      '/artifacts/../agentproof.db',
      '/artifacts/..%2Fagentproof.db',
      '/artifacts/%2e%2e%2fagentproof.db',
      '/artifacts/..%5Cagentproof.db',
      '/artifacts/missions/../../agentproof.db',
      '/artifacts/.gitkeep',
    ]) {
      const res = await app.inject({ url });
      expect(res.statusCode, url).toBe(404);
    }
    expect((await app.inject({ url: '/artifacts/%00' })).statusCode).toBe(400);
    await app.close();
  });

  it('keeps those statuses under a root error handler that turns every error into a 500', async () => {
    // server.ts used to install exactly this handler after registerRoutes; the artifacts scope
    // carries its own, so the refusals above stayed 403/400 in substance but surfaced as 500s.
    const app = Fastify();
    await registerRoutes(app);
    app.setErrorHandler((err: unknown, _req, reply) => {
      reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    });
    const dir = path.join(config.artifactsDir, 'run_routes_scope');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'report.md'), '# ok');
    expect((await app.inject({ url: '/artifacts/run_routes_scope/report.md' })).statusCode).toBe(
      200,
    );
    expect((await app.inject({ url: '/artifacts/run_routes_scope/' })).statusCode).toBe(404);
    expect((await app.inject({ url: '/artifacts/..%2Fagentproof.db' })).statusCode).toBe(404);
    expect((await app.inject({ url: '/artifacts/%00' })).statusCode).toBe(400);
    await app.close();
  });
});

describe('registerErrorHandler', () => {
  it('answers with the status the error carries and 500 otherwise', async () => {
    const app = Fastify();
    registerErrorHandler(app);
    app.get('/teapot', async () => {
      throw Object.assign(new Error('short and stout'), { statusCode: 418 });
    });
    app.get('/boom', async () => {
      throw new Error('boom');
    });
    // A provider's HTTP status rides on `status` (LlmError); it is not this runner's answer.
    app.get('/upstream', async () => {
      throw Object.assign(new Error('rate limited upstream'), { status: 429 });
    });
    const teapot = await app.inject({ url: '/teapot' });
    expect(teapot.statusCode).toBe(418);
    expect(teapot.json()).toEqual({ error: 'short and stout' });
    expect((await app.inject({ url: '/boom' })).statusCode).toBe(500);
    expect((await app.inject({ url: '/upstream' })).statusCode).toBe(500);
    await app.close();
  });
});

describe('GET /runs/:id/events', () => {
  it('sends the current status and closes at once when the run has already finished', async () => {
    const app = await server();
    const mission = { ...structuredClone(hoodieMission), id: 'mis_routes_sse' };
    db.saveMission(mission);
    const run: Run = {
      ...structuredClone(alphaFailedRun),
      id: 'run_routes_sse_finished',
      missionId: mission.id,
    };
    db.saveRun(run);
    const res = await withinMs(app.inject({ url: `/runs/${run.id}/events` }), 3000, 'event stream');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(sseEvents(res.body)).toEqual([
      expect.objectContaining({ type: 'status', runId: run.id, status: run.status }),
    ]);
    await app.close();
  });
});

describe('a browser run end to end (stubbed agent and store)', () => {
  it('verifies through the cart, writes the report before the terminal status, and builds the mission report', async () => {
    setLlmForTests(narrator());
    stubs.cart = {
      items: [
        {
          productId: 'HOODIE-001',
          variantId: 'HOODIE-001-S',
          name: 'Black Hoodie',
          attributes: { color: 'black', size: 'S' },
          unitPrice: 49,
          quantity: 1,
        },
      ],
      subtotal: 49,
      currency: 'USD',
      source: 'api',
    };
    const app = await server();
    const mission = Mission.parse(
      (await app.inject({ method: 'POST', url: '/missions/fixture', payload: { bug: 'A' } })).json()
        .mission,
    );
    const run: Run = {
      id: 'run_routes_e2e_alpha',
      missionId: mission.id,
      agent: { kind: 'alpha_semantic', viewport: { width: 1280, height: 800 }, headed: false },
      status: 'queued',
      label: 'original',
      createdAt: new Date().toISOString(),
      steps: [],
      evidence: [],
    };
    db.saveRun(run);
    const events: RunEvent[] = [];
    const polled: PolledState[] = [];
    const unsubscribe = recordPolled(run.id, events, polled);
    await executeRun(run.id);
    unsubscribe();

    const finished = db.getRun(run.id)!;
    expect(finished.status).toBe('failed');
    expect(finished.claim).toMatchObject({
      outcome: 'done',
      finalUrl: `${mission.storeUrl}/checkout`,
    });
    expect(finished.resolvedModel).toBe('grok-4.3');
    expect(finished.steps).toHaveLength(1);
    expect(finished.evidence.some((e) => e.kind === 'cart_state')).toBe(true);
    expect(finished.verification?.observedCart?.items[0]?.attributes.size).toBe('S');
    expect(
      finished.verification?.checkpoints.find((c) => c.id === 'cart_matches_variant')?.status,
    ).toBe('failed');
    expect(finished.reportPath).toBe(`${run.id}/report.json`);
    // Run.usage = the agent's calls plus the narrator's.
    expect(finished.usage?.calls).toBe(3);

    const statuses = events.filter((e) => e.type === 'status').map((e) => e.status);
    expect(statuses).toEqual(['running', 'verifying', 'failed']);
    const reportIndex = events.findIndex((e) => e.type === 'report');
    const terminalIndex = events.findIndex((e) => e.type === 'status' && e.status === 'failed');
    expect(reportIndex).toBeGreaterThan(-1);
    expect(reportIndex).toBeLessThan(terminalIndex);
    expect(events.some((e) => e.type === 'checkpoint')).toBe(true);
    expect(events.some((e) => e.type === 'evidence' && e.evidence.kind === 'cart_state')).toBe(
      true,
    );
    // The verdict and the report path are one write: a poller sees 'verifying' (with the
    // checkpoints) while the narrator runs, never a verdict without a report.
    expectReportWithVerdict(polled, `${run.id}/report.json`);
    expect(polled.filter((p) => p.event === 'checkpoint').map((p) => p.status)).toEqual(
      polled.filter((p) => p.event === 'checkpoint').map(() => 'verifying'),
    );
    expect(polled.find((p) => p.event === 'report')?.status).toBe('failed');

    let res = await app.inject({ url: `/runs/${run.id}/report` });
    expect(res.statusCode).toBe(200);
    expect(AgentReport.safeParse(res.json().report).success).toBe(true);
    expect(res.json().report.narrative).toContain('Stub narrative');

    res = await app.inject({ url: `/missions/${mission.id}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().missionReportPath).toBe(`missions/${mission.id}/report.json`);
    expect(res.json().runs).toHaveLength(1);

    res = await app.inject({ url: `/missions/${mission.id}/report` });
    expect(res.statusCode).toBe(200);
    const report = MissionReport.safeParse(res.json().report);
    expect(report.success).toBe(true);
    expect(report.data?.runs[0]).toMatchObject({
      runId: run.id,
      status: 'failed',
      model: 'grok-4.3',
    });
    // Reads serve the file finishRun wrote: the same id again, the same id as the artifact.
    // ?refresh=1 rebuilds, and the artifact follows.
    const reportId = report.data!.id;
    expect((await app.inject({ url: `/missions/${mission.id}/report` })).json().report.id).toBe(
      reportId,
    );
    res = await app.inject({ url: `/artifacts/missions/${mission.id}/report.json` });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(reportId);
    res = await app.inject({ url: `/missions/${mission.id}/report?refresh=1` });
    expect(res.statusCode).toBe(200);
    const refreshedId: string = res.json().report.id;
    expect(refreshedId).not.toBe(reportId);
    expect(
      (await app.inject({ url: `/artifacts/missions/${mission.id}/report.json` })).json().id,
    ).toBe(refreshedId);
    expect((await app.inject({ url: `/missions/${mission.id}/report` })).json().report.id).toBe(
      refreshedId,
    );

    res = await app.inject({ url: `/missions/${mission.id}/report.md` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/markdown');
    expect(res.body).toContain('Mission report');
    expect(
      (await app.inject({ url: `/artifacts/missions/${mission.id}/report.md` })).statusCode,
    ).toBe(200);

    expect((await app.inject({ url: '/missions/mis_missing/report' })).statusCode).toBe(404);
    const idle = Mission.parse(
      (
        await app.inject({ method: 'POST', url: '/missions/fixture', payload: { bug: 'control' } })
      ).json().mission,
    );
    res = await app.inject({ url: `/missions/${idle.id}/report` });
    expect(res.statusCode).toBe(404);
    expect(
      (await app.inject({ url: `/missions/${idle.id}` })).json().missionReportPath,
    ).toBeUndefined();
    await app.close();
  });

  it('writes a report for a run whose browser session ends in an error, before the terminal status', async () => {
    setLlmForTests(narrator());
    vi.mocked(runBrowserAgent).mockImplementationOnce(async (mission, _config, _dir, cb) => {
      cb.onStep({
        index: 0,
        at: new Date().toISOString(),
        url: `${mission.storeUrl}/products/black-hoodie`,
        action: { type: 'click', target: 'button:Add to cart', reason: 'Proceed with default' },
        outcome: 'error',
        outcomeDetail: 'Target page, context or browser has been closed',
        durationMs: 50,
        usage: STUB_USAGE,
      });
      return {
        outcome: 'error' as const,
        summary: 'Browser session crashed after step 0',
        visitedUrls: [mission.storeUrl],
        cookies: [],
        usage: STUB_USAGE,
        resolvedModel: 'grok-4.3',
        provider: 'mock',
        effort: 'low' as const,
        stepsUsed: 1,
        durationMs: 300,
      };
    });
    const app = await server();
    const mission = Mission.parse(
      (await app.inject({ method: 'POST', url: '/missions/fixture', payload: { bug: 'A' } })).json()
        .mission,
    );
    const run: Run = {
      id: 'run_routes_e2e_error',
      missionId: mission.id,
      agent: { kind: 'alpha_semantic', viewport: { width: 1280, height: 800 }, headed: false },
      status: 'queued',
      label: 'original',
      createdAt: new Date().toISOString(),
      steps: [],
      evidence: [],
    };
    db.saveRun(run);
    const events: RunEvent[] = [];
    const polled: PolledState[] = [];
    const unsubscribe = recordPolled(run.id, events, polled);
    await executeRun(run.id);
    unsubscribe();

    const finished = db.getRun(run.id)!;
    expect(finished.status).toBe('error');
    expect(finished.errorMessage).toBe('Browser session crashed after step 0');
    expect(finished.claim?.outcome).toBe('error');
    expect(finished.verification).toBeUndefined();
    expect(finished.reportPath).toBe(`${run.id}/report.json`);
    expect(finished.usage?.calls).toBe(STUB_USAGE.calls + 1); // the agent's call plus the narrator's
    expectReportWithVerdict(polled, `${run.id}/report.json`);
    const statuses = events.filter((e) => e.type === 'status').map((e) => e.status);
    expect(statuses).toEqual(['running', 'error']);
    expect(events.findIndex((e) => e.type === 'report')).toBeLessThan(
      events.findIndex((e) => e.type === 'status' && e.status === 'error'),
    );

    const res = await app.inject({ url: `/runs/${run.id}/report` });
    expect(res.statusCode).toBe(200);
    const report = AgentReport.safeParse(res.json().report);
    expect(report.success).toBe(true);
    expect(report.data).toMatchObject({ status: 'error', checkpoints: [], runId: run.id });
    expect(report.data?.steps).toHaveLength(1);
    expect(report.data?.usage.calls).toBe(STUB_USAGE.calls + 1);
    // An error is not a verdict: the mission report still waits for a finished run.
    expect((await app.inject({ url: `/missions/${mission.id}/report` })).statusCode).toBe(404);
    await app.close();
  });

  it('runs Gamma through the same finish path, with the claim the CLI records and no model cost', async () => {
    const cart: ObservedCart = {
      items: [
        {
          productId: 'HOODIE-001',
          variantId: 'HOODIE-001-S',
          name: 'Black Hoodie',
          attributes: { color: 'black', size: 'S' },
          unitPrice: 49,
          quantity: 1,
        },
      ],
      subtotal: 49,
      currency: 'USD',
      source: 'api',
    };
    const selectedVariant = {
      id: 'HOODIE-001-M',
      attributes: { color: 'black', size: 'M' },
      price: 49,
      inStock: true,
    };
    const notes = [
      'Selected HOODIE-001-M from the live catalog.',
      'Read back the cart using this run’s session cookie.',
    ];
    vi.mocked(runGamma).mockImplementationOnce(async () => ({
      checkpoints: [
        {
          id: 'catalog_variant_resolves',
          status: 'failed',
          detail: 'Requested HOODIE-001-M; cart returned HOODIE-001-S.',
          evidenceIds: [],
        },
      ],
      cart,
      catalogRecord: {
        id: 'HOODIE-001',
        slug: 'black-hoodie',
        name: 'Black Hoodie',
        category: 'apparel',
        basePrice: 49,
        variants: [selectedVariant],
      },
      selectedVariant,
      checkoutReached: true,
      notes,
    }));
    const app = await server();
    const mission = Mission.parse(
      (await app.inject({ method: 'POST', url: '/missions/fixture', payload: { bug: 'B' } })).json()
        .mission,
    );
    const run: Run = {
      id: 'run_routes_e2e_gamma',
      missionId: mission.id,
      agent: AgentConfig.parse({ kind: 'gamma_structured' }),
      status: 'queued',
      label: 'original',
      createdAt: new Date().toISOString(),
      steps: [],
      evidence: [],
    };
    db.saveRun(run);
    const events: RunEvent[] = [];
    const polled: PolledState[] = [];
    const unsubscribe = recordPolled(run.id, events, polled);
    await executeRun(run.id);
    unsubscribe();

    const finished = db.getRun(run.id)!;
    expect(finished.status).toBe('failed');
    expect(finished.claim).toEqual({ outcome: 'done', summary: notes.join(' ') });
    expect(finished.resolvedModel).toBe('none');
    expect(finished.usage).toMatchObject({ calls: 0, estimatedCostUsd: 0 });
    expect(finished.verification?.firstFailure?.id).toBe('cart_matches_variant');
    expect(finished.evidence.map((e) => e.kind).sort()).toEqual([
      'cart_state',
      'catalog_record',
      'network',
    ]);
    expectReportWithVerdict(polled, `${run.id}/report.json`);

    const res = await app.inject({ url: `/runs/${run.id}/report` });
    expect(res.statusCode).toBe(200);
    const report = AgentReport.parse(res.json().report);
    expect(report.agent).toMatchObject({
      kind: 'gamma_structured',
      model: 'none',
      provider: 'none',
    });
    expect(report.claim).toEqual(finished.claim);
    // Gamma's narrative is deterministic and now carries the stopping claim, as the CLI's does.
    expect(report.narrative).toContain(`It stopped with done: ${notes.join(' ')}`);
    const missionReport = MissionReport.parse(
      (await app.inject({ url: `/missions/${mission.id}/report` })).json().report,
    );
    expect(missionReport.runs[0]).toMatchObject({
      agentKind: 'gamma_structured',
      claim: finished.claim,
      model: 'none',
    });
    expect(missionReport.costComparison[0]).toMatchObject({
      agentKind: 'gamma_structured',
      estimatedCostUsd: 0,
      relativeCost: 0,
    });
    await app.close();
  });
});
