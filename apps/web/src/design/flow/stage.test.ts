import { describe, expect, it } from 'vitest';

import { runsABugged } from '../fixtures';
import { initialLanes, reduceLanes } from '../replay/reduce';
import { buildReplayScript } from '../replay/script';
import {
  costScale,
  inStageOrder,
  laneAtReview,
  nextLane,
  reviewLabel,
  reviewLength,
  stageLane,
} from './stage';

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

  it('rebuilds a shopper at any step of its process for review', () => {
    const end = lanesAt(Number.POSITIVE_INFINITY);
    const alphaReport = staged.find((r) => r.agent.kind === 'alpha_semantic')!;
    const alpha = end.find((l) => l.runId === alphaReport.runId)!;
    const artifacts = alphaReport.steps.map((s) => ({
      index: s.index,
      screenshotPath: s.screenshotPath,
      snapshotPath: s.snapshotPath,
    }));
    expect(reviewLength(alpha)).toBe(alphaReport.steps.length + 1);
    expect(reviewLabel(alpha, 0)).toBe('step 1 of 6');
    expect(reviewLabel(alpha, reviewLength(alpha) - 1)).toBe('verdict');

    const first = laneAtReview(alpha, artifacts, 0);
    expect(first.status).toBe('running');
    expect(first.steps).toHaveLength(1);
    expect(first.checkpoints).toHaveLength(0);
    expect(first.costUsd).toBeCloseTo(alphaReport.steps[0]!.usage?.estimatedCostUsd ?? 0, 8);
    expect(first.latestScreenshotPath).toBe('run_e2f6442a5419/step-000.png');
    expect(first.latestSnapshotPath).toBe('run_e2f6442a5419/step-000.aria.txt');
    expect(first.stage).toBe('find');

    const second = laneAtReview(alpha, artifacts, 1);
    expect(second.steps).toHaveLength(2);
    expect(second.stage).toBe('variant');
    expect(second.costUsd).toBeGreaterThan(first.costUsd);

    expect(laneAtReview(alpha, artifacts, reviewLength(alpha) - 1)).toBe(alpha);
  });

  it('rebuilds the data check as catalog, cart and verdict', () => {
    const end = lanesAt(Number.POSITIVE_INFINITY);
    const gamma = end.find((l) => l.agent.kind === 'gamma_structured')!;
    expect(reviewLength(gamma)).toBe(3);
    expect([0, 1, 2].map((i) => reviewLabel(gamma, i))).toEqual(['catalog', 'cart', 'verdict']);
    expect(laneAtReview(gamma, [], 0).checkpoints).toHaveLength(0);
    const catalogOnly = laneAtReview(gamma, [], 1);
    expect(catalogOnly.status).toBe('verifying');
    expect(catalogOnly.checkpoints.every((c) => c.status === 'passed')).toBe(true);
    expect(catalogOnly.checkpoints.some((c) => c.id === 'catalog_variant_resolves')).toBe(false);
    expect(laneAtReview(gamma, [], 2)).toBe(gamma);
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
