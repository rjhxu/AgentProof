import { describe, expect, it } from 'vitest';

import type { Evidence, RunEvent, RunStatus, RunStep } from '@agentproof/shared';

import { runAlphaABugged } from '../fixtures';
import { initialLanes, isTerminal, reduceLane, reduceLanes, statusRank } from './reduce';

const runId = runAlphaABugged.runId;
const seed = { runId, agent: runAlphaABugged.agent };
const [lane0] = initialLanes([seed]);
const lane = lane0!;

function status(value: RunStatus): RunEvent {
  return { type: 'status', runId, status: value, at: '2026-10-18T03:27:05.000Z' };
}

function stepEvent(step: RunStep): RunEvent {
  return { type: 'step', runId, step };
}

function evidenceEvent(
  kind: Evidence['kind'],
  stepIndex: number | undefined,
  path: string,
): RunEvent {
  return {
    type: 'evidence',
    runId,
    evidence: {
      id: `ev_${path}`,
      runId,
      kind,
      stepIndex,
      capturedAt: '2026-10-18T03:27:05.000Z',
      path,
    },
  };
}

const firstStep = runAlphaABugged.steps[0]!;
const secondStep = runAlphaABugged.steps[1]!;

describe('step deduplication', () => {
  it('counts a step once however often it arrives', () => {
    const once = reduceLane(lane, stepEvent(firstStep));
    const twice = reduceLane(once, stepEvent(firstStep));
    expect(twice).toBe(once);
    expect(twice.steps).toHaveLength(1);
    expect(twice.costUsd).toBeCloseTo(firstStep.usage?.estimatedCostUsd ?? 0, 10);
  });

  it('still adds a step with a new index', () => {
    const two = [stepEvent(firstStep), stepEvent(secondStep), stepEvent(firstStep)].reduce(
      reduceLane,
      lane,
    );
    expect(two.steps.map((s) => s.index)).toEqual([0, 1]);
    expect(two.costUsd).toBeCloseTo(
      (firstStep.usage?.estimatedCostUsd ?? 0) + (secondStep.usage?.estimatedCostUsd ?? 0),
      10,
    );
    expect(two.stage).toBe('variant');
  });

  it('ignores a repeated step that would move the stage back', () => {
    const atCart = [stepEvent(firstStep), stepEvent(runAlphaABugged.steps[4]!)].reduce(
      reduceLane,
      lane,
    );
    expect(atCart.stage).toBe('cart');
    expect(reduceLane(atCart, stepEvent(firstStep)).stage).toBe('cart');
  });
});

describe('evidence before its step', () => {
  const frame = (index: number) =>
    evidenceEvent('screenshot', index, `${runId}/step-00${index}.png`);
  const tree = (index: number) =>
    evidenceEvent('dom_snapshot', index, `${runId}/step-00${index}.aria.txt`);

  it('shows the frame and the tree of the step about to arrive', () => {
    const next = [tree(0), frame(0), stepEvent(firstStep), tree(1), frame(1)].reduce(
      reduceLane,
      lane,
    );
    expect(next.steps).toHaveLength(1);
    expect(next.latestScreenshotPath).toBe(`${runId}/step-001.png`);
    expect(next.latestSnapshotPath).toBe(`${runId}/step-001.aria.txt`);
  });

  it('ignores the evidence of a step already on the lane, so a repeat cannot rewind the frame', () => {
    const atSecond = [
      tree(0),
      frame(0),
      stepEvent(firstStep),
      tree(1),
      frame(1),
      stepEvent(secondStep),
    ].reduce(reduceLane, lane);
    expect(atSecond.latestScreenshotPath).toBe(`${runId}/step-001.png`);
    // The snapshot repeats the first step's evidence after the stream has shown the second step.
    expect(reduceLane(atSecond, frame(0))).toBe(atSecond);
    expect(reduceLane(atSecond, tree(0))).toBe(atSecond);
    expect(reduceLane(atSecond, frame(1))).toBe(atSecond);
    // Live evidence for the next step still applies.
    expect(reduceLane(atSecond, frame(2)).latestScreenshotPath).toBe(`${runId}/step-002.png`);
  });

  it('keeps evidence that names no step', () => {
    const shown = reduceLane(
      reduceLane(lane, stepEvent(firstStep)),
      evidenceEvent('screenshot', undefined, `${runId}/final.png`),
    );
    expect(shown.latestScreenshotPath).toBe(`${runId}/final.png`);
  });
});

describe('status monotonicity', () => {
  it('ranks queued, running, verifying and every verdict in that order', () => {
    expect(statusRank('queued')).toBe(0);
    expect(statusRank('running')).toBe(1);
    expect(statusRank('verifying')).toBe(2);
    for (const terminal of ['passed', 'failed', 'error', 'cancelled'] as const) {
      expect(statusRank(terminal)).toBe(3);
      expect(isTerminal(terminal)).toBe(true);
    }
  });

  it('never moves a lane backwards', () => {
    const verifying = [status('running'), status('verifying')].reduce(reduceLane, lane);
    expect(verifying.status).toBe('verifying');
    expect(reduceLane(verifying, status('running'))).toBe(verifying);
    expect(reduceLane(verifying, status('queued'))).toBe(verifying);
    const failed = reduceLane(verifying, status('failed'));
    expect(failed.status).toBe('failed');
    expect(reduceLane(failed, status('verifying'))).toBe(failed);
    expect(reduceLane(failed, status('running'))).toBe(failed);
  });

  it('lets the same rank repeat: verifying stays, a verdict may replace a verdict', () => {
    const verifying = [status('running'), status('verifying')].reduce(reduceLane, lane);
    expect(reduceLane(verifying, status('verifying'))).toEqual(verifying);
    const failed = reduceLane(verifying, status('failed'));
    expect(reduceLane(failed, status('error')).status).toBe('error');
  });

  it('keeps the stage rule for an agent with no browser steps', () => {
    const gammaSeed = {
      runId: 'run_gamma',
      agent: { ...runAlphaABugged.agent, kind: 'gamma_structured' as const },
    };
    const [gamma] = initialLanes([gammaSeed]);
    const running = reduceLane(gamma!, { ...status('running'), runId: 'run_gamma' });
    expect(running.stage).toBe('find');
    const verifying = reduceLane(running, { ...status('verifying'), runId: 'run_gamma' });
    expect(verifying.stage).toBe('cart');
    // A verdict straight from running moves it there too.
    expect(reduceLane(running, { ...status('failed'), runId: 'run_gamma' }).stage).toBe('cart');
    // A backwards status does not touch the stage either.
    expect(reduceLane(verifying, { ...status('running'), runId: 'run_gamma' })).toBe(verifying);
  });

  it('keys that rule on the kind: a shopper that stopped before its first step stays put', () => {
    const errored = [status('running'), status('error')].reduce(reduceLane, lane);
    expect(errored.status).toBe('error');
    expect(errored.steps).toHaveLength(0);
    expect(errored.stage).toBe('find');
    expect([status('running'), status('verifying')].reduce(reduceLane, lane).stage).toBe('find');
  });

  it('applies through reduceLanes to the matching lane only', () => {
    const lanes = initialLanes([seed, { runId: 'run_other', agent: runAlphaABugged.agent }]);
    const next = reduceLanes(lanes, status('running'));
    expect(next[0]!.status).toBe('running');
    expect(next[1]).toBe(lanes[1]);
  });
});
