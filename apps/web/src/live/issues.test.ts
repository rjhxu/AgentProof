import { describe, expect, it } from 'vitest';

import { Issue } from '@agentproof/shared';
import type { Run } from '@agentproof/shared';
import { alphaFailedRun, alphaIssue } from '@agentproof/shared/fixtures';

import { missionABugged } from '../design/fixtures';
import { failedWithCheckpoint, fallbackIssue, pickIssue } from './issues';

/** The demo run's checkpoints, re-keyed to the recorded Alpha run so the report attributes them. */
const recordedAlpha: Run = { ...alphaFailedRun, id: 'run_e2f6442a5419' };

const cartIssue: Issue = {
  ...alphaIssue,
  id: 'iss_cart',
  checkpointId: 'cart_matches_variant',
  title: 'Cart holds the wrong size',
};
const otherRunIssue: Issue = { ...alphaIssue, id: 'iss_other', runId: 'run_other' };

describe('pickIssue', () => {
  it('prefers the issue on the first failed checkpoint', () => {
    expect(pickIssue(alphaFailedRun, [otherRunIssue, cartIssue, alphaIssue])).toBe(alphaIssue);
  });

  it('falls back to the first issue the run has', () => {
    expect(pickIssue(alphaFailedRun, [otherRunIssue, cartIssue])).toBe(cartIssue);
    const noVerification: Run = { ...alphaFailedRun, verification: undefined };
    expect(pickIssue(noVerification, [cartIssue, alphaIssue])).toBe(cartIssue);
  });

  it('has nothing for a run without issues', () => {
    expect(pickIssue(alphaFailedRun, [otherRunIssue])).toBeUndefined();
    expect(pickIssue(alphaFailedRun, [])).toBeUndefined();
  });
});

describe('fallbackIssue', () => {
  it('writes the issue from the verifier and the report attribution only', () => {
    const issue = fallbackIssue(recordedAlpha, missionABugged);
    expect(issue).toEqual({
      id: 'iss_e2f6442a5419',
      runId: 'run_e2f6442a5419',
      checkpointId: 'correct_size_identified',
      category: 'semantic_interface_problem',
      title: 'Correct size identified failed',
      observed: 'Agent could not locate a size control in the accessibility tree.',
      evidenceIds: ['ev_demo00000002'],
      suspectedFiles: [],
    });
    expect(issue).not.toHaveProperty('inferredCause');
    expect(issue).not.toHaveProperty('confidence');
    expect(issue).not.toHaveProperty('suggestedRepair');
    expect(() => Issue.parse(issue)).not.toThrow();
  });

  it('says insufficient evidence without a report, or when the report does not attribute it', () => {
    expect(fallbackIssue(alphaFailedRun)?.category).toBe('insufficient_evidence');
    expect(fallbackIssue(alphaFailedRun)?.id).toBe('iss_demo0000alpha');
    const unattributed = { ...missionABugged, attributions: [] };
    expect(fallbackIssue(recordedAlpha, unattributed)?.category).toBe('insufficient_evidence');
    // Another agent's failure on the same checkpoint does not explain this one.
    const gammaOnly = {
      ...missionABugged,
      attributions: missionABugged.attributions.map((a) => ({
        ...a,
        failingAgents: ['gamma_structured' as const],
      })),
    };
    expect(fallbackIssue(recordedAlpha, gammaOnly)?.category).toBe('insufficient_evidence');
  });

  it('uses the first failed checkpoint when the verifier named no first failure', () => {
    const verification = alphaFailedRun.verification!;
    const noFirst: Run = {
      ...alphaFailedRun,
      verification: { ...verification, firstFailure: undefined },
    };
    expect(fallbackIssue(noFirst)?.checkpointId).toBe('correct_size_identified');
    const detailless: Run = {
      ...alphaFailedRun,
      verification: {
        ...verification,
        firstFailure: { id: 'added_to_cart', status: 'failed', evidenceIds: [] },
      },
    };
    expect(fallbackIssue(detailless)).toMatchObject({
      checkpointId: 'added_to_cart',
      title: 'Product added to cart failed',
      observed: 'The verifier failed this checkpoint.',
      evidenceIds: [],
    });
  });

  it('has nothing for a run that passed, errored or failed without a checkpoint', () => {
    expect(fallbackIssue({ ...alphaFailedRun, status: 'passed' })).toBeUndefined();
    expect(fallbackIssue({ ...alphaFailedRun, status: 'error' })).toBeUndefined();
    expect(fallbackIssue({ ...alphaFailedRun, verification: undefined })).toBeUndefined();
    const allPassed: Run = {
      ...alphaFailedRun,
      verification: {
        ...alphaFailedRun.verification!,
        firstFailure: undefined,
        checkpoints: alphaFailedRun.verification!.checkpoints.map((c) => ({
          ...c,
          status: 'passed' as const,
        })),
      },
    };
    expect(fallbackIssue(allPassed)).toBeUndefined();
  });
});

describe('failedWithCheckpoint', () => {
  it('gates on a failed run with a failed checkpoint', () => {
    expect(failedWithCheckpoint(alphaFailedRun)).toBe(true);
    expect(failedWithCheckpoint({ ...alphaFailedRun, status: 'passed' })).toBe(false);
    expect(failedWithCheckpoint({ ...alphaFailedRun, status: 'running' })).toBe(false);
    expect(failedWithCheckpoint({ ...alphaFailedRun, verification: undefined })).toBe(false);
    const noFailure: Run = {
      ...alphaFailedRun,
      verification: {
        ...alphaFailedRun.verification!,
        firstFailure: undefined,
        checkpoints: alphaFailedRun.verification!.checkpoints.filter((c) => c.status !== 'failed'),
      },
    };
    expect(failedWithCheckpoint(noFailure)).toBe(false);
  });
});
