import path from 'node:path';
import fs from 'node:fs';
import { runBrowserAgent, runGamma } from '@agentproof/agent';
import { verify, overallStatus } from '@agentproof/verifier';
import { type Mission, type Run, type RunStatus, nowIso, newId } from '@agentproof/shared';
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
      const evidence = [
        ...(result.catalogRecord
          ? [
              {
                id: newId('ev'),
                runId,
                kind: 'catalog_record' as const,
                capturedAt: nowIso(),
                label: 'Live catalog and requested variant',
                data: { product: result.catalogRecord, selectedVariant: result.selectedVariant },
              },
            ]
          : []),
        ...(result.cart
          ? [
              {
                id: newId('ev'),
                runId,
                kind: 'cart_state' as const,
                capturedAt: nowIso(),
                label: 'Cart read back from the store',
                data: result.cart,
              },
            ]
          : []),
        ...(result.checkoutReached !== undefined
          ? [
              {
                id: newId('ev'),
                runId,
                kind: 'network' as const,
                capturedAt: nowIso(),
                label: 'Checkout review response',
                data: {
                  url: new URL('/checkout', mission.storeUrl).href,
                  reached: result.checkoutReached,
                },
              },
            ]
          : []),
      ];
      run = { ...run, evidence };
      saveRun(run);
      for (const entry of evidence) publish({ type: 'evidence', runId, evidence: entry });
      const verification = verify({
        mission,
        cart: result.cart,
        cartEvidenceIds: evidence.filter((e) => e.kind === 'cart_state').map((e) => e.id),
        checkoutReached:
          result.checkoutReached === undefined
            ? undefined
            : {
                reached: result.checkoutReached,
                evidenceIds: evidence.filter((e) => e.kind === 'network').map((e) => e.id),
              },
      });
      // Gamma identifies attributes in the catalog, not a product page.
      for (const checkpoint of verification.checkpoints) {
        if (
          ['product_discovered', 'correct_color_identified', 'correct_size_identified'].includes(
            checkpoint.id,
          ) &&
          result.selectedVariant
        ) {
          checkpoint.status = 'passed';
          checkpoint.detail = `Identified in live catalog: ${result.selectedVariant.id}`;
          checkpoint.evidenceIds = evidence
            .filter((e) => e.kind === 'catalog_record')
            .map((e) => e.id);
        }
      }
      for (const checkpoint of result.checkpoints) {
        checkpoint.evidenceIds = evidence.filter((e) => e.kind !== 'network').map((e) => e.id);
        const index = verification.checkpoints.findIndex((c) => c.id === checkpoint.id);
        if (index >= 0) verification.checkpoints[index] = checkpoint;
        else verification.checkpoints.push(checkpoint);
      }
      verification.firstFailure = verification.checkpoints.find((c) => c.status === 'failed');
      for (const checkpoint of verification.checkpoints)
        publish({ type: 'checkpoint', runId, checkpoint });
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
