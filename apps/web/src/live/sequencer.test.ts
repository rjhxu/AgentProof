import { describe, expect, it } from 'vitest';

import type { RunEvent } from '@agentproof/shared';

import { runsABugged } from '../design/fixtures';
import { initialLanes, isTerminal, type LaneState } from '../design/replay/reduce';
import { buildReplayScript } from '../design/replay/script';
import {
  createSequencer,
  DEFAULT_SEQUENCER_OPTIONS,
  delayFor,
  drainAll,
  enqueueEvent,
  enqueueEvents,
  tick,
  type SequencerState,
} from './sequencer';

/** The recorded runs as the stream would send them, in order, with the replay clock dropped. */
const events: RunEvent[] = buildReplayScript(runsABugged).map((e) => e.event);
const seeds = runsABugged.map((r) => ({ runId: r.runId, agent: r.agent }));
const o = DEFAULT_SEQUENCER_OPTIONS;

type Frame = { at: number; lanes: LaneState[]; nextInMs: number | null };

/** Step a fake clock: tick, sleep exactly what the sequencer asks for, repeat until it rests. */
function play(start: SequencerState, from = 0): { state: SequencerState; frames: Frame[] } {
  let state = start;
  let now = from;
  const frames: Frame[] = [];
  for (let i = 0; i < 10_000; i++) {
    const result = tick(state, now);
    state = result.state;
    frames.push({ at: now, lanes: state.lanes, nextInMs: result.nextInMs });
    if (result.nextInMs === null) break;
    now += result.nextInMs;
  }
  return { state, frames };
}

function laneIn(frame: Frame, index: number): LaneState {
  return frame.lanes[index]!;
}

const fed = enqueueEvents(createSequencer(seeds, 0), events);
const played = play(fed);

