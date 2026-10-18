'use client';

import { useCallback, useEffect, useMemo, useReducer, useState } from 'react';
import { AnimatePresence, MotionConfig, motion } from 'motion/react';
import type {
  AgentKind,
  AgentReport,
  FailurePoint,
  Issue,
  Mission,
  MissionReport,
  ObservedCart,
  Repair,
  RepositoryConnection,
} from '@agentproof/shared';

import { summarize, thesisLine } from '../format';
import type { ReplayEvent } from '../replay/script';
import { useReplay } from '../replay/use-replay';
import { DevControls } from './dev-controls';
import { buildProblems, buildRoster, orderProblems } from './findings-data';
import { FindingsStep } from './findings-step';
import type { CodeFixPreview, ReadingProgress } from './fixes-data';
import { FixesStep } from './fixes-step';
import { initialFlow, reduceFlow, stepIndex, type FlowStep } from './flow-machine';
import { ScanStep } from './scan-step';
import { FLOW_SHELL, Stepper } from './stepper';
import { StoreStep } from './store-step';

export type FlowProps = {
  report: MissionReport;
  runs: AgentReport[];
  problems: Array<{ issue: Issue; repair: Repair }>;
  repository: RepositoryConnection;
  script: ReplayEvent[];
  mission: Mission;
  /** Artifact path -> URL for every frame the sandbox can show. */
  frames: Record<string, string>;
  /** Artifact path -> the accessibility-tree text a reading agent took at a step. */
  snapshots: Record<string, string>;
  /** Run id -> where the run diverged, from each report. */
  failurePoints: Record<string, FailurePoint>;
  /** Run id -> the cart the verifier observed, from each report. */
  observedCarts: Record<string, ObservedCart>;
  /** Issue id -> the checks, the second opinion and the delivery of its fix. */
  codefixes: Record<string, CodeFixPreview>;
  initial: { step: FlowStep; speed: number; t: number | 'end' | null };
};

/*
 * Sandbox beats. The live page (src/live/live-flow.tsx) replaces each with a runner call:
 * deriving the mission, connecting the repository, reading the code, opening pull requests.
 */
const DERIVE_MS = 700;
const CONNECT_MS = 600;
const READ_MS = 2200;
const OPEN_MS = 1600;

type Opening = 'idle' | 'pending' | 'done';

