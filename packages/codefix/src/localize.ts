import type { LocalizedFile } from '@agentproof/shared';
import type { EvidenceBundle } from './evidence';

/**
 * Evidence bundle: a collection of facts from a failed run that will be searched
 * in source files to identify candidates for the model to examine.
 */

export type TermSource = 'product' | 'variant' | 'attribute' | 'control' | 'category' | 'url';

export interface SearchTerm {
  term: string;
  weight: number;
  source: TermSource;
}

const STOPWORDS = new Set([
  'a',
  'an',
  'the',
  'in',
  'for',
  'of',
  'and',
  'with',
  'to',
  'under',
  'less',
  'than',
  'pair',
  'pairs',
]);

/**
 * Split text on whitespace and hyphens, lowercase, filter out stopwords and short words.
 */
function tokenizeProduct(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[\s\-]+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
}

/**
 * Derive weighted search terms from evidence bundle.
 * Lowercase, deduplicated (keeping highest weight), at most 40 terms, deterministic order.
 */
export function deriveSearchTerms(bundle: EvidenceBundle): SearchTerm[] {
  const termMap = new Map<string, { weight: number; source: TermSource }>();

  // product: split on whitespace and hyphens, also include hyphenated full product
  const productTerms = tokenizeProduct(bundle.requirements.product);
  for (const term of productTerms) {
    const key = term.toLowerCase();
    updateTermMap(termMap, key, 2.0, 'product');
  }
  // Also add the full product as hyphenated variant
  const hyphenatedProduct = bundle.requirements.product.toLowerCase().replace(/\s+/g, '-');
  updateTermMap(termMap, hyphenatedProduct, 2.0, 'product');

  // url: extract slug parts from /products/<slug> paths
  for (const url of bundle.visitedUrls) {
    const match = url.match(/\/products\/([^/?]+)/);
    if (match && match[1]) {
      const slug = match[1];
      // Add each hyphen-separated part if longer than 3 chars
      for (const part of slug.split('-')) {
        if (part.length > 3) {
          updateTermMap(termMap, part.toLowerCase(), 2.0, 'url');
        }
      }
    }
  }

  // variant: variantId, productId, and pattern matches in catalogRecord/cartApi
  if (bundle.observedCart?.items && Array.isArray(bundle.observedCart.items)) {
    for (const item of bundle.observedCart.items) {
      if (item && item.variantId) {
        updateTermMap(termMap, item.variantId.toLowerCase(), 3.0, 'variant');
        // Also add prefix before last hyphen
        const match = item.variantId.match(/^(.+?)-[^-]+$/);
        if (match && match[1]) {
          updateTermMap(termMap, match[1].toLowerCase(), 3.0, 'variant');
        }
      }
      if (item && item.productId) {
        updateTermMap(termMap, item.productId.toLowerCase(), 3.0, 'variant');
      }
    }
  }

  // Extract variant patterns from catalogRecord and cartApi
  extractVariantPatterns(bundle.catalogRecord, termMap);
  extractVariantPatterns(bundle.cartApi, termMap);

  // attribute: keys from requirements.attributes, and values > 2 chars
  for (const [key, value] of Object.entries(bundle.requirements.attributes)) {
    updateTermMap(termMap, key.toLowerCase(), 1.5, 'attribute');
    if (value.length > 2) {
      updateTermMap(termMap, value.toLowerCase(), 1.5, 'attribute');
    }
  }

  // control: from stepLines and failurePoint
  extractControlTerms(bundle.stepLines, termMap);
  if (bundle.failurePoint?.attempted) {
    extractControlTerms([bundle.failurePoint.attempted], termMap);
  }
  if (bundle.failurePoint?.outcome) {
    extractControlTerms([bundle.failurePoint.outcome], termMap);
  }

  // category: by attributionCategory and checkpointId
  const categoryTerms = getCategoryTerms(bundle.attributionCategory, bundle.checkpointId);
  for (const term of categoryTerms) {
    updateTermMap(termMap, term.toLowerCase(), 1.0, 'category');
  }

  // Convert to array, deduplicate keeping highest weight, limit to 40, sort
  const result: SearchTerm[] = [];
  for (const [term, { weight, source }] of termMap) {
    result.push({ term, weight, source });
  }

  // Sort by weight desc, then alphabetically
  result.sort((a, b) => {
    if (b.weight !== a.weight) return b.weight - a.weight;
    return a.term.localeCompare(b.term);
  });

  return result.slice(0, 40);
}

