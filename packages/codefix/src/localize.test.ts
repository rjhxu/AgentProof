import { describe, it, expect } from 'vitest';
import type { LocalizedFile } from '@agentproof/shared';
import {
  deriveSearchTerms,
  isSourceCandidate,
  rankFiles,
  outlineFile,
  selectForModel,
  DEFAULT_SELECTION_BUDGET,
  type SourceFile,
  type SearchTerm,
} from './localize';
import type { EvidenceBundle } from './evidence';

// Tiny fake store for testing
const fakeStoreFiles: SourceFile[] = [
  {
    path: 'src/views.ts',
    text: `
export const legacySizeChips = () => {
  return (
    <div class="chip" data-size="S">S</div>
  );
};

export function renderSize(size: string) {
  const Size = ['S', 'M', 'L'];
  return Size.map((s) => <div class="chip" key={s}>{s}</div>);
}

// hoodie specific sizing
export const hookieSizeChips = () => {
  return renderSize('hoodie');
};
    `,
  },
  {
    path: 'src/cart.ts',
    text: `
const LEGACY_VARIANT_MAP: Record<string, string> = {
  'HOODIE-001-M': 'HOODIE-001-S',
  'TSHIRT-002-L': 'TSHIRT-002-M',
};

export function resolveVariantId(id: string): string {
  return LEGACY_VARIANT_MAP[id] || id;
}

export function applyLegacyMapping(variantId: string): string {
  if (variantId in LEGACY_VARIANT_MAP) {
    return LEGACY_VARIANT_MAP[variantId];
  }
  return variantId;
}
    `,
  },
  {
    path: 'src/swatches.ts',
    text: `
export interface SwatchConfig {
  color: string;
  hex: string;
}

export const swatches: Record<string, SwatchConfig> = {
  black: { color: 'black', hex: '#000000' },
  navy: { color: 'navy', hex: '#001a4d' },
};

export function renderSwatch(color: string) {
  const config = swatches[color];
  return config ? <div style={{ background: config.hex }}>{config.color}</div> : null;
}
    `,
  },
  {
    path: 'src/quantity-stepper.ts',
    text: `
export interface QuantityStepperProps {
  quantity: number;
  onIncrease: () => void;
  onDecrease: () => void;
}

export const QuantityStepper = ({ quantity, onIncrease, onDecrease }: QuantityStepperProps) => {
  return (
    <div>
      <button onClick={onDecrease}>Decrease</button>
      <span>{quantity}</span>
      <button onClick={onIncrease}>Increase</button>
    </div>
  );
};
    `,
  },
  {
    path: 'src/html.ts',
    text: `
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => {
    const map: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return map[c];
  });
}

export function sanitizeInput(input: string): string {
  return escapeHtml(input);
}
    `,
  },
];