export function Flow(p: FlowProps) {
  const [state, dispatch] = useReducer(reduceFlow, p.initial.step, (step) => initialFlow(step));
  const [reviewRunId, setReviewRunId] = useState<string>();

  const seeds = useMemo(() => p.runs.map((r) => ({ runId: r.runId, agent: r.agent })), [p.runs]);
  const startAtMs =
    p.initial.step === 'scan'
      ? p.initial.t === 'end'
        ? Infinity
        : (p.initial.t ?? 0)
      : stepIndex(p.initial.step) > 1
        ? Infinity
        : 0;
  const replay = useReplay(p.script, seeds, {
    speed: p.initial.speed,
    autoplay: p.initial.step === 'scan' && p.initial.t !== 'end',
    startAtMs,
  });

  const summary = useMemo(() => summarize(p.report), [p.report]);
  const thesis = useMemo(() => thesisLine(p.report), [p.report]);
  // Where each step's frame and snapshot live, for walking back through a run after the scan.
  const stepArtifacts = useMemo(
    () =>
      Object.fromEntries(
        p.runs.map((r) => [
          r.runId,
          r.steps.map((s) => ({
            index: s.index,
            screenshotPath: s.screenshotPath,
            snapshotPath: s.snapshotPath,
          })),
        ]),
      ),
    [p.runs],
  );
  // Problems in the order they broke the purchase path; Findings and Fixes share it.
  const problems = useMemo(() => orderProblems(p.problems, p.runs), [p.problems, p.runs]);
  const cards = useMemo(
    () => buildProblems(p.report, p.runs, problems, p.frames, p.observedCarts),
    [p.report, p.runs, problems, p.frames, p.observedCarts],
  );
  const roster = useMemo(() => buildRoster(p.report), [p.report]);
  const agents = useMemo(
    () => roster.map((shopper) => ({ kind: shopper.kind, name: shopper.name })),
    [roster],
  );
  const resolveArtifactUrl = useCallback(
    (path: string | undefined) => (path ? p.frames[path] : undefined),
    [p.frames],
  );

  // Deriving the mission: the recorded hoodie mission after a short beat, then the scan.
  const restartReplay = replay.restart;
  useEffect(() => {
    if (state.step !== 'store' || state.phase !== 'deriving') return;
    const url = state.url.trim();
    const id = setTimeout(() => {
      dispatch({
        type: 'MISSION_DERIVED',
        mission: { ...p.mission, storeUrl: url || p.mission.storeUrl },
      });
      restartReplay();
      dispatch({ type: 'CONFIRMED' });
    }, DERIVE_MS);
    return () => clearTimeout(id);
  }, [state, p.mission, restartReplay]);

  useEffect(() => {
    if (state.step === 'scan' && state.phase === 'running' && replay.done) {
      dispatch({ type: 'SCAN_FINISHED' });
    }
  }, [state, replay.done]);

  // Each step starts at the top of the page.
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [state.step]);

  // Connecting the repository: the fixture connection after a short beat on Fixes.
  useEffect(() => {
    if (state.step !== 'fixes' || state.phase !== 'submitting') return;
    const id = setTimeout(() => dispatch({ type: 'REPOSITORY_CONNECTED' }), CONNECT_MS);
    return () => clearTimeout(id);
  }, [state]);

  // Reading the code: count through the fixture's files over READ_MS, then the cards.
  const [readCount, setReadCount] = useState(0);
  const fileTotal = Math.max(1, p.repository.fileCount);
  useEffect(() => {
    if (state.step !== 'fixes' || state.phase !== 'reading') return;
    setReadCount(0);
    const interval = Math.max(20, READ_MS / fileTotal);
    const counter = setInterval(() => setReadCount((c) => Math.min(fileTotal, c + 1)), interval);
    const done = setTimeout(() => dispatch({ type: 'REPOSITORY_READ' }), READ_MS + 250);
    return () => {
      clearInterval(counter);
      clearTimeout(done);
    };
  }, [state, fileTotal]);
  const reading: ReadingProgress | undefined =
    state.step === 'fixes' && state.phase === 'reading'
      ? (() => {
          const file =
            p.repository.files[Math.min(p.repository.files.length - 1, Math.max(0, readCount - 1))];
          return {
            done: readCount,
            total: fileTotal,
            label: `${readCount} of ${fileTotal} files`,
            ...(file ? { current: file } : {}),
          };
        })()
      : undefined;

  // Opening draft pull requests: pending for a beat, then each fixture's `opened` delivery.
  const [opening, setOpening] = useState<Opening>('idle');
  useEffect(() => {
    if (opening !== 'pending') return;
    const id = setTimeout(() => setOpening('done'), OPEN_MS);
    return () => clearTimeout(id);
  }, [opening]);
  useEffect(() => {
    if (state.step !== 'fixes') setOpening('idle');
  }, [state.step]);
  const codefixes = useMemo(() => {
    if (opening === 'idle') return p.codefixes;
    return Object.fromEntries(
      Object.entries(p.codefixes).map(([id, preview]) => [
        id,
        {
          ...preview,
          delivery:
            opening === 'pending'
              ? { mode: 'pull_request' as const, status: 'pending' as const }
              : (preview.opened ?? preview.delivery),
        },
      ]),
    );
  }, [p.codefixes, opening]);

  // The sandbox keeps today's screens. A jump back to a finished scan opens the review.
  const jump = useCallback(
    (step: FlowStep) => {
      if (step === 'scan') {
        const finished =
          stepIndex(state.step) > 1 || (state.step === 'scan' && state.phase === 'done');
        if (finished) {
          replay.seekToEnd();
          dispatch({ type: 'JUMP', step, context: { scanDone: true } });
        } else {
          replay.restart();
          dispatch({ type: 'JUMP', step });
        }
        return;
      }
      if (step === 'store') {
        dispatch({
          type: 'JUMP',
          step,
          context: { url: p.mission.storeUrl, mission: p.mission },
        });
        return;
      }
      if (stepIndex(step) > 1) replay.seekToEnd();
      dispatch({ type: 'JUMP', step });
    },
    [replay, state],
  );

  const reviewShopper = useCallback(
    (kind: AgentKind) => {
      const run = p.runs.find((r) => r.agent.kind === kind);
      setReviewRunId(run?.runId);
      replay.seekToEnd();
      dispatch({ type: 'JUMP', step: 'scan', context: { scanDone: true } });
    },
    [p.runs, replay],
  );

  const changeMission = useCallback(() => {
    dispatch({
      type: 'JUMP',
      step: 'store',
      context: { url: p.mission.storeUrl, mission: p.mission, editing: true },
    });
  }, [p.mission]);

  const confirm = useCallback(() => {
    replay.restart();
    dispatch({ type: 'CONFIRMED' });
  }, [replay]);

  const download = useCallback(() => {
    const blob = new Blob([JSON.stringify(p.report, null, 2)], { type: 'application/json' });
    const href = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = href;
    a.download = `agentproof-report-${p.report.missionId}.json`;
    a.click();
    URL.revokeObjectURL(href);
  }, [p.report]);

  const busy =
    (state.step === 'store' && state.phase === 'deriving') ||
    (state.step === 'scan' && state.phase === 'running') ||
    (state.step === 'fixes' && (state.phase === 'submitting' || state.phase === 'reading'));

  return (
    <MotionConfig reducedMotion="user">
      <Stepper current={state.step} busy={busy} onJump={jump} />
      <main className={state.step === 'scan' ? FLOW_SHELL : `${FLOW_SHELL} pb-24 pt-12`}>
        <AnimatePresence mode="wait" initial={false}>
          <motion.section
            key={state.step}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.22, ease: 'easeOut' }}
          >
            {state.step === 'store' ? (
              <StoreStep
                url={state.url}
                phase={state.phase}
                mission={state.mission}
                editing={state.editing}
                onUrlChange={(url) => dispatch({ type: 'URL_CHANGED', url })}
                onSubmit={() => dispatch({ type: 'URL_SUBMITTED' })}
                onToggleEdit={() => dispatch({ type: 'EDIT_TOGGLED' })}
                onConfirm={confirm}
              />
            ) : state.step === 'scan' ? (
              <ScanStep
                mission={p.mission}
                lanes={replay.lanes}
                phase={state.phase}
                costComparison={state.phase === 'done' ? p.report.costComparison : undefined}
                snapshots={p.snapshots}
                failurePoints={p.failurePoints}
                observedCarts={p.observedCarts}
                stepArtifacts={stepArtifacts}
                resolveArtifactUrl={resolveArtifactUrl}
                onContinue={() => dispatch({ type: 'CONTINUE' })}
                onChangeMission={changeMission}
                initialReviewRunId={state.phase === 'done' ? reviewRunId : undefined}
              />
            ) : state.step === 'findings' ? (
              <FindingsStep
                summary={summary}
                thesis={thesis}
                cards={cards}
                roster={roster}
                matrix={p.report.matrix}
                agents={agents}
                onReviewShopper={reviewShopper}
                onDownload={download}
                onGetFixes={cards.length > 0 ? () => dispatch({ type: 'CONTINUE' }) : undefined}
              />
            ) : state.phase === 'connect' || state.phase === 'submitting' ? (
              <FixesStep
                phase={state.phase}
                fixes={problems}
                codefixes={codefixes}
                opening={opening}
                onOpen={() => setOpening('pending')}
                onConnect={() => dispatch({ type: 'CONNECT_SUBMITTED' })}
                defaultRepositoryUrl={p.repository.url}
              />
            ) : (
              <FixesStep
                repository={p.repository}
                phase={state.phase}
                fixes={problems}
                codefixes={codefixes}
                reading={reading}
                opening={opening}
                onOpen={() => setOpening('pending')}
              />
            )}
          </motion.section>
        </AnimatePresence>
      </main>
      <DevControls step={state.step} onJump={jump} replay={replay} />
    </MotionConfig>
  );
}