function updateTermMap(
  map: Map<string, { weight: number; source: TermSource }>,
  term: string,
  weight: number,
  source: TermSource,
) {
  const existing = map.get(term);
  if (!existing || existing.weight < weight) {
    map.set(term, { weight, source });
  }
}

function extractVariantPatterns(
  obj: unknown,
  termMap: Map<string, { weight: number; source: TermSource }>,
  depth = 0,
) {
  if (depth > 4 || !obj) return;

  if (typeof obj === 'string') {
    const match = obj.match(/^[A-Z]{2,}-\d{3}(-[A-Z0-9]+)*$/);
    if (match) {
      updateTermMap(termMap, obj.toLowerCase(), 3.0, 'variant');
      // Also add prefix before last hyphen
      const prefixMatch = obj.match(/^(.+?)-[^-]+$/);
      if (prefixMatch && prefixMatch[1]) {
        updateTermMap(termMap, prefixMatch[1].toLowerCase(), 3.0, 'variant');
      }
    }
    return;
  }

  if (Array.isArray(obj)) {
    for (const item of obj) {
      extractVariantPatterns(item, termMap, depth + 1);
    }
  } else if (typeof obj === 'object') {
    for (const value of Object.values(obj)) {
      extractVariantPatterns(value, termMap, depth + 1);
    }
  }
}

function extractControlTerms(
  lines: string[],
  termMap: Map<string, { weight: number; source: TermSource }>,
) {
  for (const line of lines) {
    // `click button:Add to cart -> ok`, `select combobox:Size = M -> error: ...`: the accessible
    // name is everything after the role's colon up to ` = `, ` -> ` or the end of the line.
    const roleMatches = line.matchAll(
      /\b(?:button|link|combobox|radio|checkbox|textbox|spinbutton|option|tab|menuitem|heading|listbox|switch|slider|img|region|group|radiogroup):([^\n]*?)(?=\s+=\s|\s+->\s|$)/g,
    );
    for (const match of roleMatches) {
      const name = match[1]?.trim().toLowerCase();
      if (name && name.length >= 3) {
        updateTermMap(termMap, name, 2.5, 'control');
      }
    }

    // Double-quoted strings: `no button "Add to cart" in the accessibility tree`.
    const quoted = line.match(/"([^"]+)"/g);
    if (quoted) {
      for (const q of quoted) {
        const text = q.slice(1, -1).trim().toLowerCase();
        if (text.length >= 3 && text.length <= 60) {
          updateTermMap(termMap, text, 2.5, 'control');
        }
      }
    }
  }
}

function getCategoryTerms(category?: string, checkpointId?: string): string[] {
  const terms: string[] = [];

  if (category === 'semantic_interface_problem') {
    terms.push(
      'aria-',
      'role=',
      'aria-label',
      'aria-hidden',
      'label',
      'fieldset',
      'legend',
      'tabindex',
      'hidden',
    );
  } else if (category === 'product_data_inconsistency') {
    terms.push('variant', 'map', 'legacy', 'resolve', 'catalog', 'sku', 'price');
  }

  if (checkpointId === 'correct_size_identified') {
    terms.push('size', 'chip', 'picker', 'option');
  } else if (checkpointId === 'correct_color_identified') {
    terms.push('swatch', 'color', 'colour');
  } else if (checkpointId === 'cart_quantity_correct') {
    terms.push('quantity', 'stepper', 'increase', 'decrease');
  } else if (checkpointId === 'added_to_cart') {
    terms.push('add to cart', 'buy', 'aria-hidden', 'inert');
  } else if (
    checkpointId === 'cart_matches_variant' ||
    checkpointId === 'catalog_variant_resolves'
  ) {
    terms.push('variant', 'map', 'legacy');
  }

  return terms;
}

export const SOURCE_EXTENSIONS = [
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.html',
  '.css',
] as const;

/**
 * Check if a file is a valid source candidate for model inspection.
 * Must be inside <storeRoot>/src/, have an allowlisted extension, not test/spec files, etc.
 */
