import { z } from 'zod';
import { ObservedCart, type Checkpoint, type Mission } from '@agentproof/shared';
import { hostIsAllowed } from './policy';

/** Gamma: deterministic catalog/cart inspector. */

const Variant = z.object({
  id: z.string(),
  attributes: z.record(z.string(), z.string()),
  price: z.number().nonnegative(),
  inStock: z.boolean(),
});
const Product = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  category: z.string(),
  basePrice: z.number(),
  variants: z.array(Variant),
});
export type CatalogVariant = z.infer<typeof Variant>;
export type CatalogProduct = z.infer<typeof Product>;
export interface Catalog {
  products: CatalogProduct[];
}
export interface GammaResult {
  checkpoints: Checkpoint[];
  cart?: ObservedCart;
  catalogRecord?: CatalogProduct;
  selectedVariant?: CatalogVariant;
  checkoutReached?: boolean;
  notes: string[];
}

const norm = (value: string) => {
  const lower = value.trim().toLowerCase();
  return ({ small: 's', medium: 'm', large: 'l' } as Record<string, string>)[lower] ?? lower;
};

/** Real HTTP execution, isolated cart per run. No redirects or payment submission. */
export async function runGamma(
  mission: Mission,
  fetchImpl: typeof fetch = fetch,
): Promise<GammaResult> {
  if (!hostIsAllowed(mission.storeUrl)) throw new Error('Store host is not allowed');
  if (!['http:', 'https:'].includes(new URL(mission.storeUrl).protocol))
    throw new Error('Unsupported store protocol');
  let cookie = '';
  const request = async (path: string, init: RequestInit = {}) => {
    const response = await fetchImpl(new URL(path, mission.storeUrl), {
      ...init,
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
      headers: {
        'Content-Type': 'application/json',
        ...(cookie ? { Cookie: cookie } : {}),
        ...init.headers,
      },
    });
    const cookies = response.headers.getSetCookie();
    if (cookies.length) cookie = cookies.map((value) => value.split(';')[0]).join('; ');
    if (!response.ok) throw new Error(path + ' returned HTTP ' + response.status);
    return response;
  };
  const catalog = z
    .object({ products: z.array(Product) })
    .parse(await (await request('/api/catalog.json')).json());
  const req = mission.requirements;
  const matches = catalog.products.flatMap((product) => {
    if (
      !req.product
        .toLowerCase()
        .split(/\s+/)
        .every((word) => product.name.toLowerCase().includes(word))
    )
      return [];
    if (req.category && norm(req.category) !== norm(product.category)) return [];
    return product.variants
      .filter(
        (variant) =>
          variant.inStock &&
          Object.entries(req.attributes).every(
            ([key, value]) => norm(variant.attributes[key] ?? '') === norm(value),
          ) &&
          (req.maxUnitPrice === undefined || variant.price <= req.maxUnitPrice) &&
          (req.maxTotalPrice === undefined || variant.price * req.quantity <= req.maxTotalPrice),
      )
      .map((variant) => ({ product, variant }));
  });
  const match = matches[0];
  if (!match)
    return {
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
  const { product, variant } = match;
  await request('/api/cart', {
    method: 'POST',
    body: JSON.stringify({ variantId: variant.id, quantity: req.quantity }),
  });
  const rawCart = ObservedCart.omit({ source: true }).parse(
    await (await request('/api/cart')).json(),
  );
  const cart = ObservedCart.parse({ ...rawCart, source: 'api' });
  const item = cart.items[0];
  const resolves =
    cart.items.length === 1 &&
    item?.productId === product.id &&
    item.variantId === variant.id &&
    item.unitPrice === variant.price &&
    item.quantity === req.quantity &&
    Object.entries(variant.attributes).every(
      ([key, value]) => norm(item.attributes[key] ?? '') === norm(value),
    );
  let checkoutReached: boolean | undefined;
  if (mission.successMilestone === 'checkout_review') {
    const html = await (await request('/checkout')).text();
    checkoutReached =
      /<h1>Review your order<\/h1>/i.test(html) && html.includes('/checkout/place-order');
  }
  return {
    cart,
    catalogRecord: product,
    selectedVariant: variant,
    checkoutReached,
    checkpoints: [
      {
        id: 'catalog_variant_resolves',
        status: resolves ? 'passed' : 'failed',
        detail:
          'Requested ' +
          variant.id +
          ' (' +
          JSON.stringify(variant.attributes) +
          '); cart returned ' +
          (item?.variantId ?? 'no item') +
          ' (' +
          JSON.stringify(item?.attributes ?? {}) +
          ').',
        evidenceIds: [],
      },
    ],
    notes: [
      'Selected ' + variant.id + ' from the live catalog.',
      'Read back the cart using this run’s session cookie.',
    ],
  };
}