describe('deriveSearchTerms', () => {
  it('Bug A: semantic_interface_problem for size picker', () => {
    const bundle: EvidenceBundle = {
      agentKind: 'alpha_semantic',
      checkpointId: 'correct_size_identified',
      checkpointLabel: 'Correct size identified',
      observed: 'No combobox "Size" found in accessibility tree; default size S was selected',
      attributionCategory: 'semantic_interface_problem',
      attributionReason: 'Size picker is a mouse-only div with no accessible role',
      requirements: {
        product: 'black hoodie',
        attributes: { color: 'black', size: 'M' },
        quantity: 1,
      },
      successMilestone: 'added_to_cart',
      storeUrl: 'http://localhost:5000',
      stepLines: [
        '#2 select combobox:Size = M -> error: no combobox "Size" in the accessibility tree',
        '#3 click button:Add to cart -> ok',
      ],
      stepsTotal: 5,
      failurePoint: {
        stepIndex: 2,
        attempted: 'select combobox:Size = M',
        outcome: 'error: no combobox "Size" in the accessibility tree',
        perceived: 'no combobox "Size" in the accessibility tree',
      },
      observedCart: {
        subtotal: 49,
        currency: 'USD',
        source: 'api',
        items: [
          {
            productId: 'HOODIE-001',
            variantId: 'HOODIE-001-S',
            name: 'Black Hoodie',
            unitPrice: 49,
            quantity: 1,
            attributes: { color: 'black', size: 'S' },
          },
        ],
      },
      visitedUrls: ['/', '/products/black-hoodie'],
    };

    const terms = deriveSearchTerms(bundle);
    const termSet = new Set(terms.map((t) => t.term.toLowerCase()));

    // Should include size-related terms
    expect(
      Array.from(termSet).some(
        (t) =>
          t.includes('size') || t === 'add to cart' || t === 'aria-label' || t === 'aria-hidden',
      ),
    ).toBe(true);

    // Should include product terms
    expect(Array.from(termSet).some((t) => t.includes('black') || t.includes('hoodie'))).toBe(true);

    // Should include variant id (lowercase)
    expect(Array.from(termSet).some((t) => t === 'hoodie-001-s' || t === 'hoodie-001')).toBe(true);

    // Total should be at most 40
    expect(terms.length).toBeLessThanOrEqual(40);

    // Should be deduplicated
    const uniqueTerms = new Set(terms.map((t) => t.term.toLowerCase()));
    expect(uniqueTerms.size).toBe(terms.length);
  });

  it('Bug B: product_data_inconsistency with variant mapping', () => {
    const bundle: EvidenceBundle = {
      agentKind: 'gamma_structured',
      checkpointId: 'catalog_variant_resolves',
      checkpointLabel: 'Catalog variant resolves',
      observed: 'Cart shows HOODIE-001-S but catalog record shows HOODIE-001-M',
      attributionCategory: 'product_data_inconsistency',
      attributionReason: 'LEGACY_VARIANT_MAP silently converts size M to S',
      requirements: {
        product: 'black hoodie',
        attributes: { color: 'black', size: 'M' },
        quantity: 1,
      },
      successMilestone: 'added_to_cart',
      storeUrl: 'http://localhost:5000',
      stepLines: ['#1 check catalog for HOODIE variant', '#2 add variant HOODIE-001-M to cart'],
      stepsTotal: 2,
      observedCart: {
        subtotal: 49,
        currency: 'USD',
        source: 'api',
        items: [
          {
            productId: 'HOODIE-001',
            variantId: 'HOODIE-001-S',
            name: 'Black Hoodie',
            attributes: {},
            unitPrice: 49,
            quantity: 1,
          },
        ],
      },
      catalogRecord: {
        selectedVariant: { id: 'HOODIE-001-M' },
      },
      cartApi: {
        items: [
          {
            variantId: 'HOODIE-001-S',
            name: 'Black Hoodie',
          },
        ],
      },
      visitedUrls: ['/', '/products/black-hoodie'],
    };

    const terms = deriveSearchTerms(bundle);
    const termSet = new Set(terms.map((t) => t.term.toLowerCase()));

    // Should include variant mapping related terms
    expect(Array.from(termSet).some((t) => t === 'legacy' || t === 'map' || t === 'variant')).toBe(
      true,
    );

    // Should include both variant ids
    expect(Array.from(termSet).some((t) => t === 'hoodie-001-m' || t === 'hoodie-001')).toBe(true);

    // matchedTerms for Bug B should include hoodie-001-m
    const bugBTerms = terms.map((t) => t.term.toLowerCase());
    expect(bugBTerms.some((t) => t === 'hoodie-001-m')).toBe(true);
  });

  it('returns at most 40 terms, deduplicated, deterministically sorted', () => {
    const bundle: EvidenceBundle = {
      agentKind: 'alpha_semantic',
      checkpointId: 'added_to_cart',
      checkpointLabel: 'Added to cart',
      observed: 'Item added',
      requirements: {
        product: 'very long product name with many words and hyphens',
        attributes: {
          attr1: 'value1',
          attr2: 'value2',
          attr3: 'value3',
          attr4: 'value4',
          attr5: 'value5',
        },
        quantity: 1,
      },
      successMilestone: 'added_to_cart',
      storeUrl: 'http://localhost:5000',
      stepLines: [
        'click button:Add to cart',
        'click button:Add to Cart',
        'click button:add to cart',
      ],
      stepsTotal: 3,
      visitedUrls: ['/products/very-long-name'],
    };

    const terms1 = deriveSearchTerms(bundle);
    const terms2 = deriveSearchTerms(bundle);

    // Deterministic order
    expect(terms1).toEqual(terms2);

    // At most 40
    expect(terms1.length).toBeLessThanOrEqual(40);

    // Deduplicated
    const termSet = new Set(terms1.map((t) => t.term.toLowerCase()));
    expect(termSet.size).toBe(terms1.length);

    // Sorted by weight desc, then alphabetically
    for (let i = 1; i < terms1.length; i++) {
      const prev = terms1[i - 1];
      const curr = terms1[i];
      if (prev && curr) {
        if (Math.abs(prev.weight - curr.weight) < 0.01) {
          // Same weight, should be alphabetical
          expect(prev.term.localeCompare(curr.term)).toBeLessThanOrEqual(0);
        } else {
          // Different weight, should be descending
          expect(prev.weight).toBeGreaterThanOrEqual(curr.weight);
        }
      }
    }
  });
});

