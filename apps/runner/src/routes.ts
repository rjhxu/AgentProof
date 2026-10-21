import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import {
  MissionDerivationError,
  STORE_ADDRESS_HELP,
  allowedHosts,
  deriveMissionFromStore,
  generateMission,
  hostIsAllowed,
  isHttpUrl,
  scenarioMission,
} from '@agentproof/agent';
import { diagnose } from '@agentproof/diagnostics';
import { compareRuns } from '@agentproof/verifier';
import {
  AgentConfig,
  CreateMissionRequest,
  FixtureMissionRequest,
  StartRunsRequest,
  type Run,
  type RunStatus,
  newId,
  nowIso,
} from '@agentproof/shared';
import { config } from './config';
import * as db from './db';
import { subscribe } from './events';
import { enqueue } from './jobs';
import { hoodieMission } from '@agentproof/shared/fixtures';
import { diagnoseGamma, proposeGammaRepair, applyGammaRepair } from './gamma-demo';
import { registerRepositoryRoutes } from './repository-routes';
import { registerCodeFixRoutes } from './codefix-routes';
import { registerGitHubAppRoutes } from './github-app-routes';
import {
  agentSummaryFor,
  currentMissionReport,
  missionReportExists,
  missionReportRelativePath,
  readRunReport,
  readRunReportMarkdown,
} from './reports';

const MARKDOWN = 'text/markdown; charset=utf-8';

const TERMINAL_STATUSES: ReadonlySet<RunStatus> = new Set([
  'passed',
  'failed',
  'error',
  'cancelled',
]);

