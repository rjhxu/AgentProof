import type { AgentReport, RunEvent } from '@agentproof/shared';

/** A run event and when it fires, in milliseconds from the start of the replay. */
export type ReplayEvent = { at: number; event: RunEvent };

export type ReplayOptions = {
  /** Target median gap between a browsing agent's steps at 1x. */
  stepGapMs: number;
  /** Delay between one browsing lane starting and the next. */
  laneStaggerMs: number;
  /** From a lane's last step to "verifying". */
  verifyDelayMs: number;
  /** Between checkpoints in the burst after verification. */
  checkpointGapMs: number;
  /** When an agent with no browser steps (Gamma) reaches its verdict. */
  noBrowserFinishMs: number;
  /**
   * One shopper at a time: each browsing lane starts after the previous one's report instead
   * of all of them at once. Gamma keeps its own timing. The live runner still runs them in
   * parallel; a sequencer in front of the reducer gives the same order at wiring.
   */
  sequential: boolean;
  /** In sequential mode, the hold between one lane's report and the next lane's start. */
  laneGapMs: number;
  /** The same hold after a lane that failed: the freeze frame is the moment worth reading. */
  failGapMs: number;
};

export const DEFAULT_REPLAY_OPTIONS: ReplayOptions = {
  stepGapMs: 600,
  laneStaggerMs: 150,
  verifyDelayMs: 500,
  checkpointGapMs: 60,
  noBrowserFinishMs: 1300,
  sequential: false,
  laneGapMs: 1200,
  failGapMs: 2800,
};

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const low = sorted[mid - 1];
  const high = sorted[mid];
  if (high === undefined) return 0;
  return sorted.length % 2 === 0 && low !== undefined ? (low + high) / 2 : high;
}

/** Time before each recorded step: the model's latency before the first, the gap after. */
function gapsBefore(report: AgentReport): number[] {
  const times = report.steps.map((s) => Date.parse(s.at));
  const diffs: number[] = [];
  for (let i = 1; i < times.length; i++) {
    const prev = times[i - 1];
    const cur = times[i];
    if (prev !== undefined && cur !== undefined && Number.isFinite(prev) && Number.isFinite(cur)) {
      diffs.push(Math.max(0, cur - prev));
    }
  }
  const first = median(diffs) || 1000;
  return [first, ...diffs];
}

/**
 * Turn recorded run reports into the events a live run would stream, on a compressed
 * clock. Step pacing keeps the recorded proportions (a slower agent stays slower), the
 * checkpoints arrive in one burst after "verifying" because that is how the runner emits
 * them, and an agent with no browser steps finishes first.
 */
export function buildReplayScript(
  reports: AgentReport[],
  options: Partial<ReplayOptions> = {},
): ReplayEvent[] {
  const o = { ...DEFAULT_REPLAY_OPTIONS, ...options };
  const events: ReplayEvent[] = [];
  const push = (at: number, event: RunEvent) => events.push({ at: Math.round(at), event });

  const browsing = reports.filter((r) => r.steps.length > 0);
  const base = median(browsing.flatMap((r) => gapsBefore(r).slice(1))) || 1000;
  const scale = o.stepGapMs / base;

  let laneIndex = 0;
  let previousReportAt = 0;
  let previousFailed = false;
  for (const report of reports) {
    const runId = report.runId;
    const stamp = report.steps[0]?.at ?? report.generatedAt;
    const status = (at: number, value: AgentReport['status']) =>
      push(at, { type: 'status', runId, status: value, at: stamp });

    if (report.steps.length === 0) {
      // On its own clock from zero in parallel mode; in its turn in sequential mode.
      const base = o.sequential
        ? laneIndex === 0
          ? 0
          : previousReportAt + (previousFailed ? o.failGapMs : o.laneGapMs)
        : 0;
      if (o.sequential) laneIndex += 1;
      status(base + 60, 'running');
      const verifyAt = base + Math.max(160, o.noBrowserFinishMs * 0.4);
      status(verifyAt, 'verifying');
      let t = verifyAt + 200;
      for (const checkpoint of report.checkpoints) {
        push(t, { type: 'checkpoint', runId, checkpoint });
        t += o.checkpointGapMs;
      }
      const finishAt = Math.max(t + 100, base + o.noBrowserFinishMs);
      status(finishAt, report.status);
      push(finishAt + 50, {
        type: 'report',
        runId,
        reportPath: `${runId}/report.json`,
        at: report.generatedAt,
      });
      if (o.sequential) {
        previousReportAt = finishAt + 50;
        previousFailed = report.status !== 'passed';
      }
      continue;
    }

    const start = o.sequential
      ? laneIndex === 0
        ? 0
        : previousReportAt + (previousFailed ? o.failGapMs : o.laneGapMs)
      : laneIndex * o.laneStaggerMs;
    laneIndex += 1;
    status(start, 'running');

    const gaps = gapsBefore(report);
    let t = start;
    report.steps.forEach((step, index) => {
      t += (gaps[index] ?? base) * scale;
      if (step.snapshotPath) {
        push(t - 2, {
          type: 'evidence',
          runId,
          evidence: {
            id: step.snapshotEvidenceId ?? `ev_replay_${runId}_${index}_aria`,
            runId,
            kind: 'dom_snapshot',
            stepIndex: step.index,
            capturedAt: step.at,
            path: step.snapshotPath,
          },
        });
      }
      if (step.screenshotPath) {
        push(t - 1, {
          type: 'evidence',
          runId,
          evidence: {
            id: step.screenshotEvidenceId ?? `ev_replay_${runId}_${index}`,
            runId,
            kind: 'screenshot',
            stepIndex: step.index,
            capturedAt: step.at,
            path: step.screenshotPath,
          },
        });
      }
      push(t, { type: 'step', runId, step });
    });

    const verifyAt = t + o.verifyDelayMs;
    status(verifyAt, 'verifying');
    let c = verifyAt + 150;
    for (const checkpoint of report.checkpoints) {
      push(c, { type: 'checkpoint', runId, checkpoint });
      c += o.checkpointGapMs;
    }
    status(c + 100, report.status);
    push(c + 150, {
      type: 'report',
      runId,
      reportPath: `${runId}/report.json`,
      at: report.generatedAt,
    });
    previousReportAt = c + 150;
    previousFailed = report.status !== 'passed';
  }

  return events.sort((a, b) => a.at - b.at);
}

export function scriptDurationMs(script: ReplayEvent[]): number {
  return script.length === 0 ? 0 : (script[script.length - 1]?.at ?? 0);
}
