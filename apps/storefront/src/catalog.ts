/**
 * Product data for the synthetic store "Northwind Threads".
 * This is the source of truth for the page, the structured feed, and the cart API.
 *
 * Each product renders through a page template (see views.ts). Each scenario's planted
 * agent-compatibility bug lives in a different template or component, so a mission about one
 * product only runs into that product's bug:
 *
 *   black-hoodie, grey-hoodie   classic     DEMO BUG A (views.ts), DEMO BUG B (cart.ts, API only)
 *   crewneck-sweatshirt         apparel     DEMO BUG C (swatches.ts + swatchLabels below)
 *   merino-socks                essentials  DEMO BUG D (quantity-stepper.ts)
 *   studio-headphones           feature     DEMO BUG E (feature-layout.ts)
 *   canvas-tote                 simple      none (control scenario)
 */
export interface Variant {
  id: string;
  attributes: Record<string, string>;
  price: number;
  inStock: boolean;
}

export type ProductTemplate = 'classic' | 'apparel' | 'essentials' | 'feature' | 'simple';

export interface Product {
  id: string;
  slug: string;
  name: string;
  category: string;
  description: string;
  /** Price advertised on listing pages and in the feed. Variants may differ (see headphones). */
  basePrice: number;
  template: ProductTemplate;
  variants: Variant[];
  /** Display names for color swatches, by swatch position (apparel template). */
  swatchLabels?: string[];
  /** Spec table rows (feature template). */
  specs?: Record<string, string>;
}

export const products: Product[] = [
  {
    id: 'HOODIE-001',
    slug: 'black-hoodie',
    name: 'Black Hoodie',
    category: 'apparel',
    description: 'Heavyweight cotton fleece hoodie. Relaxed fit, kangaroo pocket.',
    basePrice: 49,
    template: 'classic',
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
    template: 'classic',
    variants: [
      { id: 'HOODIE-002-S', attributes: { color: 'grey', size: 'S' }, price: 49, inStock: true },
      { id: 'HOODIE-002-M', attributes: { color: 'grey', size: 'M' }, price: 49, inStock: false },
      { id: 'HOODIE-002-L', attributes: { color: 'grey', size: 'L' }, price: 49, inStock: true },
    ],
  },
  {
    id: 'CREW-001',
    slug: 'crewneck-sweatshirt',
    name: 'Crewneck Sweatshirt',
    category: 'apparel',
    description: 'Midweight loopback cotton crewneck. Ribbed cuffs and hem, true to size.',
    basePrice: 58,
    template: 'apparel',
    variants: [
      { id: 'CREW-001-NVY-S', attributes: { color: 'navy', size: 'S' }, price: 58, inStock: true },
      { id: 'CREW-001-NVY-M', attributes: { color: 'navy', size: 'M' }, price: 58, inStock: true },
      { id: 'CREW-001-NVY-L', attributes: { color: 'navy', size: 'L' }, price: 58, inStock: true },
      {
        id: 'CREW-001-FOR-S',
        attributes: { color: 'forest', size: 'S' },
        price: 58,
        inStock: true,
      },
      {
        id: 'CREW-001-FOR-M',
        attributes: { color: 'forest', size: 'M' },
        price: 58,
        inStock: true,
      },
      {
        id: 'CREW-001-FOR-L',
        attributes: { color: 'forest', size: 'L' },
        price: 58,
        inStock: true,
      },
      {
        id: 'CREW-001-OAT-S',
        attributes: { color: 'oatmeal', size: 'S' },
        price: 58,
        inStock: true,
      },
      {
        id: 'CREW-001-OAT-M',
        attributes: { color: 'oatmeal', size: 'M' },
        price: 58,
        inStock: true,
      },
      {
        id: 'CREW-001-OAT-L',
        attributes: { color: 'oatmeal', size: 'L' },
        price: 58,
        inStock: false,
      },
    ],
    // DEMO BUG C (data half). Copied from the spring merch sheet, which listed Forest first.
    // The swatches render in variant order (navy, forest, oatmeal), so the first two names are swapped.
    swatchLabels: ['Forest', 'Navy', 'Oatmeal'],
  },
  {
    id: 'SOCK-001',
    slug: 'merino-socks',
    name: 'Merino Crew Socks',
    category: 'accessories',
    description: 'Cushioned merino wool blend crew socks. Sold per pair.',
    basePrice: 14,
    template: 'essentials',
    variants: [
      { id: 'SOCK-001-S', attributes: { color: 'charcoal', size: 'S' }, price: 14, inStock: true },
      { id: 'SOCK-001-M', attributes: { color: 'charcoal', size: 'M' }, price: 14, inStock: true },
      { id: 'SOCK-001-L', attributes: { color: 'charcoal', size: 'L' }, price: 14, inStock: true },
    ],
  },
  {
    id: 'HP-100',
    slug: 'studio-headphones',
    name: 'Studio Headphones',
    category: 'audio',
    description: 'Closed-back over-ear headphones. Wired or wireless.',
    // Spec example C (pricing data, not a planted bug): advertised "from $89", but the wireless
    // configuration is $119. A "wireless under $100" mission has no valid answer.
    basePrice: 89,
    template: 'feature',
    variants: [
      { id: 'HP-100-WIRED', attributes: { connectivity: 'wired' }, price: 89, inStock: true },
      {
        id: 'HP-100-WIRELESS',
        attributes: { connectivity: 'wireless' },
        price: 119,
        inStock: true,
      },
    ],
    specs: {
      Drivers: '40 mm dynamic',
      Weight: '280 g',
      Cable: '1.5 m detachable (wired)',
      Battery: '30 hours (wireless)',
    },
  },
  {
    id: 'TOTE-001',
    slug: 'canvas-tote',
    name: 'Canvas Tote',
    category: 'accessories',
    description: '16 oz natural cotton canvas tote with an inside pocket.',
    basePrice: 24,
    template: 'simple',
    variants: [{ id: 'TOTE-001-NAT', attributes: { color: 'natural' }, price: 24, inStock: true }],
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

/** Distinct values of one attribute, in variant order. */
export function attributeValues(product: Product, attr: string): string[] {
  return [
    ...new Set(product.variants.map((v) => v.attributes[attr]).filter((v) => v !== undefined)),
  ];
}

/** True if some in-stock variant has this attribute value. */
export function valueInStock(product: Product, attr: string, value: string): boolean {
  return product.variants.some((v) => v.inStock && v.attributes[attr] === value);
}
