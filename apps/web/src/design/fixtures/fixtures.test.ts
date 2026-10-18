import { describe, expect, it } from 'vitest';

import {
  codefixesABugged,
  missionABugged,
  missionAFixed,
  missionControl,
  problemsABugged,
  repositoryA,
  resolveDesignArtifact,
  runAlphaABugged,
  runsABugged,
  snapshotsABugged,
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

  it('every accessibility-tree snapshot a reading agent took is in the snapshots fixture', () => {
    let count = 0;
    for (const report of runsABugged) {
      for (const step of report.steps) {
        if (!step.snapshotPath) continue;
        count += 1;
        expect(snapshotsABugged[step.snapshotPath]).toMatch(/^- /);
      }
      const failing = report.failurePoint?.snapshotPath;
      if (failing) expect(snapshotsABugged[failing]).toContain(report.failurePoint!.perceived);
    }
    expect(count).toBe(11);
    expect(
      runsABugged.find((r) => r.agent.kind === 'beta_vision')!.steps.some((s) => s.snapshotPath),
    ).toBe(false);
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

  it('every problem has a composed code fix with all seven checks and a pull request to open', () => {
    for (const { issue } of problemsABugged) {
      const preview = codefixesABugged[issue.id];
      expect(preview).toBeDefined();
      expect(preview!.checks.map((c) => c.id).sort()).toEqual(
        [
          'applies_cleanly',
          'content_policy',
          'no_dependency_changes',
          'paths_in_scope',
          'rematch',
          'size_within_bounds',
          'typecheck',
        ].sort(),
      );
      expect(preview!.delivery.status).toBe('not_requested');
      expect(preview!.opened?.status).toBe('delivered');
      expect(preview!.opened?.draft).toBe(true);
    }
    expect(repositoryA.accessVia).toBe('github_app');
  });
});
