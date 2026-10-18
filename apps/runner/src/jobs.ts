import path from 'node:path';
import fs from 'node:fs';
import {
  browserRunEvidenceForCart,
  fetchCartWithCookies,
  gammaVerification,
  runBrowserAgent,
  runGamma,
  verificationInputFromBrowserRun,
  type BrowserRunResult,
} from '@agentproof/agent';
import { verify, overallStatus } from '@agentproof/verifier';
import {
  EMPTY_USAGE,
  addUsage,
  type AgentClaim,
  type Mission,
  type ObservedCart,
  type Run,
  type RunStatus,
  nowIso,
} from '@agentproof/shared';
import { config } from './config';
import { getMission, getRun, saveRun } from './db';
import { publish } from './events';
import { generateRunReport, regenerateMissionReport } from './reports';

/**
 * Minimal async job manager: a FIFO queue with a concurrency cap.
 * Good enough for the hackathon; no Redis, no workers.
 *
 * OWNER: Vihan. The browser-run branch and the report step were added in W5 (Zach). The Gamma
 * branch keeps Vihan's behaviour: its evidence and verification block moved verbatim into
 * gammaVerification() in @agentproof/agent (assess.ts) so the CLI shares it, and the run now
 * finishes through finishRun() like every other agent.
 */
const queue: string[] = [];
let active = 0;
/**
 * Missions substituted for the stored one while a run executes: the code-fix agent's rematch runs
 * the same mission against an ephemeral patched store (docs/CODEFIX.md). Never persisted.
 */
const missionOverrides = new Map<string, Mission>();

export function enqueue(runId: string, missionOverride?: Mission): void {
  if (missionOverride) missionOverrides.set(runId, missionOverride);
  queue.push(runId);
  pump();
}

function pump(): void {
  while (active < config.maxConcurrentRuns && queue.length > 0) {
    const runId = queue.shift()!;
    active++;
    executeRun(runId, missionOverrides.get(runId))
      .catch((err) => console.error(`[jobs] run ${runId} crashed`, err))
      .finally(() => {
        missionOverrides.delete(runId);
        active--;
        pump();
      });
  }
}