export function isSourceCandidate(path: string, storeRoot: string): boolean {
  // Normalize storeRoot (remove leading/trailing slashes)
  let normalized = storeRoot.replace(/^\/+|\/+$/g, '');

  // Build expected prefix
  let prefix: string;
  if (normalized) {
    prefix = normalized + '/src/';
  } else {
    prefix = 'src/';
  }

  // Check if path starts with the prefix
  if (!path.startsWith(prefix)) {
    return false;
  }

  // Check for excluded patterns
  if (/(^|\/)(node_modules|dist|build|public|\.git)(\/|$)/.test(path)) {
    return false;
  }

  // Check for test/spec files
  if (path.includes('.test.') || path.includes('.spec.')) {
    return false;
  }

  // Check for .d.ts files
  if (path.endsWith('.d.ts')) {
    return false;
  }

  // Check extension
  const hasValidExtension = (SOURCE_EXTENSIONS as readonly string[]).some((ext) =>
    path.endsWith(ext),
  );
  if (!hasValidExtension) {
    return false;
  }

  return true;
}

export interface SourceFile {
  path: string;
  text: string;
}

/**
 * Score every file by weighted term hits and rank.
 * Deterministic ordering: score desc, bytes asc, path asc.
 */
/**
 * What the failure is about, so file kinds can be weighed: a missing control lives in markup, a
 * wrong variant lives in data or a mapping. Both optional; without hints, term hits alone rank.
 */
export interface RankHints {
  checkpointId?: string;
  category?: string;
}

const UI_CHECKPOINTS = new Set([
  'product_discovered',
  'correct_size_identified',
  'correct_color_identified',
  'added_to_cart',
  'cart_quantity_correct',
  'checkout_review_reached',
]);
const DATA_CHECKPOINTS = new Set([
  'cart_matches_variant',
  'catalog_variant_resolves',
  'catalog_price_matches_page',
  'price_within_budget',
]);

/** HTML tag openings per 1,000 characters: how much of the file renders markup. */
export function markupDensity(text: string): number {
  const tags = text.match(/<[a-z][a-z0-9-]*(?=[\s>/])/gi)?.length ?? 0;
  return (tags * 1000) / Math.max(text.length, 1);
}

/** Record-like fields per 1,000 characters: how much of the file is product data. */
export function dataDensity(text: string): number {
  const fields =
    text.match(/\b(?:id|price|inStock|sku|slug|name|variantId)\s*:\s*['"\d\[{]/g)?.length ?? 0;
  return (fields * 1000) / Math.max(text.length, 1);
}

/**
 * Multiplier from the file's shape and the failure's kind. UI failures favour markup-heavy files
 * and discount pure data files (the catalog mentions every product term but renders nothing);
 * data failures favour record-heavy files. Bounded to [0.5, 2.6].
 */
export function shapeMultiplier(text: string, hints: RankHints | undefined): number {
  if (!hints) return 1;
  const ui =
    hints.category === 'semantic_interface_problem' ||
    (hints.checkpointId !== undefined && UI_CHECKPOINTS.has(hints.checkpointId));
  const data =
    hints.category === 'product_data_inconsistency' ||
    hints.category === 'cart_checkout_defect' ||
    (hints.checkpointId !== undefined && DATA_CHECKPOINTS.has(hints.checkpointId));
  const markup = markupDensity(text);
  const records = dataDensity(text);
  if (ui && !data) {
    let m = 1 + Math.min(markup, 8) * 0.2;
    if (records > 4 && markup < 1) m *= 0.5;
    return m;
  }
  if (data && !ui) {
    return 1 + Math.min(records, 8) * 0.1;
  }
  return 1;
}

export function rankFiles(
  files: SourceFile[],
  terms: SearchTerm[],
  hints?: RankHints,
): LocalizedFile[] {
  const results: LocalizedFile[] = [];

  for (const file of files) {
    const lowerText = file.text.toLowerCase();
    const basename = file.path.split('/').pop()?.toLowerCase() || '';

    let score = 0;
    const matchedTermsMap = new Map<string, number>();

    for (const { term, weight } of terms) {
      const lowerTerm = term.toLowerCase();
      let count = 0;
      let index = 0;

      // Count non-overlapping occurrences
      while ((index = lowerText.indexOf(lowerTerm, index)) !== -1) {
        count++;
        index += lowerTerm.length;
      }

      if (count > 0) {
        const capped = Math.min(count, 5);
        let contribution = weight * capped;
        // Bonus if term appears in filename
        if (basename.includes(lowerTerm)) {
          contribution += weight * 2;
        }
        score += contribution;
        matchedTermsMap.set(lowerTerm, contribution);
      }
    }

    score = Math.round(score * shapeMultiplier(file.text, hints) * 100) / 100;

    // Get matched terms sorted by contribution desc
    const matchedTerms = Array.from(matchedTermsMap.entries())
      .sort((a, b) => b[1] - a[1])
      .map((e) => e[0])
      .slice(0, 12);

    const bytes = Buffer.byteLength(file.text, 'utf-8');

    results.push({
      path: file.path,
      score,
      matchedTerms,
      bytes,
      included: false,
      flags: [],
    });
  }

  // Sort: score desc, bytes asc, path asc
  results.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.bytes !== b.bytes) return a.bytes - b.bytes;
    return a.path.localeCompare(b.path);
  });

  return results;
}

