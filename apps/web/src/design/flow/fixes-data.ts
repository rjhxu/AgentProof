import { z } from 'zod';
import { CodeFixCheck, CodeFixDelivery, CodeFixReview } from '@agentproof/shared';
import type { CodeFixCheckId, RepositoryConnection } from '@agentproof/shared';

/*
 * What the Fixes step shows about a fix beyond its diff: the code-written validation checks,
 * the reviewer's second opinion and the delivery. These are the fields of the `CodeFix` record
 * the step reads at wiring (attempts[finalAttempt].validation.checks, review, delivery); the
 * sandbox composes them per issue, and `opened` is the delivery once the pull request exists.
 */
export const CodeFixPreview = z.object({
  checks: z.array(CodeFixCheck),
  review: CodeFixReview.optional(),
  delivery: CodeFixDelivery,
  /** The delivery after "open draft pull requests": what the runner returns at wiring. */
  opened: CodeFixDelivery.optional(),
});
export type CodeFixPreview = z.infer<typeof CodeFixPreview>;

/**
 * Progress of the reading beat on the Fixes step: files counted so far, the total, a label
 * ("12 of 48 files") and the file under the cursor. The sandbox counts the fixture's files over
 * a timer; the live page derives it from the code-fix records (src/live/codefix-view.ts defines
 * the same shape, so neither side imports the other).
 */
export type ReadingProgress = { done: number; total: number; label: string; current?: string };

/** The seven checks in the order the agent runs them. */
export const CHECK_ORDER: readonly CodeFixCheckId[] = [
  'paths_in_scope',
  'no_dependency_changes',
  'size_within_bounds',
  'applies_cleanly',
  'content_policy',
  'typecheck',
  'rematch',
];

export const CHECK_LABELS: Record<CodeFixCheckId, string> = {
  paths_in_scope: 'Paths in scope',
  no_dependency_changes: 'No dependency changes',
  size_within_bounds: 'Size within bounds',
  applies_cleanly: 'Applies cleanly',
  content_policy: 'Content policy',
  typecheck: 'Typecheck',
  rematch: 'Rematch',
};

export type ChecksSummary = {
  passed: number;
  failed: number;
  skipped: number;
  total: number;
  /** "7 of 7 checks passed", "6 of 7 checks passed, rematch skipped", "typecheck failed". */
  line: string;
};

export function checksSummary(checks: CodeFixCheck[]): ChecksSummary {
  const passed = checks.filter((c) => c.status === 'passed').length;
  const failed = checks.filter((c) => c.status === 'failed');
  const skipped = checks.filter((c) => c.status === 'skipped');
  const total = checks.length;
  const name = (c: CodeFixCheck) => CHECK_LABELS[c.id].toLowerCase();
  let line: string;
  if (failed.length > 0) {
    line = `${failed.map(name).join(', ')} failed`;
  } else {
    line = `${passed} of ${total} checks passed`;
    if (skipped.length > 0) line += `, ${skipped.map(name).join(', ')} skipped`;
  }
  return { passed, failed: failed.length, skipped: skipped.length, total, line };
}

/** Pull requests are opened by the GitHub App; a read-only token cannot push or open one. */
export function canOpenPullRequests(repository: RepositoryConnection): boolean {
  return repository.accessVia === 'github_app';
}

/** One line for the delivery, in merchant words. */
export function deliveryLine(delivery: CodeFixDelivery): string {
  if (delivery.status === 'delivered') {
    const where =
      delivery.pullRequestNumber !== undefined
        ? `Draft pull request #${delivery.pullRequestNumber}`
        : delivery.mode === 'branch'
          ? 'Branch pushed'
          : 'Patch ready';
    const branch = delivery.branch ? ` · ${delivery.branch}` : '';
    const by =
      delivery.actor === 'github_app'
        ? ' · opened by the AgentProof app'
        : delivery.actor === 'token'
          ? ' · opened with your token'
          : '';
    return `${where}${branch}${by}`;
  }
  if (delivery.status === 'pending') return 'Pushing a branch and opening a draft pull request';
  if (delivery.status === 'failed') return delivery.error ?? 'Could not open the pull request';
  return 'Not opened yet';
}

/** The second opinion, as the verdict plus what the reviewer confirmed, never as a status. */
export function reviewLine(review: CodeFixReview): string {
  const parts: string[] = [review.verdict];
  if (review.minimal) parts.push('minimal');
  if (review.addressesObservedFailure) parts.push('addresses the observed failure');
  parts.push(
    review.humanVisibleChange ? 'changes what a shopper sees' : 'nothing a shopper sees changes',
  );
  return parts.join(' · ');
}
