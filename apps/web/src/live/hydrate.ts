import { AGENT_LABELS } from '@agentproof/shared';
import type {
  AgentKind,
  AgentProfileSummary,
  AgentReport,
  Evidence,
  Run,
  RunEvent,
  RunStatus,
} from '@agentproof/shared';

import { inStageOrder, type StepArtifact } from '../design/flow/stage';
import { isTerminal, type LaneSeed } from '../design/replay/reduce';

/*
 * The event stream does not replay what happened before the page subscribed, so the page loads
 * each run (GET /runs/:id) and rebuilds the events the stream would have sent so far. Folding
 * them through the same reducer puts a lane exactly where a live one would be, and the reducer's
 * guards (steps once, status never backwards) absorb whatever the stream repeats.
 */

export function isTerminalStatus(status: RunStatus): boolean {
  return isTerminal(status);
}

function compareIso(a: string, b: string): number {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isFinite(ta) && Number.isFinite(tb)) return ta - tb;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * What the stream would have sent so far for this run, in the runner's order: running, then per
 * step its evidence (the accessibility tree, then the frame) and the step, then verifying and the
 * checkpoints, then the report path, then the verdict. Logs are not rebuilt.
 */
export function eventsFromRun(run: Run, nowIso: string = new Date().toISOString()): RunEvent[] {
  const runId = run.id;
  const events: RunEvent[] = [];

  if (run.status !== 'queued') {
    events.push({ type: 'status', runId, status: 'running', at: run.startedAt ?? run.createdAt });
  }

  const steps = [...run.steps].sort((a, b) => a.index - b.index);
  for (const step of steps) {
    const captured = run.evidence.filter(
      (e) => e.stepIndex === step.index && e.path !== undefined && e.path !== '',
    );
    for (const kind of ['dom_snapshot', 'screenshot'] as const) {
      for (const evidence of captured) {
        if (evidence.kind === kind) events.push({ type: 'evidence', runId, evidence });
      }
    }
    events.push({ type: 'step', runId, step });
  }

  if (run.verification || run.status === 'verifying') {
    events.push({
      type: 'status',
      runId,
      status: 'verifying',
      at: run.verification?.verifiedAt ?? nowIso,
    });
    for (const checkpoint of run.verification?.checkpoints ?? []) {
      events.push({ type: 'checkpoint', runId, checkpoint });
    }
  }

  if (run.reportPath) {
    events.push({
      type: 'report',
      runId,
      reportPath: run.reportPath,
      at: run.finishedAt ?? nowIso,
    });
  }

  if (isTerminal(run.status)) {
    events.push({ type: 'status', runId, status: run.status, at: run.finishedAt ?? nowIso });
  }

  return events;
}

/** A lane label when the runner has not filled `agentSummary`: the shared names, no senses yet. */
export function fallbackSummary(run: Run): AgentProfileSummary {
  const kind = run.agent.kind;
  const label = AGENT_LABELS[kind];
  return {
    kind,
    name: label.name,
    strategy: label.strategy,
    perceives: [],
    targetGrammars: [],
    model:
      run.resolvedModel ?? run.agent.model ?? (kind === 'gamma_structured' ? 'none' : 'pending'),
    provider: 'unknown',
  };
}

export function seedFromRun(run: Run): LaneSeed {
  return { runId: run.id, agent: run.agentSummary ?? fallbackSummary(run) };
}

/**
 * The runs the Scan step stages: the original attempt of each agent (never a rematch), the last
 * one created when an agent was started more than once, in stage order.
 */
export function originalRuns(runs: Run[]): Run[] {
  const latest = new Map<AgentKind, Run>();
  const originals = runs
    .filter((run) => run.label === 'original')
    .sort((a, b) => compareIso(a.createdAt, b.createdAt));
  for (const run of originals) latest.set(run.agent.kind, run);
  return inStageOrder([...latest.values()]);
}

/** The frame and the accessibility tree of each step, from the run's file-backed evidence. */
export function stepArtifactsFromEvidence(evidence: Evidence[]): StepArtifact[] {
  const byIndex = new Map<number, StepArtifact>();
  for (const entry of evidence) {
    if (entry.stepIndex === undefined || !entry.path) continue;
    if (entry.kind !== 'screenshot' && entry.kind !== 'dom_snapshot') continue;
    const artifact = byIndex.get(entry.stepIndex) ?? { index: entry.stepIndex };
    if (entry.kind === 'screenshot') artifact.screenshotPath = entry.path;
    else artifact.snapshotPath = entry.path;
    byIndex.set(entry.stepIndex, artifact);
  }
  return [...byIndex.values()].sort((a, b) => a.index - b.index);
}

/** The same, from a finished run's report, which already resolved the paths per step. */
export function stepArtifactsFromReport(report: AgentReport): StepArtifact[] {
  return [...report.steps]
    .sort((a, b) => a.index - b.index)
    .map((step) => ({
      index: step.index,
      ...(step.screenshotPath ? { screenshotPath: step.screenshotPath } : {}),
      ...(step.snapshotPath ? { snapshotPath: step.snapshotPath } : {}),
    }));
}
