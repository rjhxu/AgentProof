import { describe, expect, it, vi } from 'vitest';
import { Mission } from '@agentproof/shared';
import {
  CatalogFeed,
  MissionDerivationError,
  deriveMissionFromStore,
  isHttpUrl,
  missionFromCatalog,
} from './mission-derive';

const STORE = 'http://localhost:5000';

/**
 * The Northwind feed as GET /api/catalog.json serves it (apps/storefront/src/catalog.ts), cut down
 * to what the derivation rules need: a product with no stock, a single-variant product ahead of
 * the hoodie, and the hoodie in S/M/L at $49. Extra fields (image) must be tolerated.
 */
const northwind = {
  store: 'Northwind Threads',
  currency: 'USD',
  products: [
    {
      id: 'CAP-001',
      slug: 'wool-cap',
      name: 'Wool Cap',
      category: 'accessories',
      basePrice: 19,
      url: '/products/wool-cap',
      image: '/images/wool-cap.jpeg',
      variants: [{ id: 'CAP-001-BLK', attributes: { color: 'black' }, price: 19, inStock: false }],
    },
    {
      id: 'TOTE-001',
      slug: 'canvas-tote',
      name: 'Canvas Tote',
      category: 'accessories',
      basePrice: 24,
      url: '/products/canvas-tote',
      image: '/images/canvas-tote.jpeg',
      variants: [
        { id: 'TOTE-001-NAT', attributes: { color: 'natural' }, price: 24, inStock: true },
      ],
    },
    {
      id: 'HOODIE-001',
      slug: 'black-hoodie',
      name: 'Black Hoodie',
      category: 'apparel',
      basePrice: 49,
      url: '/products/black-hoodie',
      image: '/images/black-hoodie.jpeg',
      variants: [
        { id: 'HOODIE-001-S', attributes: { color: 'black', size: 'S' }, price: 49, inStock: true },
        { id: 'HOODIE-001-M', attributes: { color: 'black', size: 'M' }, price: 49, inStock: true },
        { id: 'HOODIE-001-L', attributes: { color: 'black', size: 'L' }, price: 49, inStock: true },
      ],
    },
  ],
};

const HOODIE_PROMPT =
  'Find the Black Hoodie in black, size M for under $60, add it to the cart, and reach checkout. Do not place the order.';

function feed(products: unknown[]): CatalogFeed {
  return CatalogFeed.parse({ products });
}

/** The rejection of a derivation, asserted to be the typed error. */
async function failure(promise: Promise<unknown>): Promise<MissionDerivationError> {
  const error: unknown = await promise.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(error).toBeInstanceOf(MissionDerivationError);
  return error as MissionDerivationError;
}

