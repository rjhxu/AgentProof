import { describe, expect, it } from 'vitest';

import { missionABugged, missionAFixed, runAlphaABugged, snapshotsABugged } from './fixtures';
import { clickPoint, senses, stepReason, targetLine, thesisLine } from './format';

describe('senses', () => {
  it('gives Sigma every sense and the strongest model, Gamma only the API', () => {
    expect(senses('alpha_semantic')).toEqual(['reads']);
    expect(senses('beta_vision')).toEqual(['looks']);
    expect(senses('sigma_hybrid')).toEqual(['reads', 'looks', 'strongest']);
    expect(senses('gamma_structured')).toEqual(['api']);
  });
});

describe('clickPoint', () => {
  it('maps a coordinate target onto the 1280x800 frame as percentages', () => {
    expect(clickPoint('640,400')).toEqual({ x: 50, y: 50 });
    expect(clickPoint('262,300')).toEqual({ x: (262 / 1280) * 100, y: (300 / 800) * 100 });
  });

  it('ignores role targets and nothing', () => {
    expect(clickPoint('link:Black Hoodie')).toBeUndefined();
    expect(clickPoint(undefined)).toBeUndefined();
  });
});

describe('targetLine', () => {
  const lines = snapshotsABugged['run_e2f6442a5419/step-000.aria.txt']!.split('\n');

  it('finds the line naming a role target', () => {
    const index = targetLine(lines, 'link:Black Hoodie');
    expect(index).toBeGreaterThanOrEqual(0);
    expect(lines[index]).toContain('link "Black Hoodie"');
  });

  it('finds a bare select target by its word and reports absence as -1', () => {
    const product = snapshotsABugged['run_e2f6442a5419/step-001.aria.txt']!.split('\n');
    expect(product[targetLine(product, 'Size')]).toContain('Size');
    expect(targetLine(product, 'combobox:Colour')).toBe(-1);
    expect(targetLine(product, '262,300')).toBe(-1);
  });
});

describe('stepReason', () => {
  it('is the recorded reason, or the summary of a done step', () => {
    const first = runAlphaABugged.steps[0];
    expect(stepReason(first)).toBe(first?.action?.type === 'done' ? '' : first?.action?.reason);
    const last = runAlphaABugged.steps[runAlphaABugged.steps.length - 1];
    expect(last?.action?.type).toBe('done');
    expect(stepReason(last)).toBeTruthy();
    expect(stepReason(undefined)).toBeUndefined();
  });
});

describe('thesisLine', () => {
  it('names the strongest shopper, its multiple and the cheapest one on the bugged store', () => {
    expect(thesisLine(missionABugged)).toBe(
      'Sigma bought it, at 22 times the price. Your store should work for Alpha.',
    );
  });

  it('says the store works for the cheapest agent once Alpha passes', () => {
    expect(thesisLine(missionAFixed)).toMatch(/^Alpha, the cheapest shopper, bought it\./);
  });
});
