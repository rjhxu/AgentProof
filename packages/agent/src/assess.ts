import {
  ObservedCart,
  newId,
  nowIso,
  type Checkpoint,
  type CheckpointId,
  type Evidence,
  type LlmUsage,
  type Mission,
  type RunStep,
  type VerificationResult,
} from '@agentproof/shared';
import { verify, type VerificationInput } from '@agentproof/verifier';
import type { GammaResult } from './gamma';
import type { LlmEffort } from './llm-types';

/**
 * Post-run assessment helpers shared by the CLI and the runner: turn what an agent run left
 * behind (session cookies, visited URLs, Gamma's API observations) into verifier input and
 * evidence. Nothing in here decides pass or fail; `verify()` in @agentproof/verifier does.
 */

/**
 * What the browser loop returns (see `BrowserAgentResult` in ./browser-agent.ts). Declared
 * structurally here, with the post-skeleton fields optional, so this module compiles against both
 * the loop's skeleton and its finished form and the real result type stays assignable.
 */
export interface BrowserRunResult {
  outcome: 'done' | 'fail' | 'step_limit' | 'error';
  summary: string;
  finalUrl?: string;
  visitedUrls?: string[];
  cookies?: CookieLike[];
  usage?: LlmUsage;
  resolvedModel?: string;
  provider?: string;
  effort?: LlmEffort;
  stepsUsed?: number;
  durationMs?: number;
  tracePath?: string;
}

export interface CookieLike {
  name: string;
  value: string;
  domain?: string;
  path?: string;
}

export const CART_FETCH_TIMEOUT_MS = 10_000;

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function pathnameOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).pathname;
  } catch {
    return undefined;
  }
}

/** A cookie applies to the store when it has no domain or its domain covers the store host. */
function cookieAppliesTo(cookie: CookieLike, host: string): boolean {
  const domain = (cookie.domain ?? '').trim().toLowerCase().replace(/^\./, '');
  if (domain === '') return true;
  return host === domain || host.endsWith(`.${domain}`);
}

/** `name=value; name2=value2` for the cookies that apply to the store host. */
export function cookieHeaderFor(storeUrl: string, cookies: CookieLike[]): string {
  const host = hostOf(storeUrl) ?? '';
  return cookies
    .filter((c) => c.name && cookieAppliesTo(c, host))
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
}

/**
 * GET /api/cart with the agent's session cookies, as the runner does after a browser run.
 * Returns the cart tagged `source: 'api'`, or undefined on any failure (HTTP error, redirect,
 * timeout, unparsable JSON). Also undefined, without a request, when no cookie applies to the
 * store host: the store would mint a fresh session and answer with an empty cart that says
 * nothing about this run, and the cart checkpoints must then read "not verified", not "failed".
 * Never throws: a missing cart is "not verified", not a crash.
 */
export async function fetchCartWithCookies(
  storeUrl: string,
  cookies: CookieLike[],
  fetchImpl: typeof fetch = fetch,
): Promise<ObservedCart | undefined> {
  let url: URL;
  try {
    url = new URL('/api/cart', storeUrl);
  } catch {
    return undefined;
  }
  const cookieHeader = cookieHeaderFor(storeUrl, cookies);
  if (!cookieHeader) return undefined;
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(CART_FETCH_TIMEOUT_MS),
      headers: { Accept: 'application/json', Cookie: cookieHeader },
    });
    if (!response.ok) return undefined;
    const body: unknown = await response.json();
    const parsed = ObservedCart.omit({ source: true }).safeParse(body);
    if (!parsed.success) return undefined;
    return { ...parsed.data, source: 'api' };
  } catch {
    return undefined;
  }
}

/** Inline cart_state evidence for a cart read back through the session cookies. */
export function browserRunEvidenceForCart(runId: string, cart: ObservedCart): Evidence {
  return {
    id: newId('ev'),
    runId,
    kind: 'cart_state',
    capturedAt: nowIso(),
    label: 'Cart read back from the store API with the session cookies',
    data: cart,
  };
}

/** "black-hoodie" -> "black hoodie" (a malformed percent-escape is kept as is). */
function slugToWords(slug: string): string {
  let decoded = slug;
  try {
    decoded = decodeURIComponent(slug);
  } catch {
    // keep the raw slug
  }
  return decoded.replace(/[-_]+/g, ' ').trim();
}

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 0);
}

/**
 * Does a product page slug name the mission's product? A token match, as Gamma matches catalog
 * names: every slug word is in the product ("merino-socks" for "merino crew socks") or every
 * product word is in the slug ("black-hoodie" for "black hoodie"). "grey-hoodie" does not match
 * "black hoodie": the sides share a word but each has one the other lacks.
 */
export function productSlugMatches(slug: string, product: string): boolean {
  const slugWords = words(slugToWords(slug));
  const productWords = words(product);
  if (slugWords.length === 0 || productWords.length === 0) return false;
  const within = (a: string[], b: string[]) => a.every((w) => b.includes(w));
  return within(slugWords, productWords) || within(productWords, slugWords);
}

/** The slug of a `/products/<slug>` pathname; undefined for any other path. */
export function productSlugOf(pathname: string | undefined): string | undefined {
  if (!pathname || !pathname.startsWith('/products/')) return undefined;
  const slug = pathname.slice('/products/'.length).split('/')[0] ?? '';
  return slug ? slug : undefined;
}

/** True when a URL or pathname is the product page of the mission's product. */
export function productPathMatches(urlOrPath: string, product: string): boolean {
  const pathname = urlOrPath.startsWith('/') ? urlOrPath : pathnameOf(urlOrPath);
  const slug = productSlugOf(pathname);
  return slug !== undefined && productSlugMatches(slug, product);
}

