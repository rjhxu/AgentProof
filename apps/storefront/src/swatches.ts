import { attributeValues, type Product } from './catalog';
import { esc, imageUrl, titleCase } from './html';

/** Swatch fill colors, keyed by the catalog's color value. */
const SWATCH_HEX: Record<string, string> = {
  navy: '#1f3566',
  forest: '#2f6b3f',
  oatmeal: '#ddd0b6',
  black: '#151515',
  grey: '#9a9a9a',
  charcoal: '#3b3b3b',
  natural: '#e9e0cc',
};

/**
 * Color picker for the apparel template: a row of round swatches, one radio input per color.
 * No color is preselected; the shopper has to pick one.
 *
 * DEMO BUG C ("Mislabelled swatches").
 * Each swatch's value and fill come from the variant data, but its accessible name comes from
 * product.swatchLabels[i], a hand-maintained display-name list matched by position. The two lists
 * are in different orders (see catalog.ts), so the navy swatch is announced as "Forest" and the
 * forest swatch as "Navy". Sighted shoppers pick by color and never see the name. An agent that
 * checks the radio named "Navy" gets the forest green sweatshirt.
 */
export function colorSwatches(product: Product): string {
  const colors = attributeValues(product, 'color');
  const labels = product.swatchLabels ?? [];
  const swatches = colors
    .map(
      (color, i) => `
        <label class="swatch" style="--swatch: ${SWATCH_HEX[color] ?? '#cccccc'}">
          <input type="radio" name="color" value="${esc(color)}" aria-label="${esc(labels[i] ?? titleCase(color))}" required>
        </label>`,
    )
    .join('');

  // Optional per-color photos: public/images/<slug>-<color>.jpg replaces the main photo on select.
  const photos = Object.fromEntries(
    colors.flatMap((c) => {
      const url = imageUrl(`${product.slug}-${c}`);
      return url ? [[c, url]] : [];
    }),
  );

  return `
    <fieldset class="option-row option-group">
      <legend class="option-label">Color</legend>
      <div class="swatches">${swatches}
      </div>
    </fieldset>
    <script>
    (() => {
      const photos = ${JSON.stringify(photos)};
      const img = document.querySelector('.product .media img');
      document.querySelectorAll('.swatch input').forEach((input) => {
        input.addEventListener('change', () => {
          if (img && photos[input.value]) img.src = photos[input.value];
        });
      });
    })();
    </script>`;
}
