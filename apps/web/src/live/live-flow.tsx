'use client';

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { AnimatePresence, MotionConfig, motion } from 'motion/react';
import type {
  AgentKind,
  AgentReport,
  CodeFix,
  ConnectRepositoryRequest,
  GitHubAppStatus,
  Issue,
  Mission,
  MissionReport,
  Repair,
  RepositoryConnection,
  Run,
} from '@agentproof/shared';

import { buildProblems, orderProblems } from '../design/flow/findings-data';
import { FindingsStep } from '../design/flow/findings-step';
import { CHECK_LABELS, canOpenPullRequests, type CodeFixPreview } from '../design/flow/fixes-data';
import { FixesStep } from '../design/flow/fixes-step';
import { initialFlow, reduceFlow, type FlowStep } from '../design/flow/flow-machine';
import { SpinnerIcon } from '../design/flow/icons';
import { ScanStep } from '../design/flow/scan-step';
import { Stepper } from '../design/flow/stepper';
import { StoreStep } from '../design/flow/store-step';
import { summarize, thesisLine } from '../design/format';
import { api } from '../lib/api';
import { shouldAutoOpenPullRequests } from './auto-open';
import {
  deliveryOf,
  finalAttempt,
  isFixDone,
  previewFromCodeFix,
  readingProgress,
  repairFromCodeFix,
} from './codefix-view';
import { ErrorBar } from './error-bar';
import { isTerminalStatus, originalRuns } from './hydrate';
import { failedWithCheckpoint, fallbackIssue, pickIssue } from './issues';
import { normalizeStoreUrl } from './store-url';
import { useAppRepositories } from './use-app-repositories';
import { useFixes } from './use-fixes';
import { useLiveScan } from './use-live-scan';

/*
 * The four-step flow fed by the runner: the same steps, stepper and motion as the sandbox at
 * /design/flow, with every sandbox beat replaced by a call. The flow reducer still decides which
 * step is on screen; this component owns what the runner returned (the mission, the runs, the
 * reports, the issues, the repository connections) and the calls that fetch it. Verdicts and
 * every line of the findings come from the reports; the model's text stays labelled in the steps.
 */

/** All four, in this order: the runner starts two at a time in body order, and the stage shows them in it. */
const AGENTS: AgentKind[] = ['alpha_semantic', 'beta_vision', 'gamma_structured', 'sigma_hybrid'];

const MISSION_REPORT_RETRIES = 6;
const MISSION_REPORT_RETRY_MS = 1500;
/** After the quick retries: keep asking at this pace until the report is in or the runs change. */
const MISSION_REPORT_PATIENCE_MS = 3000;

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Keep the mission in the address bar, so a reload or a shared link resumes it. */
function rememberMission(id: string): void {
  try {
    const url = new URL(window.location.href);
    url.searchParams.set('mission', id);
    window.history.replaceState(null, '', url);
  } catch {
    // The address bar is a convenience; the page works without it.
  }
}

/** Take the mission out of the address bar: a reload starts over. */
function forgetMission(): void {
  try {
    const url = new URL(window.location.href);
    url.searchParams.delete('mission');
    window.history.replaceState(null, '', url);
  } catch {
    // As above.
  }
}

/** Why a finished fix has no change to show: the first failing check, else the fix's own error. */
function failureText(fix: CodeFix): string {
  const check = previewFromCodeFix(fix).checks.find((c) => c.status === 'failed');
  if (check) return `${CHECK_LABELS[check.id]}: ${check.detail}`;
  return fix.error ?? 'the agent proposed no change';
}

function Preparing({ children }: { children: string }) {
  return (
    <p className="mt-24 flex items-center justify-center gap-2 text-[15px] text-[var(--muted)]">
      <SpinnerIcon />
      {children}
    </p>
  );
}

