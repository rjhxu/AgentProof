import type { Cart } from './cart';
import type { Product } from './catalog';

/**
 * Server-rendered HTML. Deliberately plain so Playwright behaviour is predictable.
 *
 * OWNER: Developer 3.
 */

const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

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

export function catalogPage(products: Product[]): string {
  const cards = products
    .map(
      (p) => `
  <article class="card">
    <a href="/products/${p.slug}">
      <div class="thumb" aria-hidden="true">${esc(p.name.split(' ')[0] ?? '')}</div>
      <h2>${esc(p.name)}</h2>
    </a>
    <p class="price">From $${p.basePrice.toFixed(2)}</p>
    <a class="button" href="/products/${p.slug}">View</a>
  </article>`,
    )
    .join('');
  return `<h1>All products</h1><section class="grid">${cards}</section>`;
}

export function productPage(product: Product): string {
  const sizes = [
    ...new Set(product.variants.map((v) => v.attributes.size).filter(Boolean)),
  ] as string[];
  const otherAttrs = Object.keys(product.variants[0]?.attributes ?? {}).filter((k) => k !== 'size');

  /**
   * DEMO BUG A (spec example A, "The Visually Functional Store").
   * The size picker is a row of <div> chips. A sighted shopper (and a vision agent) sees
   * "S M L" and clicks one. There is no form control, role, label, or keyboard handling,
   * so a semantic agent reading the accessibility tree finds nothing to select, and the
   * hidden input keeps its default (first size).
   *
   * Expected repair: a <fieldset><legend>Size</legend> of radio inputs with labels,
   * or buttons with role="radio" + aria-checked inside role="radiogroup" aria-label="Size".
   */
  const sizePicker =
    sizes.length === 0
      ? ''
      : `
  <div class="option-row">
    <span class="option-label">Size</span>
    <div class="size-picker">
      ${sizes.map((s, i) => `<div class="chip${i === 0 ? ' selected' : ''}" data-size="${esc(s)}">${esc(s)}</div>`).join('')}
    </div>
    <input type="hidden" name="size" value="${esc(sizes[0] ?? '')}">
  </div>`;

  const otherPickers = otherAttrs
    .map((attr) => {
      const values = [
        ...new Set(product.variants.map((v) => v.attributes[attr]).filter(Boolean)),
      ] as string[];
      return `
  <div class="option-row">
    <label for="opt-${esc(attr)}" class="option-label">${esc(attr[0]!.toUpperCase() + attr.slice(1))}</label>
    <select id="opt-${esc(attr)}" name="${esc(attr)}">
      ${values.map((v) => `<option value="${esc(v)}">${esc(v)}</option>`).join('')}
    </select>
  </div>`;
    })
    .join('');

  return `
<nav aria-label="Breadcrumb"><a href="/">Shop</a> / ${esc(product.name)}</nav>
<section class="product">
  <div class="thumb large" aria-hidden="true">${esc(product.name)}</div>
  <div class="details">
    <h1>${esc(product.name)}</h1>
    <p class="price" id="price">$${product.basePrice.toFixed(2)}</p>
    <p>${esc(product.description)}</p>
    <form method="post" action="/cart/add" id="add-form">
      <input type="hidden" name="productId" value="${esc(product.id)}">
      ${sizePicker}
      ${otherPickers}
      <div class="option-row">
        <label for="qty" class="option-label">Quantity</label>
        <input id="qty" name="quantity" type="number" min="1" value="1">
      </div>
      <button type="submit" class="button primary">Add to cart</button>
    </form>
  </div>
</section>
<script>
  // Chip picker wiring (mouse only - part of DEMO BUG A).
  document.querySelectorAll('.size-picker .chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('.size-picker .chip').forEach((c) => c.classList.remove('selected'));
      chip.classList.add('selected');
      document.querySelector('input[name=size]').value = chip.dataset.size;
    });
  });
  // Variant pricing: update displayed price when options change.
  const variants = ${JSON.stringify(product.variants)};
  const form = document.getElementById('add-form');
  form.addEventListener('change', () => {
    const data = Object.fromEntries(new FormData(form).entries());
    const match = variants.find((v) => Object.entries(v.attributes).every(([k, val]) => data[k] === val));
    if (match) document.getElementById('price').textContent = '$' + match.price.toFixed(2);
  });
</script>`;
}

export function cartPage(cart: Cart): string {
  if (cart.items.length === 0)
    return `<h1>Your cart</h1><p>Your cart is empty.</p><a class="button" href="/">Continue shopping</a>`;
  const rows = cart.items
    .map(
      (l) => `
    <tr>
      <td>${esc(l.name)}</td>
      <td>${esc(
        Object.entries(l.attributes)
          .map(([k, v]) => `${k}: ${v}`)
          .join(', '),
      )}</td>
      <td>${l.quantity}</td>
      <td>$${l.unitPrice.toFixed(2)}</td>
      <td>$${(l.unitPrice * l.quantity).toFixed(2)}</td>
    </tr>`,
    )
    .join('');
  return `
<h1>Your cart</h1>
<table class="cart-table">
  <thead><tr><th>Item</th><th>Options</th><th>Qty</th><th>Price</th><th>Total</th></tr></thead>
  <tbody>${rows}</tbody>
  <tfoot><tr><td colspan="4">Subtotal</td><td id="subtotal">$${cart.subtotal.toFixed(2)}</td></tr></tfoot>
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
<section class="review">
  <ul>
    ${cart.items.map((l) => `<li>${l.quantity} x ${esc(l.name)} (${esc(Object.values(l.attributes).join(', '))}) - $${(l.unitPrice * l.quantity).toFixed(2)}</li>`).join('')}
  </ul>
  <p><strong>Order total: $${cart.subtotal.toFixed(2)}</strong></p>
  <p class="muted">Shipping: Free standard (3-5 days)</p>
</section>
<form method="post" action="/checkout/place-order">
  <button type="submit" class="button primary" id="place-order">Place order</button>
</form>
<p class="muted">AgentProof tests stop here. The policy layer forbids clicking "Place order".</p>`;
}
