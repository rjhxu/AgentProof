const MINUS_ICON = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 12h14"/></svg>`;
const PLUS_ICON = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>`;

/**
 * Quantity control for the essentials template: "− 1 +".
 *
 * DEMO BUG D ("Icon-only quantity stepper").
 * The two buttons contain only SVG icons, with no text, aria-label, or <title>, so they have no
 * accessible name. The count is a plain <span>, and the value the form submits is a hidden input.
 * Sighted shoppers see minus and plus signs and click. An agent reading the accessibility tree sees
 * two nameless buttons next to the text "1" and no labelled field it can type into, so it cannot
 * set a quantity and adds a single pair.
 */
export function quantityStepper(max = 10): string {
  return `
    <div class="option-row">
      <span class="option-label">Quantity</span>
      <div class="stepper" data-stepper data-max="${max}">
        <button type="button" class="stepper-btn" data-step="-1">${MINUS_ICON}</button>
        <span class="stepper-value" data-stepper-value>1</span>
        <button type="button" class="stepper-btn" data-step="1">${PLUS_ICON}</button>
        <input type="hidden" name="quantity" value="1">
      </div>
    </div>
    <script>
    document.querySelectorAll('[data-stepper]').forEach((stepper) => {
      const input = stepper.querySelector('input[name=quantity]');
      const display = stepper.querySelector('[data-stepper-value]');
      const max = Number(stepper.dataset.max);
      stepper.querySelectorAll('[data-step]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const next = Math.min(max, Math.max(1, Number(input.value) + Number(btn.dataset.step)));
          input.value = String(next);
          display.textContent = String(next);
        });
      });
    });
    </script>`;
}