export function LiveFlow({ missionId }: { missionId?: string }) {
  const [state, dispatch] = useReducer(reduceFlow, 'store' as FlowStep, (step) =>
    initialFlow(step),
  );
  const [storeError, setStoreError] = useState<string>();
  const [promptVisible, setPromptVisible] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [starting, setStarting] = useState(false);
  const [mission, setMission] = useState<Mission>();
  /** The original runs, one per agent, in stage order. */
  const [runs, setRuns] = useState<Run[]>([]);
  const [report, setReport] = useState<MissionReport>();
  const [issues, setIssues] = useState<Record<string, Issue>>({});
  const [repositories, setRepositories] = useState<Record<string, RepositoryConnection>>({});
  const [connectError, setConnectError] = useState<string>();
  const [githubApp, setGithubApp] = useState<GitHubAppStatus>();
  const [pageError, setPageError] = useState<string>();
  /** The code-fix error the user dismissed; the hook keeps its own until the next request. */
  const [dismissedFixError, setDismissedFixError] = useState<string>();

  const reportRef = useRef<MissionReport | undefined>(undefined);
  useEffect(() => {
    reportRef.current = report;
  }, [report]);
  /** Runs whose issue is being looked up or diagnosed: diagnose is never called twice for a run. */
  const diagnosing = useRef(new Set<string>());
  /** Runs that were already finished when the page loaded: no diagnosis (a model call) for those. */
  const settledAtLoad = useRef(new Set<string>());
  /** Runs whose issue is the code-written stand-in: rebuilt once the report attributes the failure. */
  const fellBack = useRef(new Set<string>());
  const missionReportFor = useRef('');
  const appFetched = useRef(false);

  const fixes = useFixes();
  /** The GitHub App path asked to open draft pull requests once the fixes are ready. */
  const [openAfterRead, setOpenAfterRead] = useState(false);
  const autoOpened = useRef(false);

  // ---- issues: one per failed run, from the saved run, else a diagnosis, else the checkpoint ----
  const ensureIssue = useCallback(async (run: Run, allowDiagnose: boolean) => {
    if (diagnosing.current.has(run.id)) return;
    diagnosing.current.add(run.id);
    let issue: Issue | undefined;
    try {
      const { issues: saved } = await api.getRun(run.id);
      issue = pickIssue(run, saved);
    } catch {
      // Fall through to the diagnosis or the fallback.
    }
    if (!issue && allowDiagnose) {
      try {
        issue = (await api.diagnose(run.id)).issue;
      } catch {
        // The fallback below carries the checkpoint's facts without a hypothesis.
      }
    }
    const found = issue ?? fallbackIssue(run, reportRef.current);
    if (!issue && found) fellBack.current.add(run.id);
    if (found) setIssues((prev) => ({ ...prev, [run.id]: found }));
  }, []);

  const onRunFinished = useCallback(
    (run: Run) => {
      if (!failedWithCheckpoint(run)) return;
      void ensureIssue(run, !settledAtLoad.current.has(run.id));
    },
    [ensureIssue],
  );

  const scan = useLiveScan(runs, { onRunFinished });
  const runKey = runs.map((r) => r.id).join(',');

  // ---- the mission report, once every run has finished ----------------------------------------
  // Quick retries first, then patience: the runner writes the report after the last run, and the
  // page keeps asking until it is there or the runs change, telling the user once it runs late.
  const currentMissionId = mission?.id;
  useEffect(() => {
    if (!scan.allFinished || !currentMissionId || runKey === '') return;
    if (missionReportFor.current === runKey) return;
    missionReportFor.current = runKey;
    let cancelled = false;
    let complained = false;
    void (async () => {
      for (let attempt = 0; !cancelled; attempt++) {
        try {
          const { report: fresh } = await api.getMissionReport(currentMissionId, {
            refresh: true,
          });
          if (cancelled) return;
          setReport(fresh);
          if (complained) setPageError(undefined);
          return;
        } catch (err) {
          if (cancelled) return;
          if (attempt === MISSION_REPORT_RETRIES) {
            complained = true;
            setPageError(
              `The scan finished but its report could not be loaded: ${errorText(err)}. Still trying.`,
            );
          }
          await sleep(
            attempt < MISSION_REPORT_RETRIES ? MISSION_REPORT_RETRY_MS : MISSION_REPORT_PATIENCE_MS,
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [scan.allFinished, currentMissionId, runKey]);

  // The report's attribution names each failure's category: the stand-in issues take it on.
  useEffect(() => {
    if (!report || fellBack.current.size === 0) return;
    setIssues((prev) => {
      let next = prev;
      for (const runId of fellBack.current) {
        const run = scan.finalRuns[runId] ?? runs.find((r) => r.id === runId);
        const rebuilt = run ? fallbackIssue(run, report) : undefined;
        if (rebuilt && rebuilt.category !== prev[runId]?.category) {
          next = { ...next, [runId]: rebuilt };
        }
      }
      return next;
    });
  }, [report, runs, scan.finalRuns]);

  // The scan is over when the stage has shown everything and the report is in.
  useEffect(() => {
    if (state.step === 'scan' && state.phase === 'running' && scan.done && report) {
      dispatch({ type: 'SCAN_FINISHED' });
    }
  }, [state, scan.done, report]);

  // The GitHub App decides whether connecting starts from an install link or a URL.
  useEffect(() => {
    if (state.step !== 'findings' || appFetched.current) return;
    appFetched.current = true;
    void api
      .getGitHubApp()
      .then(({ app }) => setGithubApp(app))
      .catch(() => undefined);
  }, [state.step]);

  const appRepos = useAppRepositories(
    state.step === 'findings' &&
      state.connect !== 'closed' &&
      githubApp?.configured === true &&
      githubApp.installUrl !== undefined,
  );

  // The cards appear once every diff fix has finished.
  useEffect(() => {
    if (state.step === 'fixes' && state.phase === 'reading' && fixes.allDiffDone) {
      dispatch({ type: 'REPOSITORY_READ' });
    }
  }, [state, fixes.allDiffDone]);

  // Each step starts at the top of the page.
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [state.step]);

  // ---- resume: ?mission=<id> ------------------------------------------------------------------
  useEffect(() => {
    if (!missionId) return;
    let cancelled = false;
    void (async () => {
      try {
        const { mission: found, runs: all } = await api.getMission(missionId);
        if (cancelled) return;
        setMission(found);
        const originals = originalRuns(all);
        if (originals.length === 0) {
          // Derived but never started: the user confirms to start.
          dispatch({
            type: 'JUMP',
            step: 'store',
            context: { url: found.storeUrl, mission: found },
          });
          return;
        }
        for (const run of originals) {
          if (isTerminalStatus(run.status)) settledAtLoad.current.add(run.id);
        }
        setRuns(originals);
        dispatch({ type: 'JUMP', step: 'scan' });
        await Promise.all(
          originals.filter(failedWithCheckpoint).map(async (run) => {
            const [saved, repository, list] = await Promise.all([
              api.getRun(run.id).catch(() => undefined),
              api.getRepository(run.id).catch(() => undefined),
              api.listCodeFixes(run.id).catch(() => undefined),
            ]);
            if (cancelled) return;
            if (saved) {
              const issue = pickIssue(saved.run, saved.issues);
              if (issue) setIssues((prev) => ({ ...prev, [run.id]: issue }));
            }
            const connected = repository?.repository;
            if (connected) setRepositories((prev) => ({ ...prev, [run.id]: connected }));
            if (list) fixes.adopt(run.id, list.codefixes);
          }),
        );
      } catch (err) {
        if (!cancelled) setPageError(errorText(err));
      }
    })();
    return () => {
      cancelled = true;
    };
    // The adopt callback is stable; the effect runs once per mission id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [missionId]);

  // ---- store ----------------------------------------------------------------------------------
  const submitStore = async () => {
    if (state.step !== 'store' || state.phase !== 'idle') return;
    const url = normalizeStoreUrl(state.url);
    if (!url) {
      setStoreError('Enter the store address, like https://your-store.com');
      return;
    }
    setStoreError(undefined);
    if (url !== state.url) dispatch({ type: 'URL_CHANGED', url });
    dispatch({ type: 'URL_SUBMITTED' });
    const text = prompt.trim();
    try {
      const { mission: derived } = await api.createMission({
        storeUrl: url,
        ...(promptVisible && text ? { prompt: text } : {}),
      });
      setMission(derived);
      dispatch({ type: 'MISSION_DERIVED', mission: derived });
      rememberMission(derived.id);
    } catch (err) {
      dispatch({ type: 'DERIVE_FAILED' });
      const message = errorText(err);
      setStoreError(message);
      // The store publishes no product feed: ask what to buy and send it with the next submit.
      if (message.startsWith('No product feed')) setPromptVisible(true);
    }
  };

  const toggleEdit = () => {
    if (state.step !== 'store') return;
    if (!state.editing) setPrompt(state.mission?.rawPrompt ?? '');
    dispatch({ type: 'EDIT_TOGGLED' });
  };

  const confirm = async () => {
    if (state.step !== 'store' || state.phase !== 'derived') return;
    let current = state.mission ?? mission;
    if (!current) return;
    setStoreError(undefined);
    const text = prompt.trim();
    if (state.editing && text && text !== current.rawPrompt) {
      dispatch({ type: 'REDERIVE' });
      try {
        const { mission: derived } = await api.createMission({
          storeUrl: current.storeUrl,
          prompt: text,
        });
        current = derived;
        setMission(derived);
        dispatch({ type: 'MISSION_DERIVED', mission: derived });
        rememberMission(derived.id);
      } catch (err) {
        // Back to the address field; the edited prompt stays in view and goes with the next submit.
        dispatch({ type: 'DERIVE_FAILED' });
        setPromptVisible(true);
        setStoreError(errorText(err));
        return;
      }
    }
    // A scan of this mission is still running (the user came back to this step): rejoin it.
    if (runs.length > 0 && runs.every((r) => r.missionId === current.id) && !scan.allFinished) {
      dispatch({ type: 'CONFIRMED' });
      return;
    }
    setStarting(true);
    try {
      const { runs: started } = await api.startRuns(current.id, { agents: AGENTS });
      // A new scan: nothing from an earlier one carries over.
      setReport(undefined);
      setIssues({});
      setRepositories({});
      setConnectError(undefined);
      setOpenAfterRead(false);
      autoOpened.current = false;
      diagnosing.current.clear();
      settledAtLoad.current.clear();
      fellBack.current.clear();
      fixes.reset();
      setRuns(originalRuns(started));
      dispatch({ type: 'CONFIRMED' });
    } catch (err) {
      setStoreError(errorText(err));
    } finally {
      setStarting(false);
    }
  };

  /** Back to an empty address field: the mission, the scan and everything after it are dropped. */
  const resetStore = () => {
    dispatch({ type: 'JUMP', step: 'store' });
    setMission(undefined);
    setRuns([]);
    setReport(undefined);
    setIssues({});
    setRepositories({});
    setStoreError(undefined);
    setConnectError(undefined);
    setOpenAfterRead(false);
    autoOpened.current = false;
    setPromptVisible(false);
    setPrompt('');
    diagnosing.current.clear();
    settledAtLoad.current.clear();
    fellBack.current.clear();
    fixes.reset();
    forgetMission();
  };

  // ---- scan -----------------------------------------------------------------------------------
  const summary = useMemo(() => (report ? summarize(report) : undefined), [report]);
  const thesis = useMemo(() => (report ? thesisLine(report) : ''), [report]);
  const resolveArtifactUrl = useCallback(
    (path: string | undefined) => (path ? api.artifactUrl(path) : undefined),
    [],
  );

  // ---- findings -------------------------------------------------------------------------------
  const reports = useMemo(
    () => runs.map((r) => scan.reports[r.id]).filter((r): r is AgentReport => r !== undefined),
    [runs, scan.reports],
  );
  // Problems in the order they broke the purchase path; Findings and Fixes share it.
  const problems = useMemo(
    () =>
      orderProblems(
        Object.values(issues).map((issue) => ({ issue })),
        reports,
      ),
    [issues, reports],
  );
  const frames = useMemo(() => {
    const out: Record<string, string> = {};
    for (const r of reports) {
      for (const s of r.steps) {
        if (s.screenshotPath) out[s.screenshotPath] = api.artifactUrl(s.screenshotPath);
      }
      const failing = r.failurePoint?.screenshotPath;
      if (failing) out[failing] = api.artifactUrl(failing);
    }
    return out;
  }, [reports]);
  const cards = useMemo(
    () => (report ? buildProblems(report, reports, problems, frames, scan.observedCarts) : []),
    [report, reports, problems, frames, scan.observedCarts],
  );
  // Every failed run needs its issue, and every finished run its report (unless the runner never
  // produced one), before the walkthrough can be built: the step lays out its beats from the cards
  // it mounts with.
  const findingsPending =
    !report ||
    report.runs.some(
      (r) =>
        runs.some((staged) => staged.id === r.runId) &&
        r.status === 'failed' &&
        r.firstFailure !== undefined &&
        issues[r.runId] === undefined,
    ) ||
    runs.some(
      (r) => failedWithCheckpoint(scan.finalRuns[r.id] ?? r) && issues[r.id] === undefined,
    ) ||
    runs.some((r) => {
      const final = scan.finalRuns[r.id];
      return (
        final !== undefined &&
        isTerminalStatus(final.status) &&
        !scan.reports[r.id] &&
        !scan.reportFailures.includes(r.id)
      );
    });

  const download = () => {
    if (!report) return;
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
    const href = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = href;
    a.download = `agentproof-report-${report.missionId}.json`;
    a.click();
    URL.revokeObjectURL(href);
  };

  /** Connect the same repository to every failed run; the request (and its token) is not kept. */
  const connect = async (
    request: ConnectRepositoryRequest,
    opts?: { openPullRequests?: boolean },
  ) => {
    dispatch({ type: 'CONNECT_SUBMITTED' });
    setConnectError(undefined);
    setOpenAfterRead(false);
    autoOpened.current = false;
    const targets = runs.filter((r) => failedWithCheckpoint(scan.finalRuns[r.id] ?? r));
    try {
      const entries = await Promise.all(
        targets.map(async (run) => {
          try {
            const { repository } = await api.connectRepository(run.id, request);
            return [run.id, repository] as const;
          } catch (err) {
            // Already connected from an earlier attempt: that connection serves.
            if (/Disconnect the current repository/i.test(errorText(err))) {
              const { repository } = await api.getRepository(run.id);
              if (repository) return [run.id, repository] as const;
            }
            throw err;
          }
        }),
      );
      const connected: Record<string, RepositoryConnection> = {};
      for (const [id, repository] of entries) if (repository) connected[id] = repository;
      if (Object.keys(connected).length === 0) {
        throw new Error('The repository could not be connected.');
      }
      setRepositories(connected);
      setOpenAfterRead(opts?.openPullRequests === true);
      dispatch({ type: 'REPOSITORY_CONNECTED' });
      void fixes.start(targets, connected);
    } catch (err) {
      dispatch({ type: 'CONNECT_FAILED' });
      setOpenAfterRead(false);
      setConnectError(errorText(err));
    }
  };

  // ---- fixes ----------------------------------------------------------------------------------
  /** The first connected repository in stage order; every failed run connects the same one. */
  const repository = useMemo(
    () => runs.map((r) => repositories[r.id]).find((r) => r !== undefined),
    [runs, repositories],
  );
  const fixesView = useMemo(() => {
    const list: Array<{ issue: Issue; repair: Repair }> = [];
    const failed: Array<{ issue: Issue; error: string }> = [];
    const codefixes: Record<string, CodeFixPreview> = {};
    for (const { issue } of problems) {
      const fix = fixes.diff[issue.runId];
      const pr = fixes.pr[issue.runId];
      if (!fix) {
        const startError = fixes.startErrors[issue.runId];
        if (startError) failed.push({ issue, error: startError });
        continue;
      }
      // Once a pull request has been opened, its record carries the delivered diff and its own
      // checks: the card reads both from it, so what it shows is what was delivered.
      const opened = pr && isFixDone(pr) && finalAttempt(pr)?.diff !== undefined ? pr : undefined;
      const source = opened ?? fix;
      const repair = repairFromCodeFix(issue, source);
      // A request that never became a record still has a delivery line to show.
      const prError = fixes.prErrors[issue.runId];
      const delivery = pr
        ? deliveryOf(pr)
        : prError !== undefined
          ? { mode: 'pull_request' as const, status: 'failed' as const, error: prError }
          : undefined;
      codefixes[issue.id] = previewFromCodeFix(source, delivery);
      if (repair) list.push({ issue, repair });
      else if (isFixDone(fix)) failed.push({ issue, error: failureText(fix) });
    }
    return { list, failed, codefixes };
  }, [problems, fixes.diff, fixes.pr, fixes.prErrors, fixes.startErrors]);

  // The GitHub App path opens the draft pull requests itself, once, when the fixes are ready.
  useEffect(() => {
    if (
      !shouldAutoOpenPullRequests({
        ready: state.step === 'fixes' && state.phase === 'ready',
        requested: openAfterRead,
        fired: autoOpened.current,
        canOpen: repository !== undefined && canOpenPullRequests(repository),
        opening: fixes.opening,
        fixCount: fixesView.list.length,
      })
    ) {
      return;
    }
    autoOpened.current = true;
    void fixes.openPullRequests();
  }, [
    state,
    openAfterRead,
    repository,
    fixes.opening,
    fixes.openPullRequests,
    fixesView.list.length,
  ]);

  // ---- stepper --------------------------------------------------------------------------------
  // The reading beat counts problems in the order Findings told them, not in fix-arrival order.
  const reading = useMemo(() => {
    const ordered = problems
      .map((p) => fixes.diff[p.issue.runId])
      .filter((f): f is CodeFix => f !== undefined);
    if (ordered.length === 0) return fixes.reading;
    const titles = Object.fromEntries(
      problems.map((p, i) => [p.issue.runId, `Problem ${i + 1} of ${problems.length}`]),
    );
    return readingProgress(ordered, titles);
  }, [problems, fixes.diff, fixes.reading]);

  const jump = (step: FlowStep) => {
    if (step === 'store') {
      const url = mission?.storeUrl ?? (state.step === 'store' ? state.url : undefined);
      dispatch({
        type: 'JUMP',
        step,
        context: { ...(url ? { url } : {}), ...(mission ? { mission } : {}) },
      });
      return;
    }
    // Back to the scan: show the rest at once; SCAN_FINISHED fires again as soon as it is done.
    if (step === 'scan') scan.skipToEnd();
    dispatch({ type: 'JUMP', step });
  };

  const busy =
    (state.step === 'store' && (state.phase === 'deriving' || starting)) ||
    (state.step === 'scan' && state.phase === 'running') ||
    (state.step === 'findings' && state.connect === 'submitting') ||
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
                error={storeError}
                prompt={prompt}
                onPromptChange={setPrompt}
                promptVisible={promptVisible}
                starting={starting}
                onUrlChange={(url) => {
                  setStoreError(undefined);
                  dispatch({ type: 'URL_CHANGED', url });
                }}
                onSubmit={() => void submitStore()}
                onToggleEdit={toggleEdit}
                onConfirm={() => void confirm()}
                onReset={resetStore}
              />
            ) : state.step === 'scan' ? (
              mission ? (
                <ScanStep
                  mission={mission}
                  lanes={scan.lanes}
                  phase={state.phase}
                  summary={state.phase === 'done' ? summary : undefined}
                  thesis={state.phase === 'done' ? thesis : undefined}
                  matrix={state.phase === 'done' ? report?.matrix : undefined}
                  costComparison={state.phase === 'done' ? report?.costComparison : undefined}
                  snapshots={scan.snapshots}
                  failurePoints={scan.failurePoints}
                  observedCarts={scan.observedCarts}
                  stepArtifacts={scan.stepArtifacts}
                  resolveArtifactUrl={resolveArtifactUrl}
                  onContinue={() => dispatch({ type: 'CONTINUE' })}
                />
              ) : (
                <Preparing>Starting the scan</Preparing>
              )
            ) : state.step === 'findings' ? (
              report && summary && !findingsPending ? (
                <FindingsStep
                  summary={summary}
                  thesis={thesis}
                  cards={cards}
                  connect={state.connect}
                  connectError={connectError}
                  app={
                    githubApp?.configured === true && githubApp.installUrl
                      ? {
                          installUrl: githubApp.installUrl,
                          repositories: appRepos.repositories,
                          loading: appRepos.loading,
                          ...(appRepos.error ? { error: appRepos.error } : {}),
                          onRefresh: () => void appRepos.refresh(),
                        }
                      : undefined
                  }
                  onOpenConnect={() => dispatch({ type: 'CONNECT_OPENED' })}
                  onConnect={(request, opts) => void connect(request, opts)}
                  onDownload={download}
                  onContinueToFixes={
                    repository && fixes.allDiffDone
                      ? () => dispatch({ type: 'JUMP', step: 'fixes' })
                      : undefined
                  }
                />
              ) : (
                <Preparing>Preparing the findings</Preparing>
              )
            ) : repository ? (
              <FixesStep
                repository={repository}
                phase={state.phase}
                fixes={fixesView.list}
                codefixes={fixesView.codefixes}
                failed={fixesView.failed}
                reading={reading}
                opening={fixes.opening}
                autoOpen={openAfterRead}
                onOpen={() => void fixes.openPullRequests()}
              />
            ) : (
              <Preparing>Connecting the repository</Preparing>
            )}
          </motion.section>
        </AnimatePresence>
      </main>
      <ErrorBar
        message={pageError ?? (fixes.error !== dismissedFixError ? fixes.error : undefined)}
        onDismiss={() => {
          setPageError(undefined);
          setDismissedFixError(fixes.error);
        }}
      />
    </MotionConfig>
  );
}
