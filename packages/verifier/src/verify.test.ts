import { describe, expect, it } from 'vitest';
import { hoodieMission, alphaFailedRun } from '@agentproof/shared/fixtures';
import type { ObservedCart } from '@agentproof/shared';
import { verify, overallStatus } from './verify';
import { compareRuns } from './compare';

const mediumCart: ObservedCart = {
  source: 'api',
  currency: 'USD',
  subtotal: 49,
  items: [
    {
      productId: 'HOODIE-001',
      variantId: 'HOODIE-001-M',
      name: 'Black Hoodie',
      attributes: { color: 'black', size: 'M' },
      unitPrice: 49,
      quantity: 1,
    },
  ],
};

describe('verify', () => {
  it('passes a correct medium hoodie cart under budget', () => {
    const v = verify({
      mission: hoodieMission,
      cart: mediumCart,
      productPage: { found: true, name: 'Black Hoodie', attributes: { color: 'black', size: 'M' } },
      checkoutReached: { reached: true },
    });
    expect(overallStatus(v)).toBe('passed');
    expect(v.firstFailure).toBeUndefined();
  });

  it('fails cart_matches_variant when the cart holds size S', () => {
    const smallCart: ObservedCart = {
      ...mediumCart,
      items: [
        {
          ...mediumCart.items[0]!,
          variantId: 'HOODIE-001-S',
          attributes: { color: 'black', size: 'S' },
        },
      ],
    };
    const v = verify({ mission: hoodieMission, cart: smallCart });
    const cp = v.checkpoints.find((c) => c.id === 'cart_matches_variant');
    expect(cp?.status).toBe('failed');
    expect(cp?.detail).toContain('size');
  });

  it('fails price_within_budget by arithmetic, not opinion', () => {
    const pricey: ObservedCart = {
      ...mediumCart,
      subtotal: 65,
      items: [{ ...mediumCart.items[0]!, unitPrice: 65 }],
    };
    const v = verify({ mission: hoodieMission, cart: pricey });
    expect(v.checkpoints.find((c) => c.id === 'price_within_budget')?.status).toBe('failed');
  });

  it('marks downstream checkpoints not_tested when no cart was observed', () => {
    const v = verify({ mission: hoodieMission, productPage: { found: false } });
    expect(v.checkpoints.find((c) => c.id === 'product_discovered')?.status).toBe('failed');
    expect(v.checkpoints.find((c) => c.id === 'cart_matches_variant')?.status).toBe('not_tested');
  });

  it('treats "medium" and "M" as the same size', () => {
    const cart: ObservedCart = {
      ...mediumCart,
      items: [{ ...mediumCart.items[0]!, attributes: { color: 'Black', size: 'Medium' } }],
    };
    const v = verify({ mission: hoodieMission, cart });
    expect(v.checkpoints.find((c) => c.id === 'cart_matches_variant')?.status).toBe('passed');
  });
});

describe('compareRuns', () => {
  it('counts improvements between original and rematch', () => {
    const rematch = {
      ...alphaFailedRun,
      id: 'run_rematch',
      label: 'rematch' as const,
      verification: {
        ...alphaFailedRun.verification!,
        checkpoints: alphaFailedRun.verification!.checkpoints.map((c) => ({
          ...c,
          status: 'passed' as const,
        })),
      },
    };
    const cmp = compareRuns(alphaFailedRun, rematch);
    expect(cmp.improved).toBe(3); // two failed + one not_tested -> passed
    expect(cmp.regressed).toBe(0);
  });
});