function setStatus(run: Run, status: RunStatus, extra: Partial<Run> = {}): Run {
  const next = { ...run, ...extra, status };
  saveRun(next);
  publish({ type: 'status', runId: run.id, status, at: nowIso() });
  return next;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** How a run ends: the verifier's verdict, or 'error' when the agent's session failed before one. */
type FinalStatus = 'passed' | 'failed' | 'error';

/**
 * Report first, then the verdict (W5, Zach).
 *
 * The stored status stays as it was ('verifying') while the report is built, so a client polling
 * GET /runs/:id never sees passed/failed without a reportPath (GET /runs/:id/report would 404 in
 * that window, which lasts as long as the narrator call). Everything else the run learned
 * (verification, claim, usage) is persisted right away so pollers see the checkpoints meanwhile.
 * The verdict and the report path are then saved in one write, the 'report' event goes out, and
 * the terminal 'status' event last: the SSE route closes the stream on a terminal status, so
 * clients would otherwise never see 'report'. If the report cannot be written the verdict is
 * saved anyway; report failures never change a verdict the verifier already reached. The mission
 * report is rebuilt last, once this run counts as finished (error runs do not).
 */
async function finishRun(
  run: Run,
  mission: Mission,
  verdict: FinalStatus,
  extra: Partial<Run>,
): Promise<Run> {
  const pending: Run = { ...run, ...extra };
  saveRun(pending);
  const finished: Run = { ...pending, status: verdict, finishedAt: nowIso() };
  let saved = finished;
  try {
    const { relativeJsonPath, narrativeUsage } = await generateRunReport(finished, mission);
    saved = {
      ...finished,
      reportPath: relativeJsonPath,
      usage: addUsage(finished.usage ?? EMPTY_USAGE, narrativeUsage),
    };
    saveRun(saved);
    publish({ type: 'report', runId: run.id, reportPath: relativeJsonPath, at: nowIso() });
  } catch (err) {
    saveRun(saved);
    console.error(`[jobs] run ${run.id}: report generation failed`, err);
    publish({
      type: 'log',
      runId: run.id,
      message: `Report generation failed: ${errorMessage(err)}`,
      at: nowIso(),
    });
  }
  publish({ type: 'status', runId: run.id, status: verdict, at: nowIso() });
  if (verdict !== 'error') {
    try {
      await regenerateMissionReport(run.missionId);
    } catch (err) {
      console.error(`[jobs] mission ${run.missionId}: mission report regeneration failed`, err);
    }
  }
  return saved;
}

export async function executeRun(runId: string, missionOverride?: Mission): Promise<void> {
  const stored = getRun(runId);
  if (!stored) throw new Error(`run ${runId} not found`);
  let run: Run = stored;
  const mission = missionOverride ?? getMission(run.missionId);
  if (!mission) throw new Error(`mission ${run.missionId} not found`);

  const artifactDir = path.join(config.artifactsDir, run.id);
  fs.mkdirSync(artifactDir, { recursive: true });
  run = setStatus(run, 'running', { startedAt: nowIso() });

  try {
    if (run.agent.kind === 'gamma_structured') {
      const result = await runGamma(mission);
      run = setStatus(run, 'verifying');
      // catalog_record / cart_state / network evidence, verify() on the cart and checkout
      // observations, catalog-identified attribute checkpoints, Gamma's own checkpoints merged.
      const { verification, evidence } = gammaVerification({ mission, result, runId });
      run = { ...run, evidence };
      saveRun(run);
      for (const entry of evidence) publish({ type: 'evidence', runId, evidence: entry });
      for (const checkpoint of verification.checkpoints)
        publish({ type: 'checkpoint', runId, checkpoint });
      // The same stopping claim the CLI records for Gamma (packages/agent/src/cli.ts), so both
      // entry points produce one report. Never a verdict: the verifier decided above.
      const claim: AgentClaim = {
        outcome: 'done',
        summary: result.notes.join(' ') || 'Inspected the catalog feed and the cart API.',
      };
      // Gamma runs no model: "none" and a zero cost line keep it out of the cost ratio (W5).
      run = await finishRun(run, mission, overallStatus(verification), {
        verification,
        claim,
        resolvedModel: 'none',
        usage: { ...EMPTY_USAGE, estimatedCostUsd: 0 },
      });
      return;
    }

    // ---- browser agents: Alpha, Beta, Sigma (W5, Zach) ---------------------------------------
    // Typed structurally (assess.ts) so the post-skeleton fields of the loop's result (cookies,
    // usage, resolvedModel) are optional here and this file compiles against either form.
    const result: BrowserRunResult = await runBrowserAgent(mission, run.agent, artifactDir, {
      onStep: (step) => {
        run = { ...run, steps: [...run.steps, step] };
        saveRun(run);
        publish({ type: 'step', runId, step });
      },
      onEvidence: (evidence) => {
        run = { ...run, evidence: [...run.evidence, evidence] };
        saveRun(run);
        publish({ type: 'evidence', runId, evidence });
      },
      onLog: (message) => publish({ type: 'log', runId, message, at: nowIso() }),
    });

    // The claim is what the agent said when it stopped; the verifier decides below.
    const claim: AgentClaim = {
      outcome: result.outcome,
      summary: result.summary,
      ...(result.finalUrl ? { finalUrl: result.finalUrl } : {}),
    };
    const agentFields: Partial<Run> = {
      claim,
      ...(result.usage ? { usage: result.usage } : {}),
      ...(result.resolvedModel ? { resolvedModel: result.resolvedModel } : {}),
    };

    if (result.outcome === 'error') {
      // The browser session failed before a verdict was possible: nothing is verified, but the
      // step log, usage and narrative still become a report, so the run and what it cost are on
      // record (GET /runs/:id/report) instead of vanishing.
      run = await finishRun(run, mission, 'error', {
        ...agentFields,
        errorMessage: result.summary,
      });
      return;
    }

    run = setStatus(run, 'verifying', agentFields);

    // The cart is read through the store API with the browser session's cookies, so the verdict
    // rests on what the store holds, not on what the agent claims. A failed read is infra, not a
    // verdict: the cart checkpoints then come back not_verified and the log says why.
    let cart: ObservedCart | undefined;
    try {
      cart = await fetchCartWithCookies(mission.storeUrl, result.cookies ?? []);
      if (!cart)
        publish({
          type: 'log',
          runId,
          message:
            'The store API returned no readable cart for this session; cart checkpoints are not verified.',
          at: nowIso(),
        });
    } catch (err) {
      publish({
        type: 'log',
        runId,
        message: `Could not read the cart through the store API: ${errorMessage(err)}`,
        at: nowIso(),
      });
    }
    const cartEvidenceIds: string[] = [];
    if (cart) {
      const evidence = browserRunEvidenceForCart(runId, cart);
      run = { ...run, evidence: [...run.evidence, evidence] };
      saveRun(run);
      publish({ type: 'evidence', runId, evidence });
      cartEvidenceIds.push(evidence.id);
    }

    const verification = verify(
      verificationInputFromBrowserRun({ mission, result, cart, cartEvidenceIds }),
    );
    for (const checkpoint of verification.checkpoints)
      publish({ type: 'checkpoint', runId, checkpoint });
    run = await finishRun(run, mission, overallStatus(verification), { verification });
  } catch (err) {
    setStatus(run, 'error', { errorMessage: String(err), finishedAt: nowIso() });
  }
}
