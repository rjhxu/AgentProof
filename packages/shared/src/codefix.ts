import { z } from 'zod';
import { AgentKind } from './agent';
import { CheckpointId } from './checkpoint';
import { FailureCategory, RunComparison } from './issue';
import { MissionRequirements } from './mission';
import { RunStatus } from './run';
import { LlmUsage } from './usage';

/**
 * The code-fix agent's record (docs/CODEFIX.md). One document per attempt to fix a failed run:
 * what the model was shown, which files code chose, every proposal and every check, how the fix
 * was delivered, and what a real rerun showed afterwards.
 *
 * Trust rules encoded here:
 *   - Every `status`, every check verdict and every number is written by code.
 *   - Model output lives only in `attempts[].proposal` and `review`, and the UI must label it as
 *     a hypothesis. `input.evidenceText` is the exact text the model received.
 *   - Delivery never merges: the only modes are a diff, a pushed `agentproof/*` branch, or a
 *     DRAFT pull request. Tokens are request-scoped and never appear in this document.
 */

export const CodeFixMode = z.enum(['diff', 'branch', 'pull_request']);
export type CodeFixMode = z.infer<typeof CodeFixMode>;

export const CodeFixStatus = z.enum(['running', 'succeeded', 'failed']);
export type CodeFixStatus = z.infer<typeof CodeFixStatus>;

export const CodeFixStage = z.enum([
  'collect',
  'localize',
  'propose',
  'validate',
  'review',
  'rematch',
  'deliver',
  'done',
]);
export type CodeFixStage = z.infer<typeof CodeFixStage>;

// ---- validation (code) ------------------------------------------------------------------------

export const CodeFixCheckId = z.enum([
  'paths_in_scope', // every touched path is a source file inside the store root
  'no_dependency_changes', // package.json, lockfiles, CI, env files and scripts untouched
  'size_within_bounds', // at most N files and M changed lines
  'applies_cleanly', // git apply --check in a clean worktree at the snapshot commit
  'content_policy', // added lines carry no network calls, dynamic code, secrets, obfuscation or hidden-from-humans CSS
  'typecheck', // tsc --noEmit in the patched store root (skipped when the repo has no tsconfig)
  'rematch', // the same agent passes a real rerun against the patched store (opt-in)
]);
export type CodeFixCheckId = z.infer<typeof CodeFixCheckId>;

export const CodeFixCheckStatus = z.enum(['passed', 'failed', 'skipped']);
export type CodeFixCheckStatus = z.infer<typeof CodeFixCheckStatus>;

export const CodeFixCheck = z.object({
  id: CodeFixCheckId,
  status: CodeFixCheckStatus,
  /** Factual, code-written: what was checked and what was found (<= 2000 chars) */
  detail: z.string(),
  durationMs: z.number().int().nonnegative().optional(),
});
export type CodeFixCheck = z.infer<typeof CodeFixCheck>;

export const ValidationReport = z.object({
  checks: z.array(CodeFixCheck),
  /** True when no check failed. Skipped checks do not fail a report; their detail says why. */
  passed: z.boolean(),
});
export type ValidationReport = z.infer<typeof ValidationReport>;

// ---- what the model returns (strict JSON) -----------------------------------------------------

/** One edit: replace an exact, unique substring of a file the model was shown. */
export const CodeEdit = z.object({
  /** Repository-relative POSIX path, exactly as shown to the model */
  path: z.string().min(1).max(300),
  /** Exact substring of the current file; must occur exactly once */
  search: z.string().min(1).max(4000),
  /** Replacement text; empty deletes the matched text */
  replace: z.string().max(20000),
  reason: z.string().max(500),
});
export type CodeEdit = z.infer<typeof CodeEdit>;

// Bounds on model output are enforced by Zod after the strict-schema call (the strict schema
// drops them), so an oversized or runaway answer fails the attempt with a precise reason.
export const CodeFixDiagnosis = z.object({
  title: z.string().max(160),
  category: FailureCategory,
  inferredCause: z.string().max(2000),
  confidence: z.enum(['low', 'medium', 'high']),
  /** Files the model was only shown as outlines and needs in full before it can edit */
  needsFiles: z.array(z.string().max(300)).max(5).default([]),
});
export type CodeFixDiagnosis = z.infer<typeof CodeFixDiagnosis>;

export const CodeFixProposal = z.object({
  diagnosis: CodeFixDiagnosis,
  /** Empty when needsFiles is non-empty or the model found nothing to change */
  edits: z.array(CodeEdit).max(20),
  /** One paragraph for the pull request, human-facing; labelled as the model's summary */
  summary: z.string().max(2000),
});
export type CodeFixProposal = z.infer<typeof CodeFixProposal>;

