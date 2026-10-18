import { z } from 'zod';
import { Mission, type MissionRequirements, newId, nowIso } from '@agentproof/shared';

/**
 * URL-only missions: a Mission derived from the store's own product feed (GET /api/catalog.json)
 * with no model call, so the dashboard's first step needs nothing but a store address. The
 * derivation is deterministic and the prompt is code-written; the only judgement in it is which
 * product and variant to ask for, and that follows the rules on missionFromCatalog().
 *
 * It lives server-side because the storefront sends no CORS headers: a browser page cannot read
 * the feed itself, the runner can.
 */

/** A derivation failure the HTTP layer answers with its status: 400 bad address, 422 no feed. */
export class MissionDerivationError extends Error {
  constructor(
    message: string,
    public readonly statusCode: 400 | 422 = 422,
  ) {
    super(message);
    this.name = 'MissionDerivationError';
  }
}

export const STORE_ADDRESS_HELP = 'The store address must start with http:// or https://.';
export const CATALOG_FEED_PATH = '/api/catalog.json';
const FEED_TIMEOUT_MS = 5000;

/**
 * The product feed, leniently: the storefront's GET /api/catalog.json (apps/storefront/src/server.ts)
 * is the reference shape, and a store that omits categories, prices or stock flags still derives.
 * Fields the derivation does not read (image, description) are dropped.
 */
export const CatalogFeed = z.object({
  store: z.string().optional(),
  currency: z.string().optional(),
  products: z.array(
    z.object({
      id: z.string(),
      slug: z.string(),
      name: z.string(),
      category: z.string().optional(),
      basePrice: z.number().optional(),
      url: z.string().optional(),
      variants: z
        .array(
          z.object({
            id: z.string(),
            attributes: z.record(z.string(), z.string()).default({}),
            price: z.number().nonnegative(),
            inStock: z.boolean().default(true),
          }),
        )
        .default([]),
    }),
  ),
});
export type CatalogFeed = z.infer<typeof CatalogFeed>;
type CatalogVariant = CatalogFeed['products'][number]['variants'][number];

/**
 * True for an absolute http(s) address. "localhost:5000" is not one: the URL parser reads
 * "localhost" as its scheme, so z.url() lets it through and this check is what catches it.
 */
export function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/** True when some attribute offers the shopper a real choice: two or more in-stock values. */
function offersChoice(variants: CatalogVariant[]): boolean {
  const values = new Map<string, Set<string>>();
  for (const variant of variants) {
    for (const [key, value] of Object.entries(variant.attributes)) {
      const seen = values.get(key) ?? new Set<string>();
      seen.add(value);
      values.set(key, seen);
    }
  }
  return [...values.values()].some((seen) => seen.size >= 2);
}

/** Lowercase keys and trimmed values, in the feed's order (the order the prompt reads them in). */
function normalizeAttributes(attributes: Record<string, string>): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(attributes)) {
    normalized[key.toLowerCase()] = value.trim();
  }
  return normalized;
}

/** "black, size M": a color as its value, a size as "size M", anything else as "key value". */
function describeAttributes(attributes: Record<string, string>): string {
  return Object.entries(attributes)
    .map(([key, value]) =>
      key === 'color' ? value : key === 'size' ? `size ${value}` : `${key} ${value}`,
    )
    .join(', ');
}

/** The price plus 20% headroom, rounded up to the next $10: 49 -> 60, 58 -> 70, 14 -> 20. */
function budgetFor(price: number): number | undefined {
  if (price === 0) return undefined;
  return Math.ceil((price * 1.2) / 10) * 10;
}

/**
 * The mission a shopper should be able to complete on this store, from its feed. Pure.
 *
 * Product: the first product with an attribute that has two or more distinct in-stock values (a
 * real choice), else the first product with any in-stock variant. Variant: the second in-stock
 * variant in feed order when there is one, so the shopper has to change at least one default
 * (for the Northwind hoodie that is size M), else the first. Budget: the variant price plus 20%
 * rounded up to the next $10, omitted for a free item. Milestone: checkout review; the agent
 * never places the order. Throws a 422 MissionDerivationError when nothing is in stock, or when
 * what the feed says makes no valid Mission (a product whose name is blank).
 */
export function missionFromCatalog(
  catalog: CatalogFeed,
  storeUrl: string,
  now = nowIso(),
): Mission {
  const candidates = catalog.products.flatMap((product) => {
    const inStock = product.variants.filter((variant) => variant.inStock);
    const first = inStock[0];
    return first ? [{ product, inStock, variant: inStock[1] ?? first }] : [];
  });
  const chosen = candidates.find((candidate) => offersChoice(candidate.inStock)) ?? candidates[0];
  if (!chosen) throw new MissionDerivationError('The catalog lists no product in stock.', 422);

  const { product, variant } = chosen;
  const attributes = normalizeAttributes(variant.attributes);
  const maxUnitPrice = budgetFor(variant.price);
  const requirements: MissionRequirements = {
    product: product.name.trim().toLowerCase(),
    ...(product.category ? { category: product.category } : {}),
    attributes,
    quantity: 1,
    ...(maxUnitPrice === undefined ? {} : { maxUnitPrice }),
  };

  // Code-written, never a model's: the same sentence shape as the scenario prompts.
  const where = Object.keys(attributes).length ? ` in ${describeAttributes(attributes)}` : '';
  const budget = maxUnitPrice === undefined ? '' : ` for under $${maxUnitPrice}`;
  const rawPrompt = `Find the ${product.name.trim()}${where}${budget}, add it to the cart, and reach checkout. Do not place the order.`;

  // allowedActions and maxSteps take the schema defaults (every action, 25 steps). A feed the
  // CatalogFeed schema accepted can still make no Mission (a blank product name leaves
  // requirements.product empty): that is the feed's fault, answered as a 422, not a crash.
  const mission = Mission.safeParse({
    id: newId('mis'),
    createdAt: now,
    storeUrl,
    rawPrompt,
    requirements,
    successMilestone: 'checkout_review',
    paymentAuthorized: false,
  });
  if (!mission.success) {
    const issue = mission.error.issues[0];
    throw new MissionDerivationError(
      `The catalog feed could not be turned into a mission: ${issue?.message ?? mission.error.message}`,
      422,
    );
  }
  return mission.data;
}

/**
 * Derive the mission from a live store: GET <origin>/api/catalog.json, then missionFromCatalog().
 * A bad address is a 400. A store without a readable feed (a non-2xx status, a redirect, a
 * timeout, a network error, a non-JSON body or an unexpected shape) is a 422 that tells the user
 * to say what to buy instead. Only the feed is read; nothing is written to the store.
 */
export async function deriveMissionFromStore(
  storeUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Mission> {
  if (!isHttpUrl(storeUrl)) throw new MissionDerivationError(STORE_ADDRESS_HELP, 400);
  const { origin } = new URL(storeUrl);
  let body: unknown;
  try {
    const response = await fetchImpl(new URL(CATALOG_FEED_PATH, origin), {
      redirect: 'error',
      signal: AbortSignal.timeout(FEED_TIMEOUT_MS),
      headers: { Accept: 'application/json' },
    });
    body = response.ok ? await response.json() : undefined;
  } catch {
    body = undefined;
  }
  const catalog = CatalogFeed.safeParse(body);
  if (!catalog.success) {
    throw new MissionDerivationError(
      `No product feed at ${origin}${CATALOG_FEED_PATH}. Tell the shoppers what to buy instead.`,
      422,
    );
  }
  return missionFromCatalog(catalog.data, storeUrl);
}
