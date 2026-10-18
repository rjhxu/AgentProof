import { describe, expect, it } from 'vitest';

import { missionABugged, runsABugged } from '../fixtures';
import { initialLanes, reduceLanes } from './reduce';
import { buildReplayScript, scriptDurationMs } from './script';

const script = buildReplayScript(runsABugged);
const gamma = runsABugged.find((r) => r.steps.length === 0);
const browsing = runsABugged.filter((r) => r.steps.length > 0);

function terminalAt(runId: string): number {
  const hit = script.find(
    (e) =>
      e.event.type === 'status' &&
      e.event.runId === runId &&
      (e.event.status === 'passed' || e.event.status === 'failed'),
  );
  if (!hit) throw new Error(`no terminal status for ${runId}`);
  return hit.at;
}

describe('replay script', () => {
  it('is sorted and gives every run exactly one terminal status', () => {
    for (let i = 1; i < script.length; i++) {
      expect(script[i]!.at).toBeGreaterThanOrEqual(script[i - 1]!.at);
    }
    for (const report of runsABugged) {
      const terminals = script.filter(
        (e) =>
          e.event.type === 'status' &&
          e.event.runId === report.runId &&
          (e.event.status === 'passed' || e.event.status === 'failed'),
      );
      expect(terminals).toHaveLength(1);
      expect(terminals[0]!.event).toMatchObject({ status: report.status });
    }
  });

  it('sends checkpoints only after a lane has taken its last step', () => {
    for (const report of browsing) {
      const lastStepAt = Math.max(
        ...script
          .filter((e) => e.event.type === 'step' && e.event.runId === report.runId)
          .map((e) => e.at),
      );
      const firstCheckpointAt = Math.min(
        ...script
          .filter((e) => e.event.type === 'checkpoint' && e.event.runId === report.runId)
          .map((e) => e.at),
      );
      expect(firstCheckpointAt).toBeGreaterThan(lastStepAt);
    }
  });

  it('lets the agent with no browser finish before any browsing agent', () => {
    expect(gamma).toBeDefined();
    const gammaDone = terminalAt(gamma!.runId);
    for (const report of browsing) {
      expect(terminalAt(report.runId)).toBeGreaterThan(gammaDone);
    }
  });

  it('keeps the recorded proportions and lands in a few seconds at 1x', () => {
    const total = scriptDurationMs(script);
    expect(total).toBeGreaterThan(3000);
    expect(total).toBeLessThan(15000);
  });
});

describe('lane reducer', () => {
  it('reproduces every report when the whole script is folded', () => {
    const seeds = runsABugged.map((r) => ({ runId: r.runId, agent: r.agent }));
    const lanes = script.reduce((acc, e) => reduceLanes(acc, e.event), initialLanes(seeds));
    for (const report of runsABugged) {
      const lane = lanes.find((l) => l.runId === report.runId);
      expect(lane).toBeDefined();
      expect(lane!.status).toBe(report.status);
      expect(lane!.steps).toHaveLength(report.steps.length);
      expect(lane!.checkpoints).toHaveLength(report.checkpoints.length);
      expect(lane!.reportPath).toBe(`${report.runId}/report.json`);
    }
    const alpha = lanes.find((l) => l.agent.kind === 'alpha_semantic')!;
    expect(alpha.stage).toBe('review');
    expect(alpha.latestScreenshotPath).toBe('run_e2f6442a5419/step-005.png');
    expect(alpha.costUsd).toBeGreaterThan(0);
    const gammaLane = lanes.find((l) => l.agent.kind === 'gamma_structured')!;
    expect(gammaLane.stage).toBe('cart');
    expect(gammaLane.costUsd).toBe(0);
  });

  it('matches the mission report verdicts', () => {
    const seeds = runsABugged.map((r) => ({ runId: r.runId, agent: r.agent }));
    const lanes = script.reduce((acc, e) => reduceLanes(acc, e.event), initialLanes(seeds));
    for (const run of missionABugged.runs) {
      expect(lanes.find((l) => l.runId === run.runId)?.status).toBe(run.status);
    }
  });
});
