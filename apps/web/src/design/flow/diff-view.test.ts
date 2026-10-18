import { describe, expect, it } from 'vitest';

import { classifyDiffLine } from './diff-lines';

describe('classifyDiffLine', () => {
  it('tells headers, hunks, additions, removals and context apart', () => {
    expect(classifyDiffLine('--- a/apps/storefront/src/cart.ts')).toBe('meta');
    expect(classifyDiffLine('+++ b/apps/storefront/src/cart.ts')).toBe('meta');
    expect(classifyDiffLine('@@ -29,9 +29,7 @@')).toBe('hunk');
    expect(classifyDiffLine('+const LEGACY_VARIANT_MAP = {};')).toBe('add');
    expect(classifyDiffLine("-  'HOODIE-001-M': 'HOODIE-001-S',")).toBe('del');
    expect(classifyDiffLine(' export function resolveVariantId() {')).toBe('ctx');
    expect(classifyDiffLine('')).toBe('ctx');
  });
});
