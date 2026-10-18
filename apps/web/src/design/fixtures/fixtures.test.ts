import { describe, expect, it } from 'vitest';

import {
  missionABugged,
  missionAFixed,
  missionControl,
  problemsABugged,
  repositoryA,
  resolveDesignArtifact,
  runAlphaABugged,
  runsABugged,
} from './index';

/**
 * The recorded reports must keep parsing against the shared schemas. If this fails, the
 * contract in packages/shared changed; update the fixture (or the schema default) before
 * designing against it.
 */
describe('design fixtures', () => {
  it('bugged Bug A has four agents with the recorded verdicts', () => {
    const byKind = Object.fromEntries(missionABugged.runs.map((r) => [r.agentKind, r.status]));
    expect(byKind).toEqual({
      alpha_semantic: 'failed',
      beta_vision: 'passed',
      sigma_hybrid: 'passed',
      gamma_structured: 'failed',
    });
    expect(missionABugged.attributions.length).toBeGreaterThan(0);
    expect(missionABugged.costComparison).toHaveLength(4);
  });

  it('fixed Bug A and the control have no failed runs', () => {
    for (const report of [missionAFixed, missionControl]) {
      expect(report.runs.every((r) => r.status === 'passed')).toBe(true);
    }
  });

  it('the Alpha run report carries its steps', () => {
    expect(runAlphaABugged.agent.kind).toBe('alpha_semantic');
    expect(runAlphaABugged.status).toBe('failed');
    expect(runAlphaABugged.steps.length).toBeGreaterThan(0);
  });

  it('the four run reports belong to the bugged Bug A mission, in arena order', () => {
    expect(runsABugged.map((r) => r.agent.kind)).toEqual(
      missionABugged.runs.map((r) => r.agentKind),
    );
    expect(runsABugged.map((r) => r.runId)).toEqual(missionABugged.runs.map((r) => r.runId));
  });

  it('every browsing step frame resolves to a copied file', () => {
    for (const report of runsABugged) {
      for (const step of report.steps) {
        expect(resolveDesignArtifact(step.screenshotPath)).toMatch(/^\/design\/.+\.png$/);
      }
    }
    expect(resolveDesignArtifact('run_unknown/step-000.png')).toBeUndefined();
  });

  it('the problems point at runs of the mission and carry their repairs', () => {
    const runIds = new Set(missionABugged.runs.map((r) => r.runId));
    for (const { issue, repair } of problemsABugged) {
      expect(runIds.has(issue.runId)).toBe(true);
      expect(repair.issueId).toBe(issue.id);
      expect(repair.diff).toContain('+++ b/');
      expect(repair.files.every((f) => f.startsWith('apps/storefront/'))).toBe(true);
    }
    expect(repositoryA.files.length).toBe(repositoryA.fileCount);
  });
});
