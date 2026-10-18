'use client';

import { useCallback, useEffect, useMemo, useReducer } from 'react';
import { AnimatePresence, MotionConfig, motion } from 'motion/react';
import { CHECKPOINT_LABELS } from '@agentproof/shared';
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

import { costLine, summarize, thesisLine } from '../format';
import type { ReplayEvent } from '../replay/script';
import { useReplay } from '../replay/use-replay';
import { DevControls } from './dev-controls';
import { FindingsStep, type IssueCardData } from './findings-step';
import { FixesStep } from './fixes-step';
import { initialFlow, reduceFlow, stepIndex, type FlowStep } from './flow-machine';
import { ScanStep } from './scan-step';
import { Stepper } from './stepper';
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
  initial: { step: FlowStep; speed: number; t: number | 'end' | null };
};

const DERIVE_MS = 700;
const READ_MS = 2200;

/** Words the report's deterministic recommendations use for each failure category. */
const CATEGORY_WORDS: Partial<Record<Issue['category'], string[]>> = {
  semantic_interface_problem: ['accessible name', 'role'],
  product_data_inconsistency: ['catalog', 'cart api'],
  cart_checkout_defect: ['cart', 'checkout'],
};

function buildCards(
  report: MissionReport,
  runs: AgentReport[],
  problems: FlowProps['problems'],
  frames: Record<string, string>,
): IssueCardData[] {
  const names = Object.fromEntries(report.runs.map((r) => [r.agentKind, r.agentName])) as Partial<
    Record<AgentKind, string>
  >;
  return problems.map(({ issue }) => {
    const run = runs.find((r) => r.runId === issue.runId);
    const kind = run?.agent.kind;
    const attribution =
      report.attributions.find(
        (a) => a.checkpointId === issue.checkpointId && a.category === issue.category,
      ) ??
      report.attributions.find(
        (a) => a.category === issue.category && (kind ? a.failingAgents.includes(kind) : true),
      );
    const failingStep =
      run?.failurePoint && run.steps.find((s) => s.index === run.failurePoint?.stepIndex);
    const screenshotPath = run?.failurePoint?.screenshotPath ?? failingStep?.screenshotPath;
    const rowId = attribution?.checkpointId ?? issue.checkpointId;
    const row = report.matrix[rowId];
    const affected = report.runs
      .map((r) => ({
        kind: r.agentKind,
        name: r.agentName,
        status: row?.[r.agentKind] ?? 'not_run',
      }))
      .filter((a) => a.status !== 'not_run');
    const labels = [CHECKPOINT_LABELS[issue.checkpointId], CHECKPOINT_LABELS[rowId]];
    // Two recommendations can name the same checkpoint; the category's own words break the tie.
    const keywords = CATEGORY_WORDS[issue.category] ?? [];
    const candidates = report.recommendations.filter((r) => labels.some((l) => r.includes(l)));
    const recommendation =
      candidates.find((r) => keywords.some((w) => r.toLowerCase().includes(w))) ?? candidates[0];
    return {
      issue,
      attribution,
      screenshotUrl: screenshotPath ? frames[screenshotPath] : undefined,
      excerpt: run?.failurePoint?.perceived,
      affected,
      cost: kind ? costLine(report.costComparison, kind, names) : '',
      recommendation,
    };
  });
}

export function Flow(p: FlowProps) {
  const [state, dispatch] = useReducer(reduceFlow, p.initial.step, initialFlow);

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
  const cards = useMemo(
    () => buildCards(p.report, p.runs, p.problems, p.frames),
    [p.report, p.runs, p.problems, p.frames],
  );
  const resolveArtifactUrl = useCallback(
    (path: string | undefined) => (path ? p.frames[path] : undefined),
    [p.frames],
  );

  // Sandbox beats. At wiring these become the mission endpoint and the repository read.
  useEffect(() => {
    if (state.step !== 'store' || state.phase !== 'deriving') return;
    const url = state.url.trim();
    const id = setTimeout(
      () =>
        dispatch({
          type: 'MISSION_DERIVED',
          mission: { ...p.mission, storeUrl: url || p.mission.storeUrl },
        }),
      DERIVE_MS,
    );
    return () => clearTimeout(id);
  }, [state, p.mission]);

  useEffect(() => {
    if (state.step === 'scan' && state.phase === 'running' && replay.done) {
      dispatch({ type: 'SCAN_FINISHED' });
    }
  }, [state, replay.done]);

  // Each step starts at the top of the page.
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [state.step]);

  useEffect(() => {
    if (state.step !== 'fixes' || state.phase !== 'reading') return;
    const id = setTimeout(() => dispatch({ type: 'REPOSITORY_READ' }), READ_MS + 250);
    return () => clearTimeout(id);
  }, [state]);

  const jump = useCallback(
    (step: FlowStep) => {
      if (step === 'scan') replay.restart();
      else if (stepIndex(step) > 1) replay.seekToEnd();
      dispatch({ type: 'JUMP', step });
    },
    [replay],
  );

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
    (state.step === 'fixes' && state.phase === 'reading');

  return (
    <MotionConfig reducedMotion="user">
      <Stepper current={state.step} busy={busy} onJump={jump} />
      <main
        className={
          state.step === 'scan'
            ? 'mx-auto w-full max-w-[1120px] px-6'
            : 'mx-auto max-w-[880px] px-6 pb-24 pt-12'
        }
      >
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
                summary={state.phase === 'done' ? summary : undefined}
                thesis={state.phase === 'done' ? thesis : undefined}
                matrix={state.phase === 'done' ? p.report.matrix : undefined}
                costComparison={state.phase === 'done' ? p.report.costComparison : undefined}
                snapshots={p.snapshots}
                failurePoints={p.failurePoints}
                observedCarts={p.observedCarts}
                stepArtifacts={stepArtifacts}
                resolveArtifactUrl={resolveArtifactUrl}
                onContinue={() => dispatch({ type: 'CONTINUE' })}
              />
            ) : state.step === 'findings' ? (
              <FindingsStep
                summary={summary}
                cards={cards}
                connect={state.connect}
                onOpenConnect={() => dispatch({ type: 'CONNECT_OPENED' })}
                onConnect={(request) => dispatch({ type: 'CONNECT_SUBMITTED', request })}
                onDownload={download}
              />
            ) : (
              <FixesStep
                repository={p.repository}
                phase={state.phase}
                fixes={p.problems}
                readMs={READ_MS}
              />
            )}
          </motion.section>
        </AnimatePresence>
      </main>
      <DevControls step={state.step} onJump={jump} replay={replay} />
    </MotionConfig>
  );
}
