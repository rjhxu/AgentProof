import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AgentReport,
  Evidence,
  FailurePoint,
  ObservedCart,
  Run,
  RunEvent,
} from '@agentproof/shared';

import type { StepArtifact } from '../design/flow/stage';
import { initialLanes, type LaneState } from '../design/replay/reduce';
import { api } from '../lib/api';
import {
  eventsFromRun,
  isTerminalStatus,
  seedFromRun,
  stepArtifactsFromEvidence,
  stepArtifactsFromReport,
} from './hydrate';
import {
  createSequencer,
  drainAll,
  enqueueEvent,
  enqueueEvents,
  tick,
  type SequencerState,
} from './sequencer';

/*
 * The Scan step's feed from the runner. One EventSource per run goes into the sequencer, which
 * paces the four parallel runs into one shopper at a time for the stage. Each stream loads the
 * saved run (GET /runs/:id) when it opens, the first time and on every reconnection, so nothing
 * can fall between the snapshot and the subscription; the reducer drops what both carried.
 * Everything the stage needs besides the lanes (accessibility-tree snapshots, failure points,
 * carts, where each step's frame lives) is fetched here as the events arrive, before pacing.
 * A run whose report never came is named, so the page can stop waiting for it. Browser only.
 */

export type LiveScanOptions = {
  /** Called once per run with the saved run (verification included) after its terminal status. */
  onRunFinished?: (run: Run) => void;
  /** false drains every event at once instead of pacing them; the default paces. */
  paced?: boolean;
};

export type LiveScan = {
  lanes: LaneState[];
  /** The sequencer has shown everything: every lane is terminal and nothing is queued. */
  done: boolean;
  /** Every run has sent its terminal status, whether or not the stage has shown it yet. */
  allFinished: boolean;
  /** Run id -> its report, once the run finished and the runner wrote it. */
  reports: Record<string, AgentReport>;
  /** Run ids whose report could not be fetched after the retries: none will come. */
  reportFailures: string[];
  /** Run id -> the saved run after its terminal status, verification included. */
  finalRuns: Record<string, Run>;
  /** Artifact path -> the accessibility-tree text at that path. */
  snapshots: Record<string, string>;
  /** Run id -> where each step's frame and snapshot live. */
  stepArtifacts: Record<string, StepArtifact[]>;
  failurePoints: Record<string, FailurePoint>;
  observedCarts: Record<string, ObservedCart>;
  /** Show the rest at once: nothing stays paced after this. */
  skipToEnd: () => void;
};

type ScanData = Omit<LiveScan, 'lanes' | 'done' | 'skipToEnd'> & { key: string };
type LaneView = { key: string; lanes: LaneState[]; done: boolean };

const REPORT_RETRIES = 8;
const REPORT_RETRY_MS = 750;

function emptyData(key: string): ScanData {
  return {
    key,
    allFinished: false,
    reports: {},
    reportFailures: [],
    finalRuns: {},
    snapshots: {},
    stepArtifacts: {},
    failurePoints: {},
    observedCarts: {},
  };
}

