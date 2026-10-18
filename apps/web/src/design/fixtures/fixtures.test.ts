import { describe, expect, it } from 'vitest';

import { missionABugged, missionAFixed, missionControl, runAlphaABugged } from './index';

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
});