describe('sequencer', () => {
  it('starts with every lane queued, nothing buffered and the first seed active', () => {
    const fresh = createSequencer(seeds, 1000);
    expect(fresh.lanes).toEqual(initialLanes(seeds));
    expect(fresh.order).toEqual(seeds.map((s) => s.runId));
    expect(fresh.active).toBe(0);
    expect(fresh.done).toBe(false);
    expect(fresh.lastShownAt).toBe(1000);
    expect(fresh.holdUntil).toBeNull();
    expect(createSequencer([], 0).done).toBe(true);
    expect(createSequencer(seeds, 0, { stepGapMs: 10 }).options).toEqual({ ...o, stepGapMs: 10 });
  });

  it('lets only the first lane change until its verdict', () => {
    const untouched = initialLanes(seeds);
    const firstTerminal = played.frames.findIndex((f) => isTerminal(laneIn(f, 0).status));
    expect(firstTerminal).toBeGreaterThan(0);
    for (const frame of played.frames.slice(0, firstTerminal + 1)) {
      for (let i = 1; i < seeds.length; i++) expect(laneIn(frame, i)).toEqual(untouched[i]);
    }
    expect(laneIn(played.frames[firstTerminal]!, 0).status).toBe('failed');
  });

  it('holds longer after a failure than after a pass', () => {
    const alphaDone = played.frames.find((f) => isTerminal(laneIn(f, 0).status))!;
    expect(alphaDone.nextInMs).toBe(o.failGapMs);
    const betaDone = played.frames.find((f) => isTerminal(laneIn(f, 1).status))!;
    expect(laneIn(betaDone, 1).status).toBe('passed');
    expect(betaDone.nextInMs).toBe(o.laneGapMs);
    // The next lane starts exactly when the hold ends, not before.
    const betaStart = played.frames.find((f) => laneIn(f, 1).status !== 'queued')!;
    expect(betaStart.at).toBe(alphaDone.at + o.failGapMs);
  });

  it('shows the report of a finished lane during its hold, not after it', () => {
    const alphaDone = played.frames.find((f) => isTerminal(laneIn(f, 0).status))!;
    expect(laneIn(alphaDone, 0).reportPath).toBe(`${seeds[0]!.runId}/report.json`);
  });

  it('keeps the steps of a lane at least stepGapMs apart', () => {
    for (let i = 0; i < seeds.length; i++) {
      const stepTimes: number[] = [];
      let seen = 0;
      for (const frame of played.frames) {
        const count = laneIn(frame, i).steps.length;
        if (count > seen) {
          stepTimes.push(frame.at);
          seen = count;
        }
      }
      expect(seen).toBe(runsABugged[i]!.steps.length);
      for (let k = 1; k < stepTimes.length; k++) {
        expect(stepTimes[k]! - stepTimes[k - 1]!).toBeGreaterThanOrEqual(o.stepGapMs);
      }
    }
  });

  it('waits verifyDelayMs before the verdict begins and terminalDelayMs before it lands', () => {
    const lastStep = played.frames.find(
      (f) => laneIn(f, 0).steps.length === runsABugged[0]!.steps.length,
    )!;
    const verifying = played.frames.find((f) => laneIn(f, 0).status === 'verifying')!;
    expect(verifying.at - lastStep.at).toBe(o.verifyDelayMs);
    const allCheckpoints = played.frames.find(
      (f) => laneIn(f, 0).checkpoints.length === runsABugged[0]!.checkpoints.length,
    )!;
    const verdict = played.frames.find((f) => isTerminal(laneIn(f, 0).status))!;
    expect(verdict.at - allCheckpoints.at).toBe(o.terminalDelayMs);
  });

  it('plays every lane in seed order and ends done with every lane at its verdict', () => {
    const starts = seeds.map(
      (_, i) => played.frames.find((f) => laneIn(f, i).status !== 'queued')!.at,
    );
    for (let i = 1; i < starts.length; i++) expect(starts[i]!).toBeGreaterThan(starts[i - 1]!);
    expect(played.state.done).toBe(true);
    expect(played.state.active).toBe(seeds.length);
    for (const report of runsABugged) {
      const lane = played.state.lanes.find((l) => l.runId === report.runId)!;
      expect(lane.status).toBe(report.status);
      expect(lane.steps).toHaveLength(report.steps.length);
      expect(lane.checkpoints).toHaveLength(report.checkpoints.length);
      expect(lane.reportPath).toBe(`${report.runId}/report.json`);
    }
    expect(Object.values(played.state.queues).every((q) => q.length === 0)).toBe(true);
  });

  it('rests when the active lane has nothing queued and resumes when events arrive', () => {
    const alphaOnly = events.filter((e) => e.runId === seeds[0]!.runId);
    const { state, frames } = play(enqueueEvents(createSequencer(seeds, 0), alphaOnly));
    const last = frames[frames.length - 1]!;
    expect(last.nextInMs).toBeNull();
    expect(state.done).toBe(false);
    expect(state.active).toBe(1);
    expect(laneIn(last, 1).status).toBe('queued');
    const betaOnly = events.filter((e) => e.runId === seeds[1]!.runId);
    const resumed = play(enqueueEvents(state, betaOnly), last.at);
    expect(resumed.state.active).toBe(2);
    expect(resumed.state.lanes[1]!.status).toBe('passed');
  });

  it('promotes past a lane a snapshot already finished without a hold', () => {
    const alphaOnly = events.filter((e) => e.runId === seeds[0]!.runId);
    const drained = drainAll(enqueueEvents(createSequencer(seeds, 0), alphaOnly));
    expect(drained.lanes[0]!.status).toBe('failed');
    expect(drained.active).toBe(1);
    expect(drained.done).toBe(false);
    const betaOnly = events.filter((e) => e.runId === seeds[1]!.runId);
    const { frames } = play(enqueueEvents(drained, betaOnly), 5000);
    expect(laneIn(frames[0]!, 1).status).toBe('running');
    expect(frames[0]!.at).toBe(5000);
  });

  it('drains everything at once and is then done', () => {
    const drained = drainAll(fed);
    expect(drained.done).toBe(true);
    expect(drained.active).toBe(seeds.length);
    expect(drained.holdUntil).toBeNull();
    for (const report of runsABugged) {
      const lane = drained.lanes.find((l) => l.runId === report.runId)!;
      expect(isTerminal(lane.status)).toBe(true);
      expect(lane.status).toBe(report.status);
      expect(lane.steps).toHaveLength(report.steps.length);
    }
    expect(Object.values(drained.queues).every((q) => q.length === 0)).toBe(true);
    // Once done, anything that still arrives shows at once.
    const late: RunEvent = {
      type: 'log',
      runId: seeds[0]!.runId,
      message: 'late',
      at: '2026-10-18T03:27:41.000Z',
    };
    const after = tick(enqueueEvent(drained, late), 99_999);
    expect(after.nextInMs).toBeNull();
    expect(Object.values(after.state.queues).every((q) => q.length === 0)).toBe(true);
  });

  it('ignores an event for a run it does not know', () => {
    const fresh = createSequencer(seeds, 0);
    const stray: RunEvent = {
      type: 'status',
      runId: 'run_000000000000',
      status: 'running',
      at: '2026-10-18T03:27:05.000Z',
    };
    expect(enqueueEvent(fresh, stray)).toBe(fresh);
    expect(enqueueEvents(fresh, [stray, stray])).toBe(fresh);
  });

  it('applies a report event at once', () => {
    const runId = seeds[0]!.runId;
    const at = '2026-10-18T03:27:05.000Z';
    const fresh = enqueueEvents(createSequencer([seeds[0]!], 0), [
      { type: 'status', runId, status: 'running', at },
      { type: 'report', runId, reportPath: `${runId}/report.json`, at },
    ]);
    const { state, nextInMs } = tick(fresh, 0);
    expect(nextInMs).toBeNull();
    expect(state.lanes[0]!.status).toBe('running');
    expect(state.lanes[0]!.reportPath).toBe(`${runId}/report.json`);
    expect(state.lastShownAt).toBe(0);
  });

  it('returns the same state object when a tick changes nothing', () => {
    const fresh = createSequencer(seeds, 0);
    expect(tick(fresh, 10).state).toBe(fresh);
    const waiting = tick(fed, 0);
    expect(tick(waiting.state, 1).state).toBe(waiting.state);
  });

  it('does not spend the step gap on a repeated step', () => {
    const runId = seeds[0]!.runId;
    const step = runsABugged[0]!.steps[0]!;
    const at = '2026-10-18T03:27:05.000Z';
    const fresh = enqueueEvents(createSequencer([seeds[0]!], 0), [
      { type: 'status', runId, status: 'running', at },
      { type: 'step', runId, step },
      { type: 'step', runId, step },
      { type: 'step', runId, step: runsABugged[0]!.steps[1]! },
    ]);
    const first = tick(fresh, o.stepGapMs);
    expect(first.state.lanes[0]!.steps).toHaveLength(1);
    // The duplicate was dropped without resetting the clock, so the second step is due in one gap.
    expect(first.nextInMs).toBe(o.stepGapMs);
    const second = tick(first.state, 2 * o.stepGapMs);
    expect(second.state.lanes[0]!.steps.map((s) => s.index)).toEqual([0, 1]);
  });
});

