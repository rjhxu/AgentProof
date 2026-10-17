import { z } from 'zod';
import { AgentAction, AgentConfig } from './agent';
import { Checkpoint } from './checkpoint';
import { Evidence, ObservedCart } from './evidence';

export const RunStatus = z.enum([
  'queued',
  'running',
  'verifying',
  'passed', // every checkpoint up to the success milestone passed
  'failed', // at least one checkpoint failed
  'error', // runner/infra error, not a store or agent verdict
  'cancelled',
]);
export type RunStatus = z.infer<typeof RunStatus>;

/** One iteration of the observe -> decide -> act loop. */
export const RunStep = z.object({
  index: z.number().int().nonnegative(),
  at: z.string(),
  url: z.string().optional(),
  /** The action the agent proposed (already validated against policy) */
  action: AgentAction.optional(),
  /** What happened when the runner executed it */
  outcome: z.enum(['ok', 'rejected_by_policy', 'error']).default('ok'),
  outcomeDetail: z.string().optional(),
  screenshotEvidenceId: z.string().optional(),
  durationMs: z.number().int().nonnegative().optional(),
});
export type RunStep = z.infer<typeof RunStep>;

export const VerificationResult = z.object({
  checkpoints: z.array(Checkpoint),
  observedCart: ObservedCart.optional(),
  /** First failed checkpoint, if any. Drives the headline in the UI. */
  firstFailure: Checkpoint.optional(),
  verifiedAt: z.string(),
});
export type VerificationResult = z.infer<typeof VerificationResult>;

export const Run = z.object({
  id: z.string(),
  missionId: z.string(),
  agent: AgentConfig,
  status: RunStatus,
  /** "original" for the first attempt, "rematch" for re-runs after a repair */
  label: z.enum(['original', 'rematch']).default('original'),
  /** For a rematch, the run it is being compared against */
  parentRunId: z.string().optional(),
  createdAt: z.string(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  steps: z.array(RunStep).default([]),
  evidence: z.array(Evidence).default([]),
  verification: VerificationResult.optional(),
  /** Set when status is "error" */
  errorMessage: z.string().optional(),
});
export type Run = z.infer<typeof Run>;

/** Streamed to the dashboard via SSE or polling while a run is in progress. */
export const RunEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('status'), runId: z.string(), status: RunStatus, at: z.string() }),
  z.object({ type: z.literal('step'), runId: z.string(), step: RunStep }),
  z.object({ type: z.literal('evidence'), runId: z.string(), evidence: Evidence }),
  z.object({ type: z.literal('checkpoint'), runId: z.string(), checkpoint: Checkpoint }),
  z.object({ type: z.literal('log'), runId: z.string(), message: z.string(), at: z.string() }),
]);
export type RunEvent = z.infer<typeof RunEvent>;
