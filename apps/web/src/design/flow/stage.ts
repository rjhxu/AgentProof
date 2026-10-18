import type { AgentKind } from '@agentproof/shared';

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
