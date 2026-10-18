import { describe, expect, it, vi } from 'vitest';
import { Evidence, VerificationResult, type ObservedCart, type RunStep } from '@agentproof/shared';
import { alphaFailedRun, hoodieMission } from '@agentproof/shared/fixtures';
import { verify } from '@agentproof/verifier';
import {
  browserRunEvidenceForCart,
  cookieHeaderFor,
  fetchCartWithCookies,
  gammaVerification,
  productPathMatches,
  productSlugMatches,
  productSlugOf,
  screenshotEvidenceForPage,
  verificationInputFromBrowserRun,
  type BrowserRunResult,
} from './assess';
import type { GammaResult } from './gamma';

const STORE = 'http://localhost:5000';

const cartJson = (size: string, quantity = 1) => ({
  items: [
    {
      productId: 'HOODIE-001',
      variantId: `HOODIE-001-${size}`,
      name: 'Black Hoodie',
      attributes: { color: 'black', size },
      unitPrice: 49,
      quantity,
    },
  ],
  subtotal: 49 * quantity,
  currency: 'USD',
});

const sessionCookies = [
  { name: 'nw_session', value: 'abc123', domain: 'localhost', path: '/' },
  { name: 'other_site', value: 'nope', domain: 'example.com', path: '/' },
  { name: 'bare', value: 'y' },
];

type FetchCall = { url: string; init: RequestInit | undefined };

function fakeFetch(respond: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: FetchCall[] = [];
  const impl = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return respond(String(input), init);
  });
  return { calls, impl: impl as unknown as typeof fetch };
}

describe('cookieHeaderFor', () => {
  it('keeps cookies without a domain or whose domain covers the store host, in order', () => {
    expect(cookieHeaderFor(STORE, sessionCookies)).toBe('nw_session=abc123; bare=y');
  });

  it('matches a parent domain with or without the leading dot', () => {
    const cookies = [
      { name: 'a', value: '1', domain: '.example.com' },
      { name: 'b', value: '2', domain: 'example.com' },
      { name: 'c', value: '3', domain: 'shop.example.com' },
      { name: 'd', value: '4', domain: 'other.example.com' },
    ];
    expect(cookieHeaderFor('https://shop.example.com', cookies)).toBe('a=1; b=2; c=3');
  });
});

