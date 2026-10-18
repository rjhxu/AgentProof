import {
  ObservedCart,
  newId,
  nowIso,
  type Checkpoint,
  type CheckpointId,
  type Evidence,
  type LlmUsage,
  type Mission,
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
 * timeout, unparsable JSON). Never throws: a missing cart is "not verified", not a crash.
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
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(CART_FETCH_TIMEOUT_MS),
      headers: {
        Accept: 'application/json',
        ...(cookieHeader ? { Cookie: cookieHeader } : {}),
      },
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

/** "black-hoodie" -> "black hoodie" */
function slugToWords(slug: string): string {
  return decodeURIComponent(slug).replace(/[-_]+/g, ' ').trim();
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
 *   productPage.found   a visited URL (or the final URL) is under /products/; name is the slug of
 *                       the last such URL as words.
 *   checkoutReached     the final URL or a visited URL is /checkout AND the observed cart has at
 *                       least one item. The store redirects /checkout to /cart when the cart is
 *                       empty, so a checkout URL without a confirmed non-empty cart never counts.
 */
export function verificationInputFromBrowserRun(args: BrowserVerificationArgs): VerificationInput {
  const { mission, result, cart } = args;
  const urls = [...(result.visitedUrls ?? []), ...(result.finalUrl ? [result.finalUrl] : [])];
  const productPaths = urls
    .map(pathnameOf)
    .filter((p): p is string => p !== undefined && p.startsWith('/products/'));
  const lastProduct = productPaths[productPaths.length - 1];
  const slug = lastProduct?.slice('/products/'.length).split('/')[0] ?? '';
  const name = slug ? slugToWords(slug) : undefined;

  const sawCheckout = urls.some((u) => pathnameOf(u) === '/checkout');
  const cartHasItems = (cart?.items.length ?? 0) > 0;

  return {
    mission,
    ...(cart ? { cart } : {}),
    cartEvidenceIds: args.cartEvidenceIds ?? [],
    productPage: {
      found: productPaths.length > 0,
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