describe('isSourceCandidate', () => {
  it('accepts src/views.ts with empty storeRoot', () => {
    expect(isSourceCandidate('src/views.ts', '')).toBe(true);
    expect(isSourceCandidate('src/views.ts', '/')).toBe(true);
  });

  it('accepts apps/storefront/src/views.ts with storeRoot apps/storefront', () => {
    expect(isSourceCandidate('apps/storefront/src/views.ts', 'apps/storefront')).toBe(true);
    expect(isSourceCandidate('apps/storefront/src/views.ts', '/apps/storefront/')).toBe(true);
    expect(isSourceCandidate('apps/storefront/src/views.ts', 'apps/storefront/')).toBe(true);
  });

  it('rejects files outside src/', () => {
    expect(isSourceCandidate('docs/x.ts', '')).toBe(false);
    expect(isSourceCandidate('app.ts', '')).toBe(false);
  });

  it('rejects test and spec files', () => {
    expect(isSourceCandidate('src/views.test.ts', '')).toBe(false);
    expect(isSourceCandidate('src/views.spec.ts', '')).toBe(false);
    expect(isSourceCandidate('src/views.test.tsx', '')).toBe(false);
  });

  it('rejects .d.ts files', () => {
    expect(isSourceCandidate('src/types.d.ts', '')).toBe(false);
  });

  it('rejects non-source extensions', () => {
    expect(isSourceCandidate('src/img.png', '')).toBe(false);
    expect(isSourceCandidate('src/config.json', '')).toBe(false);
  });

  it('rejects files under excluded directories', () => {
    expect(isSourceCandidate('src/node_modules/x/a.ts', '')).toBe(false);
    expect(isSourceCandidate('src/dist/app.ts', '')).toBe(false);
    expect(isSourceCandidate('src/build/app.ts', '')).toBe(false);
    expect(isSourceCandidate('src/public/app.js', '')).toBe(false);
    expect(isSourceCandidate('src/.git/objects/x', '')).toBe(false);
  });

  it('rejects files when storeRoot mismatch', () => {
    expect(isSourceCandidate('src/views.ts', 'apps/storefront')).toBe(false);
    expect(isSourceCandidate('apps/web/src/views.ts', 'apps/storefront')).toBe(false);
  });

  it('accepts allowlisted extensions', () => {
    expect(isSourceCandidate('src/app.ts', '')).toBe(true);
    expect(isSourceCandidate('src/app.tsx', '')).toBe(true);
    expect(isSourceCandidate('src/app.js', '')).toBe(true);
    expect(isSourceCandidate('src/app.jsx', '')).toBe(true);
    expect(isSourceCandidate('src/app.mjs', '')).toBe(true);
    expect(isSourceCandidate('src/app.cjs', '')).toBe(true);
    expect(isSourceCandidate('src/styles.html', '')).toBe(true);
    expect(isSourceCandidate('src/styles.css', '')).toBe(true);
  });
});

