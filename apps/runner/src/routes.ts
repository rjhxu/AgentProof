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

/**
 * HTTP surface. Contract lives in packages/shared/src/api.ts; keep them in sync.
 */
export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async () => ({ ok: true, at: nowIso() }));

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
    const evidence = run.evidence.filter((e) => failure.evidenceIds.includes(e.id));
    // TODO(vihan): pass repoFiles + sourceExcerpts from apps/storefront for better suspectedFiles.
    const issue = await diagnose({ mission, run, checkpoint: failure, evidence });
    db.saveIssue(issue);
    return { issue };
  });

  app.post<{ Params: { id: string } }>('/issues/:id/repair', async (req, reply) => {
    const issue = db.getIssue(req.params.id);
    if (!issue) return reply.code(404).send({ error: 'issue not found' });
    // TODO(vihan): proposeRepair({ issue, sources }) then db.saveRepair
    return reply.code(501).send({ error: 'repair proposal not implemented yet' });
  });

  app.post<{ Params: { id: string } }>('/repairs/:id/apply', async (req, reply) => {
    const repair = db.getRepair(req.params.id);
    if (!repair) return reply.code(404).send({ error: 'repair not found' });
    // TODO(vihan): applyRepair(repair, config.storefrontDir) then db.saveRepair({...repair, status:'applied'})
    return reply.code(501).send({ error: 'repair apply not implemented yet' });
  });
}
