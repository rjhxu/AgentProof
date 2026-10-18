import { describe, expect, it } from 'vitest';

import { AGENT_LABELS } from '@agentproof/shared';
import type { Evidence, Run, RunEvent } from '@agentproof/shared';
import { alphaFailedRun } from '@agentproof/shared/fixtures';

import { runAlphaABugged, runGammaABugged } from '../design/fixtures';
import { initialLanes, reduceLanes } from '../design/replay/reduce';
import {
  eventsFromRun,
  fallbackSummary,
  isTerminalStatus,
  originalRuns,
  seedFromRun,
  stepArtifactsFromEvidence,
  stepArtifactsFromReport,
} from './hydrate';

const NOW = '2026-10-18T12:00:00.000Z';

function summary(events: RunEvent[]): string[] {
  return events.map((e) => {
    switch (e.type) {
      case 'status':
        return `status:${e.status}`;
      case 'step':
        return `step:${e.step.index}`;
      case 'evidence':
        return `evidence:${e.evidence.kind}:${e.evidence.stepIndex}`;
      case 'checkpoint':
        return `checkpoint:${e.checkpoint.id}`;
      case 'report':
        return 'report';
      case 'log':
        return 'log';
    }
  });
}

describe('eventsFromRun', () => {
  it('rebuilds the stream of the failed demo run in the runner order', () => {
    const events = eventsFromRun(alphaFailedRun, NOW);
    expect(summary(events)).toEqual([
      'status:running',
      'evidence:screenshot:0',
      'step:0',
      // The step-1 snapshot is inline data with no path, so it is not an evidence event.
      'step:1',
      'step:2',
      'status:verifying',
      ...alphaFailedRun.verification!.checkpoints.map((c) => `checkpoint:${c.id}`),
      'status:failed',
    ]);
    expect(events.every((e) => e.runId === alphaFailedRun.id)).toBe(true);
    expect(events[0]).toMatchObject({ at: alphaFailedRun.startedAt });
    expect(events[events.length - 1]).toMatchObject({ at: alphaFailedRun.finishedAt });
    expect(events.some((e) => e.type === 'log')).toBe(false);
  });

  it('puts the report path before the verdict, as the runner does', () => {
    const run: Run = { ...alphaFailedRun, reportPath: `${alphaFailedRun.id}/report.json` };
    const events = eventsFromRun(run, NOW);
    const tail = summary(events).slice(-2);
    expect(tail).toEqual(['report', 'status:failed']);
    expect(events[events.length - 2]).toMatchObject({
      type: 'report',
      reportPath: `${alphaFailedRun.id}/report.json`,
      at: alphaFailedRun.finishedAt,
    });
  });

  it('sends the accessibility tree before the frame of the same step', () => {
    const screenshot: Evidence = {
      id: 'ev_shot',
      runId: alphaFailedRun.id,
      kind: 'screenshot',
      stepIndex: 1,
      capturedAt: NOW,
      path: `${alphaFailedRun.id}/step-001.png`,
    };
    const tree: Evidence = {
      id: 'ev_tree',
      runId: alphaFailedRun.id,
      kind: 'dom_snapshot',
      stepIndex: 1,
      capturedAt: NOW,
      path: `${alphaFailedRun.id}/step-001.aria.txt`,
    };
    const run: Run = { ...alphaFailedRun, evidence: [screenshot, tree] };
    const events = summary(eventsFromRun(run, NOW));
    expect(events.indexOf('evidence:dom_snapshot:1')).toBeLessThan(
      events.indexOf('evidence:screenshot:1'),
    );
    expect(events.indexOf('evidence:screenshot:1')).toBeLessThan(events.indexOf('step:1'));
    expect(events.indexOf('step:0')).toBeLessThan(events.indexOf('evidence:dom_snapshot:1'));
  });

  it('sends nothing for a queued run and only running for one in progress', () => {
    const queued: Run = {
      ...alphaFailedRun,
      status: 'queued',
      steps: [],
      evidence: [],
      startedAt: undefined,
      finishedAt: undefined,
      verification: undefined,
    };
    expect(eventsFromRun(queued, NOW)).toEqual([]);
    const running: Run = { ...queued, status: 'running', startedAt: NOW };
    expect(eventsFromRun(running, NOW)).toEqual([
      { type: 'status', runId: alphaFailedRun.id, status: 'running', at: NOW },
    ]);
    const verifying: Run = { ...running, status: 'verifying' };
    expect(summary(eventsFromRun(verifying, NOW))).toEqual(['status:running', 'status:verifying']);
  });

  it('falls back to now for a verdict with no finish time, and marks an error run', () => {
    const errored: Run = {
      ...alphaFailedRun,
      status: 'error',
      verification: undefined,
      finishedAt: undefined,
      errorMessage: 'browser crashed',
    };
    const events = eventsFromRun(errored, NOW);
    expect(events[events.length - 1]).toEqual({
      type: 'status',
      runId: alphaFailedRun.id,
      status: 'error',
      at: NOW,
    });
    expect(summary(events)).not.toContain('status:verifying');
  });

  it('folds into the same lane a live stream would have built', () => {
    const run: Run = { ...alphaFailedRun, reportPath: `${alphaFailedRun.id}/report.json` };
    const lanes = eventsFromRun(run, NOW).reduce(reduceLanes, initialLanes([seedFromRun(run)]));
    const lane = lanes[0]!;
    expect(lane.status).toBe('failed');
    expect(lane.steps).toHaveLength(3);
    expect(lane.checkpoints).toHaveLength(8);
    expect(lane.latestScreenshotPath).toBe('run_demo0000alpha/step-000.png');
    expect(lane.stage).toBe('variant');
    expect(lane.reportPath).toBe(`${alphaFailedRun.id}/report.json`);
    // Folding the same events twice changes nothing: the reducer guards absorb the repeat.
    const again = eventsFromRun(run, NOW).reduce(reduceLanes, lanes);
    expect(again).toEqual(lanes);
  });
});

