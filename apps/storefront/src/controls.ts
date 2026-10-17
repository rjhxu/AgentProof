import { attributeValues, valueInStock, type Product } from './catalog';
import { esc, money, titleCase } from './html';

/**
 * Product-page form controls shared by the templates. These are the reference patterns
 * (native inputs, visible labels, state the accessibility tree can see). The planted
 * agent-compatibility bugs live in their own components, not here.
 */

/** Price of the variant a fresh page load starts on (first in-stock variant). */
export function defaultPrice(product: Product): number {
  return (
    (product.variants.find((v) => v.inStock) ?? product.variants[0])?.price ?? product.basePrice
  );
}

/** Radio group for one attribute, styled as chips. Starts on the first in-stock value. */
export function optionGroup(product: Product, attr: string): string {
  const values = attributeValues(product, attr);
  const initial = values.find((v) => valueInStock(product, attr, v));
  const choices = values
    .map(
      (v) => `
        <label class="choice">
          <input type="radio" name="${esc(attr)}" value="${esc(v)}"${v === initial ? ' checked' : ''}${valueInStock(product, attr, v) ? '' : ' disabled'}>
          <span>${esc(titleCase(v))}</span>
        </label>`,
    )
    .join('');
  return `
    <fieldset class="option-row option-group">
      <legend class="option-label">${esc(titleCase(attr))}</legend>
      <div class="choices">${choices}
      </div>
    </fieldset>`;
}

/** An attribute with a single value: shown as text, submitted as a hidden field. */
export function fixedOption(product: Product, attr: string): string {
  const value = attributeValues(product, attr)[0] ?? '';
  return `
    <div class="option-row">
      <span class="option-label">${esc(titleCase(attr))}</span>
      <span class="option-fixed">${esc(titleCase(value))}</span>
      <input type="hidden" name="${esc(attr)}" value="${esc(value)}">
    </div>`;
}

/** Every attribute not in `skip`: a radio group if it varies, fixed text if it does not. */
export function remainingOptions(product: Product, skip: string[]): string {
  const attrs = Object.keys(product.variants[0]?.attributes ?? {}).filter((a) => !skip.includes(a));
  return attrs
    .map((a) =>
      attributeValues(product, a).length > 1 ? optionGroup(product, a) : fixedOption(product, a),
    )
    .join('');
}

export function quantityInput(): string {
  return `
    <div class="option-row">
      <label for="qty" class="option-label">Quantity</label>
      <input id="qty" name="quantity" type="number" min="1" max="10" value="1" inputmode="numeric">
    </div>`;
}

/** The add-to-cart form. `controls` is the template's option and quantity markup. */
export function buyForm(product: Product, controls: string): string {
  return `
<form method="post" action="/cart/add" id="add-form" class="buy-form">
  <p class="price" id="price">${money(defaultPrice(product))}</p>
  <input type="hidden" name="productId" value="${esc(product.id)}">
  ${controls}
  <button type="submit" class="button primary add-to-cart">Add to cart</button>
</form>`;
}

/**
 * Keeps the displayed price on the selected variant, and disables radio values that have no
 * in-stock variant given the other current selections (e.g. oatmeal crewneck in L).
 */
export function variantScript(product: Product): string {
  return `
<script>
(() => {
  const variants = ${JSON.stringify(product.variants)};
  const form = document.getElementById('add-form');
  const price = document.getElementById('price');
  if (!form) return;
  const matches = (attrs, sel) =>
    Object.entries(attrs).every(([k, v]) => sel[k] === undefined || sel[k] === v);
  function update() {
    const sel = Object.fromEntries(new FormData(form).entries());
    form.querySelectorAll('input[type=radio]').forEach((input) => {
      const trial = { ...sel, [input.name]: input.value };
      input.disabled = !variants.some((v) => v.inStock && matches(v.attributes, trial));
      if (input.disabled && input.checked) {
        input.checked = false;
        const next = form.querySelector('input[type=radio][name="' + input.name + '"]:not(:disabled)');
        if (next) next.checked = true;
      }
    });
    const now = Object.fromEntries(new FormData(form).entries());
    const exact = variants.find((v) =>
      Object.entries(v.attributes).every(([k, val]) => now[k] === val),
    );
    if (exact && price) price.textContent = '$' + exact.price.toFixed(2);
  }
  form.addEventListener('change', update);
  update();
})();
</script>`;
}
