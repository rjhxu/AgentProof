import { describe, expect, it } from 'vitest';

import { CodeFix, CodeFixStage, Repair } from '@agentproof/shared';
import type { CodeFixDelivery } from '@agentproof/shared';

import { codefixesABugged, issueAlphaABugged, repairAlphaABugged } from '../design/fixtures';
import { CodeFixPreview } from '../design/flow/fixes-data';
import {
  CODEFIX_STAGE_WORDS,
  deliveryOf,
  finalAttempt,
  isFixDone,
  latestFix,
  previewFromCodeFix,
  readingProgress,
  repairFromCodeFix,
} from './codefix-view';

/*
 * No fix has been recorded through the runner on this repository yet, so the records are built by
 * hand and parsed with the shared schema: a contract change surfaces here, not on the Fixes step.
 */

const alphaPreview = codefixesABugged[issueAlphaABugged.id]!;

const base = {
  runId: issueAlphaABugged.runId,
  missionId: 'mis_4d8c056edb7d',
  repositoryId: 'repo_0a1b2c3d4e5f',
  createdAt: '2026-10-18T04:00:00.000Z',
  options: {},
  usage: {},
  localization: [
    {
      path: 'apps/storefront/src/html.ts',
      score: 3,
      matchedTerms: ['size'],
      bytes: 1200,
      included: false,
    },
    {
      path: 'apps/storefront/src/views.ts',
      score: 12,
      matchedTerms: ['size', 'chip'],
      bytes: 6100,
      included: true,
    },
  ],
};

/** Mid-way: the files are being ranked, nothing proposed yet. */
const running = CodeFix.parse({
  ...base,
  id: 'fix_0000000000a1',
  status: 'running',
  stage: 'localize',
  mode: 'diff',
  delivery: { mode: 'diff', status: 'not_requested' },
});

/** Done in diff mode: one attempt with a diff, the seven checks and a second opinion. */
const succeeded = CodeFix.parse({
  ...base,
  id: 'fix_0000000000b2',
  createdAt: '2026-10-18T04:05:00.000Z',
  finishedAt: '2026-10-18T04:06:30.000Z',
  status: 'succeeded',
  stage: 'done',
  mode: 'diff',
  attempts: [
    {
      index: 0,
      model: 'test-model',
      startedAt: '2026-10-18T04:05:10.000Z',
      finishedAt: '2026-10-18T04:06:00.000Z',
      proposal: {
        diagnosis: {
          title: 'Size chips are not form controls',
          category: 'semantic_interface_problem',
          inferredCause: 'The size picker renders plain div chips with no role or name.',
          confidence: 'high',
        },
        edits: [
          {
            path: 'apps/storefront/src/views.ts',
            search: '<div class="chip">',
            replace: '<label class="chip"><input type="radio" name="size">',
            reason: 'Expose each size as a labelled radio input',
          },
        ],
        summary: repairAlphaABugged.summary,
      },
      diff: repairAlphaABugged.diff,
      files: repairAlphaABugged.files,
      validation: { checks: alphaPreview.checks, passed: true },
      usage: { calls: 1, inputTokens: 5000, outputTokens: 600, estimatedCostUsd: 0.004 },
    },
  ],
  finalAttempt: 0,
  review: alphaPreview.review,
  delivery: { mode: 'diff', status: 'delivered', deliveredAt: '2026-10-18T04:06:30.000Z' },
});

/** Nothing matched the evidence: failed before any attempt. */
const failed = CodeFix.parse({
  ...base,
  id: 'fix_0000000000c3',
  createdAt: '2026-10-18T04:10:00.000Z',
  finishedAt: '2026-10-18T04:10:05.000Z',
  status: 'failed',
  stage: 'localize',
  mode: 'diff',
  localization: [],
  delivery: { mode: 'diff', status: 'not_requested' },
  error: 'No source file matched the evidence.',
});