describe('seedFromRun', () => {
  it('uses the runner summary when the run carries one', () => {
    const run: Run = { ...alphaFailedRun, agentSummary: runAlphaABugged.agent };
    expect(seedFromRun(run)).toEqual({ runId: alphaFailedRun.id, agent: runAlphaABugged.agent });
  });

  it('labels the lane from the shared names when it does not', () => {
    const seed = seedFromRun(alphaFailedRun);
    expect(seed.runId).toBe(alphaFailedRun.id);
    expect(seed.agent).toEqual({
      kind: 'alpha_semantic',
      name: AGENT_LABELS.alpha_semantic.name,
      strategy: AGENT_LABELS.alpha_semantic.strategy,
      perceives: [],
      targetGrammars: [],
      model: alphaFailedRun.agent.model,
      provider: 'unknown',
    });
  });

  it('prefers the resolved model, says none for the data check and pending otherwise', () => {
    expect(fallbackSummary({ ...alphaFailedRun, resolvedModel: 'resolved-model' }).model).toBe(
      'resolved-model',
    );
    const gamma: Run = {
      ...alphaFailedRun,
      agent: { ...alphaFailedRun.agent, kind: 'gamma_structured', model: undefined },
    };
    expect(fallbackSummary(gamma)).toMatchObject({
      kind: 'gamma_structured',
      name: 'Agent Gamma',
      model: 'none',
    });
    const pending: Run = {
      ...alphaFailedRun,
      agent: { ...alphaFailedRun.agent, model: undefined },
    };
    expect(fallbackSummary(pending).model).toBe('pending');
  });
});

