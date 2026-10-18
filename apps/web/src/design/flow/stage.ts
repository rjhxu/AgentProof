import type { LaneState } from '../replay/reduce';

/** The shoppers: every lane with a browser. Gamma checks the catalog and never takes the stage. */
export function browsingLanes(lanes: LaneState[]): LaneState[] {
  return lanes.filter((l) => l.agent.kind !== 'gamma_structured');
}

export function gammaLane(lanes: LaneState[]): LaneState | undefined {
  return lanes.find((l) => l.agent.kind === 'gamma_structured');
}

/**
 * Who is on stage: the last shopper that has started. Shoppers start one after another, so a
 * finished one holds the stage until the next one starts, which is the freeze frame.
 */
export function stageLane(lanes: LaneState[]): LaneState | undefined {
  const started = browsingLanes(lanes).filter((l) => l.status !== 'queued');
  return started[started.length - 1];
}

/** The shopper waiting to go next, if any. */
export function nextLane(lanes: LaneState[]): LaneState | undefined {
  return browsingLanes(lanes).find((l) => l.status === 'queued');
}

/** The widest cost bar: the most expensive shopper so far. Zero before anyone has spent. */
export function costScale(lanes: LaneState[]): number {
  return lanes.reduce((max, l) => Math.max(max, l.costUsd), 0);
}
