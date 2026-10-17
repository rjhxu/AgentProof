import type { Product } from './catalog';
import { esc, productImage, titleCase } from './html';

/**
 * Page template for featured hardware (audio): a large art stage with the buy box floating
 * over it, followed by a spec table.
 *
 * DEMO BUG E ("Buy box inside an aria-hidden stage").
 * The stage was marked aria-hidden="true" back when it only held decorative artwork. The buy box
 * (price, options, Add to cart) was later moved inside it so it could sit on top of the art.
 * aria-hidden removes the whole subtree from the accessibility tree but changes nothing on screen,
 * so sighted shoppers can still see and click everything. An agent reading the tree finds the
 * heading and the specs and no way to buy.
 */
export function featureLayout(product: Product, buyForm: string): string {
  const specs = Object.entries(product.specs ?? {})
    .map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`)
    .join('');
  return `
<nav aria-label="Breadcrumb" class="breadcrumb"><a href="/">Shop</a> / ${esc(product.name)}</nav>
<header class="feature-intro">
  <p class="eyebrow">${esc(titleCase(product.category))}</p>
  <h1>${esc(product.name)}</h1>
  <p class="lede">${esc(product.description)}</p>
</header>
<section class="feature-stage" aria-hidden="true">
  <div class="feature-art">${productImage(product.slug, '', { className: 'large', placeholder: product.name })}</div>
  <div class="feature-buy">${buyForm}</div>
</section>
<section class="feature-specs" aria-labelledby="specs-heading">
  <h2 id="specs-heading">Specs</h2>
  <dl>${specs}</dl>
</section>`;
}
