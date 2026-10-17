import path from 'node:path';
import fs from 'node:fs';
import { runBrowserAgent, runGamma } from '@agentproof/agent';
import { verify, overallStatus } from '@agentproof/verifier';
import { type Mission, type Run, type RunStatus, nowIso } from '@agentproof/shared';
import { config } from './config';
import { getRun, saveRun } from './db';
import { publish } from './events';

/**
 * Minimal async job manager: a FIFO queue with a concurrency cap.
 * Good enough for the hackathon; no Redis, no workers.
 *
 * OWNER: Vihan.
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

export async function executeRun(runId: string, missionOverride?: Mission): Promise<void> {
  let run = getRun(runId);
  if (!run) throw new Error(`run ${runId} not found`);
  const mission = missionOverride ?? (await import('./db')).getMission(run.missionId);
  if (!mission) throw new Error(`mission ${run.missionId} not found`);

  const artifactDir = path.join(config.artifactsDir, run.id);
  fs.mkdirSync(artifactDir, { recursive: true });
  run = setStatus(run, 'running', { startedAt: nowIso() });

  try {
    if (run.agent.kind === 'gamma_structured') {
      const result = await runGamma(mission);
      run = setStatus(run, 'verifying');
      // TODO(vihan): merge Gamma checkpoints with verify() output, attach catalogRecord evidence.
      const verification = verify({ mission, cart: result.cart });
      verification.checkpoints.push(...result.checkpoints);
      run = setStatus(run, overallStatus(verification), { verification, finishedAt: nowIso() });
      return;
    }

    const result = await runBrowserAgent(mission, run.agent, artifactDir, {
      onStep: (step) => {
        run = { ...run!, steps: [...run!.steps, step] };
        saveRun(run);
        publish({ type: 'step', runId, step });
      },
      onEvidence: (evidence) => {
        run = { ...run!, evidence: [...run!.evidence, evidence] };
        saveRun(run);
        publish({ type: 'evidence', runId, evidence });
      },
      onLog: (message) => publish({ type: 'log', runId, message, at: nowIso() }),
    });

    if (result.outcome === 'error') {
      run = setStatus(run, 'error', { errorMessage: result.summary, finishedAt: nowIso() });
      return;
    }

    run = setStatus(run, 'verifying');
    // TODO(ryan+vihan): collect ObservedCart from the store API using the session cookies,
    // and productPage/checkoutReached from the step log, then pass them here.
    const verification = verify({ mission });
    for (const checkpoint of verification.checkpoints)
      publish({ type: 'checkpoint', runId, checkpoint });
    run = setStatus(run, overallStatus(verification), { verification, finishedAt: nowIso() });
  } catch (err) {
    setStatus(run, 'error', { errorMessage: String(err), finishedAt: nowIso() });
  }
}
