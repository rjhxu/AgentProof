import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import {
  AgentReport,
  Mission,
  MissionReport,
  type LlmUsage,
  type ObservedCart,
  type Run,
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
  };
});

import { createMockLlm, setLlmForTests } from '@agentproof/agent';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentproof-routes-'));
process.env.AGENTPROOF_DATA_DIR = dataDir;
const { config } = await import('./config');
const db = await import('./db');
const { registerRoutes } = await import('./routes');
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

async function server() {
  const app = Fastify();
  await registerRoutes(app);
  return app;
}

const narratorText = 'Stub narrative: the agent added the default size.';
function narrator() {
  return createMockLlm([{ text: narratorText, json: { narrative: narratorText } }]);
}

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
    // No directory listing (403 from @fastify/static with index off; 404 would be fine too).
    expect([403, 404]).toContain(
      (await app.inject({ url: '/artifacts/run_routes_artifact/' })).statusCode,
    );
    expect((await app.inject({ url: '/artifacts/../agentproof.db' })).statusCode).not.toBe(200);
    expect((await app.inject({ url: '/artifacts/..%2Fagentproof.db' })).statusCode).not.toBe(200);
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
    const unsubscribe = subscribe(run.id, (event) => events.push(event));
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
});
