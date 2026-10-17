/**
 * Product data for the synthetic store "Northwind Threads".
 * This is the source of truth for the page, the structured feed, and the cart API.
 *
 * OWNER: Vihan.
 */
export interface Variant {
  id: string;
  attributes: Record<string, string>;
  price: number;
  inStock: boolean;
}

export interface Product {
  id: string;
  slug: string;
  name: string;
  category: string;
  description: string;
  /** Price advertised on listing pages and in the feed. Variants may differ (see headphones). */
  basePrice: number;
  variants: Variant[];
}

export const products: Product[] = [
  {
    id: 'HOODIE-001',
    slug: 'black-hoodie',
    name: 'Black Hoodie',
    category: 'apparel',
    description: 'Heavyweight cotton fleece hoodie. Relaxed fit, kangaroo pocket.',
    basePrice: 49,
    variants: [
      { id: 'HOODIE-001-S', attributes: { color: 'black', size: 'S' }, price: 49, inStock: true },
      { id: 'HOODIE-001-M', attributes: { color: 'black', size: 'M' }, price: 49, inStock: true },
      { id: 'HOODIE-001-L', attributes: { color: 'black', size: 'L' }, price: 49, inStock: true },
    ],
  },
  {
    id: 'HOODIE-002',
    slug: 'grey-hoodie',
    name: 'Grey Hoodie',
    category: 'apparel',
    description: 'Same fleece, heather grey.',
    basePrice: 49,
    variants: [
      { id: 'HOODIE-002-S', attributes: { color: 'grey', size: 'S' }, price: 49, inStock: true },
      { id: 'HOODIE-002-M', attributes: { color: 'grey', size: 'M' }, price: 49, inStock: false },
      { id: 'HOODIE-002-L', attributes: { color: 'grey', size: 'L' }, price: 49, inStock: true },
    ],
  },
  {
    id: 'HP-100',
    slug: 'studio-headphones',
    name: 'Studio Headphones',
    category: 'audio',
    description: 'Closed-back over-ear headphones. Wired or wireless.',
    // Example C in the spec: advertised at $89, but the wireless configuration is $119.
    basePrice: 89,
    variants: [
      { id: 'HP-100-WIRED', attributes: { connectivity: 'wired' }, price: 89, inStock: true },
      {
        id: 'HP-100-WIRELESS',
        attributes: { connectivity: 'wireless' },
        price: 119,
        inStock: true,
      },
    ],
  },
];

export function findProductBySlug(slug: string): Product | undefined {
  return products.find((p) => p.slug === slug);
}

export function findVariant(variantId: string): { product: Product; variant: Variant } | undefined {
  for (const product of products) {
    const variant = product.variants.find((v) => v.id === variantId);
    if (variant) return { product, variant };
  }
  return undefined;
}