describe('fetchCartWithCookies', () => {
  it('GETs /api/cart on the store with the applicable cookies, no redirects, a timeout', async () => {
    const { calls, impl } = fakeFetch(() => Response.json(cartJson('S')));
    const cart = await fetchCartWithCookies(STORE, sessionCookies, impl);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('http://localhost:5000/api/cart');
    expect(calls[0]!.init?.method).toBe('GET');
    expect(calls[0]!.init?.redirect).toBe('error');
    expect(calls[0]!.init?.signal).toBeInstanceOf(AbortSignal);
    expect(calls[0]!.init?.headers).toMatchObject({ Cookie: 'nw_session=abc123; bare=y' });
    expect(cart).toEqual({ ...cartJson('S'), source: 'api' });
    expect(cart?.source).toBe('api');
  });

  it('makes no request when no cookie applies to the store host: an anonymous cart is not this run’s', async () => {
    const { calls, impl } = fakeFetch(() => Response.json({ items: [], subtotal: 0 }));
    await expect(fetchCartWithCookies(STORE, [sessionCookies[1]!], impl)).resolves.toBeUndefined();
    await expect(fetchCartWithCookies(STORE, [], impl)).resolves.toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it('returns undefined on a non-2xx response', async () => {
    const { impl } = fakeFetch(() => new Response('boom', { status: 500 }));
    await expect(fetchCartWithCookies(STORE, sessionCookies, impl)).resolves.toBeUndefined();
  });

  it('returns undefined on invalid JSON or a body that is not a cart', async () => {
    const notJson = fakeFetch(() => new Response('<html>', { status: 200 }));
    await expect(
      fetchCartWithCookies(STORE, sessionCookies, notJson.impl),
    ).resolves.toBeUndefined();
    const wrongShape = fakeFetch(() => Response.json({ items: 'nope' }));
    await expect(
      fetchCartWithCookies(STORE, sessionCookies, wrongShape.impl),
    ).resolves.toBeUndefined();
  });

  it('never throws: a network failure or a bad store URL becomes undefined', async () => {
    const { impl } = fakeFetch(() => {
      throw new TypeError('fetch failed');
    });
    await expect(fetchCartWithCookies(STORE, sessionCookies, impl)).resolves.toBeUndefined();
    await expect(fetchCartWithCookies('not a url', sessionCookies, impl)).resolves.toBeUndefined();
  });
});

describe('browserRunEvidenceForCart', () => {
  it('is inline cart_state evidence for the run', () => {
    const cart: ObservedCart = { ...cartJson('S'), source: 'api' };
    const evidence = browserRunEvidenceForCart('run_test', cart);
    expect(Evidence.safeParse(evidence).success).toBe(true);
    expect(evidence).toMatchObject({ runId: 'run_test', kind: 'cart_state', data: cart });
    expect(evidence.id).toMatch(/^ev_/);
    expect(evidence.path).toBeUndefined();
  });
});

describe('productSlugMatches / productPathMatches', () => {
  it('matches a slug whose words are within the product or that contains every product word', () => {
    expect(productSlugMatches('black-hoodie', 'black hoodie')).toBe(true);
    expect(productSlugMatches('merino-socks', 'merino crew socks')).toBe(true);
    expect(productSlugMatches('crewneck-sweatshirt', 'crewneck sweatshirt')).toBe(true);
    expect(productSlugMatches('studio-headphones', 'studio headphones')).toBe(true);
    expect(productSlugMatches('canvas-tote', 'canvas tote')).toBe(true);
    expect(productSlugMatches('black-hoodie', 'hoodie')).toBe(true);
    expect(productSlugMatches('Black_Hoodie', 'Black Hoodie')).toBe(true);
  });

  it('rejects a different product that merely shares a word, and empty input', () => {
    expect(productSlugMatches('grey-hoodie', 'black hoodie')).toBe(false);
    expect(productSlugMatches('canvas-tote', 'black hoodie')).toBe(false);
    expect(productSlugMatches('', 'black hoodie')).toBe(false);
    expect(productSlugMatches('black-hoodie', '')).toBe(false);
  });

  it('reads the slug from a /products/ pathname or URL only', () => {
    expect(productSlugOf('/products/black-hoodie')).toBe('black-hoodie');
    expect(productSlugOf('/products/black-hoodie/reviews')).toBe('black-hoodie');
    expect(productSlugOf('/products/')).toBeUndefined();
    expect(productSlugOf('/cart')).toBeUndefined();
    expect(productSlugOf(undefined)).toBeUndefined();
    expect(productPathMatches('/products/black-hoodie', 'black hoodie')).toBe(true);
    expect(productPathMatches('http://localhost:5000/products/black-hoodie', 'black hoodie')).toBe(
      true,
    );
    expect(productPathMatches('http://localhost:5000/products/grey-hoodie', 'black hoodie')).toBe(
      false,
    );
    expect(productPathMatches('/checkout', 'black hoodie')).toBe(false);
    expect(productPathMatches('::not a url::', 'black hoodie')).toBe(false);
  });
});

describe('screenshotEvidenceForPage', () => {
  const steps: RunStep[] = alphaFailedRun.steps;

  it('returns the screenshot of the first step observed on a matching page, else nothing', () => {
    expect(screenshotEvidenceForPage(steps, (p) => p.startsWith('/products/'))).toEqual([
      steps[1]!.screenshotEvidenceId,
    ]);
    expect(screenshotEvidenceForPage(steps, (p) => p === '/')).toEqual([
      steps[0]!.screenshotEvidenceId,
    ]);
    expect(screenshotEvidenceForPage(steps, (p) => p === '/checkout')).toEqual([]);
    expect(screenshotEvidenceForPage([], () => true)).toEqual([]);
  });

  it('skips steps without a URL or a screenshot', () => {
    const bare: RunStep[] = [
      { index: 0, at: 't', outcome: 'ok' },
      { index: 1, at: 't', url: '::bad::', outcome: 'ok', screenshotEvidenceId: 'ev_x' },
      { index: 2, at: 't', url: 'http://localhost:5000/checkout', outcome: 'ok' },
      {
        index: 3,
        at: 't',
        url: 'http://localhost:5000/checkout',
        outcome: 'ok',
        screenshotEvidenceId: 'ev_ok',
      },
    ];
    expect(screenshotEvidenceForPage(bare, (p) => p === '/checkout')).toEqual(['ev_ok']);
  });
});

describe('verificationInputFromBrowserRun', () => {
  const result = (over: Partial<BrowserRunResult> = {}): BrowserRunResult => ({
    outcome: 'done',
    summary: 'Reached the checkout review page',
    finalUrl: 'http://localhost:5000/checkout',
    visitedUrls: [
      'http://localhost:5000/',
      'http://localhost:5000/products/black-hoodie',
      'http://localhost:5000/cart',
      'http://localhost:5000/checkout',
    ],
    cookies: sessionCookies,
    ...over,
  });
  const cartS: ObservedCart = { ...cartJson('S'), source: 'api' };
  const missionFor = (product: string) => ({
    ...hoodieMission,
    requirements: { ...hoodieMission.requirements, product },
  });

  it('finds the product page from the visited URLs and names it from the slug', () => {
    const input = verificationInputFromBrowserRun({
      mission: hoodieMission,
      result: result(),
      cart: cartS,
    });
    expect(input.productPage).toEqual({ found: true, name: 'black hoodie', evidenceIds: [] });
    expect(input.mission).toBe(hoodieMission);
    expect(input.cart).toBe(cartS);
  });

  it('does not count a different product’s page as discovering the mission product', () => {
    const wrong = verificationInputFromBrowserRun({
      mission: hoodieMission,
      result: result({
        visitedUrls: ['http://localhost:5000/', 'http://localhost:5000/products/grey-hoodie'],
      }),
      cart: cartS,
    });
    expect(wrong.productPage).toEqual({ found: false, name: 'grey hoodie', evidenceIds: [] });
    expect(verify(wrong).checkpoints.find((c) => c.id === 'product_discovered')?.status).toBe(
      'failed',
    );

    // The last matching page names the product even when a wrong one was visited after it.
    const detour = verificationInputFromBrowserRun({
      mission: hoodieMission,
      result: result({
        visitedUrls: [
          'http://localhost:5000/products/black-hoodie',
          'http://localhost:5000/products/grey-hoodie',
        ],
      }),
    });
    expect(detour.productPage).toMatchObject({ found: true, name: 'black hoodie' });

    // A slug shorter than the mission's product name (scenario D) still matches.
    const socks = verificationInputFromBrowserRun({
      mission: missionFor('merino crew socks'),
      result: result({ visitedUrls: ['http://localhost:5000/products/merino-socks'] }),
    });
    expect(socks.productPage).toMatchObject({ found: true, name: 'merino socks' });
  });

  it('counts checkout as reached only with a checkout URL and a non-empty cart', () => {
    const reached = verificationInputFromBrowserRun({
      mission: hoodieMission,
      result: result(),
      cart: cartS,
      cartEvidenceIds: ['ev_cart'],
      checkoutEvidenceIds: ['ev_shot'],
    });
    expect(reached.checkoutReached).toEqual({ reached: true, evidenceIds: ['ev_shot'] });
    expect(reached.cartEvidenceIds).toEqual(['ev_cart']);

    const emptyCart = verificationInputFromBrowserRun({
      mission: hoodieMission,
      result: result(),
      cart: { items: [], subtotal: 0, currency: 'USD', source: 'api' },
    });
    expect(emptyCart.checkoutReached?.reached).toBe(false);

    const noCart = verificationInputFromBrowserRun({ mission: hoodieMission, result: result() });
    expect(noCart.checkoutReached?.reached).toBe(false);
    expect(noCart.cart).toBeUndefined();

    const noCheckout = verificationInputFromBrowserRun({
      mission: hoodieMission,
      result: result({
        finalUrl: 'http://localhost:5000/cart',
        visitedUrls: ['http://localhost:5000/', 'http://localhost:5000/products/black-hoodie'],
      }),
      cart: cartS,
    });
    expect(noCheckout.checkoutReached?.reached).toBe(false);
  });

  it('uses the final URL when it is the only checkout or product evidence', () => {
    const input = verificationInputFromBrowserRun({
      mission: hoodieMission,
      result: result({ visitedUrls: [], finalUrl: 'http://localhost:5000/checkout' }),
      cart: cartS,
    });
    expect(input.checkoutReached?.reached).toBe(true);
    expect(input.productPage?.found).toBe(false);
    expect(input.productPage?.name).toBeUndefined();

    const productOnly = verificationInputFromBrowserRun({
      mission: missionFor('canvas tote'),
      result: result({
        visitedUrls: undefined,
        finalUrl: 'http://localhost:5000/products/canvas-tote',
      }),
    });
    expect(productOnly.productPage).toMatchObject({ found: true, name: 'canvas tote' });
  });

  it('tolerates unparsable URLs and a skeleton result without URLs or cookies', () => {
    const input = verificationInputFromBrowserRun({
      mission: hoodieMission,
      result: { outcome: 'error', summary: 'not implemented' },
    });
    expect(input.productPage?.found).toBe(false);
    expect(input.checkoutReached?.reached).toBe(false);
    const odd = verificationInputFromBrowserRun({
      mission: hoodieMission,
      result: result({ visitedUrls: ['::not a url::', 'http://localhost:5000/products/x-y'] }),
    });
    expect(odd.productPage).toMatchObject({ found: false, name: 'x y' });
  });

  it('reproduces the Bug A verdict when run through the verifier', () => {
    const verification = verify(
      verificationInputFromBrowserRun({ mission: hoodieMission, result: result(), cart: cartS }),
    );
    const status = Object.fromEntries(verification.checkpoints.map((c) => [c.id, c.status]));
    expect(status).toEqual({
      product_discovered: 'passed',
      correct_color_identified: 'passed',
      correct_size_identified: 'failed',
      added_to_cart: 'passed',
      cart_matches_variant: 'failed',
      cart_quantity_correct: 'passed',
      price_within_budget: 'passed',
      checkout_review_reached: 'passed',
    });
    expect(verification.firstFailure?.id).toBe('correct_size_identified');
  });
});

describe('gammaVerification', () => {
  const product = {
    id: 'HOODIE-001',
    slug: 'black-hoodie',
    name: 'Black Hoodie',
    category: 'apparel',
    basePrice: 49,
    variants: [
      { id: 'HOODIE-001-S', attributes: { color: 'black', size: 'S' }, price: 49, inStock: true },
      { id: 'HOODIE-001-M', attributes: { color: 'black', size: 'M' }, price: 49, inStock: true },
    ],
  };
  const bugB: GammaResult = {
    checkpoints: [
      {
        id: 'catalog_variant_resolves',
        status: 'failed',
        detail:
          'Requested HOODIE-001-M ({"color":"black","size":"M"}); cart returned HOODIE-001-S ({"color":"black","size":"S"}).',
        evidenceIds: [],
      },
    ],
    cart: { ...cartJson('S'), source: 'api' },
    catalogRecord: product,
    selectedVariant: product.variants[1]!,
    checkoutReached: true,
    notes: ['Selected HOODIE-001-M from the live catalog.'],
  };

  it('reproduces the Bug B outcome: variant id does not resolve, product found in the catalog', () => {
    const { verification, evidence } = gammaVerification({
      mission: hoodieMission,
      result: bugB,
      runId: 'run_gamma',
    });
    expect(VerificationResult.safeParse(verification).success).toBe(true);
    const byId = Object.fromEntries(verification.checkpoints.map((c) => [c.id, c]));
    expect(byId.catalog_variant_resolves?.status).toBe('failed');
    expect(byId.product_discovered?.status).toBe('passed');
    expect(byId.product_discovered?.detail).toBe('Identified in live catalog: HOODIE-001-M');
    expect(byId.correct_color_identified?.status).toBe('passed');
    expect(byId.correct_size_identified?.status).toBe('passed');
    expect(byId.added_to_cart?.status).toBe('passed');
    expect(byId.cart_matches_variant?.status).toBe('failed');
    expect(byId.cart_matches_variant?.detail).toContain('size: required "M", cart has "S"');
    expect(byId.price_within_budget?.status).toBe('passed');
    expect(byId.checkout_review_reached?.status).toBe('passed');
    expect(verification.firstFailure?.status).toBe('failed');
    expect(verification.observedCart).toEqual(bugB.cart);

    // Evidence: catalog record, cart state, and the checkout response, all inline, all for this run.
    expect(evidence.map((e) => e.kind)).toEqual(['catalog_record', 'cart_state', 'network']);
    for (const e of evidence) {
      expect(Evidence.safeParse(e).success).toBe(true);
      expect(e.runId).toBe('run_gamma');
      expect(e.id).toMatch(/^ev_/);
    }
    const ids = (kind: string) => evidence.filter((e) => e.kind === kind).map((e) => e.id);
    expect(byId.product_discovered?.evidenceIds).toEqual(ids('catalog_record'));
    expect(byId.added_to_cart?.evidenceIds).toEqual(ids('cart_state'));
    expect(byId.checkout_review_reached?.evidenceIds).toEqual(ids('network'));
    expect(byId.catalog_variant_resolves?.evidenceIds).toEqual([
      ...ids('catalog_record'),
      ...ids('cart_state'),
    ]);
    expect(evidence.find((e) => e.kind === 'network')?.data).toEqual({
      url: 'http://localhost:5000/checkout',
      reached: true,
    });
  });

  it('does not mutate the Gamma result it was given', () => {
    const copy = structuredClone(bugB);
    gammaVerification({ mission: hoodieMission, result: copy, runId: 'run_gamma' });
    expect(copy).toEqual(bugB);
  });

  it('passes everything after the repair (cart returns the requested variant)', () => {
    const fixed: GammaResult = {
      ...bugB,
      cart: { ...cartJson('M'), source: 'api' },
      checkpoints: [{ id: 'catalog_variant_resolves', status: 'passed', evidenceIds: [] }],
    };
    const { verification } = gammaVerification({
      mission: hoodieMission,
      result: fixed,
      runId: 'r',
    });
    expect(verification.checkpoints.every((c) => c.status === 'passed')).toBe(true);
    expect(verification.firstFailure).toBeUndefined();
  });

  it('keeps Gamma’s product_discovered failure when nothing in the catalog matched', () => {
    const noMatch: GammaResult = {
      checkpoints: [
        {
          id: 'product_discovered',
          status: 'failed',
          detail: 'No in-stock catalog variant satisfies the mission and budget.',
          evidenceIds: [],
        },
      ],
      notes: ['No cart mutation attempted.'],
    };
    const { verification, evidence } = gammaVerification({
      mission: hoodieMission,
      result: noMatch,
      runId: 'r',
    });
    expect(evidence).toEqual([]);
    const byId = Object.fromEntries(verification.checkpoints.map((c) => [c.id, c]));
    expect(byId.product_discovered).toMatchObject({ status: 'failed', evidenceIds: [] });
    expect(byId.added_to_cart?.status).toBe('not_verified');
    expect(byId.checkout_review_reached?.status).toBe('not_tested');
    expect(verification.firstFailure?.id).toBe('product_discovered');
  });
});