describe('originalRuns', () => {
  const make = (id: string, kind: Run['agent']['kind'], createdAt: string, label = 'original') =>
    ({
      ...alphaFailedRun,
      id,
      agent: { ...alphaFailedRun.agent, kind },
      createdAt,
      label: label as Run['label'],
    }) satisfies Run;

  it('keeps the last original per agent, drops rematches, returns stage order', () => {
    const runs = [
      make('run_sigma', 'sigma_hybrid', '2026-10-18T03:00:04.000Z'),
      make('run_alpha_old', 'alpha_semantic', '2026-10-18T03:00:01.000Z'),
      make('run_gamma', 'gamma_structured', '2026-10-18T03:00:03.000Z'),
      make('run_alpha_rematch', 'alpha_semantic', '2026-10-18T03:10:00.000Z', 'rematch'),
      make('run_beta', 'beta_vision', '2026-10-18T03:00:02.000Z'),
      make('run_alpha_new', 'alpha_semantic', '2026-10-18T03:05:00.000Z'),
    ];
    expect(originalRuns(runs).map((r) => r.id)).toEqual([
      'run_alpha_new',
      'run_beta',
      'run_gamma',
      'run_sigma',
    ]);
    expect(originalRuns([])).toEqual([]);
  });

  it('keeps the later run even when it is listed first', () => {
    const runs = [
      make('run_later', 'alpha_semantic', '2026-10-18T03:05:00.000Z'),
      make('run_earlier', 'alpha_semantic', '2026-10-18T03:00:00.000Z'),
    ];
    expect(originalRuns(runs).map((r) => r.id)).toEqual(['run_later']);
  });
});

describe('step artifacts', () => {
  it('groups file-backed evidence by step', () => {
    expect(stepArtifactsFromEvidence(alphaFailedRun.evidence)).toEqual([
      { index: 0, screenshotPath: 'run_demo0000alpha/step-000.png' },
    ]);
    const evidence: Evidence[] = [
      {
        id: 'ev_b',
        runId: 'run_x',
        kind: 'screenshot',
        stepIndex: 1,
        capturedAt: NOW,
        path: 'run_x/step-001.png',
      },
      {
        id: 'ev_a',
        runId: 'run_x',
        kind: 'dom_snapshot',
        stepIndex: 0,
        capturedAt: NOW,
        path: 'run_x/step-000.aria.txt',
      },
      {
        id: 'ev_c',
        runId: 'run_x',
        kind: 'screenshot',
        stepIndex: 0,
        capturedAt: NOW,
        path: 'run_x/step-000.png',
      },
      { id: 'ev_d', runId: 'run_x', kind: 'cart_state', stepIndex: 1, capturedAt: NOW, data: {} },
      { id: 'ev_e', runId: 'run_x', kind: 'trace', capturedAt: NOW, path: 'run_x/trace.zip' },
    ];
    expect(stepArtifactsFromEvidence(evidence)).toEqual([
      { index: 0, screenshotPath: 'run_x/step-000.png', snapshotPath: 'run_x/step-000.aria.txt' },
      { index: 1, screenshotPath: 'run_x/step-001.png' },
    ]);
    expect(stepArtifactsFromEvidence([])).toEqual([]);
  });

  it('reads the resolved paths off a report', () => {
    const artifacts = stepArtifactsFromReport(runAlphaABugged);
    expect(artifacts).toHaveLength(runAlphaABugged.steps.length);
    expect(artifacts[0]).toEqual({
      index: 0,
      screenshotPath: 'run_e2f6442a5419/step-000.png',
      snapshotPath: 'run_e2f6442a5419/step-000.aria.txt',
    });
    expect(artifacts.map((a) => a.index)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(stepArtifactsFromReport(runGammaABugged)).toEqual([]);
  });
});

describe('isTerminalStatus', () => {
  it('names the four verdicts', () => {
    expect(isTerminalStatus('passed')).toBe(true);
    expect(isTerminalStatus('failed')).toBe(true);
    expect(isTerminalStatus('error')).toBe(true);
    expect(isTerminalStatus('cancelled')).toBe(true);
    expect(isTerminalStatus('queued')).toBe(false);
    expect(isTerminalStatus('running')).toBe(false);
    expect(isTerminalStatus('verifying')).toBe(false);
  });
});