describe('rankFiles', () => {
  it('ranks views.ts first for Bug A terms', () => {
    const terms: SearchTerm[] = [
      { term: 'size', weight: 2.5, source: 'control' },
      { term: 'add to cart', weight: 2.5, source: 'control' },
      { term: 'aria-label', weight: 1.0, source: 'category' },
      { term: 'chip', weight: 1.0, source: 'category' },
    ];

    const ranked = rankFiles(fakeStoreFiles, terms);

    // views.ts should be first (has 'chip' and mentions 'size')
    expect(ranked[0]?.path).toBe('src/views.ts');
    expect(ranked[0]?.score ?? 0).toBeGreaterThan(0);
  });

  it('ranks cart.ts first for Bug B terms', () => {
    const terms: SearchTerm[] = [
      { term: 'legacy', weight: 1.0, source: 'category' },
      { term: 'map', weight: 1.0, source: 'category' },
      { term: 'hoodie-001-m', weight: 3.0, source: 'variant' },
    ];

    const ranked = rankFiles(fakeStoreFiles, terms);

    // cart.ts should rank very high (has LEGACY_VARIANT_MAP)
    const cartIndex = ranked.findIndex((f) => f.path === 'src/cart.ts');
    expect(cartIndex).toBeGreaterThanOrEqual(0);
    expect(cartIndex).toBeLessThan(2);
  });

  it('includes all files even those with score 0', () => {
    const terms: SearchTerm[] = [{ term: 'nonexistent', weight: 1.0, source: 'product' }];

    const ranked = rankFiles(fakeStoreFiles, terms);

    // All files should be included
    expect(ranked.length).toBe(fakeStoreFiles.length);

    // Files with score 0 should be at the end, sorted by bytes asc
    const zeroScoreFiles = ranked.filter((f) => f.score === 0);
    expect(zeroScoreFiles.length).toBeGreaterThan(0);

    for (let i = 1; i < zeroScoreFiles.length; i++) {
      const prev = zeroScoreFiles[i - 1];
      const curr = zeroScoreFiles[i];
      if (prev && curr) {
        expect(prev.bytes).toBeLessThanOrEqual(curr.bytes);
      }
    }
  });

  it('sorts by score desc, then bytes asc, then path asc', () => {
    const terms: SearchTerm[] = [{ term: 'chip', weight: 1.0, source: 'category' }];

    const ranked = rankFiles(fakeStoreFiles, terms);

    for (let i = 1; i < ranked.length; i++) {
      const prev = ranked[i - 1];
      const curr = ranked[i];
      if (!prev || !curr) continue;

      if (Math.abs(prev.score - curr.score) > 0.001) {
        expect(prev.score).toBeGreaterThanOrEqual(curr.score);
      } else if (prev.bytes !== curr.bytes) {
        expect(prev.bytes).toBeLessThanOrEqual(curr.bytes);
      } else {
        expect(prev.path.localeCompare(curr.path)).toBeLessThanOrEqual(0);
      }
    }
  });

  it('includes at most 12 matched terms per file', () => {
    const terms: SearchTerm[] = Array.from({ length: 20 }, (_, i) => ({
      term: `term${i}`,
      weight: 1.0,
      source: 'category' as const,
    }));

    const ranked = rankFiles(fakeStoreFiles, terms);

    for (const file of ranked) {
      expect(file.matchedTerms.length).toBeLessThanOrEqual(12);
    }
  });

  it('calculates bytes as UTF-8 length', () => {
    const ranked = rankFiles(fakeStoreFiles, []);

    for (let i = 0; i < fakeStoreFiles.length; i++) {
      const file = fakeStoreFiles[i];
      if (!file) continue;
      const expectedBytes = Buffer.byteLength(file.text, 'utf-8');
      expect(ranked.some((f) => f.path === file.path && f.bytes === expectedBytes)).toBe(true);
    }
  });
});

