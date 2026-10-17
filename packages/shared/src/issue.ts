import { z } from 'zod';
import { CheckpointId } from './checkpoint';

/** Spec section 8, step 4. Every failure gets exactly one category. */
export const FailureCategory = z.enum([
  'agent_execution_error', // the agent made a wrong decision; store may be fine
  'semantic_interface_problem', // controls lack accessible structure
  'product_data_inconsistency', // feed / page / cart disagree
  'cart_checkout_defect', // store-side bug in cart or checkout
  'authorization_restriction', // agent was not permitted to proceed
  'unsupported_integration', // store lacks the interface being tested
  'transient_error', // timeout, flake, network
  'insufficient_evidence', // we cannot say
]);
export type FailureCategory = z.infer<typeof FailureCategory>;

export const FAILURE_CATEGORY_LABELS: Record<FailureCategory, string> = {
  agent_execution_error: 'Agent execution error',
  semantic_interface_problem: 'Semantic interface problem',
  product_data_inconsistency: 'Product data inconsistency',
  cart_checkout_defect: 'Cart or checkout defect',
  authorization_restriction: 'Authorization or access restriction',
  unsupported_integration: 'Unsupported integration',
  transient_error: 'Transient error',
  insufficient_evidence: 'Insufficient evidence',
};

/**
 * An Issue separates what was OBSERVED (deterministic, from the verifier) from what is
 * INFERRED (Claude's root-cause hypothesis). The UI must render these distinctly.
 */
export const Issue = z.object({
  id: z.string(),
  runId: z.string(),
  checkpointId: CheckpointId,
  category: FailureCategory,
  title: z.string(),
  /** Facts only. Written by the verifier, never by the LLM. */
  observed: z.string(),
  evidenceIds: z.array(z.string()).default([]),
  /** Claude's hypothesis. May be absent when evidence is insufficient. */
  inferredCause: z.string().optional(),
  confidence: z.enum(['low', 'medium', 'high']).optional(),
  suggestedRepair: z.string().optional(),
  /** Source files Claude believes are involved, when a repo is connected */
  suspectedFiles: z.array(z.string()).default([]),
});
export type Issue = z.infer<typeof Issue>;

/** Shape Claude is asked to return from the diagnosis prompt. */
export const DiagnosisDraft = Issue.pick({
  category: true,
  title: true,
  inferredCause: true,
  confidence: true,
  suggestedRepair: true,
  suspectedFiles: true,
});
export type DiagnosisDraft = z.infer<typeof DiagnosisDraft>;

export const RepairStatus = z.enum(['proposed', 'applied', 'rejected']);

export const Repair = z.object({
  id: z.string(),
  issueId: z.string(),
  summary: z.string(),
  /** Unified diff against the storefront repo */
  diff: z.string(),
  files: z.array(z.string()),
  status: RepairStatus.default('proposed'),
  createdAt: z.string(),
  appliedAt: z.string().optional(),
});
export type Repair = z.infer<typeof Repair>;

/** Before/after comparison shown after a rematch. */
export const CheckpointDelta = z.object({
  id: CheckpointId,
  before: z.string(),
  after: z.string(),
  change: z.enum(['improved', 'regressed', 'unchanged']),
});

export const RunComparison = z.object({
  originalRunId: z.string(),
  rematchRunId: z.string(),
  deltas: z.array(CheckpointDelta),
  improved: z.number().int(),
  regressed: z.number().int(),
  unchanged: z.number().int(),
});
export type RunComparison = z.infer<typeof RunComparison>;