describe('delayFor', () => {
  const runId = 'run_x';
  const at = '2026-10-18T03:27:05.000Z';
  it('paces steps, checkpoints, verifying and verdicts; everything else shows at once', () => {
    const step = runsABugged[0]!.steps[0]!;
    const checkpoint = runsABugged[0]!.checkpoints[0]!;
    expect(delayFor({ type: 'step', runId, step }, o)).toBe(o.stepGapMs);
    expect(delayFor({ type: 'checkpoint', runId, checkpoint }, o)).toBe(o.checkpointGapMs);
    expect(delayFor({ type: 'status', runId, status: 'verifying', at }, o)).toBe(o.verifyDelayMs);
    for (const status of ['passed', 'failed', 'error', 'cancelled'] as const) {
      expect(delayFor({ type: 'status', runId, status, at }, o)).toBe(o.terminalDelayMs);
    }
    expect(delayFor({ type: 'status', runId, status: 'running', at }, o)).toBe(0);
    expect(delayFor({ type: 'status', runId, status: 'queued', at }, o)).toBe(0);
    expect(delayFor({ type: 'report', runId, reportPath: 'x/report.json', at }, o)).toBe(0);
    expect(delayFor({ type: 'log', runId, message: 'm', at }, o)).toBe(0);
    expect(
      delayFor(
        {
          type: 'evidence',
          runId,
          evidence: { id: 'ev_1', runId, kind: 'screenshot', capturedAt: at, path: 'x/0.png' },
        },
        o,
      ),
    ).toBe(0);
  });
});