describe('outlineFile', () => {
  it('extracts export function signatures', () => {
    const text = `
export function myFunc() {
  // ...
}

export const myConst = () => {};

export default class MyClass {}
`;

    const outline = outlineFile(text);
    expect(outline).toContain('export function myFunc');
    expect(outline).toContain('export const myConst');
    expect(outline).toContain('export default class MyClass');
  });

  it('trims lines to 120 chars', () => {
    const longLine = 'export function ' + 'a'.repeat(200) + '() { return "very long"; }';
    const text = longLine;

    const outline = outlineFile(text);
    const lines = outline.split('\n');
    for (const line of lines) {
      if (line !== '(no exports)') {
        expect(line.length).toBeLessThanOrEqual(120);
      }
    }
  });

  it('caps at maxLines (default 40)', () => {
    const lines = Array.from({ length: 50 }, (_, i) => `export const var${i} = ${i};`);
    const text = lines.join('\n');

    const outline = outlineFile(text);
    expect(outline.split('\n').length).toBeLessThanOrEqual(40);
  });

  it('respects custom maxLines', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `export const var${i} = ${i};`);
    const text = lines.join('\n');

    const outline = outlineFile(text, 5);
    expect(outline.split('\n').length).toBeLessThanOrEqual(5);
  });

  it('returns "(no exports)" when no export lines', () => {
    const text = `
const x = 1;
function y() {}
class Z {}
`;

    const outline = outlineFile(text);
    expect(outline).toBe('(no exports)');
  });

  it('handles async exports', () => {
    const text = `
export async function loadData() {
  // ...
}
`;

    const outline = outlineFile(text);
    expect(outline).toContain('export async function loadData');
  });

  it('handles type and interface exports', () => {
    const text = `
export type MyType = string | number;
export interface MyInterface {
  prop: string;
}
export enum MyEnum {
  A,
  B,
}
`;

    const outline = outlineFile(text);
    expect(outline).toContain('export type MyType');
    expect(outline).toContain('export interface MyInterface');
    expect(outline).toContain('export enum MyEnum');
  });
});