export const CodeFixReviewVerdict = z.enum(['approve', 'concerns', 'reject']);
export type CodeFixReviewVerdict = z.infer<typeof CodeFixReviewVerdict>;

/** What the reviewer model returns. Advisory: it never changes the diff or the status. */
export const CodeFixReviewDraft = z.object({
  verdict: CodeFixReviewVerdict,
  /** Whether the change alters what a sighted shopper sees or can do */
  humanVisibleChange: z.boolean(),
  addressesObservedFailure: z.boolean(),
  minimal: z.boolean(),
  notes: z.array(z.string().max(600)).max(10),
});
export type CodeFixReviewDraft = z.infer<typeof CodeFixReviewDraft>;

export const CodeFixReview = CodeFixReviewDraft.extend({
  model: z.string(),
  usage: LlmUsage,
});
export type CodeFixReview = z.infer<typeof CodeFixReview>;

// ---- the record --------------------------------------------------------------------------------

/** Provenance: what the pipeline worked from. Written by code during `collect`. */
export const CodeFixInput = z.object({
  agentKind: AgentKind,
  checkpointId: CheckpointId,
  /** The checkpoint's code-written detail: what was observed to be wrong */
  observed: z.string(),
  requirements: MissionRequirements,
  /** Attribution from the mission report, when one exists: the prior handed to the model */
  attributionCategory: FailureCategory.optional(),
  attributionReason: z.string().optional(),
  /** The exact evidence text the model received (sanitized: no control or bidi characters) */
  evidenceText: z.string(),
  evidenceChars: z.number().int().nonnegative(),
  /** Code-written flags from scanning the evidence, e.g. "instruction_like": page text that reads as instructions */
  evidenceFlags: z.array(z.string()).default([]),
  repositoryUrl: z.string(),
  commitSha: z.string(),
  /** Directory of the store inside the repository ('' for a repo that is only the store) */
  storeRoot: z.string(),
});
export type CodeFixInput = z.infer<typeof CodeFixInput>;

/** A candidate source file, scored by code. */
export const LocalizedFile = z.object({
  path: z.string(),
  score: z.number().nonnegative(),
  matchedTerms: z.array(z.string()),
  bytes: z.number().int().nonnegative(),
  /** Full text sent to the model (true) or only its outline (false) */
  included: z.boolean(),
  /** Code-written flags from scanning the file (instruction_like, secret_like, bidi_or_zero_width, ...) */
  flags: z.array(z.string()).default([]),
  /** Set when the file may never be shown in full (binary, oversized, invisible characters, a credential) */
  excludedReason: z.string().optional(),
});
export type LocalizedFile = z.infer<typeof LocalizedFile>;

export const CodeFixAttempt = z.object({
  index: z.number().int().nonnegative(),
  model: z.string(),
  startedAt: z.string(),
  finishedAt: z.string().optional(),
  /** Absent when the model call failed or returned no JSON */
  proposal: CodeFixProposal.optional(),
  /** Unified diff generated by code from the edits; absent when the edits could not be applied */
  diff: z.string().optional(),
  files: z.array(z.string()).default([]),
  /** Why edits could not become a diff: a search string missing or ambiguous, a path not shown */
  editErrors: z.array(z.string()).default([]),
  validation: ValidationReport.optional(),
  usage: LlmUsage,
  /** SHA-256 of the exact system + user text sent to the model, so the input is verifiable later */
  promptSha256: z.string().optional(),
  promptChars: z.number().int().nonnegative().optional(),
  error: z.string().optional(),
});
export type CodeFixAttempt = z.infer<typeof CodeFixAttempt>;

export const CodeFixDeliveryStatus = z.enum(['not_requested', 'pending', 'delivered', 'failed']);
export type CodeFixDeliveryStatus = z.infer<typeof CodeFixDeliveryStatus>;

export const CodeFixDelivery = z.object({
  mode: CodeFixMode,
  status: CodeFixDeliveryStatus,
  /** Always `agentproof/...`; never the default branch */
  branch: z.string().optional(),
  commitSha: z.string().optional(),
  /** GitHub's "open a pull request" page, prefilled (branch mode) */
  compareUrl: z.string().optional(),
  pullRequestUrl: z.string().optional(),
  pullRequestNumber: z.number().int().positive().optional(),
  /** Pull requests are always opened as drafts */
  draft: z.boolean().optional(),
  /** Which credential pushed and opened the PR: the GitHub App installation or the request token */
  actor: z.enum(['github_app', 'token']).optional(),
  deliveredAt: z.string().optional(),
  error: z.string().optional(),
});
export type CodeFixDelivery = z.infer<typeof CodeFixDelivery>;

