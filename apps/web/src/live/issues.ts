import { CHECKPOINT_LABELS } from '@agentproof/shared';
import type { Checkpoint, Issue, MissionReport, Run } from '@agentproof/shared';

/*
 * Which issue a run's problem card shows, and a code-written stand-in when the diagnosis is not
 * available (the model call failed, or the run has not been diagnosed yet). The stand-in carries
 * only verifier facts: the checkpoint, its detail, its evidence, and the report's attribution.
 */

/** The run's failed checkpoint: the verifier's first failure, else the first one marked failed. */
function failedCheckpoint(run: Run): Checkpoint | undefined {
  const verification = run.verification;
  if (!verification) return undefined;
  const first = verification.firstFailure;
  if (first && first.status === 'failed') return first;
  return verification.checkpoints.find((c) => c.status === 'failed');
}

/** The issue for the run's first failure, else the first issue the run has. */
export function pickIssue(run: Run, issues: Issue[]): Issue | undefined {
  const mine = issues.filter((issue) => issue.runId === run.id);
  const firstFailure = run.verification?.firstFailure?.id;
  const matching =
    firstFailure === undefined
      ? undefined
      : mine.find((issue) => issue.checkpointId === firstFailure);
  return matching ?? mine[0];
}

/**
 * A code-written issue for a failed run when no diagnosis is available. Facts only: no inferred
 * cause, no confidence, no suggested repair, so the UI has no hypothesis to label.
 */
export function fallbackIssue(run: Run, report?: MissionReport): Issue | undefined {
  if (run.status !== 'failed') return undefined;
  const checkpoint = failedCheckpoint(run);
  if (!checkpoint) return undefined;
  const attribution = report?.attributions.find(
    (a) => a.checkpointId === checkpoint.id && a.failingAgents.includes(run.agent.kind),
  );
  return {
    id: `iss_${run.id.slice(4)}`,
    runId: run.id,
    checkpointId: checkpoint.id,
    category: attribution?.category ?? 'insufficient_evidence',
    title: `${CHECKPOINT_LABELS[checkpoint.id]} failed`,
    observed: checkpoint.detail ?? 'The verifier failed this checkpoint.',
    evidenceIds: checkpoint.evidenceIds,
    suspectedFiles: [],
  };
}

/**
 * The runner's precondition for diagnose, repository connect and codefix: the run failed and a
 * checkpoint says where.
 */
export function failedWithCheckpoint(run: Run): boolean {
  return run.status === 'failed' && failedCheckpoint(run) !== undefined;
}
