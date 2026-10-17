import type { Checkpoint, Mission, ObservedCart } from '@agentproof/shared';

/**
 * Agent Gamma: Structured Commerce Inspector.
 *
 * No browser. It reads the storefront's machine-readable catalog (GET {storeUrl}/api/catalog.json),
 * finds the variant that satisfies the mission, then exercises the cart API with that variant id
 * and checks whether the cart agrees with the catalog. This is how the "HOODIE-001-M resolves to
 * small" bug (spec example B) is caught.
 *
 * OWNER: Vihan (Gamma reads the catalog + cart API he owns).
 */

export interface CatalogVariant {
  id: string;
  attributes: Record<string, string>;
  price: number;
  inStock: boolean;
}
export interface CatalogProduct {
  id: string;
  slug: string;
  name: string;
  category: string;
  basePrice: number;
  variants: CatalogVariant[];
}
export interface Catalog {
  products: CatalogProduct[];
}

export interface GammaResult {
  checkpoints: Checkpoint[];
  cart?: ObservedCart;
  catalogRecord?: CatalogProduct;
  notes: string[];
}

export async function runGamma(
  mission: Mission,
  fetchImpl: typeof fetch = fetch,
): Promise<GammaResult> {
  const notes: string[] = [];
  const res = await fetchImpl(new URL('/api/catalog.json', mission.storeUrl));
  if (!res.ok) {
    return {
      checkpoints: [
        {
          id: 'catalog_variant_resolves',
          status: 'unsupported',
          detail: 'No catalog feed',
          evidenceIds: [],
        },
      ],
      notes: [`GET /api/catalog.json returned ${res.status}`],
    };
  }
  const catalog = (await res.json()) as Catalog;

  // TODO(vihan):
  // 1. pick the product whose name matches mission.requirements.product (simple token match)
  // 2. pick the variant whose attributes satisfy mission.requirements.attributes
  // 3. POST {storeUrl}/api/cart { variantId, quantity } and GET the cart back
  // 4. compare cart item attributes/price with the catalog variant -> catalog_variant_resolves
  // 5. GET the product page and compare the displayed price -> catalog_price_matches_page
  notes.push(`Catalog has ${catalog.products.length} products`);
  return { checkpoints: [], notes };
}
