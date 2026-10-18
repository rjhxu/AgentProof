import { describe, expect, it } from 'vitest';

import { CHECKPOINT_LABELS } from '@agentproof/shared';

import { missionABugged, problemsABugged, runsABugged } from '../fixtures';
import { buildProblems, orderProblems } from './findings-data';

const frames = { 'run_e2f6442a5419/step-001.png': '/design/alpha-a-step-01.png' };
const carts = Object.fromEntries(
  runsABugged.flatMap((r) => (r.observedCart ? [[r.runId, r.observedCart]] : [])),
);
const cards = buildProblems(missionABugged, runsABugged, problemsABugged, frames, carts);
const [alpha, gamma] = cards;

describe('orderProblems', () => {
  it('puts the problem that broke the purchase path first, whatever the input order', () => {
    const reversed = orderProblems([...problemsABugged].reverse(), runsABugged);
    expect(reversed.map((p) => p.issue.id)).toEqual(['iss_a1b2c3d4e5f6', 'iss_b2c3d4e5f6a1']);
    expect(cards.map((c) => c.issue.id)).toEqual(['iss_a1b2c3d4e5f6', 'iss_b2c3d4e5f6a1']);
  });
});

describe("Alpha's problem", () => {
  it('reads every shopper off the row in stage order, with the verifier detail as its line', () => {
    expect(alpha!.rowId).toBe('correct_size_identified');
    expect(alpha!.shoppers.map((s) => [s.kind, s.status, s.line])).toEqual([
      ['alpha_semantic', 'failed', 'Required size "M", observed "S"'],
      ['beta_vision', 'passed', 'Required size "M", observed "M"'],
      ['gamma_structured', 'passed', 'Identified in live catalog: HOODIE-001-M'],
      ['sigma_hybrid', 'passed', 'Required size "M", observed "M"'],
    ]);
    expect(alpha!.shoppers.map((s) => s.failing)).toEqual([true, false, false, false]);
    expect(alpha!.shoppers.map((s) => s.benchmark)).toEqual([false, false, false, true]);
  });

  it('carries each shopper cost and the multiple over the cheapest', () => {
    expect(alpha!.shoppers.map((s) => s.cost)).toEqual(['$0.0025', '$0.0027', '$0', '$0.054']);
    expect(alpha!.shoppers.map((s) => s.multiple)).toEqual([
      undefined,
      '1.1× Alpha',
      undefined,
      '22× Alpha',
    ]);
  });

  it('says where it broke and keeps the failing evidence', () => {
    expect(alpha!.where).toBe('Choose');
    expect(alpha!.checkpointLabel).toBe(CHECKPOINT_LABELS.correct_size_identified);
    expect(alpha!.target).toBe('Size');
    expect(alpha!.failingStep).toBe(2);
    expect(alpha!.screenshotUrl).toBe('/design/alpha-a-step-01.png');
    expect(alpha!.excerpt).toMatch(/^- main:/);
    expect(alpha!.observedCart).toBeUndefined();
    expect(alpha!.attribution?.category).toBe('semantic_interface_problem');
    expect(alpha!.cost).toBe(
      'Alpha, the cheapest shopper, failed here; Beta passed at 1.1×, Sigma passed at 22×.',
    );
    expect(alpha!.recommendation).toContain('accessible name');
  });
});

describe("Gamma's problem", () => {
  it('reads the chips from the attribution row and the failing line from the catalog check', () => {
    expect(gamma!.rowId).toBe('cart_matches_variant');
    expect(gamma!.rowLabel).toBe(CHECKPOINT_LABELS.cart_matches_variant);
    expect(gamma!.checkpointLabel).toBe(CHECKPOINT_LABELS.catalog_variant_resolves);
    expect(gamma!.where).toBe('Cart API');
    const byKind = Object.fromEntries(gamma!.shoppers.map((s) => [s.kind, s]));
    expect(byKind.gamma_structured?.line).toBe(
      'Requested HOODIE-001-M; cart returned HOODIE-001-S.',
    );
    expect(byKind.beta_vision?.line).toBe(
      'Cart variant HOODIE-001-M matches all requested attributes',
    );
    expect(byKind.gamma_structured?.failing).toBe(true);
  });

  it("points Alpha's failure on that row at the size problem", () => {
    const alphaChip = gamma!.shoppers.find((s) => s.kind === 'alpha_semantic');
    expect(alphaChip?.status).toBe('failed');
    expect(alphaChip?.attributedTo).toBe(0);
    expect(
      gamma!.shoppers.find((s) => s.kind === 'gamma_structured')?.attributedTo,
    ).toBeUndefined();
  });

  it('shows the cart it read back instead of a viewport', () => {
    expect(gamma!.screenshotUrl).toBeUndefined();
    expect(gamma!.excerpt).toBeUndefined();
    expect(gamma!.observedCart?.items[0]?.variantId).toBe('HOODIE-001-S');
    expect(gamma!.recommendation).toContain('cart API');
  });
});

describe('every chip', () => {
  it('is code-written text with the JSON stripped and no absent shopper', () => {
    for (const card of cards) {
      for (const s of card.shoppers) {
        expect(s.line).not.toContain('{');
        expect(s.status).not.toBe('not_run');
      }
    }
  });
});