/**
 * Extract export signatures from file text.
 * Lines matching /^\s*export\s+(default\s+|async\s+)?(function|const|let|class|interface|type|enum)\b/
 * trimmed to 120 chars each, capped at maxLines (default 40).
 * Returns '(no exports)' when none.
 */
export function outlineFile(text: string, maxLines = 40): string {
  const lines = text.split('\n');
  const exportLines: string[] = [];

  for (const line of lines) {
    if (
      /^\s*export\s+(default\s+|async\s+)?(function|const|let|class|interface|type|enum)\b/.test(
        line,
      )
    ) {
      const trimmed = line.trim().slice(0, 120);
      exportLines.push(trimmed);
      if (exportLines.length >= maxLines) break;
    }
  }

  return exportLines.length > 0 ? exportLines.join('\n') : '(no exports)';
}

export interface SelectionBudget {
  maxFiles: number;
  maxChars: number;
}

/** About 6k tokens of source per proposal call: cents on the default model. */
export const DEFAULT_SELECTION_BUDGET: SelectionBudget = {
  maxFiles: 5,
  maxChars: 24000,
};

export interface ModelSourceSelection {
  included: SourceFile[];
  outlined: Array<{ path: string; outline: string }>;
  ranked: LocalizedFile[];
}

/**
 * Select files for model input based on budget constraints.
 * Include files in rank order while count < maxFiles and total chars + size <= maxChars.
 * forceInclude paths are included first (still counted against budget).
 * Missing files are outlined with '(file not readable)'.
 */
export function selectForModel(
  ranked: LocalizedFile[],
  files: Map<string, string>,
  budget = DEFAULT_SELECTION_BUDGET,
  forceInclude?: string[],
): ModelSourceSelection {
  const included: SourceFile[] = [];
  const outlined: Array<{ path: string; outline: string }> = [];
  const included_paths = new Set<string>();

  let fileCount = 0;
  let totalChars = 0;

  // First, process forceInclude
  const toProcess = [...(forceInclude || []), ...ranked.map((f) => f.path)];
  const processedPaths = new Set<string>();

  for (const path of toProcess) {
    if (processedPaths.has(path)) continue;
    processedPaths.add(path);

    const fileText = files.get(path);
    if (!fileText) {
      // File not readable - will be outlined later
      continue;
    }

    const fileBytes = Buffer.byteLength(fileText, 'utf-8');

    // For forced includes, include even if it exceeds budget (alone)
    const isForced = forceInclude?.includes(path);
    const wouldExceed = totalChars + fileBytes > budget.maxChars;
    const atCapacity = fileCount >= budget.maxFiles;

    if (isForced || (!wouldExceed && !atCapacity)) {
      included.push({ path, text: fileText });
      included_paths.add(path);
      fileCount++;
      totalChars += fileBytes;
    }
  }

  // Now outline the rest
  const rankedSet = new Set(ranked.map((f) => f.path));
  for (const rankedFile of ranked) {
    if (included_paths.has(rankedFile.path)) {
      // Already included
      continue;
    }

    const fileText = files.get(rankedFile.path);
    const outline = fileText ? outlineFile(fileText) : '(file not readable)';
    outlined.push({ path: rankedFile.path, outline });
  }

  // Update included flags in ranked
  const rankedWithFlags = ranked.map((f) => ({
    ...f,
    included: included_paths.has(f.path),
  }));

  return {
    included,
    outlined,
    ranked: rankedWithFlags,
  };
}
