import { useCallback, useEffect, useState } from 'react';

import { initialLanes, isTerminal, reduceLanes, type LaneSeed, type LaneState } from './reduce';
import type { ReplayEvent } from './script';

export type ReplayOptionsInput = {
  speed?: number;
  autoplay?: boolean;
  /** Apply every event up to this time before the first render. Infinity means the end. */
  startAtMs?: number;
};

export type Replay = {
  lanes: LaneState[];
  elapsedMs: number;
  done: boolean;
  playing: boolean;
  speed: number;
  play: () => void;
  pause: () => void;
  restart: () => void;
  seekToEnd: () => void;
  setSpeed: (speed: number) => void;
};

type ReplayState = {
  lanes: LaneState[];
  cursor: number;
  elapsedMs: number;
  playing: boolean;
  speed: number;
};

function advanceTo(state: ReplayState, script: ReplayEvent[], targetMs: number): ReplayState {
  let { lanes, cursor } = state;
  while (cursor < script.length) {
    const next = script[cursor];
    if (!next || next.at > targetMs) break;
    lanes = reduceLanes(lanes, next.event);
    cursor += 1;
  }
  const last = script[cursor - 1];
  return {
    ...state,
    lanes,
    cursor,
    elapsedMs: Number.isFinite(targetMs) ? targetMs : (last?.at ?? state.elapsedMs),
  };
}

/**
 * Plays a replay script into lane state on a timer, in the browser only. Server rendering
 * sees the state at `startAtMs`, so a URL like ?t=end renders the finished scan with no
 * flash. Everything the Scan step shows comes out of `lanes`.
 */
export function useReplay(
  script: ReplayEvent[],
  seeds: LaneSeed[],
  options: ReplayOptionsInput = {},
): Replay {
  const { speed: initialSpeed = 1, autoplay = true, startAtMs = 0 } = options;

  const [state, setState] = useState<ReplayState>(() =>
    advanceTo(
      {
        lanes: initialLanes(seeds),
        cursor: 0,
        elapsedMs: 0,
        playing: autoplay,
        speed: initialSpeed,
      },
      script,
      startAtMs,
    ),
  );

  const finished = state.cursor >= script.length;

  useEffect(() => {
    if (!state.playing || finished) return;
    const next = script[state.cursor];
    if (!next) return;
    const delay = Math.max(0, (next.at - state.elapsedMs) / state.speed);
    const id = setTimeout(() => {
      setState((s) => advanceTo(s, script, next.at));
    }, delay);
    return () => clearTimeout(id);
  }, [state.playing, state.cursor, state.elapsedMs, state.speed, finished, script]);

  const play = useCallback(() => setState((s) => ({ ...s, playing: true })), []);
  const pause = useCallback(() => setState((s) => ({ ...s, playing: false })), []);
  const restart = useCallback(
    () =>
      setState((s) => ({
        lanes: initialLanes(seeds),
        cursor: 0,
        elapsedMs: 0,
        playing: true,
        speed: s.speed,
      })),
    [seeds],
  );
  const seekToEnd = useCallback(
    () => setState((s) => ({ ...advanceTo(s, script, Infinity), playing: false })),
    [script],
  );
  const setSpeed = useCallback((speed: number) => setState((s) => ({ ...s, speed })), []);

  const done = finished || state.lanes.every((lane) => isTerminal(lane.status));

  return {
    lanes: state.lanes,
    elapsedMs: state.elapsedMs,
    done,
    playing: state.playing,
    speed: state.speed,
    play,
    pause,
    restart,
    seekToEnd,
    setSpeed,
  };
}
