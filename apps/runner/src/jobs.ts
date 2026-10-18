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

export function enqueue(runId: string): void {
  queue.push(runId);
  pump();
}

function pump(): void {
  while (active < config.maxConcurrentRuns && queue.length > 0) {
    const runId = queue.shift()!;
    active++;
    executeRun(runId)
      .catch((err) => console.error(`[jobs] run ${runId} crashed`, err))
      .finally(() => {
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

/**
 * Verdict first, then the reports (W5, Zach).
 *
 * The verdict is saved before the report is generated because the report reads run.status, but
 * the terminal status event is published after it: the SSE route closes the stream on
 * passed/failed, so clients would otherwise never see the 'report' event. Report failures are
 * logged and never change a verdict the verifier already reached. The mission report is rebuilt
 * last, once this run counts as finished.
 */
async function finishRun(
  run: Run,
  mission: Mission,
  verdict: 'passed' | 'failed',
  extra: Partial<Run>,
): Promise<Run> {
  run = { ...run, ...extra, status: verdict, finishedAt: nowIso() };
  saveRun(run);
  try {
    const { relativeJsonPath, narrativeUsage } = await generateRunReport(run, mission);
    run = {
      ...run,
      reportPath: relativeJsonPath,
      usage: addUsage(run.usage ?? EMPTY_USAGE, narrativeUsage),
    };
    saveRun(run);
    publish({ type: 'report', runId: run.id, reportPath: relativeJsonPath, at: nowIso() });
  } catch (err) {
    console.error(`[jobs] run ${run.id}: report generation failed`, err);
    publish({
      type: 'log',
      runId: run.id,
      message: `Report generation failed: ${errorMessage(err)}`,
      at: nowIso(),
    });
  }
  publish({ type: 'status', runId: run.id, status: verdict, at: nowIso() });
  try {
    await regenerateMissionReport(run.missionId);
  } catch (err) {
    console.error(`[jobs] mission ${run.missionId}: mission report regeneration failed`, err);
  }
  return run;
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
      // Gamma runs no model: "none" and a zero cost line keep it out of the cost ratio (W5).
      run = await finishRun(run, mission, overallStatus(verification), {
        verification,
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
      run = setStatus(run, 'error', {
        ...agentFields,
        errorMessage: result.summary,
        finishedAt: nowIso(),
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