describe('selectForModel', () => {
  it('respects maxFiles and maxChars budget', () => {
    const ranked: LocalizedFile[] = [
      {
        path: 'src/a.ts',
        score: 10,
        matchedTerms: ['term1'],
        bytes: 200,
        included: false,
        flags: [],
      },
      {
        path: 'src/b.ts',
        score: 9,
        matchedTerms: ['term2'],
        bytes: 200,
        included: false,
        flags: [],
      },
      {
        path: 'src/c.ts',
        score: 8,
        matchedTerms: ['term3'],
        bytes: 200,
        included: false,
        flags: [],
      },
      {
        path: 'src/d.ts',
        score: 7,
        matchedTerms: ['term4'],
        bytes: 200,
        included: false,
        flags: [],
      },
    ];

    const files = new Map<string, string>([
      ['src/a.ts', 'a'.repeat(200)],
      ['src/b.ts', 'b'.repeat(200)],
      ['src/c.ts', 'c'.repeat(200)],
      ['src/d.ts', 'd'.repeat(200)],
    ]);

    const budget = { maxFiles: 2, maxChars: 500 };
    const result = selectForModel(ranked, files, budget);

    expect(result.included.length).toBeLessThanOrEqual(2);
    let totalChars = result.included.reduce((s, f) => s + f.text.length, 0);
    expect(totalChars).toBeLessThanOrEqual(500);
  });

  it('includes forceInclude paths first', () => {
    const ranked: LocalizedFile[] = [
      {
        path: 'src/a.ts',
        score: 10,
        matchedTerms: [],
        bytes: 50,
        included: false,
        flags: [],
      },
      {
        path: 'src/b.ts',
        score: 5,
        matchedTerms: [],
        bytes: 50,
        included: false,
        flags: [],
      },
    ];

    const files = new Map<string, string>([
      ['src/a.ts', 'a'.repeat(50)],
      ['src/b.ts', 'b'.repeat(50)],
    ]);

    const result = selectForModel(ranked, files, { maxFiles: 10, maxChars: 200 }, ['src/b.ts']);

    expect(result.included[0]?.path).toBe('src/b.ts');
  });

  it('marks missing files as "(file not readable)"', () => {
    const ranked: LocalizedFile[] = [
      {
        path: 'src/exists.ts',
        score: 10,
        matchedTerms: [],
        bytes: 50,
        included: false,
        flags: [],
      },
      {
        path: 'src/missing.ts',
        score: 9,
        matchedTerms: [],
        bytes: 50,
        included: false,
        flags: [],
      },
    ];

    const files = new Map<string, string>([['src/exists.ts', 'exists content']]);

    const result = selectForModel(ranked, files);

    const missingOutline = result.outlined.find((o) => o.path === 'src/missing.ts');
    expect(missingOutline?.outline).toBe('(file not readable)');
  });

  it('sets included flags correctly', () => {
    const ranked: LocalizedFile[] = [
      {
        path: 'src/a.ts',
        score: 10,
        matchedTerms: [],
        bytes: 50,
        included: false,
        flags: [],
      },
      {
        path: 'src/b.ts',
        score: 5,
        matchedTerms: [],
        bytes: 50,
        included: false,
        flags: [],
      },
    ];

    const files = new Map<string, string>([
      ['src/a.ts', 'a'.repeat(50)],
      ['src/b.ts', 'b'.repeat(50)],
    ]);

    const result = selectForModel(ranked, files, { maxFiles: 1, maxChars: 100 });

    const aFile = result.ranked.find((f) => f.path === 'src/a.ts');
    const bFile = result.ranked.find((f) => f.path === 'src/b.ts');

    expect(aFile?.included).toBe(true);
    expect(bFile?.included).toBe(false);
  });

  it('includes forced file even if it exceeds maxChars alone', () => {
    const ranked: LocalizedFile[] = [
      {
        path: 'src/huge.ts',
        score: 1,
        matchedTerms: [],
        bytes: 20000,
        included: false,
        flags: [],
      },
    ];

    const files = new Map<string, string>([['src/huge.ts', 'x'.repeat(20000)]]);

    const result = selectForModel(ranked, files, { maxFiles: 1, maxChars: 100 }, ['src/huge.ts']);

    expect(result.included[0]?.path).toBe('src/huge.ts');
  });

  it('outlines remaining files with export signatures', () => {
    const ranked: LocalizedFile[] = [
      {
        path: 'src/a.ts',
        score: 10,
        matchedTerms: [],
        bytes: 50,
        included: false,
        flags: [],
      },
      {
        path: 'src/b.ts',
        score: 5,
        matchedTerms: [],
        bytes: 50,
        included: false,
        flags: [],
      },
    ];

    const files = new Map<string, string>([
      ['src/a.ts', 'export function foo() {}'],
      ['src/b.ts', 'export function bar() {}'],
    ]);

    const result = selectForModel(ranked, files, { maxFiles: 1, maxChars: 100 });

    expect(result.outlined.length).toBe(1);
    expect(result.outlined[0]?.outline).toContain('export function bar');
  });

  it('preserves rank order in outlined list', () => {
    const ranked: LocalizedFile[] = [
      {
        path: 'src/a.ts',
        score: 10,
        matchedTerms: [],
        bytes: 50,
        included: false,
        flags: [],
      },
      {
        path: 'src/b.ts',
        score: 9,
        matchedTerms: [],
        bytes: 50,
        included: false,
        flags: [],
      },
      {
        path: 'src/c.ts',
        score: 8,
        matchedTerms: [],
        bytes: 50,
        included: false,
        flags: [],
      },
    ];

    const files = new Map<string, string>([
      ['src/a.ts', 'export function a() {}'],
      ['src/b.ts', 'export function b() {}'],
      ['src/c.ts', 'export function c() {}'],
    ]);

    const result = selectForModel(ranked, files, { maxFiles: 1, maxChars: 100 });

    // a should be included, b and c should be outlined in that order
    expect(result.included[0]?.path).toBe('src/a.ts');
    expect(result.outlined[0]?.path).toBe('src/b.ts');
    expect(result.outlined[1]?.path).toBe('src/c.ts');
  });
});

describe('DEFAULT_SELECTION_BUDGET', () => {
  it('has correct defaults', () => {
    expect(DEFAULT_SELECTION_BUDGET.maxFiles).toBe(5);
    expect(DEFAULT_SELECTION_BUDGET.maxChars).toBe(24000);
  });
});

// ---- against the real storefront source ----------------------------------------------------------
import fs from 'node:fs';
import path from 'node:path';
import { alphaFailedRun, hoodieMission } from '@agentproof/shared/fixtures';
import { buildEvidenceBundle } from './evidence';
import { shapeMultiplier, markupDensity, dataDensity } from './localize';

