import { z } from 'zod';
import { AgentKind } from './agent';
import { Checkpoint, CheckpointId, CheckpointStatus } from './checkpoint';
import { ObservedCart } from './evidence';
import { FailureCategory } from './issue';
import { Mission } from './mission';
import { AgentClaim, RunStatus, RunStep } from './run';
import { LlmUsage } from './usage';

/**
 * Reports are the hand-off between the agents and the (future) code-fix agent.
 *
 *   AgentReport   one per run: what this agent could perceive, what it did, where it got
 *                 stuck, what the verifier found, what it cost.
 *   MissionReport one per mission: every agent's result side by side, the checkpoint
 *                 matrix, deterministic attribution of each failure, and the cost comparison
 *                 that backs the thesis ("the store should work for the cheapest agent").
 *
 * Both are stored as JSON (this schema) and rendered to Markdown for humans and LLMs.
 */

/** A step as it appears in a report: the run step plus resolved artifact paths. */
export const ReportStep = RunStep.extend({
  /** Paths relative to the artifacts dir, e.g. "run_abc/step-003.png" */
  screenshotPath: z.string().optional(),
  snapshotPath: z.string().optional(),
});
export type ReportStep = z.infer<typeof ReportStep>;

/** The step at which the run diverged from the mission, with what the agent perceived there. */
export const FailurePoint = z.object({
  stepIndex: z.number().int().nonnegative(),
  url: z.string().optional(),
  /** What the agent was trying to do (its own `reason`) */
  attempted: z.string(),
  /** Why it did not work, from the step outcome */
  outcome: z.string(),
  /** Excerpt (<= 2000 chars) of what the agent could perceive: aria snapshot or "screenshot only" */
  perceived: z.string(),
  screenshotPath: z.string().optional(),
  snapshotPath: z.string().optional(),
});
export type FailurePoint = z.infer<typeof FailurePoint>;

export const AgentProfileSummary = z.object({
  kind: AgentKind,
  name: z.string(),
  strategy: z.string(),
  /** Human-readable list, e.g. ["accessibility tree (role + name)", "page text"] */
  perceives: z.array(z.string()),
  /** e.g. ["role:name"] or ["x,y"] or both; empty for Gamma */
  targetGrammars: z.array(z.string()),
  model: z.string(),
  provider: z.string(),
  effort: z.string().optional(),
});
export type AgentProfileSummary = z.infer<typeof AgentProfileSummary>;

export const AgentReport = z.object({
  id: z.string(),
  runId: z.string(),
  missionId: z.string(),
  generatedAt: z.string(),
  storeUrl: z.string(),
  mission: Mission,
  agent: AgentProfileSummary,
  /** Verifier verdict for the run */
  status: RunStatus,
  claim: AgentClaim.optional(),
  checkpoints: z.array(Checkpoint),
  firstFailure: Checkpoint.optional(),
  observedCart: ObservedCart.optional(),
  steps: z.array(ReportStep),
  failurePoint: FailurePoint.optional(),
  /**
   * The agent's own account, written by the model after the run from its step log:
   * what it tried, where it got stuck, what it could and could not perceive.
   * Labelled as the agent's narrative, never as a verdict.
   */
  narrative: z.string(),
  usage: LlmUsage,
  durationMs: z.number().int().nonnegative(),
  /** Evidence ids referenced by checkpoints and the failure point */
  evidenceIds: z.array(z.string()).default([]),
  /** Relative paths of trace.zip and other run-level artifacts */
  artifacts: z.array(z.string()).default([]),
});
export type AgentReport = z.infer<typeof AgentReport>;

export const PatternStatus = z.union([CheckpointStatus, z.literal('not_run')]);
export type PatternStatus = z.infer<typeof PatternStatus>;

/** Deterministic attribution of one failed checkpoint from the cross-agent pass/fail pattern. */
export const Attribution = z.object({
  checkpointId: CheckpointId,
  category: FailureCategory,
  /** One sentence a judge understands: "Sigma passed and Alpha failed on correct size identified" */
  reason: z.string(),
  /** Which agent served as the reference for this verdict */
  reference: AgentKind.optional(),
  pattern: z.record(AgentKind, PatternStatus),
  /** Agents whose failure this attribution explains */
  failingAgents: z.array(AgentKind),
});
export type Attribution = z.infer<typeof Attribution>;

export const MissionReportRun = z.object({
  runId: z.string(),
  agentKind: AgentKind,
  agentName: z.string(),
  model: z.string(),
  status: RunStatus,
  claim: AgentClaim.optional(),
  firstFailure: Checkpoint.optional(),
  usage: LlmUsage.optional(),
  durationMs: z.number().int().nonnegative().optional(),
  stepsUsed: z.number().int().nonnegative(),
  reportPath: z.string().optional(),
});
export type MissionReportRun = z.infer<typeof MissionReportRun>;

export const MissionReport = z.object({
  id: z.string(),
  missionId: z.string(),
  generatedAt: z.string(),
  mission: Mission,
  storeUrl: z.string(),
  runs: z.array(MissionReportRun),
  /** checkpoint -> agent kind -> status */
  matrix: z.record(CheckpointId, z.record(AgentKind, PatternStatus)),
  attributions: z.array(Attribution),
  /** Per-agent cost line for the thesis: which agent could complete the mission and at what cost */
  costComparison: z.array(
    z.object({
      agentKind: AgentKind,
      model: z.string(),
      status: RunStatus,
      inputTokens: z.number().int().nonnegative(),
      outputTokens: z.number().int().nonnegative(),
      imageInputs: z.number().int().nonnegative(),
      estimatedCostUsd: z.number().nonnegative().optional(),
      /** Cost relative to the cheapest agent that was run (1.0 = cheapest) */
      relativeCost: z.number().nonnegative().optional(),
    }),
  ),
  /** One paragraph, deterministic, e.g. "2 of 4 agents completed the mission. Alpha failed on ..." */
  headline: z.string(),
  /** Deterministic, derived from attributions: what the store must change for the cheapest agent */
  recommendations: z.array(z.string()),
});
export type MissionReport = z.infer<typeof MissionReport>;