describe('missionFromCatalog', () => {
  it('derives the hoodie in size M under $60 from a Northwind-shaped feed, with a code-written prompt', () => {
    const now = '2026-10-18T12:00:00.000Z';
    const mission = missionFromCatalog(CatalogFeed.parse(northwind), STORE, now);
    expect(Mission.safeParse(mission).success).toBe(true);
    expect(mission.id).toMatch(/^mis_/);
    expect(mission.createdAt).toBe(now);
    expect(mission.storeUrl).toBe(STORE);
    expect(mission.requirements).toEqual({
      product: 'black hoodie',
      category: 'apparel',
      attributes: { color: 'black', size: 'M' },
      quantity: 1,
      maxUnitPrice: 60,
    });
    expect(mission.rawPrompt).toBe(HOODIE_PROMPT);
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
  });

  it('skips out-of-stock variants when choosing the one to ask for', () => {
    const greyHoodie = {
      id: 'HOODIE-002',
      slug: 'grey-hoodie',
      name: 'Grey Hoodie',
      category: 'apparel',
      variants: [
        { id: 'HOODIE-002-S', attributes: { color: 'grey', size: 'S' }, price: 49, inStock: true },
        { id: 'HOODIE-002-M', attributes: { color: 'grey', size: 'M' }, price: 49, inStock: false },
        { id: 'HOODIE-002-L', attributes: { color: 'grey', size: 'L' }, price: 49, inStock: true },
      ],
    };
    const mission = missionFromCatalog(feed([greyHoodie]), STORE);
    expect(mission.requirements.attributes).toEqual({ color: 'grey', size: 'L' });
    expect(mission.rawPrompt).toContain('in grey, size L');
  });

  it('falls back to the first in-stock product when no product offers a choice, and omits "in" without attributes', () => {
    const soldOut = northwind.products[0];
    const giftCard = {
      id: 'GIFT-001',
      slug: 'gift-card',
      name: 'Gift Card',
      variants: [{ id: 'GIFT-001-25', price: 25 }],
    };
    const mission = missionFromCatalog(feed([soldOut, giftCard, northwind.products[1]]), STORE);
    expect(mission.requirements).toEqual({
      product: 'gift card',
      attributes: {},
      quantity: 1,
      maxUnitPrice: 30,
    });
    expect(mission.rawPrompt).toBe(
      'Find the Gift Card for under $30, add it to the cart, and reach checkout. Do not place the order.',
    );
  });

  it('omits the budget for a free item', () => {
    const sticker = {
      id: 'STICKER-001',
      slug: 'free-sticker',
      name: ' Free Sticker ',
      variants: [{ id: 'STICKER-001', attributes: {}, price: 0, inStock: true }],
    };
    const mission = missionFromCatalog(feed([sticker]), STORE);
    expect(mission.requirements.product).toBe('free sticker');
    expect(mission.requirements.maxUnitPrice).toBeUndefined();
    expect(mission.rawPrompt).toBe(
      'Find the Free Sticker, add it to the cart, and reach checkout. Do not place the order.',
    );
  });

  it('lowercases attribute keys, trims values and describes other attributes as "key value"', () => {
    const headphones = {
      id: 'HP-100',
      slug: 'studio-headphones',
      name: 'Studio Headphones',
      category: 'audio',
      variants: [
        { id: 'HP-100-WIRED', attributes: { Connectivity: ' wired ' }, price: 89, inStock: true },
        { id: 'HP-100-WIRELESS', attributes: { Connectivity: 'wireless' }, price: 119 },
      ],
    };
    const mission = missionFromCatalog(feed([headphones]), STORE);
    expect(mission.requirements.attributes).toEqual({ connectivity: 'wireless' });
    expect(mission.requirements.maxUnitPrice).toBe(150);
    expect(mission.rawPrompt).toBe(
      'Find the Studio Headphones in connectivity wireless for under $150, add it to the cart, and reach checkout. Do not place the order.',
    );
  });

  it.each([
    [49, 60],
    [58, 70],
    [14, 20],
    [60, 80],
  ])('budgets $%d as under $%d', (price, maxUnitPrice) => {
    const product = {
      id: 'P',
      slug: 'p',
      name: 'Thing',
      variants: [{ id: 'P-1', price, inStock: true }],
    };
    expect(missionFromCatalog(feed([product]), STORE).requirements.maxUnitPrice).toBe(maxUnitPrice);
  });

  it('throws a 422 when nothing is in stock', () => {
    for (const products of [[], [northwind.products[0]]]) {
      let thrown: unknown;
      try {
        missionFromCatalog(feed(products), STORE);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(MissionDerivationError);
      expect(thrown).toMatchObject({
        name: 'MissionDerivationError',
        statusCode: 422,
        message: 'The catalog lists no product in stock.',
      });
    }
  });

  it('throws a 422 when the feed makes no valid mission, such as a product with a blank name', () => {
    const nameless = {
      id: 'BLANK-001',
      slug: 'blank',
      name: '   ',
      variants: [{ id: 'BLANK-001-1', price: 12, inStock: true }],
    };
    let thrown: unknown;
    try {
      missionFromCatalog(feed([nameless]), STORE);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(MissionDerivationError);
    expect(thrown).toMatchObject({ name: 'MissionDerivationError', statusCode: 422 });
    expect((thrown as Error).message).toMatch(
      /^The catalog feed could not be turned into a mission: .+/,
    );
  });
});

describe('CatalogFeed', () => {
  it('accepts the real feed shape and fills the lenient defaults', () => {
    const parsed = CatalogFeed.parse(northwind);
    expect(parsed.store).toBe('Northwind Threads');
    expect(parsed.products).toHaveLength(3);
    expect(parsed.products[2]?.variants[1]?.id).toBe('HOODIE-001-M');
    const bare = CatalogFeed.parse({
      products: [{ id: 'X', slug: 'x', name: 'X', variants: [{ id: 'X-1', price: 5 }] }],
    });
    expect(bare.products[0]?.variants[0]).toEqual({
      id: 'X-1',
      attributes: {},
      price: 5,
      inStock: true,
    });
    expect(
      CatalogFeed.parse({ products: [{ id: 'Y', slug: 'y', name: 'Y' }] }).products[0]?.variants,
    ).toEqual([]);
    expect(CatalogFeed.safeParse({ products: 'nope' }).success).toBe(false);
    expect(CatalogFeed.safeParse('<!doctype html>').success).toBe(false);
  });
});

describe('isHttpUrl', () => {
  it('accepts only absolute http(s) addresses', () => {
    expect(isHttpUrl('http://localhost:5000')).toBe(true);
    expect(isHttpUrl('https://shop.example.com/path')).toBe(true);
    expect(isHttpUrl('localhost:5000')).toBe(false);
    expect(isHttpUrl('ftp://localhost:5000')).toBe(false);
    expect(isHttpUrl('not a url')).toBe(false);
  });
});

describe('deriveMissionFromStore', () => {
  const FEED_URL = 'http://localhost:5000/api/catalog.json';
  const NO_FEED = `No product feed at ${FEED_URL}. Tell the shoppers what to buy instead.`;

  function fetcher(respond: () => Response | Promise<Response>) {
    return vi.fn(async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) => respond());
  }

  it('fetches the feed at the origin and derives the mission, keeping the address as given', async () => {
    const fetchImpl = fetcher(() => Response.json(northwind));
    const mission = await deriveMissionFromStore(`${STORE}/shop`, fetchImpl as typeof fetch);
    expect(mission.storeUrl).toBe(`${STORE}/shop`);
    expect(mission.rawPrompt).toBe(HOODIE_PROMPT);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe(FEED_URL);
    expect(init).toMatchObject({ redirect: 'error', headers: { Accept: 'application/json' } });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('answers 422 for a 404, an HTML body, a wrong shape and a network error', async () => {
    const cases: Array<() => Response> = [
      () => new Response('not here', { status: 404 }),
      () => new Response('<!doctype html><h1>Shop</h1>', { status: 200 }),
      () => Response.json({ items: [] }),
      () => {
        throw new TypeError('fetch failed');
      },
    ];
    for (const respond of cases) {
      const error = await failure(deriveMissionFromStore(STORE, fetcher(respond) as typeof fetch));
      expect(error.statusCode).toBe(422);
      expect(error.message).toBe(NO_FEED);
    }
  });

  it('keeps the no-stock 422 from the derivation itself', async () => {
    const fetchImpl = fetcher(() => Response.json({ products: [northwind.products[0]] }));
    const error = await failure(deriveMissionFromStore(STORE, fetchImpl as typeof fetch));
    expect(error.statusCode).toBe(422);
    expect(error.message).toBe('The catalog lists no product in stock.');
  });

  it('answers 400 for a scheme-less or non-http address without fetching', async () => {
    const fetchImpl = fetcher(() => Response.json(northwind));
    for (const address of ['localhost:5000', 'ftp://localhost:5000', 'not a url']) {
      const error = await failure(deriveMissionFromStore(address, fetchImpl as typeof fetch));
      expect(error.statusCode).toBe(400);
      expect(error.message).toBe('The store address must start with http:// or https://.');
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