const EMPTY_DATA = emptyData('');

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function fetchText(url: string): Promise<string | undefined> {
  try {
    const res = await fetch(url, { cache: 'no-store' });
    return res.ok ? await res.text() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The run's report. jobs.ts writes it before the terminal status, so it is normally there on the
 * first try; the retries cover the window where the write is still in flight ("report not
 * ready") and a dropped request. Undefined when the runner never produced one.
 */
async function fetchReport(runId: string): Promise<AgentReport | undefined> {
  for (let attempt = 0; ; attempt++) {
    try {
      return (await api.getRunReport(runId)).report;
    } catch {
      if (attempt >= REPORT_RETRIES) return undefined;
      await sleep(REPORT_RETRY_MS);
    }
  }
}

export function useLiveScan(runs: Run[], opts: LiveScanOptions = {}): LiveScan {
  // Everything is keyed by the run ids: a new set of runs is a new scan.
  const key = runs.map((r) => r.id).join(',');
  const seeds = useMemo(() => runs.map(seedFromRun), [runs]);
  const [view, setView] = useState<LaneView>({ key: '', lanes: [], done: false });
  const [data, setData] = useState<ScanData>(EMPTY_DATA);
  const runsRef = useRef(runs);
  runsRef.current = runs;
  const onFinished = useRef(opts.onRunFinished);
  onFinished.current = opts.onRunFinished;
  const pacedOption = useRef(opts.paced !== false);
  pacedOption.current = opts.paced !== false;
  const generation = useRef(0);
  const controls = useRef<{ skipToEnd: () => void } | null>(null);

  useEffect(() => {
    if (key === '') return;
    const gen = ++generation.current;
    const alive = () => generation.current === gen;
    const current = runsRef.current;
    const ids = current.map((r) => r.id);
    const paced = { current: pacedOption.current };

    let seq: SequencerState = createSequencer(current.map(seedFromRun), Date.now());
    let timer: ReturnType<typeof setTimeout> | null = null;
    const sources: EventSource[] = [];
    const evidenceByRun = new Map<string, Evidence[]>();
    const fetchedSnapshots = new Set<string>();
    const terminal = new Set<string>();
    const finished = new Set<string>();
    const reported = new Set<string>();

    setView({ key, lanes: seq.lanes, done: seq.done });
    setData(emptyData(key));

    const patch = (fn: (d: ScanData) => ScanData) => {
      if (alive()) setData((d) => fn(d.key === key ? d : emptyData(key)));
    };
    const render = () => {
      if (alive()) setView({ key, lanes: seq.lanes, done: seq.done });
    };
    const clearTimer = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    };
    /** Show what is due now and come back when the sequencer says; or everything, unpaced. */
    const pump = () => {
      clearTimer();
      if (!alive()) return;
      if (!paced.current) {
        seq = drainAll(seq);
        render();
        return;
      }
      const out = tick(seq, Date.now());
      seq = out.state;
      render();
      if (out.nextInMs !== null) timer = setTimeout(pump, Math.max(0, out.nextInMs));
    };

    const rememberSnapshot = (path: string) => {
      if (fetchedSnapshots.has(path)) return;
      fetchedSnapshots.add(path);
      void fetchText(api.artifactUrl(path)).then((text) => {
        if (text !== undefined) {
          patch((d) => ({ ...d, snapshots: { ...d.snapshots, [path]: text } }));
        }
      });
    };

    /** After a run's terminal status: its report, the saved run, and the caller's callback. */
    const finish = async (runId: string) => {
      if (finished.has(runId)) return;
      finished.add(runId);
      if (finished.size >= ids.length) patch((d) => ({ ...d, allFinished: true }));
      const [report, saved] = await Promise.all([
        fetchReport(runId),
        api
          .getRun(runId)
          .then((r) => r.run)
          .catch(() => undefined),
      ]);
      if (!alive()) return;
      if (report) {
        reported.add(runId);
        // The lane was seeded from the run; the report carries the agent's real name and model.
        seq = {
          ...seq,
          lanes: seq.lanes.map((l) => (l.runId === runId ? { ...l, agent: report.agent } : l)),
        };
        render();
        patch((d) => ({
          ...d,
          reports: { ...d.reports, [runId]: report },
          stepArtifacts: { ...d.stepArtifacts, [runId]: stepArtifactsFromReport(report) },
          ...(report.failurePoint
            ? { failurePoints: { ...d.failurePoints, [runId]: report.failurePoint } }
            : {}),
          ...(report.observedCart
            ? { observedCarts: { ...d.observedCarts, [runId]: report.observedCart } }
            : {}),
        }));
        if (report.failurePoint?.snapshotPath) rememberSnapshot(report.failurePoint.snapshotPath);
      } else {
        // The retries are spent: the page should not wait for this report.
        patch((d) => ({ ...d, reportFailures: [...d.reportFailures, runId] }));
      }
      if (saved) patch((d) => ({ ...d, finalRuns: { ...d.finalRuns, [runId]: saved } }));
      const finalRun = saved ?? runsRef.current.find((r) => r.id === runId);
      if (finalRun) onFinished.current?.(finalRun);
    };

    /** What an event means beyond the lane it updates. Runs before pacing, once per event. */
    const sideEffects = (event: RunEvent) => {
      if (event.type === 'evidence') {
        const { kind, path } = event.evidence;
        if (!path) return;
        if (kind === 'dom_snapshot') rememberSnapshot(path);
        const list = evidenceByRun.get(event.runId) ?? [];
        if (!list.some((e) => e.id === event.evidence.id)) list.push(event.evidence);
        evidenceByRun.set(event.runId, list);
        // Until the report names every step's artifacts, the evidence seen so far does.
        if (!reported.has(event.runId)) {
          const artifacts = stepArtifactsFromEvidence([...list]);
          patch((d) => ({ ...d, stepArtifacts: { ...d.stepArtifacts, [event.runId]: artifacts } }));
        }
      } else if (event.type === 'status' && isTerminalStatus(event.status)) {
        terminal.add(event.runId);
        void finish(event.runId);
      }
    };

    const handle = (event: RunEvent) => {
      seq = enqueueEvent(seq, event);
      sideEffects(event);
      pump();
    };

    /** The saved run as events: what the stream does not replay. The sequencer dedupes. */
    const absorb = (run: Run) => {
      // A finished run is already in whole; loading it again would only queue a repeat.
      if (terminal.has(run.id)) return;
      const events = eventsFromRun(run);
      seq = enqueueEvents(seq, events);
      for (const event of events) sideEffects(event);
      if (isTerminalStatus(run.status)) {
        terminal.add(run.id);
        void finish(run.id);
      }
      pump();
    };

    /**
     * Open the stream, and load the saved run once the subscription is live. The first messages
     * wait until that run is in, so the lane starts from the snapshot and the stream adds to it.
     */
    const connect = (run: Run) => {
      const es = new EventSource(api.runEventsUrl(run.id));
      sources.push(es);
      let hydrated = false;
      const pending: RunEvent[] = [];
      es.onmessage = (msg) => {
        if (!alive()) return;
        let event: RunEvent;
        try {
          event = JSON.parse(msg.data as string) as RunEvent;
        } catch {
          return;
        }
        if (hydrated) handle(event);
        else pending.push(event);
      };
      es.onopen = () => {
        // The subscription is live from here, so the saved run plus what the stream sends from
        // now on is the whole run. On every open, not only the first: the stream does not replay
        // what a dropped connection missed, so a reconnection loads the run again to fill the gap.
        if (!alive()) return;
        void api
          .getRun(run.id)
          .then(({ run: saved }) => {
            if (alive()) absorb(saved);
          })
          .catch(() => undefined)
          .then(() => {
            if (hydrated || !alive()) return;
            hydrated = true;
            for (const event of pending.splice(0)) handle(event);
          });
      };
      es.onerror = () => {
        // The runner ends the stream after the terminal status, which the browser reports here.
        if (!alive() || terminal.has(run.id)) {
          es.close();
          return;
        }
        // A real drop: hold what the reconnected stream sends until its open has loaded the saved
        // run, so the missed events land before the live tail, as on the first open.
        hydrated = false;
        void api
          .getRun(run.id)
          .then(({ run: saved }) => {
            if (!alive()) return;
            if (isTerminalStatus(saved.status)) {
              absorb(saved);
              es.close();
            }
            // Otherwise the stream reconnects on its own and onopen loads the run again.
          })
          .catch(() => undefined);
      };
    };

    void (async () => {
      // Whether to pace is settled before the streams open. A finished scan (a resumed mission)
      // shows at once; nothing is left to watch. The lanes fill from each stream's open, not here.
      const saved = await Promise.all(
        current.map((r) =>
          api
            .getRun(r.id)
            .then((x) => x.run)
            .catch(() => undefined),
        ),
      );
      if (!alive()) return;
      if (saved.every((run) => run !== undefined && isTerminalStatus(run.status))) {
        paced.current = false;
      }
      for (const run of current) connect(run);
    })();

    controls.current = {
      skipToEnd: () => {
        paced.current = false;
        pump();
      },
    };

    return () => {
      generation.current++;
      clearTimer();
      for (const es of sources) es.close();
      controls.current = null;
    };
  }, [key]);

  const skipToEnd = useCallback(() => controls.current?.skipToEnd(), []);

  const lanes = view.key === key ? view.lanes : initialLanes(seeds);
  const shown = data.key === key ? data : EMPTY_DATA;

  return {
    lanes,
    done: view.key === key && view.done,
    allFinished: shown.allFinished,
    reports: shown.reports,
    reportFailures: shown.reportFailures,
    finalRuns: shown.finalRuns,
    snapshots: shown.snapshots,
    stepArtifacts: shown.stepArtifacts,
    failurePoints: shown.failurePoints,
    observedCarts: shown.observedCarts,
    skipToEnd,
  };
}
