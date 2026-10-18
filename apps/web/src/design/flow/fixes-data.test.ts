import { describe, expect, it } from 'vitest';
import { CodeFixCheckId } from '@agentproof/shared';

import { codefixesABugged, problemsABugged, repositoryA } from '../fixtures';
import {
  CHECK_LABELS,
  CHECK_ORDER,
  canOpenPullRequests,
  checksSummary,
  deliveryLine,
  reviewLine,
} from './fixes-data';

describe('checks', () => {
  it('labels every check the agent can run, in its order', () => {
    expect([...CHECK_ORDER].sort()).toEqual([...CodeFixCheckId.options].sort());
    for (const id of CodeFixCheckId.options) expect(CHECK_LABELS[id]).toBeTruthy();
  });

  it('summarises the composed fixes as all passed', () => {
    for (const { issue } of problemsABugged) {
      const preview = codefixesABugged[issue.id]!;
      const summary = checksSummary(preview.checks);
      expect(summary.total).toBe(7);
      expect(summary.line).toBe('7 of 7 checks passed');
    }
  });

  it('names a failed check, and a skipped one', () => {
    const checks = codefixesABugged[problemsABugged[0]!.issue.id]!.checks;
    const withFailure = checks.map((c) =>
      c.id === 'typecheck' ? { ...c, status: 'failed' as const } : c,
    );
    expect(checksSummary(withFailure).line).toBe('typecheck failed');
    const withSkip = checks.map((c) =>
      c.id === 'rematch' ? { ...c, status: 'skipped' as const } : c,
    );
    expect(checksSummary(withSkip).line).toBe('6 of 7 checks passed, rematch skipped');
  });
});

describe('delivery', () => {
  it('opens pull requests only through the GitHub App', () => {
    expect(canOpenPullRequests(repositoryA)).toBe(true);
    expect(canOpenPullRequests({ ...repositoryA, accessVia: 'token' })).toBe(false);
    expect(canOpenPullRequests({ ...repositoryA, accessVia: undefined })).toBe(false);
  });

  it('describes each delivery state in merchant words', () => {
    const preview = codefixesABugged[problemsABugged[0]!.issue.id]!;
    expect(deliveryLine(preview.delivery)).toBe('Not opened yet');
    expect(deliveryLine({ mode: 'pull_request', status: 'pending' })).toMatch(/^Pushing a branch/);
    expect(deliveryLine(preview.opened!)).toMatch(
      /^Draft pull request #\d+ · agentproof\/.+ · opened by the AgentProof app$/,
    );
    expect(reviewLine(preview.review!)).toBe(
      'approve · minimal · addresses the observed failure · nothing a shopper sees changes',
    );
  });
});