/** The pull request opened afterwards from the same diff. */
const prDelivery: CodeFixDelivery = alphaPreview.opened!;
const pullRequest = CodeFix.parse({
  ...succeeded,
  id: 'fix_0000000000d4',
  createdAt: '2026-10-18T04:20:00.000Z',
  mode: 'pull_request',
  delivery: prDelivery,
});

describe('finalAttempt', () => {
  it('is the validated attempt and nothing else', () => {
    expect(finalAttempt(running)).toBeUndefined();
    expect(finalAttempt(succeeded)).toBe(succeeded.attempts[0]);
    expect(finalAttempt(failed)).toBeUndefined();
  });
});

describe('repairFromCodeFix', () => {
  it('shapes a validated diff as the Repair the step renders', () => {
    const repair = repairFromCodeFix(issueAlphaABugged, succeeded);
    expect(repair).toEqual({
      id: succeeded.id,
      issueId: issueAlphaABugged.id,
      summary: repairAlphaABugged.summary,
      diff: repairAlphaABugged.diff,
      files: repairAlphaABugged.files,
      status: 'proposed',
      createdAt: succeeded.createdAt,
    });
    expect(() => Repair.parse(repair)).not.toThrow();
  });

  it('has nothing to show while running, after a failure, or without a diff', () => {
    expect(repairFromCodeFix(issueAlphaABugged, running)).toBeUndefined();
    expect(repairFromCodeFix(issueAlphaABugged, failed)).toBeUndefined();
    const noDiff = CodeFix.parse({
      ...succeeded,
      attempts: [{ ...succeeded.attempts[0]!, diff: undefined }],
    });
    expect(repairFromCodeFix(issueAlphaABugged, noDiff)).toBeUndefined();
    const noProposal = CodeFix.parse({
      ...succeeded,
      attempts: [{ ...succeeded.attempts[0]!, proposal: undefined }],
    });
    expect(repairFromCodeFix(issueAlphaABugged, noProposal)).toBeUndefined();
  });
});

describe('previewFromCodeFix', () => {
  it('carries the seven checks, the second opinion and the delivery', () => {
    const preview = previewFromCodeFix(succeeded);
    expect(preview.checks).toHaveLength(7);
    expect(preview.checks).toEqual(alphaPreview.checks);
    expect(preview.review).toEqual(alphaPreview.review);
    expect(preview.delivery).toEqual(succeeded.delivery);
    expect(preview.opened).toBeUndefined();
    expect(() => CodeFixPreview.parse(preview)).not.toThrow();
  });

  it('shows the pull request delivery when the caller has one', () => {
    expect(previewFromCodeFix(succeeded, prDelivery).delivery).toEqual(prDelivery);
    expect(previewFromCodeFix(succeeded, pullRequest.delivery).delivery.pullRequestNumber).toBe(12);
  });

  it('is empty-handed for a fix that never got to a diff', () => {
    expect(previewFromCodeFix(running)).toEqual({ checks: [], delivery: running.delivery });
    expect(previewFromCodeFix(failed)).toEqual({ checks: [], delivery: failed.delivery });
  });

  it('reads the checks of the last attempt when none passed, so the card says what failed', () => {
    const failedChecks = alphaPreview.checks.map((c) =>
      c.id === 'typecheck' ? { ...c, status: 'failed' as const } : c,
    );
    const failedValidation = CodeFix.parse({
      ...failed,
      attempts: [
        {
          ...succeeded.attempts[0]!,
          validation: { checks: failedChecks, passed: false },
        },
      ],
    });
    expect(previewFromCodeFix(failedValidation).checks).toEqual(failedChecks);
    expect(repairFromCodeFix(issueAlphaABugged, failedValidation)).toBeUndefined();
  });
});

