import type { Cart } from './cart';
import { attributeValues, valueInStock, type Product } from './catalog';
import { buyForm, optionGroup, quantityInput, remainingOptions, variantScript } from './controls';
import { featureLayout } from './feature-layout';
import { esc, money, productImage, titleCase } from './html';
import { quantityStepper } from './quantity-stepper';
import { colorSwatches } from './swatches';

/**
 * Server-rendered HTML. Deliberately plain so Playwright behaviour is predictable.
 *
 * OWNER: Ryan.
 */

export function layout(title: string, body: string, cartCount = 0): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} - Northwind Threads</title>
<link rel="stylesheet" href="/static/store.css">
</head>
<body>
<header class="site-header">
  <a class="brand" href="/">Northwind Threads</a>
  <nav aria-label="Primary">
    <a href="/">Shop</a>
    <a href="/cart" id="cart-link">Cart (<span id="cart-count">${cartCount}</span>)</a>
  </nav>
</header>
<main class="container">
${body}
</main>
<footer class="site-footer">Synthetic storefront for AgentProof testing. No real orders are placed.</footer>
</body>
</html>`;
}

function priceLabel(p: Product): string {
  const prices = new Set(p.variants.map((v) => v.price));
  return prices.size > 1 ? `From ${money(p.basePrice)}` : money(p.basePrice);
}

export function catalogPage(products: Product[]): string {
  const cards = products
    .map(
      (p) => `
  <article class="card">
    <a class="card-link" href="/products/${p.slug}">
      ${productImage(p.slug, '', { placeholder: p.name })}
      <h2>${esc(p.name)}</h2>
    </a>
    <p class="card-meta">${esc(titleCase(p.category))}</p>
    <p class="price">${priceLabel(p)}</p>
  </article>`,
    )
    .join('');
  return `<h1>All products</h1><section class="grid" aria-label="Products">${cards}</section>`;
}

/**
 * DEMO BUG A (spec example A, "The Visually Functional Store").
 * The size picker is a row of <div> chips. A sighted shopper (and a vision agent) sees
 * "S M L" and clicks one. There is no form control, role, label, or keyboard handling,
 * so a semantic agent reading the accessibility tree finds nothing to select, and the
 * hidden input keeps its default (first size).
 *
 * Expected repair: a <fieldset><legend>Size</legend> of radio inputs with labels,
 * or buttons with role="radio" + aria-checked inside role="radiogroup" aria-label="Size".
 * (controls.ts already has optionGroup(), which renders exactly that.)
 */
function legacySizeChips(product: Product): string {
  const sizes = attributeValues(product, 'size');
  if (sizes.length === 0) return '';
  const initial = sizes.find((s) => valueInStock(product, 'size', s)) ?? sizes[0]!;
  const chips = sizes
    .map((s) => {
      const cls = `chip${s === initial ? ' selected' : ''}${valueInStock(product, 'size', s) ? '' : ' sold-out'}`;
      return `<div class="${cls}" data-size="${esc(s)}">${esc(s)}</div>`;
    })
    .join('');
  return `
    <div class="option-row">
      <span class="option-label">Size</span>
      <div class="size-picker">${chips}</div>
      <input type="hidden" name="size" value="${esc(initial)}">
    </div>
    <script>
    // Chip picker wiring (mouse only - part of DEMO BUG A).
    document.querySelectorAll('.size-picker .chip:not(.sold-out)').forEach((chip) => {
      chip.addEventListener('click', () => {
        document.querySelectorAll('.size-picker .chip').forEach((c) => c.classList.remove('selected'));
        chip.classList.add('selected');
        document.querySelector('input[name=size]').value = chip.dataset.size;
      });
    });
    </script>`;
}

/** Standard two-column product page used by every template except `feature`. */
function productShell(product: Product, controls: string): string {
  return `
