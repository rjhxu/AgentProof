import { describe, expect, it } from 'vitest';

import { runsABugged } from '../fixtures';
import { initialLanes, reduceLanes } from '../replay/reduce';
import { buildReplayScript } from '../replay/script';
import { costScale, gammaLane, nextLane, stageLane } from './stage';

const seeds = runsABugged.map((r) => ({ runId: r.runId, agent: r.agent }));
const script = buildReplayScript(runsABugged, { sequential: true });

function lanesAt(ms: number) {
  return script
    .filter((e) => e.at <= ms)
    .reduce((acc, e) => reduceLanes(acc, e.event), initialLanes(seeds));
}

describe('stage selection', () => {
  it('has nobody on stage before the first shopper starts, then Alpha', () => {
    expect(stageLane(initialLanes(seeds))).toBeUndefined();
    expect(nextLane(initialLanes(seeds))?.agent.kind).toBe('alpha_semantic');
    expect(stageLane(lanesAt(0))?.agent.kind).toBe('alpha_semantic');
    expect(nextLane(lanesAt(0))?.agent.kind).toBe('beta_vision');
  });

  it('holds a finished shopper on stage until the next one starts', () => {
    const alphaReport = script.find(
      (e) => e.event.type === 'report' && e.event.runId === 'run_e2f6442a5419',
    )!;
    const during = lanesAt(alphaReport.at + 100);
    expect(stageLane(during)?.agent.kind).toBe('alpha_semantic');
    expect(stageLane(during)?.status).toBe('failed');
    const betaStart = script.find(
      (e) =>
        e.event.type === 'status' &&
        e.event.runId === 'run_3b3c7a56c6fc' &&
        e.event.status === 'running',
    )!;
    expect(betaStart.at).toBeGreaterThan(alphaReport.at);
    expect(stageLane(lanesAt(betaStart.at))?.agent.kind).toBe('beta_vision');
  });

  it('ends with Sigma on stage, nobody next, and Gamma off stage throughout', () => {
    const end = lanesAt(Number.POSITIVE_INFINITY);
    expect(stageLane(end)?.agent.kind).toBe('sigma_hybrid');
    expect(nextLane(end)).toBeUndefined();
    expect(gammaLane(end)?.status).toBe('failed');
    // The widest bar is Sigma's: the sum of its recorded step costs.
    const sigma = runsABugged.find((r) => r.agent.kind === 'sigma_hybrid')!;
    const sigmaSteps = sigma.steps.reduce((sum, s) => sum + (s.usage?.estimatedCostUsd ?? 0), 0);
    expect(sigmaSteps).toBeGreaterThan(0.04);
    expect(costScale(end)).toBeCloseTo(sigmaSteps, 6);
  });
});