/** A run in this status will publish no further events. */
export function isTerminalStatus(status: RunStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

/**
 * HTTP status of a thrown error. Fastify, its plugins and the http-errors that @fastify/static
 * forwards carry it on `statusCode`; anything else is a 500. `status` is never read: an LlmError
 * carries the provider's HTTP status there, and a provider's 429 or 529 is not this runner's answer.
 */
export function errorStatus(err: unknown): number {
  if (typeof err === 'object' && err !== null) {
    const value = (err as { statusCode?: unknown }).statusCode;
    if (typeof value === 'number' && Number.isInteger(value) && value >= 400 && value < 600)
      return value;
  }
  return 500;
}

/**
 * JSON error replies that keep the error's own status, so a 4xx raised by a plugin or by
 * validation stays a 4xx instead of becoming a 500. For the root app (server.ts) and the test app,
 * and it must run before registerRoutes(): Fastify binds each route to the error handler in force
 * when the route's registration settles (its after() tick), so a handler set later never reaches
 * the routes already registered.
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err: unknown, _req, reply) => {
    const status = errorStatus(err);
    if (status >= 500) app.log.error(err);
    else app.log.warn(err);
    const message = err instanceof Error ? err.message : String(err);
    reply.code(status).send({ error: message });
  });
}

/** `?refresh=1` or `?refresh=true` */
function wantsRefresh(query: unknown): boolean {
  const refresh = (query as { refresh?: unknown } | undefined)?.refresh;
  return refresh === '1' || refresh === 'true' || refresh === '';
}

/**
 * HTTP surface. Contract lives in packages/shared/src/api.ts; keep them in sync.
 */
export async function registerRoutes(app: FastifyInstance): Promise<void> {
  await registerRepositoryRoutes(app);
  await registerCodeFixRoutes(app);
  await registerGitHubAppRoutes(app);
  app.get('/health', async () => ({ ok: true, at: nowIso() }));

  // Fixed local mission: no model call or API key needed for the Gamma milestone.
  app.post('/demo/hoodie', async () => {
    const mission = {
      ...hoodieMission,
      id: newId('mis'),
      createdAt: nowIso(),
      storeUrl: config.storeUrl,
    };
    db.saveMission(mission);
    return { mission };
  });

  // ---- missions ---------------------------------------------------------------
  // With a prompt the model structures it; without one the mission is derived from the store's
  // own product feed with no model call (packages/agent/src/mission-derive.ts). Either way the
  // store address is checked first: an http(s) URL on a host this runner may visit.
  app.post('/missions', async (req, reply) => {
    const body = CreateMissionRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.message });
    const { storeUrl, prompt } = body.data;
    if (!isHttpUrl(storeUrl)) return reply.code(400).send({ error: STORE_ADDRESS_HELP });
    if (!hostIsAllowed(storeUrl)) {
      return reply.code(400).send({
        error: `Only these store hosts are allowed on this runner: ${allowedHosts().join(', ')}.`,
      });
    }
    try {
      const mission =
        prompt === undefined
          ? await deriveMissionFromStore(storeUrl)
          : await generateMission(storeUrl, prompt);
      db.saveMission(mission);
      return { mission };
    } catch (err) {
      if (err instanceof MissionDerivationError)
        return reply.code(err.statusCode).send({ error: err.message });
      throw err;
    }
  });

  // One of the storefront's known scenarios (A-E, control), no model call.
  app.post('/missions/fixture', async (req, reply) => {
    const body = FixtureMissionRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.message });
    const mission = scenarioMission(body.data.bug, body.data.storeUrl ?? config.storeUrl);
    db.saveMission(mission);
    return { mission };
  });

  app.get<{ Params: { id: string } }>('/missions/:id', async (req, reply) => {
    const mission = db.getMission(req.params.id);
    if (!mission) return reply.code(404).send({ error: 'mission not found' });
    return {
      mission,
      runs: db.listRuns(mission.id),
      // Artifacts-relative path of the cross-agent report once any run has finished.
      ...(missionReportExists(mission.id)
        ? { missionReportPath: missionReportRelativePath(mission.id) }
        : {}),
    };
  });

  app.post<{ Params: { id: string } }>('/missions/:id/runs', async (req, reply) => {
    const mission = db.getMission(req.params.id);
    if (!mission) return reply.code(404).send({ error: 'mission not found' });
    const body = StartRunsRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.message });

    const runs: Run[] = body.data.agents.map((kind) => {
      const agent = AgentConfig.parse({ kind });
      return {
        id: newId('run'),
        missionId: mission.id,
        agent,
        // The lane label before any report exists: name, senses, the model it will run on.
        agentSummary: agentSummaryFor(agent),
        status: 'queued',
        label: 'original',
        createdAt: nowIso(),
        steps: [],
        evidence: [],
      };
    });
    for (const run of runs) {
      db.saveRun(run);
      enqueue(run.id);
    }
    return { runs };
  });

  // Cross-agent mission report: the file written when the last run finished, rebuilt only when a
  // run has finished since or with ?refresh=1, so a read never rewrites it.
  app.get<{ Params: { id: string }; Querystring: { refresh?: string } }>(
    '/missions/:id/report',
    async (req, reply) => {
      if (!db.getMission(req.params.id))
        return reply.code(404).send({ error: 'mission not found' });
      const result = await currentMissionReport(req.params.id, {
        refresh: wantsRefresh(req.query),
      });
      if (!result) return reply.code(404).send({ error: 'no finished runs for this mission yet' });
      return { report: result.report };
    },
  );

  app.get<{ Params: { id: string }; Querystring: { refresh?: string } }>(
    '/missions/:id/report.md',
    async (req, reply) => {
      if (!db.getMission(req.params.id))
        return reply.code(404).send({ error: 'mission not found' });
      const result = await currentMissionReport(req.params.id, {
        refresh: wantsRefresh(req.query),
      });
      if (!result) return reply.code(404).send({ error: 'no finished runs for this mission yet' });
      return reply.type(MARKDOWN).send(fs.readFileSync(result.mdPath, 'utf8'));
    },
  );

  // ---- runs -------------------------------------------------------------------
  app.get('/runs', async () => ({ runs: db.listRuns() }));

  app.get<{ Params: { id: string } }>('/runs/:id', async (req, reply) => {
    const run = db.getRun(req.params.id);
    if (!run) return reply.code(404).send({ error: 'run not found' });
    return { run, issues: db.listIssues(run.id), repairs: db.listRepairsForRun(run.id) };
  });

  // The agent's report, written by jobs.ts once the run has a verdict.
  app.get<{ Params: { id: string } }>('/runs/:id/report', async (req, reply) => {
    const run = db.getRun(req.params.id);
    if (!run) return reply.code(404).send({ error: 'run not found' });
    const report = readRunReport(run);
    if (!report) return reply.code(404).send({ error: 'report not ready' });
    return { report };
  });

  app.get<{ Params: { id: string } }>('/runs/:id/report.md', async (req, reply) => {
    const run = db.getRun(req.params.id);
    if (!run) return reply.code(404).send({ error: 'run not found' });
    const markdown = readRunReportMarkdown(run);
    if (markdown === undefined) return reply.code(404).send({ error: 'report not ready' });
    return reply.type(MARKDOWN).send(markdown);
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

    // A finished run publishes nothing more; close instead of holding the connection open.
    if (isTerminalStatus(run.status)) {
      reply.raw.end();
      return reply;
    }

    const unsubscribe = subscribe(run.id, (event) => {
      send(event);
      if (event.type === 'status' && isTerminalStatus(event.status)) {
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
      agentSummary: agentSummaryFor(original.agent),
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

  // ---- artifacts ---------------------------------------------------
  // Screenshots, aria snapshots, traces and both report kinds, by their artifacts-relative path:
  // GET /artifacts/<runId>/step-001.png, GET /artifacts/missions/<missionId>/report.md.
  fs.mkdirSync(config.artifactsDir, { recursive: true }); // the plugin requires an existing root
  await app.register(async (artifacts) => {
    // @fastify/static refuses `..` segments and directory reads with a 403 and null bytes with a
    // 400. Error handlers are encapsulated per plugin scope, so this one keeps those statuses
    // (403 becomes 404: a probe learns nothing about what exists) whatever handler the root app
    // installs afterwards. Nothing here ever reads outside the artifacts dir; this is about
    // answering refusals with their status instead of a 500.
    artifacts.setErrorHandler((err: unknown, _req, reply) => {
      const status = errorStatus(err);
      if (status === 403 || status === 404) return reply.code(404).send({ error: 'not found' });
      if (status >= 500) artifacts.log.error(err);
      return reply.code(status).send({ error: err instanceof Error ? err.message : String(err) });
    });
    await artifacts.register(fastifyStatic, {
      root: config.artifactsDir,
      prefix: '/artifacts/',
      decorateReply: false,
      index: false,
      dotfiles: 'ignore', // .gitkeep and any other dotfile under data/artifacts stay private
    });
  });
}
