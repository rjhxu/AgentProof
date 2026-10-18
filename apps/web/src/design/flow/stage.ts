import type { AgentKind, CheckpointId } from '@agentproof/shared';

import { stageOf } from '../format';
import type { LaneState } from '../replay/reduce';

/**
 * The order agents take the stage: the cheapest shopper first, the data check third, the
 * benchmark shopper last so its price is the finale.
 */
export const STAGE_ORDER: readonly AgentKind[] = [
  'alpha_semantic',
  'beta_vision',
  'gamma_structured',
  'sigma_hybrid',
];

/** Stable sort into stage order; unknown kinds keep their place at the end. */
export function inStageOrder<T extends { agent: { kind: AgentKind } }>(items: T[]): T[] {
  const rank = (item: T) => {
    const i = STAGE_ORDER.indexOf(item.agent.kind);
    return i < 0 ? STAGE_ORDER.length : i;
  };
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => rank(a.item) - rank(b.item) || a.index - b.index)
    .map((x) => x.item);
}

/**
 * Who is on stage: the last agent that has started. Agents start one after another, so a
 * finished one holds the stage until the next one starts, which is the freeze frame.
 */
export function stageLane(lanes: LaneState[]): LaneState | undefined {
  const started = lanes.filter((l) => l.status !== 'queued');
  return started[started.length - 1];
}

/** The agent waiting to go next, if any. */
export function nextLane(lanes: LaneState[]): LaneState | undefined {
  return lanes.find((l) => l.status === 'queued');
}

/** The widest cost bar: the most expensive agent so far. Zero before anyone has spent. */
export function costScale(lanes: LaneState[]): number {
  return lanes.reduce((max, l) => Math.max(max, l.costUsd), 0);
}

// ---- review: walking back through an agent's process once the scan is done -------------------

/** Where a step's frame and snapshot live, from the run's report. */
export type StepArtifact = { index: number; screenshotPath?: string; snapshotPath?: string };

/** The checkpoints Gamma reports from the catalog alone, before it touches the cart. */
const CATALOG_CHECKPOINTS: CheckpointId[] = [
  'product_discovered',
  'correct_color_identified',
  'correct_size_identified',
];

/**
 * How many positions a review of this lane has: one per step plus the verdict for a shopper;
 * the catalog beat, the cart beat and the verdict for the data check.
 */
export function reviewLength(lane: LaneState): number {
  return lane.agent.kind === 'gamma_structured' ? 3 : lane.steps.length + 1;
}

/** "step 2 of 6", "catalog", "cart", or "verdict". */
export function reviewLabel(lane: LaneState, position: number): string {
  const last = reviewLength(lane) - 1;
  if (position >= last) return 'verdict';
  if (lane.agent.kind === 'gamma_structured') return position === 0 ? 'catalog' : 'cart';
  return `step ${position + 1} of ${lane.steps.length}`;
}

/**
 * The lane as it stood at a review position, rebuilt from the finished lane: the steps up to
 * that point, the cost so far, the frame and snapshot of that step, no checkpoints yet. The
 * last position is the finished lane itself, verdict included.
 */
export function laneAtReview(
  lane: LaneState,
  artifacts: StepArtifact[],
  position: number,
): LaneState {
  const last = reviewLength(lane) - 1;
  if (position >= last) return lane;
  if (lane.agent.kind === 'gamma_structured') {
    if (position <= 0) {
      return { ...lane, status: 'running', checkpoints: [], stage: 'find', reportPath: undefined };
    }
    return {
      ...lane,
      status: 'verifying',
      checkpoints: lane.checkpoints.filter((c) => CATALOG_CHECKPOINTS.includes(c.id)),
      stage: 'find',
      reportPath: undefined,
    };
  }
  const steps = lane.steps.slice(0, Math.max(0, position) + 1);
  const current = steps[steps.length - 1];
  const artifact = artifacts.find((a) => a.index === current?.index);
  return {
    ...lane,
    status: 'running',
    steps,
    checkpoints: [],
    costUsd: steps.reduce((sum, s) => sum + (s.usage?.estimatedCostUsd ?? 0), 0),
    stage: stageOf(current?.url),
    latestScreenshotPath: artifact?.screenshotPath,
    latestSnapshotPath: artifact?.snapshotPath,
    reportPath: undefined,
  };
}