describe('deliveryOf', () => {
  it("is the record's own delivery while it runs and once it has delivered", () => {
    expect(deliveryOf(running)).toBe(running.delivery);
    expect(deliveryOf(succeeded)).toBe(succeeded.delivery);
    expect(deliveryOf(pullRequest)).toBe(pullRequest.delivery);
    const opening = CodeFix.parse({
      ...pullRequest,
      status: 'running',
      stage: 'deliver',
      delivery: { mode: 'pull_request', status: 'pending' },
    });
    expect(deliveryOf(opening).status).toBe('pending');
  });

  it('fails a delivery still pending once the fix has finished, with the fix error as the reason', () => {
    const refused = CodeFix.parse({
      ...pullRequest,
      status: 'failed',
      error: 'GitHub refused the push.',
      delivery: { mode: 'pull_request', status: 'pending' },
    });
    expect(deliveryOf(refused)).toEqual({
      mode: 'pull_request',
      status: 'failed',
      error: 'GitHub refused the push.',
    });
    const silent = CodeFix.parse({
      ...pullRequest,
      delivery: { mode: 'pull_request', status: 'pending' },
    });
    expect(deliveryOf(silent).error).toBe('the pull request was not opened');
  });
});

describe('reading progress', () => {
  it('has a phrase for every stage', () => {
    for (const stage of CodeFixStage.options) expect(CODEFIX_STAGE_WORDS[stage]).toBeTruthy();
  });

  it('counts six slots per fix and names the first fix still running', () => {
    const progress = readingProgress([running, succeeded]);
    expect(progress).toEqual({
      done: 1 + 6,
      total: 12,
      label: 'Problem 1 of 2: finding the files behind the problem',
      current: 'apps/storefront/src/views.ts',
    });
    const second = readingProgress([succeeded, running]);
    expect(second.label).toBe('Problem 2 of 2: finding the files behind the problem');
    expect(second.done).toBe(7);
  });

  it('uses the problem title for the run when given', () => {
    const progress = readingProgress([running], { [running.runId]: 'The size picker' });
    expect(progress.label).toBe('The size picker: finding the files behind the problem');
    const other = readingProgress([running], { run_other: 'Something else' });
    expect(other.label).toBe('Problem 1 of 1: finding the files behind the problem');
  });

  it('walks the stages, with rematch and delivery past the review', () => {
    const at = (stage: CodeFix['stage']) => readingProgress([{ ...running, stage }]).done;
    expect(at('collect')).toBe(0);
    expect(at('localize')).toBe(1);
    expect(at('propose')).toBe(2);
    expect(at('validate')).toBe(3);
    expect(at('review')).toBe(4);
    expect(at('rematch')).toBe(4.5);
    expect(at('deliver')).toBe(4.5);
    expect(readingProgress([{ ...running, stage: 'deliver' }]).label).toBe(
      'Problem 1 of 1: opening the pull request',
    );
  });

  it('is finishing up once every fix is done, a failed one included', () => {
    expect(readingProgress([succeeded, failed])).toEqual({
      done: 12,
      total: 12,
      label: 'Finishing up',
    });
    expect(readingProgress([])).toEqual({ done: 0, total: 0, label: 'Finishing up' });
  });

  it('has no current file before localization has included one', () => {
    const collecting = { ...running, stage: 'collect' as const, localization: [] };
    expect(readingProgress([collecting]).current).toBeUndefined();
  });
});

describe('fix bookkeeping', () => {
  it('knows when a fix is done', () => {
    expect(isFixDone(running)).toBe(false);
    expect(isFixDone(succeeded)).toBe(true);
    expect(isFixDone(failed)).toBe(true);
  });

  it('finds the latest fix per mode by creation time', () => {
    const fixes = [pullRequest, failed, running, succeeded];
    expect(latestFix(fixes, 'diff')).toBe(failed);
    expect(latestFix(fixes, 'pull_request')).toBe(pullRequest);
    expect(latestFix(fixes, 'branch')).toBeUndefined();
    expect(latestFix([], 'diff')).toBeUndefined();
  });
});
