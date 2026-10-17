import type { FastifyInstance } from 'fastify';
import { generateMission } from '@agentproof/agent';
import { diagnose } from '@agentproof/diagnostics';
import { compareRuns } from '@agentproof/verifier';
import {
  AgentConfig,
  CreateMissionRequest,
  StartRunsRequest,
  type Run,
  newId,
  nowIso,
} from '@agentproof/shared';
import * as db from './db';
import { subscribe } from './events';
import { enqueue } from './jobs';
import { hoodieMission } from '@agentproof/shared/fixtures';
import { diagnoseGamma, proposeGammaRepair, applyGammaRepair } from './gamma-demo';
import { registerRepositoryRoutes } from './repository-routes';

/**
 * HTTP surface. Contract lives in packages/shared/src/api.ts; keep them in sync.
 */
export async function registerRoutes(app: FastifyInstance): Promise<void> {
  await registerRepositoryRoutes(app);
  app.get('/health', async () => ({ ok: true, at: nowIso() }));

  // Fixed local mission: no model call or API key needed for the Gamma milestone.
  app.post('/demo/hoodie', async () => {
    const mission = {
      ...hoodieMission,
      id: newId('mis'),
      createdAt: nowIso(),
      storeUrl: `http://localhost:${Number(process.env.STOREFRONT_PORT ?? 5000)}`,
    };
    db.saveMission(mission);
    return { mission };
  });

  // ---- missions ---------------------------------------------------------------
  app.post('/missions', async (req, reply) => {
    const body = CreateMissionRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.message });
    const mission = await generateMission(body.data.storeUrl, body.data.prompt);
    db.saveMission(mission);
    return { mission };
  });

  app.get<{ Params: { id: string } }>('/missions/:id', async (req, reply) => {
    const mission = db.getMission(req.params.id);
    if (!mission) return reply.code(404).send({ error: 'mission not found' });
    return { mission, runs: db.listRuns(mission.id) };
  });

  app.post<{ Params: { id: string } }>('/missions/:id/runs', async (req, reply) => {
    const mission = db.getMission(req.params.id);
    if (!mission) return reply.code(404).send({ error: 'mission not found' });
    const body = StartRunsRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.message });

    const runs: Run[] = body.data.agents.map((kind) => ({
      id: newId('run'),
      missionId: mission.id,
      agent: AgentConfig.parse({ kind }),
      status: 'queued',
      label: 'original',
      createdAt: nowIso(),
      steps: [],
      evidence: [],
    }));
    for (const run of runs) {
      db.saveRun(run);
      enqueue(run.id);
    }
    return { runs };
  });

  // ---- runs -------------------------------------------------------------------
  app.get('/runs', async () => ({ runs: db.listRuns() }));

  app.get<{ Params: { id: string } }>('/runs/:id', async (req, reply) => {
    const run = db.getRun(req.params.id);
    if (!run) return reply.code(404).send({ error: 'run not found' });
    return { run, issues: db.listIssues(run.id), repairs: db.listRepairsForRun(run.id) };
  });

  /** Server-Sent Events: one JSON RunEvent per message until the run finishes. */
  app.get<{ Params: { id: string } }>('/runs/:id/events', async (req, reply) => {
    const run = db.getRun(req.params.id);
    if (!run) return reply.code(404).send({ error: 'run not found' });

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    const send = (data: unknown) => reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
    send({ type: 'status', runId: run.id, status: run.status, at: nowIso() });

    const unsubscribe = subscribe(run.id, (event) => {
      send(event);
      if (
        event.type === 'status' &&
        ['passed', 'failed', 'error', 'cancelled'].includes(event.status)
      ) {
        unsubscribe();
        reply.raw.end();
      }
    });
    req.raw.on('close', unsubscribe);
    return reply; // keep the connection open
  });

  app.post<{ Params: { id: string } }>('/runs/:id/rematch', async (req, reply) => {
    const original = db.getRun(req.params.id);
    if (!original) return reply.code(404).send({ error: 'run not found' });
    const run: Run = {
      id: newId('run'),
      missionId: original.missionId,
      agent: original.agent,
      status: 'queued',
      label: 'rematch',
      parentRunId: original.id,
      createdAt: nowIso(),
      steps: [],
      evidence: [],
    };
    db.saveRun(run);
    enqueue(run.id);
    return { run };
  });

  app.get<{ Params: { id: string; otherId: string } }>(
    '/runs/:id/compare/:otherId',
    async (req, reply) => {
      const a = db.getRun(req.params.id);
      const b = db.getRun(req.params.otherId);
      if (!a || !b) return reply.code(404).send({ error: 'run not found' });
      return { comparison: compareRuns(a, b) };
    },
  );

  // ---- diagnosis & repair -----------------------------------------------------
  app.post<{ Params: { id: string } }>('/runs/:id/diagnose', async (req, reply) => {
    const run = db.getRun(req.params.id);
    if (!run) return reply.code(404).send({ error: 'run not found' });
    const failure = run.verification?.firstFailure;
    if (!failure)
      return reply.code(400).send({ error: 'run has no failed checkpoint to diagnose' });
    const mission = db.getMission(run.missionId)!;
    if (run.agent.kind === 'gamma_structured') {
      const existing = db
        .listIssues(run.id)
        .find((issue) => issue.checkpointId === 'catalog_variant_resolves');
      const issue = existing ?? diagnoseGamma(run);
      db.saveIssue(issue);
      return { issue };
    }
    const evidence = run.evidence.filter((e) => failure.evidenceIds.includes(e.id));
    // TODO(vihan): pass repoFiles + sourceExcerpts from apps/storefront for better suspectedFiles.
    const issue = await diagnose({ mission, run, checkpoint: failure, evidence });
    db.saveIssue(issue);
    return { issue };
  });

  app.post<{ Params: { id: string } }>('/issues/:id/repair', async (req, reply) => {
    const issue = db.getIssue(req.params.id);
    if (!issue) return reply.code(404).send({ error: 'issue not found' });
    if (db.getRun(issue.runId)?.agent.kind !== 'gamma_structured')
      return reply.code(501).send({ error: 'Only the targeted Gamma repair is implemented.' });
    try {
      const repair = proposeGammaRepair(issue);
      db.saveRepair(repair);
      return { repair };
    } catch (error) {
      return reply.code(409).send({ error: String(error) });
    }
  });

  app.post<{ Params: { id: string } }>('/repairs/:id/apply', async (req, reply) => {
    const repair = db.getRepair(req.params.id);
    if (!repair) return reply.code(404).send({ error: 'repair not found' });
    const issue = db.getIssue(repair.issueId);
    if (!issue || db.getRun(issue.runId)?.agent.kind !== 'gamma_structured')
      return reply.code(400).send({ error: 'Unsupported repair.' });
    try {
      const applied = applyGammaRepair(repair, issue);
      db.saveRepair(applied);
      // Wait for tsx watch to load the reviewed source change before the rematch.
      let storefrontReady = false;
      const storeUrl = db.getMission(db.getRun(issue.runId)!.missionId)!.storeUrl;
      for (let attempt = 0; attempt < 30; attempt++) {
        try {
          const response = await fetch(new URL('/health', storeUrl), {
            redirect: 'error',
            signal: AbortSignal.timeout(500),
          });
          const health = (await response.json()) as { hoodieVariantId?: string };
          if (health.hoodieVariantId === 'HOODIE-001-M') {
            storefrontReady = true;
            break;
          }
        } catch {
          /* Expected while the storefront restarts. */
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      return { repair: applied, storefrontReady };
    } catch (error) {
      return reply.code(409).send({ error: String(error) });
    }
  });
}