/**
 * Screenshot evidence id of the first step observed on a page whose pathname satisfies `match`:
 * the product page for product_discovered, /checkout for checkout_review_reached. Empty when no
 * step was there, so a checkpoint never links the screenshot of some other page as its evidence.
 */
export function screenshotEvidenceForPage(
  steps: RunStep[],
  match: (pathname: string) => boolean,
): string[] {
  for (const step of steps) {
    const pathname = pathnameOf(step.url);
    if (pathname !== undefined && step.screenshotEvidenceId && match(pathname)) {
      return [step.screenshotEvidenceId];
    }
  }
  return [];
}

export interface BrowserVerificationArgs {
  mission: Mission;
  result: BrowserRunResult;
  cart?: ObservedCart;
  cartEvidenceIds?: string[];
  productEvidenceIds?: string[];
  checkoutEvidenceIds?: string[];
}

/**
 * Verifier input from a browser run.
 *   productPage.found   a visited URL (or the final URL) is the page of the mission's product,
 *                       by slug token match (productSlugMatches); name is the slug of the last
 *                       matching page as words, or of the last product page visited when none
 *                       matched, so the report still says where the agent went.
 *   checkoutReached     the final URL or a visited URL is /checkout AND the observed cart has at
 *                       least one item. The store redirects /checkout to /cart when the cart is
 *                       empty, so a checkout URL without a confirmed non-empty cart never counts.
 */
export function verificationInputFromBrowserRun(args: BrowserVerificationArgs): VerificationInput {
  const { mission, result, cart } = args;
  const urls = [...(result.visitedUrls ?? []), ...(result.finalUrl ? [result.finalUrl] : [])];
  const slugs = urls
    .map((u) => productSlugOf(pathnameOf(u)))
    .filter((s): s is string => s !== undefined);
  const matching = slugs.filter((s) => productSlugMatches(s, mission.requirements.product));
  const named = matching[matching.length - 1] ?? slugs[slugs.length - 1];
  const name = named ? slugToWords(named) : undefined;

  const sawCheckout = urls.some((u) => pathnameOf(u) === '/checkout');
  const cartHasItems = (cart?.items.length ?? 0) > 0;

  return {
    mission,
    ...(cart ? { cart } : {}),
    cartEvidenceIds: args.cartEvidenceIds ?? [],
    productPage: {
      found: matching.length > 0,
      ...(name ? { name } : {}),
      evidenceIds: args.productEvidenceIds ?? [],
    },
    checkoutReached: {
      reached: sawCheckout && cartHasItems,
      evidenceIds: args.checkoutEvidenceIds ?? [],
    },
  };
}

const CATALOG_IDENTIFIED: CheckpointId[] = [
  'product_discovered',
  'correct_color_identified',
  'correct_size_identified',
];

/**
 * Gamma's verification, ported from the runner's Gamma block (apps/runner/src/jobs.ts):
 * catalog_record / cart_state / network evidence, `verify()` on the cart and checkout
 * observations, product and attribute checkpoints marked from the catalog selection (Gamma
 * identifies attributes in the catalog, not on a product page), then Gamma's own checkpoints
 * merged in and the first failure recomputed.
 */
export function gammaVerification(args: { mission: Mission; result: GammaResult; runId: string }): {
  verification: VerificationResult;
  evidence: Evidence[];
} {
  const { mission, result, runId } = args;
  const evidence: Evidence[] = [];
  if (result.catalogRecord) {
    evidence.push({
      id: newId('ev'),
      runId,
      kind: 'catalog_record',
      capturedAt: nowIso(),
      label: 'Live catalog and requested variant',
      data: { product: result.catalogRecord, selectedVariant: result.selectedVariant },
    });
  }
  if (result.cart) {
    evidence.push({
      id: newId('ev'),
      runId,
      kind: 'cart_state',
      capturedAt: nowIso(),
      label: 'Cart read back from the store',
      data: result.cart,
    });
  }
  if (result.checkoutReached !== undefined) {
    evidence.push({
      id: newId('ev'),
      runId,
      kind: 'network',
      capturedAt: nowIso(),
      label: 'Checkout review response',
      data: { url: new URL('/checkout', mission.storeUrl).href, reached: result.checkoutReached },
    });
  }
  const idsOfKind = (kind: Evidence['kind']) =>
    evidence.filter((e) => e.kind === kind).map((e) => e.id);
  const catalogIds = idsOfKind('catalog_record');
  const nonNetworkIds = evidence.filter((e) => e.kind !== 'network').map((e) => e.id);

  const verification = verify({
    mission,
    ...(result.cart ? { cart: result.cart } : {}),
    cartEvidenceIds: idsOfKind('cart_state'),
    ...(result.checkoutReached === undefined
      ? {}
      : {
          checkoutReached: { reached: result.checkoutReached, evidenceIds: idsOfKind('network') },
        }),
  });

  const checkpoints: Checkpoint[] = verification.checkpoints.map((checkpoint) =>
    result.selectedVariant && CATALOG_IDENTIFIED.includes(checkpoint.id)
      ? {
          ...checkpoint,
          status: 'passed',
          detail: `Identified in live catalog: ${result.selectedVariant.id}`,
          evidenceIds: catalogIds,
        }
      : checkpoint,
  );
  for (const own of result.checkpoints) {
    const merged: Checkpoint = { ...own, evidenceIds: nonNetworkIds };
    const index = checkpoints.findIndex((c) => c.id === merged.id);
    if (index >= 0) checkpoints[index] = merged;
    else checkpoints.push(merged);
  }
  const firstFailure = checkpoints.find((c) => c.status === 'failed');

  return {
    verification: {
      ...verification,
      checkpoints,
      ...(firstFailure ? { firstFailure } : { firstFailure: undefined }),
    },
    evidence,
  };
}
