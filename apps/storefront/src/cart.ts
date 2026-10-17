import { findVariant } from './catalog';

/**
 * In-memory carts keyed by a session cookie. Resets on restart, which is fine for tests.
 */
export interface CartLine {
  productId: string;
  variantId: string;
  name: string;
  attributes: Record<string, string>;
  unitPrice: number;
  quantity: number;
}
export interface Cart {
  items: CartLine[];
  subtotal: number;
  currency: 'USD';
}

const carts = new Map<string, CartLine[]>();

/**
 * DEMO BUG B (spec example B, "The Incorrect Product Variant").
 * The cart service resolves variant ids through this legacy mapping before lookup.
 * The medium hoodie is mis-mapped to small. The product page never hits this path
 * because it posts the size label, not the variant id (see server.ts), so human
 * shoppers never notice. Agent Gamma does.
 *
 * The expected repair deletes this map (or fixes the M entry). Keep the marker comment
 * so the diagnostics package can locate it.
 */
const LEGACY_VARIANT_MAP: Record<string, string> = {
  'HOODIE-001-M': 'HOODIE-001-S', // BUG: should be HOODIE-001-M
};

export function resolveVariantId(requested: string): string {
  return LEGACY_VARIANT_MAP[requested] ?? requested;
}

export function getCart(sessionId: string): Cart {
  const items = carts.get(sessionId) ?? [];
  const subtotal = items.reduce((sum, l) => sum + l.unitPrice * l.quantity, 0);
  return { items, subtotal: Math.round(subtotal * 100) / 100, currency: 'USD' };
}

export function addToCart(
  sessionId: string,
  requestedVariantId: string,
  quantity: number,
): Cart | { error: string } {
  const resolved = findVariant(resolveVariantId(requestedVariantId));
  if (!resolved) return { error: `Unknown variant ${requestedVariantId}` };
  if (!resolved.variant.inStock) return { error: `${resolved.variant.id} is out of stock` };

  const items = carts.get(sessionId) ?? [];
  const existing = items.find((l) => l.variantId === resolved.variant.id);
  if (existing) existing.quantity += quantity;
  else
    items.push({
      productId: resolved.product.id,
      variantId: resolved.variant.id,
      name: resolved.product.name,
      attributes: resolved.variant.attributes,
      unitPrice: resolved.variant.price,
      quantity,
    });
  carts.set(sessionId, items);
  return getCart(sessionId);
}

export function clearCart(sessionId: string): void {
  carts.delete(sessionId);
}
