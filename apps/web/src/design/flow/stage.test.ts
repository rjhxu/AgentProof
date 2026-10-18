import { describe, expect, it } from 'vitest';

import { runsABugged } from '../fixtures';
import { initialLanes, reduceLanes } from '../replay/reduce';
import { buildReplayScript } from '../replay/script';
import { costScale, inStageOrder, nextLane, stageLane } from './stage';

const staged = inStageOrder(runsABugged);
const seeds = staged.map((r) => ({ runId: r.runId, agent: r.agent }));
const script = buildReplayScript(staged, { sequential: true });

function lanesAt(ms: number) {
  return script
    .filter((e) => e.at <= ms)
    .reduce((acc, e) => reduceLanes(acc, e.event), initialLanes(seeds));
}

function startOf(runId: string): number {
  return script.find(
    (e) => e.event.type === 'status' && e.event.runId === runId && e.event.status === 'running',
  )!.at;
}

function reportOf(runId: string): number {
  return script.find((e) => e.event.type === 'report' && e.event.runId === runId)!.at;
}

describe('stage order', () => {
  it('puts the cheapest shopper first, the data check third and the benchmark last', () => {
    expect(staged.map((r) => r.agent.kind)).toEqual([
      'alpha_semantic',
      'beta_vision',
      'gamma_structured',
      'sigma_hybrid',
    ]);
  });
});

describe('stage selection', () => {
  it('has nobody on stage before the first agent starts, then Alpha', () => {
    expect(stageLane(initialLanes(seeds))).toBeUndefined();
    expect(nextLane(initialLanes(seeds))?.agent.kind).toBe('alpha_semantic');
    expect(stageLane(lanesAt(0))?.agent.kind).toBe('alpha_semantic');
    expect(nextLane(lanesAt(0))?.agent.kind).toBe('beta_vision');
  });

  it('holds a finished agent on stage until the next one starts', () => {
    const [alpha, beta, gamma, sigma] = staged;
    const during = lanesAt(reportOf(alpha!.runId) + 100);
    expect(stageLane(during)?.agent.kind).toBe('alpha_semantic');
    expect(stageLane(during)?.status).toBe('failed');
    expect(startOf(beta!.runId)).toBeGreaterThan(reportOf(alpha!.runId));
    expect(stageLane(lanesAt(startOf(beta!.runId)))?.agent.kind).toBe('beta_vision');
    expect(stageLane(lanesAt(startOf(gamma!.runId)))?.agent.kind).toBe('gamma_structured');
    expect(stageLane(lanesAt(startOf(sigma!.runId)))?.agent.kind).toBe('sigma_hybrid');
  });

  it('ends with Sigma on stage and nobody next', () => {
    const end = lanesAt(Number.POSITIVE_INFINITY);
    expect(stageLane(end)?.agent.kind).toBe('sigma_hybrid');
    expect(nextLane(end)).toBeUndefined();
    expect(end.find((l) => l.agent.kind === 'gamma_structured')?.status).toBe('failed');
    // The widest bar is Sigma's: the sum of its recorded step costs.
    const sigma = runsABugged.find((r) => r.agent.kind === 'sigma_hybrid')!;
    const sigmaSteps = sigma.steps.reduce((sum, s) => sum + (s.usage?.estimatedCostUsd ?? 0), 0);
    expect(sigmaSteps).toBeGreaterThan(0.04);
    expect(costScale(end)).toBeCloseTo(sigmaSteps, 6);
  });
});