export const CodeFixRematch = z.object({
  runId: z.string(),
  status: RunStatus,
  /** The ephemeral store the rematch ran against */
  storeUrl: z.string(),
  comparison: RunComparison.optional(),
  error: z.string().optional(),
});
export type CodeFixRematch = z.infer<typeof CodeFixRematch>;

export const CodeFixTimelineEntry = z.object({
  at: z.string(),
  stage: CodeFixStage,
  message: z.string(),
});
export type CodeFixTimelineEntry = z.infer<typeof CodeFixTimelineEntry>;

export const CodeFixOptions = z.object({
  typecheck: z.boolean().default(true),
  review: z.boolean().default(true),
  rematch: z.boolean().default(false),
  maxAttempts: z.number().int().min(1).max(4).default(2),
  storeRoot: z.string().default(''),
});
export type CodeFixOptions = z.infer<typeof CodeFixOptions>;

export const CodeFix = z.object({
  id: z.string().regex(/^fix_[a-f0-9]{12}$/),
  runId: z.string(),
  missionId: z.string(),
  repositoryId: z.string(),
  createdAt: z.string(),
  finishedAt: z.string().optional(),
  status: CodeFixStatus,
  stage: CodeFixStage,
  mode: CodeFixMode,
  options: CodeFixOptions,
  input: CodeFixInput.optional(),
  localization: z.array(LocalizedFile).default([]),
  attempts: z.array(CodeFixAttempt).default([]),
  /** Index into `attempts` of the diff that passed validation */
  finalAttempt: z.number().int().nonnegative().optional(),
  review: CodeFixReview.optional(),
  delivery: CodeFixDelivery,
  rematch: CodeFixRematch.optional(),
  /** Summed over every model call (proposals and review) */
  usage: LlmUsage,
  timeline: z.array(CodeFixTimelineEntry).default([]),
  /** Artifacts-relative paths: codefix/<id>/codefix.json, codefix.md, patch.diff */
  artifacts: z.array(z.string()).default([]),
  /** Set when status is `failed` */
  error: z.string().optional(),
});
export type CodeFix = z.infer<typeof CodeFix>;

// ---- API ---------------------------------------------------------------------------------------

// POST /runs/:id/codefix  -> start a fix for the run's connected repository
export const CodeFixRequest = z.object({
  mode: CodeFixMode.default('diff'),
  /**
   * Fine-grained token with Contents write (and Pull requests write for pull_request mode).
   * Held in memory for this request only; never persisted, logged or returned.
   */
  token: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .regex(/^[a-zA-Z0-9_]+$/)
    .optional(),
  consent: z.literal(true),
  typecheck: z.boolean().optional(),
  review: z.boolean().optional(),
  rematch: z.boolean().optional(),
  maxAttempts: z.number().int().min(1).max(4).optional(),
  /** Directory of the store inside the repository, e.g. "apps/storefront"; '' for the root */
  storeRoot: z.string().max(200).optional(),
});
export type CodeFixRequest = z.infer<typeof CodeFixRequest>;

export const CodeFixResponse = z.object({ codefix: CodeFix });
export type CodeFixResponse = z.infer<typeof CodeFixResponse>;

export const ListCodeFixesResponse = z.object({ codefixes: z.array(CodeFix) });
export type ListCodeFixesResponse = z.infer<typeof ListCodeFixesResponse>;

/** Streamed over GET /codefix/:id/events until `done`. */
export const CodeFixEvent = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('stage'),
    codefixId: z.string(),
    stage: CodeFixStage,
    status: CodeFixStatus,
    at: z.string(),
  }),
  z.object({ type: z.literal('log'), codefixId: z.string(), message: z.string(), at: z.string() }),
  z.object({
    type: z.literal('done'),
    codefixId: z.string(),
    status: CodeFixStatus,
    at: z.string(),
  }),
]);
export type CodeFixEvent = z.infer<typeof CodeFixEvent>;

// ---- GitHub App (docs/CODEFIX.md section 2) ---------------------------------------------------

/** What GET /github/app reports. Never the private key. */
export const GitHubAppStatus = z.object({
  configured: z.boolean(),
  appId: z.number().int().positive().optional(),
  slug: z.string().optional(),
  source: z.enum(['env', 'file']).optional(),
  /** Where to install the app on a repository */
  installUrl: z.string().optional(),
  /** Why a configured app cannot be used (bad key, missing id); never includes key material */
  error: z.string().optional(),
});
export type GitHubAppStatus = z.infer<typeof GitHubAppStatus>;

export const GitHubAppStatusResponse = z.object({ app: GitHubAppStatus });
export type GitHubAppStatusResponse = z.infer<typeof GitHubAppStatusResponse>;
