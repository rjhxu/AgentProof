import { describe, expect, it } from 'vitest';
import { Mission } from '@agentproof/shared';
import { hoodieMission } from '@agentproof/shared/fixtures';
import {
  SCENARIOS,
  SCENARIO_IDS,
  parseScenarioId,
  scenarioMission,
  type ScenarioId,
} from './scenarios';

const STORE = 'http://localhost:5000';

describe('SCENARIOS', () => {
  it('lists the five bugs and the control, keyed by their own id', () => {
    expect(Object.keys(SCENARIOS).sort()).toEqual([...SCENARIO_IDS].sort());
    for (const id of SCENARIO_IDS) expect(SCENARIOS[id].id).toBe(id);
  });

  it('A carries the hoodieMission fixture: same prompt and requirements', () => {
    expect(SCENARIOS.A.prompt).toBe(hoodieMission.rawPrompt);
    expect(SCENARIOS.A.requirements).toEqual(hoodieMission.requirements);
    expect(SCENARIOS.A.successMilestone).toBe(hoodieMission.successMilestone);
  });

  it('B is the same mission as A, intended for Gamma', () => {
    expect(SCENARIOS.B.prompt).toBe(SCENARIOS.A.prompt);
    expect(SCENARIOS.B.requirements).toEqual(SCENARIOS.A.requirements);
    expect(SCENARIOS.B.title).toBe('legacy variant map on the cart API');
    expect(SCENARIOS.B.expected.gamma).toBe('failed');
    expect(SCENARIOS.B.sourceFiles).toContain('apps/storefront/src/cart.ts');
  });

  it('matches the answer key for the other scenarios', () => {
    expect(SCENARIOS.C.requirements).toEqual({
      product: 'crewneck sweatshirt',
      category: 'apparel',
      attributes: { color: 'navy', size: 'L' },
      quantity: 1,
      maxUnitPrice: 70,
    });
    expect(SCENARIOS.D.requirements).toEqual({
      product: 'merino crew socks',
      category: 'accessories',
      attributes: { size: 'M' },
      quantity: 3,
    });
    expect(SCENARIOS.E.requirements).toEqual({
      product: 'studio headphones',
      category: 'audio',
      attributes: { connectivity: 'wired' },
      quantity: 1,
      maxUnitPrice: 100,
    });
    expect(SCENARIOS.control.requirements).toEqual({
      product: 'canvas tote',
      attributes: {},
      quantity: 1,
    });
    expect(SCENARIOS.C.productSlug).toBe('crewneck-sweatshirt');
    expect(SCENARIOS.D.productSlug).toBe('merino-socks');
    expect(SCENARIOS.E.productSlug).toBe('studio-headphones');
    expect(SCENARIOS.control.productSlug).toBe('canvas-tote');
  });

  it('expected table: the control passes, every bug fails Alpha at a named checkpoint', () => {
    expect(SCENARIOS.control.expected).toEqual({ alpha: 'passed', gamma: 'passed' });
    expect(SCENARIOS.control.bugMarker).toBeUndefined();
    const failing: Record<Exclude<ScenarioId, 'control'>, string> = {
      A: 'correct_size_identified',
      B: 'correct_size_identified',
      C: 'correct_color_identified',
      D: 'cart_quantity_correct',
      E: 'added_to_cart',
    };
    for (const [id, checkpoint] of Object.entries(failing) as [ScenarioId, string][]) {
      expect(SCENARIOS[id].expected.alpha).toBe('failed');
      expect(SCENARIOS[id].expected.failingCheckpoint).toBe(checkpoint);
      expect(SCENARIOS[id].bugMarker).toBe(`DEMO BUG ${id}`);
    }
    // Only the API path (B) breaks Gamma; the hoodie mission reaches it from A as well.
    expect(SCENARIOS.A.expected.gamma).toBe('failed');
    for (const id of ['C', 'D', 'E'] as const) expect(SCENARIOS[id].expected.gamma).toBe('passed');
  });

  it('every scenario reaches checkout review, never places an order, and names store sources', () => {
    for (const id of SCENARIO_IDS) {
      const s = SCENARIOS[id];
      expect(s.successMilestone).toBe('checkout_review');
      expect(s.prompt.endsWith('Do not place the order.')).toBe(true);
      expect(s.productSlug).toMatch(/^[a-z-]+$/);
      expect(s.sourceFiles.length).toBeGreaterThan(0);
      for (const f of s.sourceFiles) expect(f.startsWith('apps/storefront/src/')).toBe(true);
    }
  });
});

describe('scenarioMission', () => {
  it('produces a valid Mission for every scenario with the schema defaults', () => {
    for (const id of SCENARIO_IDS) {
      const mission = scenarioMission(id, STORE);
      expect(Mission.safeParse(mission).success).toBe(true);
      expect(mission.id).toMatch(/^mis_[0-9a-f]{12}$/);
      expect(Date.parse(mission.createdAt)).not.toBeNaN();
      expect(mission.storeUrl).toBe(STORE);
      expect(mission.rawPrompt).toBe(SCENARIOS[id].prompt);
      expect(mission.requirements).toEqual(SCENARIOS[id].requirements);
      expect(mission.successMilestone).toBe('checkout_review');
      expect(mission.paymentAuthorized).toBe(false);
      expect(mission.maxSteps).toBe(25);
      expect(mission.allowedActions).toEqual([
        'navigate',
        'click',
        'type',
        'select',
        'scroll',
        'extract',
      ]);
    }
  });

  it('gives each call a fresh id and an independent copy of the requirements', () => {
    const a = scenarioMission('A', STORE);
    const b = scenarioMission('A', STORE);
    expect(a.id).not.toBe(b.id);
    a.requirements.attributes.size = 'XL';
    expect(b.requirements.attributes.size).toBe('M');
    expect(SCENARIOS.A.requirements.attributes.size).toBe('M');
  });

  it('A equals the hoodieMission fixture apart from id, timestamp and store', () => {
    const mission = scenarioMission('A', STORE);
    const { id: _id, createdAt: _at, ...rest } = mission;
    const { id: _fid, createdAt: _fat, ...fixture } = hoodieMission;
    expect(rest).toEqual(fixture);
  });

  it('rejects a store URL that is not a URL', () => {
    expect(() => scenarioMission('A', 'not a url')).toThrow();
  });
});

describe('parseScenarioId', () => {
  it('accepts letters in either case and "control"', () => {
    expect(parseScenarioId('a')).toBe('A');
    expect(parseScenarioId(' E ')).toBe('E');
    expect(parseScenarioId('control')).toBe('control');
    expect(parseScenarioId('Control')).toBe('control');
  });

  it('returns undefined for anything else', () => {
    expect(parseScenarioId('F')).toBeUndefined();
    expect(parseScenarioId('')).toBeUndefined();
    expect(parseScenarioId('AB')).toBeUndefined();
  });
});
