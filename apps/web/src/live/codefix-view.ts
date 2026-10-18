import type {
  CodeFix,
  CodeFixAttempt,
  CodeFixDelivery,
  CodeFixMode,
  CodeFixStage,
  Issue,
  Repair,
} from '@agentproof/shared';

import type { CodeFixPreview } from '../design/flow/fixes-data';

/*
 * The backend writes one `CodeFix` record per failed run with a connected repository; the Fixes
 * step was designed around a `Repair` per issue plus a `CodeFixPreview` (checks, review,
 * delivery). These helpers map one onto the other. Every field they copy is code-written except
 * the proposal summary and the review, which the step already labels as the model's.
 */

/** The attempt whose diff passed validation; absent while the fix runs or when none did. */
export function finalAttempt(fix: CodeFix): CodeFixAttempt | undefined {
  return fix.finalAttempt === undefined ? undefined : fix.attempts[fix.finalAttempt];
}

/** The attempt to read checks from: the validated one, else the latest, so a failed fix says why. */
function attemptForChecks(fix: CodeFix): CodeFixAttempt | undefined {
  return finalAttempt(fix) ?? fix.attempts[fix.attempts.length - 1];
}

/** The fix as the Repair the step renders: only when the final attempt has a diff and a proposal. */
export function repairFromCodeFix(issue: Issue, fix: CodeFix): Repair | undefined {
  const attempt = finalAttempt(fix);
  if (!attempt || !attempt.diff || !attempt.proposal) return undefined;
  return {
    id: fix.id,
    issueId: issue.id,
    summary: attempt.proposal.summary,
    diff: attempt.diff,
    files: attempt.files,
    status: 'proposed',
    createdAt: fix.createdAt,
  };
}

/**
 * The checks, the second opinion and the delivery for the card. The caller passes the delivery
 * of the pull-request fix when one exists, so the card shows the draft that was opened.
 */
export function previewFromCodeFix(fix: CodeFix, delivery?: CodeFixDelivery): CodeFixPreview {
  const checks = attemptForChecks(fix)?.validation?.checks ?? [];
  return {
    checks,
    ...(fix.review ? { review: fix.review } : {}),
    delivery: delivery ?? fix.delivery,
  };
}

/**
 * The delivery as the card should read it: the record's own, except that a finished fix whose
 * delivery never left `pending` did not open its pull request, and the card says so instead of
 * spinning on.
 */
export function deliveryOf(fix: CodeFix): CodeFixDelivery {
  if (!isFixDone(fix) || fix.delivery.status !== 'pending') return fix.delivery;
  return {
    ...fix.delivery,
    status: 'failed',
    error: fix.error ?? 'the pull request was not opened',
  };
}

export type ReadingProgress = { done: number; total: number; label: string; current?: string };

export const CODEFIX_STAGE_WORDS: Record<CodeFixStage, string> = {
  collect: 'gathering the evidence',
  localize: 'finding the files behind the problem',
  propose: 'proposing a change',
  validate: 'checking the change compiles and applies',
  review: 'getting a second opinion',
  rematch: 'rerunning the shopper on the patched store',
  deliver: 'opening the pull request',
  done: 'done',
};

/** Six slots per fix: collect, localize, propose, validate, review, done. */
const SLOTS_PER_FIX = 6;

/** Rematch and delivery are optional extras after the review: half a slot past it. */
const STAGE_SLOT: Record<CodeFixStage, number> = {
  collect: 0,
  localize: 1,
  propose: 2,
  validate: 3,
  review: 4,
  rematch: 4.5,
  deliver: 4.5,
  done: 5,
};

export function isFixDone(fix: CodeFix): boolean {
  return fix.status !== 'running';
}

function slotOf(fix: CodeFix): number {
  if (isFixDone(fix)) return SLOTS_PER_FIX;
  return Math.min(SLOTS_PER_FIX, STAGE_SLOT[fix.stage]);
}

/**
 * Where "Reading your code" stands across every fix: progress out of six slots per fix, a line
 * for the first fix still running (its problem title when the caller has one, keyed by run id),
 * and the file the agent is reading in full.
 */
export function readingProgress(
  fixes: CodeFix[],
  titles: Record<string, string> = {},
): ReadingProgress {
  const total = fixes.length * SLOTS_PER_FIX;
  const done = fixes.reduce((sum, fix) => sum + slotOf(fix), 0);
  const index = fixes.findIndex((fix) => !isFixDone(fix));
  const fix = index >= 0 ? fixes[index] : undefined;
  if (!fix) return { done, total, label: 'Finishing up' };
  const who = titles[fix.runId] ?? `Problem ${index + 1} of ${fixes.length}`;
  const current = fix.localization.find((file) => file.included)?.path;
  return {
    done,
    total,
    label: `${who}: ${CODEFIX_STAGE_WORDS[fix.stage]}`,
    ...(current ? { current } : {}),
  };
}

function compareIso(a: string, b: string): number {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isFinite(ta) && Number.isFinite(tb)) return ta - tb;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The most recent fix in a mode (the diff that was read, the pull request that was opened). */
export function latestFix(fixes: CodeFix[], mode: CodeFixMode): CodeFix | undefined {
  let latest: CodeFix | undefined;
  for (const fix of fixes) {
    if (fix.mode !== mode) continue;
    if (!latest || compareIso(fix.createdAt, latest.createdAt) >= 0) latest = fix;
  }
  return latest;
}