function realStoreFiles(): SourceFile[] {
  const dir = path.resolve(import.meta.dirname, '../../../apps/storefront/src');
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => ({
      path: `apps/storefront/src/${f}`,
      text: fs.readFileSync(path.join(dir, f), 'utf8'),
    }));
}

describe('on the real storefront source', () => {
  const files = realStoreFiles();

  it('derives whole accessible names from role:name targets and quoted strings', () => {
    const checkpoint = alphaFailedRun.verification!.firstFailure!;
    const bundle = buildEvidenceBundle({ mission: hoodieMission, run: alphaFailedRun, checkpoint });
    const terms = deriveSearchTerms(bundle).map((t) => t.term);
    expect(terms).toContain('add to cart');
    expect(terms).toContain('black hoodie');
    expect(terms).toContain('size');
    expect(terms).not.toContain('add');
  });

  it('ranks the view template above the catalog data for a missing size control (Bug A)', () => {
    const checkpoint = alphaFailedRun.verification!.firstFailure!;
    const bundle = buildEvidenceBundle({ mission: hoodieMission, run: alphaFailedRun, checkpoint });
    const terms = deriveSearchTerms(bundle);
    const ranked = rankFiles(files, terms, { checkpointId: checkpoint.id });
    expect(ranked[0]?.path).toBe('apps/storefront/src/views.ts');
    const selection = selectForModel(ranked, new Map(files.map((f) => [f.path, f.text])));
    expect(selection.included.map((f) => f.path)).toContain('apps/storefront/src/views.ts');
    // Without hints the data file wins on raw term frequency: the hints exist for this reason.
    const unhinted = rankFiles(files, terms);
    expect(unhinted[0]?.path).toBe('apps/storefront/src/catalog.ts');
  });

  it('keeps the mapping file in view for a variant mismatch (Bug B)', () => {
    const bundle = buildEvidenceBundle({
      mission: hoodieMission,
      run: {
        ...alphaFailedRun,
        agent: { ...alphaFailedRun.agent, kind: 'gamma_structured' },
        evidence: [
          {
            id: 'ev_cat',
            runId: alphaFailedRun.id,
            kind: 'catalog_record',
            capturedAt: '2026-10-17T20:00:00.000Z',
            data: { selectedVariant: { id: 'HOODIE-001-M' } },
          },
        ],
      },
      checkpoint: {
        id: 'catalog_variant_resolves',
        status: 'failed',
        detail: 'Requested HOODIE-001-M, the cart holds HOODIE-001-S.',
        evidenceIds: ['ev_cat'],
      },
    });
    const terms = deriveSearchTerms(bundle);
    const ranked = rankFiles(files, terms, {
      checkpointId: 'catalog_variant_resolves',
      category: 'product_data_inconsistency',
    });
    const top = ranked.slice(0, 3).map((f) => f.path);
    expect(top).toContain('apps/storefront/src/cart.ts');
    const selection = selectForModel(ranked, new Map(files.map((f) => [f.path, f.text])));
    expect(selection.included.map((f) => f.path)).toContain('apps/storefront/src/cart.ts');
  });

  it('measures shape: templates are markup-dense, the catalog is record-dense', () => {
    const views = files.find((f) => f.path.endsWith('views.ts'))!;
    const catalog = files.find((f) => f.path.endsWith('catalog.ts'))!;
    expect(markupDensity(views.text)).toBeGreaterThan(markupDensity(catalog.text));
    expect(dataDensity(catalog.text)).toBeGreaterThan(dataDensity(views.text));
    expect(
      shapeMultiplier(views.text, { checkpointId: 'correct_size_identified' }),
    ).toBeGreaterThan(1);
    expect(shapeMultiplier(catalog.text, { checkpointId: 'correct_size_identified' })).toBeLessThan(
      1,
    );
    expect(shapeMultiplier(catalog.text, undefined)).toBe(1);
  });

  it('excludes build and vendor directories by segment, not by substring', () => {
    expect(isSourceCandidate('src/distribution.ts', '')).toBe(true);
    expect(isSourceCandidate('src/publicApi.ts', '')).toBe(true);
    expect(isSourceCandidate('src/dist/x.ts', '')).toBe(false);
  });
});