<nav aria-label="Breadcrumb" class="breadcrumb"><a href="/">Shop</a> / ${esc(product.name)}</nav>
<section class="product">
  <div class="media">${productImage(product.slug, product.name, { className: 'large' })}</div>
  <div class="details">
    <h1>${esc(product.name)}</h1>
    ${buyForm(product, controls)}
    <p class="description">${esc(product.description)}</p>
  </div>
</section>`;
}

/**
 * One page template per product line (Product.template). Each template is the only place its
 * scenario's planted bug appears, so a mission about one product never trips over another's bug.
 */
export function productPage(product: Product): string {
  let page: string;
  switch (product.template) {
    case 'classic': // hoodies: legacy chip size picker (DEMO BUG A)
      page = productShell(
        product,
        legacySizeChips(product) + remainingOptions(product, ['size']) + quantityInput(),
      );
      break;
    case 'apparel': // crewneck: color swatches (DEMO BUG C)
      page = productShell(
        product,
        colorSwatches(product) + optionGroup(product, 'size') + quantityInput(),
      );
      break;
    case 'essentials': // socks: icon-only quantity stepper (DEMO BUG D)
      page = productShell(product, remainingOptions(product, []) + quantityStepper());
      break;
    case 'feature': // headphones: buy box inside an aria-hidden stage (DEMO BUG E)
      page = featureLayout(
        product,
        buyForm(product, remainingOptions(product, []) + quantityInput()),
      );
      break;
    case 'simple': // tote: no planted bug (control scenario)
      page = productShell(product, remainingOptions(product, []) + quantityInput());
      break;
  }
  return page + variantScript(product);
}

const optionsText = (attrs: Record<string, string>) =>
  Object.entries(attrs)
    .map(([k, v]) => `${titleCase(k)}: ${titleCase(v)}`)
    .join(', ');

export function cartPage(cart: Cart): string {
  if (cart.items.length === 0)
    return `<h1>Your cart</h1><p>Your cart is empty.</p><a class="button" href="/">Continue shopping</a>`;
  const rows = cart.items
    .map(
      (l) => `
    <tr>
      <td>${esc(l.name)}</td>
      <td>${esc(optionsText(l.attributes))}</td>
      <td>${l.quantity}</td>
      <td>${money(l.unitPrice)}</td>
      <td>${money(l.unitPrice * l.quantity)}</td>
    </tr>`,
    )
    .join('');
  return `
<h1>Your cart</h1>
<table class="cart-table">
  <thead><tr><th>Item</th><th>Options</th><th>Qty</th><th>Price</th><th>Total</th></tr></thead>
  <tbody>${rows}</tbody>
  <tfoot><tr><td colspan="4">Subtotal</td><td id="subtotal">${money(cart.subtotal)}</td></tr></tfoot>
</table>
<div class="actions">
  <form method="post" action="/cart/clear"><button type="submit" class="button">Clear cart</button></form>
  <a class="button primary" href="/checkout">Proceed to checkout</a>
</div>`;
}

export function checkoutPage(cart: Cart): string {
  return `
<h1>Review your order</h1>
<p class="muted">Step 2 of 3 - Review</p>
<section class="review" aria-label="Order summary">
  <ul>
    ${cart.items.map((l) => `<li>${l.quantity} x ${esc(l.name)} (${esc(optionsText(l.attributes))}) - ${money(l.unitPrice * l.quantity)}</li>`).join('')}
  </ul>
  <p><strong>Order total: ${money(cart.subtotal)}</strong></p>
  <p class="muted">Shipping: Free standard (3-5 days)</p>
</section>
<form method="post" action="/checkout/place-order">
  <button type="submit" class="button primary" id="place-order">Place order</button>
</form>
<p class="muted">AgentProof tests stop here. The policy layer forbids clicking "Place order".</p>`;
}

export function errorPage(message: string, backHref = '/'): string {
  return `<h1>Could not add to cart</h1><p>${esc(message)}</p><a class="button" href="${esc(backHref)}">Go back</a>`;
}
