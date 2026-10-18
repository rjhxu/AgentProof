import { z } from 'zod';
import { AgentAction, AgentConfig, AgentProfileSummary } from './agent';
import { Checkpoint } from './checkpoint';
import { Evidence, ObservedCart } from './evidence';
import { LlmUsage } from './usage';

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
  outcome: z.enum(['ok', 'rejected_by_policy', 'error', 'invalid_action']).default('ok'),
  outcomeDetail: z.string().optional(),
  screenshotEvidenceId: z.string().optional(),
  /** Accessibility snapshot captured for this step (Alpha, Sigma), as evidence */
  snapshotEvidenceId: z.string().optional(),
  durationMs: z.number().int().nonnegative().optional(),
  /** Model usage for the decide() call that produced this step */
  usage: LlmUsage.optional(),
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

/** What the agent itself claimed when it stopped. Never a verdict; the verifier decides. */
export const AgentClaim = z.object({
  outcome: z.enum(['done', 'fail', 'step_limit', 'error']),
  summary: z.string(),
  finalUrl: z.string().optional(),
});
export type AgentClaim = z.infer<typeof AgentClaim>;

export const Run = z.object({
  id: z.string(),
  missionId: z.string(),
  agent: AgentConfig,
  /**
   * Human-facing profile of the agent (name, senses, model), filled by the runner when the run
   * is created so a dashboard can label a lane before any report exists.
   */
  agentSummary: AgentProfileSummary.optional(),
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
  /** The agent's own stopping claim (done / fail / step_limit / error) */
  claim: AgentClaim.optional(),
  /** Model used after profile defaults and env overrides were applied */
  resolvedModel: z.string().optional(),
  /** Summed model usage for the whole run */
  usage: LlmUsage.optional(),
  /** Path of the generated report (JSON), relative to the artifacts dir */
  reportPath: z.string().optional(),
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
  z.object({
    type: z.literal('report'),
    runId: z.string(),
    reportPath: z.string(),
    at: z.string(),
  }),
]);
export type RunEvent = z.infer<typeof RunEvent>;
