import type { RunEvent } from '@agentproof/shared';

import {
  initialLanes,
  isTerminal,
  reduceLanes,
  type LaneSeed,
  type LaneState,
} from '../design/replay/reduce';

/*
 * One shopper at a time. The runner starts runs in parallel (two at a time) and streams each
 * run's events as they happen; the Scan step shows one shopper on stage in stage order, at a
 * readable pace, and holds a finished shopper on stage before the next one starts. This module
 * is the queue between the two: pure, no timers, the caller's clock passed in. The hook calls
 * `tick` when events arrive and again after `nextInMs`.
 */

export type SequencerOptions = {
  /** Minimum gap between two browsing steps on stage. */
  stepGapMs: number;
  /** Between checkpoints in the burst after verification. */
  checkpointGapMs: number;
  /** From the last step to "verifying". */
  verifyDelayMs: number;
  /** From the last checkpoint to the verdict. */
  terminalDelayMs: number;
  /** How long a shopper that passed holds the stage before the next one starts. */
  laneGapMs: number;
  /** The same hold after a failure: the freeze frame is the moment worth reading. */
  failGapMs: number;
};

export const DEFAULT_SEQUENCER_OPTIONS: SequencerOptions = {
  stepGapMs: 600,
  checkpointGapMs: 60,
  verifyDelayMs: 500,
  terminalDelayMs: 400,
  laneGapMs: 1200,
  failGapMs: 2800,
};

export type SequencerState = {
  lanes: LaneState[];
  /** Run ids in stage order. */
  order: string[];
  /** Events received and not yet applied, per run id. */
  queues: Record<string, RunEvent[]>;
  /** Index into `order` of the lane on stage; `order.length` once every lane has had its turn. */
  active: number;
  /** When the last paced event was applied, on the caller's clock. */
  lastShownAt: number;
  /** While set, the finished lane holds the stage until this time on the caller's clock. */
  holdUntil: number | null;
  done: boolean;
  options: SequencerOptions;
};

export function createSequencer(
  seeds: LaneSeed[],
  now: number,
  options: Partial<SequencerOptions> = {},
): SequencerState {
  const order = seeds.map((seed) => seed.runId);
  return {
    lanes: initialLanes(seeds),
    order,
    queues: Object.fromEntries(order.map((runId) => [runId, [] as RunEvent[]])),
    active: 0,
    lastShownAt: now,
    holdUntil: null,
    done: seeds.length === 0,
    options: { ...DEFAULT_SEQUENCER_OPTIONS, ...options },
  };
}

/** Buffer an event for its run. Events for a run the sequencer does not know are ignored. */
export function enqueueEvent(state: SequencerState, event: RunEvent): SequencerState {
  const queue = state.queues[event.runId];
  if (!queue) return state;
  return { ...state, queues: { ...state.queues, [event.runId]: [...queue, event] } };
}

export function enqueueEvents(state: SequencerState, events: RunEvent[]): SequencerState {
  return events.reduce(enqueueEvent, state);
}

/** How long an event waits after the previous paced event before it shows; 0 shows at once. */
export function delayFor(event: RunEvent, options: SequencerOptions): number {
  switch (event.type) {
    case 'step':
      return options.stepGapMs;
    case 'checkpoint':
      return options.checkpointGapMs;
    case 'status':
      if (event.status === 'verifying') return options.verifyDelayMs;
      return isTerminal(event.status) ? options.terminalDelayMs : 0;
    default:
      return 0;
  }
}

function laneOf(lanes: LaneState[], runId: string): LaneState | undefined {
  return lanes.find((lane) => lane.runId === runId);
}

/**
 * Advance the sequencer to `now`. Only the active lane drains; the others buffer, so
 * `stageLane()` sees exactly one started lane at a time. Returns how long until the next paced
 * event or the end of a hold, or null when the active lane has nothing queued (the hook calls
 * tick again when events arrive) or the show is over.
 */
export function tick(
  state: SequencerState,
  now: number,
): { state: SequencerState; nextInMs: number | null } {
  let lanes = state.lanes;
  const queues = { ...state.queues };
  let active = state.active;
  let lastShownAt = state.lastShownAt;
  let holdUntil = state.holdUntil;
  let done = state.done;
  let changed = false;
  let nextInMs: number | null = null;

  const apply = (event: RunEvent): boolean => {
    const before = laneOf(lanes, event.runId);
    lanes = reduceLanes(lanes, event);
    changed = true;
    return laneOf(lanes, event.runId) !== before;
  };
  const flush = (runId: string): void => {
    for (const event of queues[runId] ?? []) apply(event);
    queues[runId] = [];
  };

  if (done) {
    // The show is over; whatever still arrives (a late log, a report path) shows at once.
    for (const runId of state.order) if ((queues[runId] ?? []).length > 0) flush(runId);
    return changed
      ? { state: { ...state, lanes, queues }, nextInMs: null }
      : { state, nextInMs: null };
  }

  for (;;) {
    const runId = state.order[active];
    if (runId === undefined) {
      done = true;
      changed = true;
      break;
    }
    const queue = queues[runId] ?? [];
    const head = queue[0];

    if (holdUntil !== null) {
      // The finished lane holds the stage. Bookkeeping that arrives meanwhile (its report path)
      // shows at once; when the hold ends, anything left is flushed and the next lane starts.
      if (head && delayFor(head, state.options) === 0) {
        apply(head);
        queues[runId] = queue.slice(1);
        continue;
      }
      if (now >= holdUntil) {
        flush(runId);
        holdUntil = null;
        active += 1;
        changed = true;
        continue;
      }
      nextInMs = holdUntil - now;
      break;
    }

    if (!head) {
      // Already finished with nothing left to show (a snapshot drained it): the next lane goes on.
      const lane = laneOf(lanes, runId);
      if (lane && isTerminal(lane.status)) {
        active += 1;
        changed = true;
        continue;
      }
      nextInMs = null;
      break;
    }

    const delay = delayFor(head, state.options);
    const waited = now - lastShownAt;
    if (delay === 0 || waited >= delay) {
      const before = laneOf(lanes, runId);
      const moved = apply(head);
      queues[runId] = queue.slice(1);
      // A repeated event (the snapshot and the stream both carried it) does not spend the gap.
      if (delay > 0 && moved) lastShownAt = now;
      if (
        head.type === 'status' &&
        isTerminal(head.status) &&
        before !== undefined &&
        !isTerminal(before.status)
      ) {
        holdUntil =
          now + (head.status === 'passed' ? state.options.laneGapMs : state.options.failGapMs);
      }
      continue;
    }
    nextInMs = delay - waited;
    break;
  }

  if (!changed) return { state, nextInMs };
  return {
    state: { ...state, lanes, queues, active, lastShownAt, holdUntil, done },
    nextInMs,
  };
}

/**
 * Apply every queued event of every lane at once, clear any hold, and move the stage to the
 * first lane that has not finished (or past the end, which is done). For "skip to the end".
 */
export function drainAll(state: SequencerState): SequencerState {
  let lanes = state.lanes;
  for (const runId of state.order) {
    for (const event of state.queues[runId] ?? []) lanes = reduceLanes(lanes, event);
  }
  const queues = Object.fromEntries(state.order.map((runId) => [runId, [] as RunEvent[]]));
  const firstOpen = state.order.findIndex((runId) => {
    const lane = laneOf(lanes, runId);
    return lane !== undefined && !isTerminal(lane.status);
  });
  const active = firstOpen < 0 ? state.order.length : firstOpen;
  return {
    ...state,
    lanes,
    queues,
    active,
    holdUntil: null,
    done: active >= state.order.length,
  };
}
