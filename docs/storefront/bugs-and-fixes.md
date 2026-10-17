# Storefront bugs: issue outline and fixes

This is the answer key for the Northwind Threads test store (`apps/storefront`). Each scenario pairs a product with a planted bug. The bugs block AI shopping agents but leave sighted human shoppers unaffected. For every bug this doc covers:

- the mission
- the exact steps that reproduce it
- what the agent sees
- what the verifier should report
- the diagnosis, in the `Issue` shape
- the reference fix (a patch that applies with `git apply`)
- what passing looks like afterwards

Every "before" and "after" result below was produced by a strictly semantic Playwright shopper (role + accessible name only) and a mouse-driven "human" shopper. Both were run against this code, with and without each patch applied.

**Difficulty check:** a smaller model was given only each run's evidence (mission, step log, aria snapshot, final cart) and read access to `apps/storefront/src`. It found all five root causes at the lines listed here, and its own fixes made the semantic shopper pass all five. Treat these as easy bugs: a diagnosis model that misses one has a prompt or evidence problem, not a hard bug.

## The rule these bugs follow

A planted bug may only change what a machine can perceive: the accessibility tree, accessible names, or machine-readable data. It may not change what a person sees or can click. If a human with a mouse would also end up with the wrong item, it is a store bug, not an agent-compatibility bug, and it does not belong here.

Every UI bug here also hurts screen-reader users. That is the pitch: **agent-readiness and accessibility are the same contract.**

## Running the store

```bash
pnpm dev:store                        # http://localhost:5000
STOREFRONT_PORT=5050 pnpm dev:store   # macOS: AirPlay Receiver usually owns :5000
```

- Carts live in memory, keyed by the `nw_session` cookie. Every Playwright context gets a fresh cart, and restarting the store clears all carts.
- `curl -X DELETE localhost:5000/api/cart` clears the current session's cart.
- Product photos are optional. See [Product images](#product-images).

## How each agent perceives the store

| Agent              | Observes                                               | Targets elements by                                         | Affected by |
| ------------------ | ------------------------------------------------------ | ----------------------------------------------------------- | ----------- |
| Alpha (semantic)   | `page.locator('body').ariaSnapshot()` + text excerpt   | `role:name` → `page.getByRole(role, { name, exact: true })` | A, C, D, E  |
| Beta (vision)      | screenshot                                             | `x,y` → `page.mouse.click`                                  | none        |
| Gamma (structured) | `/api/catalog.json`, `POST /api/cart`, `GET /api/cart` | variant ids                                                 | B           |

**Alpha should resolve targets with `getByRole` (and optionally `getByLabel`) only.** The snapshot for Bug A still contains the plain text `Size S M L`. An agent that may also send raw Playwright selectors such as `text="M"` can sometimes click its way past A, which defeats the scenario. A semantic agent's targets must name a role.

## Scenario index

| ID      | Product (URL)                                       | Bug                                    | Category                     | Failing checkpoint                                 | Source                                 |
| ------- | --------------------------------------------------- | -------------------------------------- | ---------------------------- | -------------------------------------------------- | -------------------------------------- |
| Control | Canvas Tote `/products/canvas-tote`                 | none                                   | n/a                          | none (all pass)                                    | `views.ts` (`simple` template)         |
| A       | Black Hoodie `/products/black-hoodie`               | Size chips are `<div>`s, not controls  | `semantic_interface_problem` | `correct_size_identified`, `cart_matches_variant`  | `views.ts:62-99`                       |
| B       | Black Hoodie via `POST /api/cart`                   | Legacy id map sends `-M` to `-S`       | `product_data_inconsistency` | `catalog_variant_resolves`, `cart_matches_variant` | `cart.ts:32-34`, `server.ts:127-136`   |
| C       | Crewneck Sweatshirt `/products/crewneck-sweatshirt` | Swatch names swapped (Navy ↔ Forest)   | `semantic_interface_problem` | `correct_color_identified`, `cart_matches_variant` | `swatches.ts:33`, `catalog.ts:120-122` |
| D       | Merino Crew Socks `/products/merino-socks`          | Icon-only `−`/`+` buttons with no name | `semantic_interface_problem` | `cart_quantity_correct`                            | `quantity-stepper.ts:18-22`            |
| E       | Studio Headphones `/products/studio-headphones`     | Buy box inside `aria-hidden="true"`    | `semantic_interface_problem` | `added_to_cart`, `checkout_review_reached`         | `feature-layout.ts:26`                 |

Each bug lives in exactly one product template (`Product.template` in `catalog.ts`), so a mission about one product never runs into another product's bug. The `classic` template carries both A and B, so the flagship hoodie mission shows two distinct failures: Alpha on A and Gamma on B. The Grey Hoodie shares the `classic` template and therefore has Bug A as well.

**Line numbers** refer to the buggy code as it stands, before any patch. Every bug is also tagged in the source with a `DEMO BUG <letter>` comment: `grep -rn "DEMO BUG" apps/storefront/src`.

## Diagnosis procedure (all scenarios)

This is the procedure we want the diagnosis model to follow. Each scenario below walks through it.

1. **Start from the verifier, not the agent.** Read the first failed checkpoint and the observed cart. The agent's own `done` or `fail` claim is evidence, not a verdict.
2. **Find the step where perception diverged.** In the step log, look for a `role:name` target that was not found, or one that was found but produced the wrong cart.
3. **Compare the two views of the same page.** Put the screenshot (what a human sees) next to the aria snapshot (what Alpha sees). Every UI bug is a control that is visible in one view but missing, nameless, misnamed or hidden in the other.
4. **Classify the gap.** There are five shapes, one per scenario:
   - no role (A)
   - id or data mismatch on the machine path (B)
   - wrong name (C)
   - no name (D)
   - hidden subtree (E)
5. **Map it to source.** Search `apps/storefront/src` for the control's visible text, CSS class, or `data-*` attribute, then follow the template in `views.ts` that renders that product.
6. **Fix the semantics, not the pixels.** A correct repair changes roles, names, `aria-*` attributes or data. It should not change the page's appearance. Prefer an existing accessible component in `controls.ts` over writing a new one.
7. **Prove it.** Rerun the same mission with the same agent and check the cart through `/api/cart`. A new ARIA attribute is not proof. A correct cart is.

---

## Control: Canvas Tote (no bug)

A baseline that every agent should pass. If this fails, the problem is in the agent or the runner, not the store.

**Mission:** `Add the canvas tote to the cart and reach checkout. Do not place the order.`

```json
{
  "product": "canvas tote",
  "attributes": {},
  "quantity": 1,
  "successMilestone": "checkout_review"
}
```

**Steps (semantic agent):**

1. Click `link:Canvas Tote`.
2. Click `button:Add to cart`.
3. Click `link:Proceed to checkout`.

**Result:** cart `TOTE-001-NAT x1 $24`. All checkpoints pass.

---

## Bug A: size chips are not form controls

| Field         | Value                                                                                       |
| ------------- | ------------------------------------------------------------------------------------------- |
| Product       | Black Hoodie, `/products/black-hoodie` (`HOODIE-001`). The Grey Hoodie shares the template. |
| Agents hit    | Alpha. Beta and humans succeed.                                                             |
| Category      | `semantic_interface_problem`                                                                |
| Source        | `apps/storefront/src/views.ts:62-99` (`legacySizeChips`), used at `views.ts:125`            |
| Reference fix | [`patches/bug-a-size-picker.patch`](patches/bug-a-size-picker.patch)                        |

**Mission:** `Find a black hoodie in medium for less than $60, add it to the cart, and reach checkout. Do not place the order.`

This is the same mission as the `hoodieMission` fixture.

```json
{
  "product": "black hoodie",
  "category": "apparel",
  "attributes": { "color": "black", "size": "M" },
  "quantity": 1,
  "maxUnitPrice": 60,
  "successMilestone": "checkout_review"
}
```

**Reproduce (semantic agent):**

1. Navigate to `/`, then click `link:Black Hoodie` (ok).
2. Try to choose size M. `radio:M`, `combobox:Size` and `button:M` are all missing from the accessibility tree.
3. Click `button:Add to cart` (ok). The form posts the hidden `size` input, which still holds its default `S`.
4. On `/cart`, click `link:Proceed to checkout`. The agent reaches `/checkout`.
5. **Cart:** `HOODIE-001-S x1 $49`.

**What Alpha sees (the size row):**

<!-- prettier-ignore-start -->
```yaml
- heading "Black Hoodie" [level=1]
- paragraph: $49.00
- text: Size S M L Color Black Quantity
- spinbutton "Quantity": "1"
- button "Add to cart"
```
<!-- prettier-ignore-end -->

"Size S M L" is plain text. There is no radio, combobox or button to operate.

**What a human sees:** three pill buttons (S, M, L). Clicking M highlights it, and the cart gets `HOODIE-001-M`. This was verified with a mouse click.

**Expected verification (Alpha):**

| Checkpoint               | Status | Detail                           |
| ------------------------ | ------ | -------------------------------- |
| product_discovered       | passed |                                  |
| correct_color_identified | passed | black                            |
| correct_size_identified  | failed | required "M", observed "S"       |
| added_to_cart            | passed |                                  |
| cart_matches_variant     | failed | size: required "M", cart has "S" |
| cart_quantity_correct    | passed |                                  |
| price_within_budget      | passed | $49 ≤ $60                        |
| checkout_review_reached  | passed |                                  |

**Diagnosis:**

- **observed** (from the verifier and evidence): "Agent requested radio/combobox/button named M or Size; none existed in the accessibility tree. The snapshot shows 'Size S M L' as plain text. Cart contains HOODIE-001-S; mission required size M."
- **inferredCause:** "The classic product template renders the size picker as `<div class="chip">` elements with a mouse-only click handler (`legacySizeChips` in views.ts). They have no role, accessible name, focusability or checked state, so a semantic agent cannot select a size and the hidden `size` input keeps its default, S."
- **suggestedRepair:** "Render the size picker with the existing accessible `optionGroup(product, 'size')` from controls.ts (a fieldset with a legend and native radio inputs), and delete `legacySizeChips`."
- **suspectedFiles:** `apps/storefront/src/views.ts`
- **confidence:** high

**Fix:**

<!-- prettier-ignore-start -->
```diff
--- a/apps/storefront/src/views.ts
+++ b/apps/storefront/src/views.ts
@@ -1,5 +1,5 @@
 import type { Cart } from './cart';
-import { attributeValues, valueInStock, type Product } from './catalog';
+import type { Product } from './catalog';
 import { buyForm, optionGroup, quantityInput, remainingOptions, variantScript } from './controls';
 import { featureLayout } from './feature-layout';
 import { esc, money, productImage, titleCase } from './html';
@@ -59,45 +59,6 @@
   return `<h1>All products</h1><section class="grid" aria-label="Products">${cards}</section>`;
 }
 
-/**
- * DEMO BUG A (spec example A, "The Visually Functional Store").
- * The size picker is a row of <div> chips. A sighted shopper (and a vision agent) sees
- * "S M L" and clicks one. There is no form control, role, label, or keyboard handling,
- * so a semantic agent reading the accessibility tree finds nothing to select, and the
- * hidden input keeps its default (first size).
- *
- * Expected repair: a <fieldset><legend>Size</legend> of radio inputs with labels,
- * or buttons with role="radio" + aria-checked inside role="radiogroup" aria-label="Size".
- * (controls.ts already has optionGroup(), which renders exactly that.)
- */
-function legacySizeChips(product: Product): string {
-  const sizes = attributeValues(product, 'size');
-  if (sizes.length === 0) return '';
-  const initial = sizes.find((s) => valueInStock(product, 'size', s)) ?? sizes[0]!;
-  const chips = sizes
-    .map((s) => {
-      const cls = `chip${s === initial ? ' selected' : ''}${valueInStock(product, 'size', s) ? '' : ' sold-out'}`;
-      return `<div class="${cls}" data-size="${esc(s)}">${esc(s)}</div>`;
-    })
-    .join('');
-  return `
-    <div class="option-row">
-      <span class="option-label">Size</span>
-      <div class="size-picker">${chips}</div>
-      <input type="hidden" name="size" value="${esc(initial)}">
-    </div>
-    <script>
-    // Chip picker wiring (mouse only - part of DEMO BUG A).
-    document.querySelectorAll('.size-picker .chip:not(.sold-out)').forEach((chip) => {
-      chip.addEventListener('click', () => {
-        document.querySelectorAll('.size-picker .chip').forEach((c) => c.classList.remove('selected'));
-        chip.classList.add('selected');
-        document.querySelector('input[name=size]').value = chip.dataset.size;
-      });
-    });
-    </script>`;
-}
-
 /** Standard two-column product page used by every template except `feature`. */
 function productShell(product: Product, controls: string): string {
   return `
@@ -119,10 +80,10 @@
 export function productPage(product: Product): string {
   let page: string;
   switch (product.template) {
-    case 'classic': // hoodies: legacy chip size picker (DEMO BUG A)
+    case 'classic': // hoodies
       page = productShell(
         product,
-        legacySizeChips(product) + remainingOptions(product, ['size']) + quantityInput(),
+        optionGroup(product, 'size') + remainingOptions(product, ['size']) + quantityInput(),
       );
       break;
     case 'apparel': // crewneck: color swatches (DEMO BUG C)
```
<!-- prettier-ignore-end -->

The patch replaces `legacySizeChips(product)` with `optionGroup(product, 'size')` and deletes the dead chip code. The pill styling comes from `.choice` in `store.css`, so the page looks the same to a human.

**After the fix:**

<!-- prettier-ignore-start -->
```yaml
- group "Size":
  - radio "S" [checked]
  - radio "M"
  - radio "L"
```
<!-- prettier-ignore-end -->

Alpha checks `radio:M`, clicks `button:Add to cart` and reaches checkout. The cart is `HOODIE-001-M x1 $49`, and every checkpoint passes.

Bug B is unaffected by this fix: the form path never touches the legacy id map.

---

## Bug B: legacy variant map on the agent API

| Field         | Value                                                                                                         |
| ------------- | ------------------------------------------------------------------------------------------------------------- |
| Product       | Black Hoodie variant `HOODIE-001-M`, via `POST /api/cart` only                                                |
| Agents hit    | Gamma. Humans and browser agents never take this path.                                                        |
| Category      | `product_data_inconsistency`                                                                                  |
| Source        | `apps/storefront/src/cart.ts:32-34` (`LEGACY_VARIANT_MAP`), applied in `server.ts:127-136` (`POST /api/cart`) |
| Reference fix | [`patches/bug-b-legacy-variant-map.patch`](patches/bug-b-legacy-variant-map.patch)                            |

**Mission:** the same hoodie mission as Bug A, run by Agent Gamma.

**Reproduce (structured agent):**

1. `GET /api/catalog.json` lists `HOODIE-001-M` with `{ color: black, size: M }` at $49.
2. `POST /api/cart {"variantId":"HOODIE-001-M","quantity":1}` returns 200.
3. `GET /api/cart`: **cart `HOODIE-001-S x1 $49`**.

**Why humans never see it:** `POST /cart/add` (the product page form) resolves the variant from the posted option values and adds the real id directly. Only `POST /api/cart` passes ids through `resolveVariantId()`.

**Expected verification (Gamma):**

- `catalog_variant_resolves` fails: the catalog says M, the cart has S.
- `cart_matches_variant` fails: size required "M", cart has "S".

**Diagnosis:**

- **observed:** "Catalog variant HOODIE-001-M (size M). POST /api/cart with that id returned 200, but the cart line is HOODIE-001-S (size S). Adding size M through the product page form yields HOODIE-001-M."
- **inferredCause:** "The cart API resolves incoming ids through `LEGACY_VARIANT_MAP` in cart.ts, which maps HOODIE-001-M to HOODIE-001-S. The HTML form path bypasses the map, so only API clients are affected."
- **suggestedRepair:** "Remove the stale HOODIE-001-M entry."
- **suspectedFiles:** `apps/storefront/src/cart.ts`
- **confidence:** high

**Fix:**

<!-- prettier-ignore-start -->
```diff
--- a/apps/storefront/src/cart.ts
+++ b/apps/storefront/src/cart.ts
@@ -29,9 +29,7 @@
  * The expected repair deletes this map (or fixes the M entry). Keep the marker comment
  * so the diagnostics package can locate it.
  */
-const LEGACY_VARIANT_MAP: Record<string, string> = {
-  'HOODIE-001-M': 'HOODIE-001-S', // BUG: should be HOODIE-001-M
-};
+const LEGACY_VARIANT_MAP: Record<string, string> = {};
 
 export function resolveVariantId(requested: string): string {
   return LEGACY_VARIANT_MAP[requested] ?? requested;
```
<!-- prettier-ignore-end -->

**After the fix:** `POST /api/cart {"variantId":"HOODIE-001-M"}` gives cart `HOODIE-001-M x1 $49`.

---

## Bug C: swatch names do not match swatch colors

| Field         | Value                                                                                                                 |
| ------------- | --------------------------------------------------------------------------------------------------------------------- |
| Product       | Crewneck Sweatshirt, `/products/crewneck-sweatshirt` (`CREW-001`)                                                     |
| Agents hit    | Alpha. Beta and humans pick by color and succeed.                                                                     |
| Category      | `semantic_interface_problem`                                                                                          |
| Source        | `apps/storefront/src/swatches.ts:33` (the name comes from `labels[i]`); data in `catalog.ts:120-122` (`swatchLabels`) |
| Reference fix | [`patches/bug-c-swatch-labels.patch`](patches/bug-c-swatch-labels.patch)                                              |

This bug is the opposite of A, D and E. The agent can operate every control, and it confidently picks the wrong one. Nothing fails until the verifier checks the cart.

**Mission:** `Find the crewneck sweatshirt in navy, size L, for under $70, add it to the cart, and reach checkout. Do not place the order.`

```json
{
  "product": "crewneck sweatshirt",
  "category": "apparel",
  "attributes": { "color": "navy", "size": "L" },
  "quantity": 1,
  "maxUnitPrice": 70,
  "successMilestone": "checkout_review"
}
```

**Reproduce (semantic agent):**

1. Click `link:Crewneck Sweatshirt` (ok).
2. Check `radio:Navy` (ok). This is the second swatch, whose fill and value are forest green.
3. Check `radio:L` (ok).
4. Click `button:Add to cart` (ok), then `link:Proceed to checkout` (ok).
5. **Cart:** `CREW-001-FOR-L x1 $58` (color forest).

**What Alpha sees:**

<!-- prettier-ignore-start -->
```yaml
- group "Color":
  - radio "Forest"
  - radio "Navy"
  - radio "Oatmeal"
```
<!-- prettier-ignore-end -->

The swatches render left to right as navy, forest, oatmeal. Their names say Forest, Navy, Oatmeal.

**What a human sees:** three color circles: dark blue, green and beige. Clicking the blue one plus L gives `CREW-001-NVY-L`. This was verified by clicking the swatch whose computed fill is navy.

**Expected verification (Alpha):**

- `correct_color_identified` fails: required "navy", observed "forest".
- `cart_matches_variant` fails: color required "navy", cart has "forest".
- Everything else passes: size L, quantity 1, $58 ≤ $70, checkout reached.

**Diagnosis:**

- **observed:** "Agent checked the radio named 'Navy' and the size L radio; both actions succeeded. Cart contains CREW-001-FOR-L (color forest); mission required navy. The aria snapshot lists color radios in the order Forest, Navy, Oatmeal."
- **inferredCause:** "colorSwatches() in swatches.ts takes each swatch's value and fill from the variant colors (navy, forest, oatmeal) but takes its aria-label from `product.swatchLabels[i]`, a separate list matched by position. In catalog.ts that list is ['Forest', 'Navy', 'Oatmeal'], so the first two accessible names are swapped. Sighted users choose by color and never see the name."
- **suggestedRepair:** "Derive the accessible name from the swatch's own color value, and remove the positional `swatchLabels` list."
- **suspectedFiles:** `apps/storefront/src/swatches.ts`, `apps/storefront/src/catalog.ts`
- **confidence:** high

**Fix:**

<!-- prettier-ignore-start -->
```diff
--- a/apps/storefront/src/catalog.ts
+++ b/apps/storefront/src/catalog.ts
@@ -33,8 +33,6 @@
   basePrice: number;
   template: ProductTemplate;
   variants: Variant[];
-  /** Display names for color swatches, by swatch position (apparel template). */
-  swatchLabels?: string[];
   /** Spec table rows (feature template). */
   specs?: Record<string, string>;
 }
@@ -117,9 +115,6 @@
         inStock: false,
       },
     ],
-    // DEMO BUG C (data half). Copied from the spring merch sheet, which listed Forest first.
-    // The swatches render in variant order (navy, forest, oatmeal), so the first two names are swapped.
-    swatchLabels: ['Forest', 'Navy', 'Oatmeal'],
   },
   {
     id: 'SOCK-001',
--- a/apps/storefront/src/swatches.ts
+++ b/apps/storefront/src/swatches.ts
@@ -14,23 +14,16 @@
 
 /**
  * Color picker for the apparel template: a row of round swatches, one radio input per color.
- * No color is preselected; the shopper has to pick one.
- *
- * DEMO BUG C ("Mislabelled swatches").
- * Each swatch's value and fill come from the variant data, but its accessible name comes from
- * product.swatchLabels[i], a hand-maintained display-name list matched by position. The two lists
- * are in different orders (see catalog.ts), so the navy swatch is announced as "Forest" and the
- * forest swatch as "Navy". Sighted shoppers pick by color and never see the name. An agent that
- * checks the radio named "Navy" gets the forest green sweatshirt.
+ * No color is preselected; the shopper has to pick one. Value, fill, and accessible name all
+ * come from the same variant color, so they cannot drift apart.
  */
 export function colorSwatches(product: Product): string {
   const colors = attributeValues(product, 'color');
-  const labels = product.swatchLabels ?? [];
   const swatches = colors
     .map(
-      (color, i) => `
+      (color) => `
         <label class="swatch" style="--swatch: ${SWATCH_HEX[color] ?? '#cccccc'}">
-          <input type="radio" name="color" value="${esc(color)}" aria-label="${esc(labels[i] ?? titleCase(color))}" required>
+          <input type="radio" name="color" value="${esc(color)}" aria-label="${esc(titleCase(color))}" required>
         </label>`,
     )
     .join('');
```
<!-- prettier-ignore-end -->

Reordering the array to `['Navy', 'Forest', 'Oatmeal']` would also make this mission pass. It is the wrong fix: the name would still be matched by position and would break again the next time someone reorders the variants. The reference fix removes the second source of truth.

**After the fix:**

<!-- prettier-ignore-start -->
```yaml
- group "Color":
  - radio "Navy"
  - radio "Forest"
  - radio "Oatmeal"
```
<!-- prettier-ignore-end -->

Alpha checks `radio:Navy` and `radio:L`. The cart is `CREW-001-NVY-L x1 $58`, and every checkpoint passes.

---

## Bug D: icon-only quantity stepper

| Field         | Value                                                                                |
| ------------- | ------------------------------------------------------------------------------------ |
| Product       | Merino Crew Socks, `/products/merino-socks` (`SOCK-001`)                             |
| Agents hit    | Alpha. Beta and humans click `+` and succeed.                                        |
| Category      | `semantic_interface_problem`                                                         |
| Source        | `apps/storefront/src/quantity-stepper.ts:18-22` (markup); the icons are at lines 1-2 |
| Reference fix | [`patches/bug-d-quantity-stepper.patch`](patches/bug-d-quantity-stepper.patch)       |

**Mission:** `Add 3 pairs of the merino crew socks in size M to the cart and reach checkout. Do not place the order.`

```json
{
  "product": "merino crew socks",
  "category": "accessories",
  "attributes": { "size": "M" },
  "quantity": 3,
  "successMilestone": "checkout_review"
}
```

**Reproduce (semantic agent):**

1. Click `link:Merino Crew Socks` (ok).
2. Check `radio:M` (ok).
3. Set quantity to 3. `spinbutton:Quantity` is missing (there is no input to type into), and so is `button:Increase quantity`. The page has two buttons with no accessible name, and the agent cannot tell which one is "+".
4. Click `button:Add to cart` (ok). The hidden `quantity` input is still 1.
5. Click `link:Proceed to checkout` (ok).
6. **Cart:** `SOCK-001-M x1 $14`.

**What Alpha sees:**

<!-- prettier-ignore-start -->
```yaml
- text: Quantity
- button:
  - img
- text: "1"
- button:
  - img
- button "Add to cart"
```
<!-- prettier-ignore-end -->

**What a human sees:** a pill reading "− 1 +". Clicking `+` twice shows 3, and the cart gets `SOCK-001-M x3`.

**Expected verification (Alpha):**

- `cart_quantity_correct` fails: required 3, cart has 1.
- Everything else passes: size M, no budget constraint, checkout reached.

**Diagnosis:**

- **observed:** "Agent looked for a Quantity field and an 'Increase quantity' button; neither existed. The snapshot shows two buttons with no accessible name around the text '1'. Cart quantity is 1; mission required 3."
- **inferredCause:** "quantityStepper() in quantity-stepper.ts renders the − and + buttons with only inline SVG icons (no text, aria-label or `<title>`), and shows the count in a plain `<span>`. The submitted value is a hidden input. A semantic agent has no named control for quantity."
- **suggestedRepair:** "Give the buttons aria-labels ('Decrease quantity' / 'Increase quantity'), mark the SVGs aria-hidden, and expose the count as an `<output>` inside a group labelled Quantity."
- **suspectedFiles:** `apps/storefront/src/quantity-stepper.ts`
- **confidence:** high

**Fix:**

<!-- prettier-ignore-start -->
```diff
--- a/apps/storefront/src/quantity-stepper.ts
+++ b/apps/storefront/src/quantity-stepper.ts
@@ -1,24 +1,19 @@
-const MINUS_ICON = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 12h14"/></svg>`;
-const PLUS_ICON = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>`;
+const MINUS_ICON = `<svg aria-hidden="true" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 12h14"/></svg>`;
+const PLUS_ICON = `<svg aria-hidden="true" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>`;
 
 /**
  * Quantity control for the essentials template: "− 1 +".
- *
- * DEMO BUG D ("Icon-only quantity stepper").
- * The two buttons contain only SVG icons, with no text, aria-label, or <title>, so they have no
- * accessible name. The count is a plain <span>, and the value the form submits is a hidden input.
- * Sighted shoppers see minus and plus signs and click. An agent reading the accessibility tree sees
- * two nameless buttons next to the text "1" and no labelled field it can type into, so it cannot
- * set a quantity and adds a single pair.
+ * The buttons are named for what they do, the icons are hidden from assistive tech, and the
+ * count is an <output> inside a group labelled "Quantity", announced when it changes.
  */
 export function quantityStepper(max = 10): string {
   return `
     <div class="option-row">
-      <span class="option-label">Quantity</span>
-      <div class="stepper" data-stepper data-max="${max}">
-        <button type="button" class="stepper-btn" data-step="-1">${MINUS_ICON}</button>
-        <span class="stepper-value" data-stepper-value>1</span>
-        <button type="button" class="stepper-btn" data-step="1">${PLUS_ICON}</button>
+      <span class="option-label" id="qty-label">Quantity</span>
+      <div class="stepper" role="group" aria-labelledby="qty-label" data-stepper data-max="${max}">
+        <button type="button" class="stepper-btn" data-step="-1" aria-label="Decrease quantity">${MINUS_ICON}</button>
+        <output class="stepper-value" aria-live="polite" data-stepper-value>1</output>
+        <button type="button" class="stepper-btn" data-step="1" aria-label="Increase quantity">${PLUS_ICON}</button>
         <input type="hidden" name="quantity" value="1">
       </div>
     </div>
```
<!-- prettier-ignore-end -->

**After the fix:**

<!-- prettier-ignore-start -->
```yaml
- group "Quantity":
  - button "Decrease quantity"
  - status: "1"
  - button "Increase quantity"
```
<!-- prettier-ignore-end -->

Alpha clicks `button:Increase quantity` twice. The status reads 3. The cart is `SOCK-001-M x3 $42`, and every checkpoint passes.

**Also acceptable:** replace the `<span>` count with a labelled `<input type="number">` so the agent can type the quantity. It is more robust, but it is a bigger diff because it needs CSS to keep the pill look.

**Known workaround:** an agent that adds one pair three times, returning to the product page each time, also ends with quantity 3, because the cart merges identical lines. If a demo run does that, it is a legitimate pass. It also takes many more steps, which the step log will show.

---

## Bug E: buy box hidden from the accessibility tree

| Field         | Value                                                                                             |
| ------------- | ------------------------------------------------------------------------------------------------- |
| Product       | Studio Headphones, `/products/studio-headphones` (`HP-100`)                                       |
| Agents hit    | Alpha. Beta and humans see and use the buy box.                                                   |
| Category      | `semantic_interface_problem`                                                                      |
| Source        | `apps/storefront/src/feature-layout.ts:26` (`<section class="feature-stage" aria-hidden="true">`) |
| Reference fix | [`patches/bug-e-hidden-buy-box.patch`](patches/bug-e-hidden-buy-box.patch)                        |

**Mission:** `Find the studio headphones, wired, under $100, add them to the cart, and reach checkout. Do not place the order.`

```json
{
  "product": "studio headphones",
  "category": "audio",
  "attributes": { "connectivity": "wired" },
  "quantity": 1,
  "maxUnitPrice": 100,
  "successMilestone": "checkout_review"
}
```

**Reproduce (semantic agent):**

1. Click `link:Studio Headphones` (ok).
2. Check `radio:Wired`. It is not in the accessibility tree.
3. Click `button:Add to cart`. It is not in the accessibility tree.
4. The agent should `fail`: the page has a heading, a description and specs, but no price, no options and no way to buy.
5. **Cart:** empty. `/checkout` redirects to `/cart` when the cart is empty.

**What Alpha sees (all of `main`):**

<!-- prettier-ignore-start -->
```yaml
- navigation "Breadcrumb": ...
- paragraph: Audio
- heading "Studio Headphones" [level=1]
- paragraph: Closed-back over-ear headphones. Wired or wireless.
- region "Specs":
  - heading "Specs" [level=2]
  - term: Drivers
  - definition: 40 mm dynamic
  ...
```
<!-- prettier-ignore-end -->

**What a human sees:** a dark hero panel with a white buy box showing $89.00, Wired/Wireless pills, quantity and "Add to cart". Clicking them gives `HP-100-WIRED x1`.

**Expected verification (Alpha):**

- `product_discovered` passes.
- `added_to_cart` fails: the cart is empty.
- `cart_matches_variant`, `cart_quantity_correct` and `price_within_budget` are `not_tested`.
- `checkout_review_reached` fails.

**Diagnosis:**

- **observed:** "The product page heading and specs were present in the accessibility tree, but no price, connectivity option or Add to cart button. Agent could not add the item; cart is empty. A screenshot of the same page shows the buy box."
- **inferredCause:** "featureLayout() in feature-layout.ts wraps both the decorative art and the buy form in `<section class="feature-stage" aria-hidden="true">`. aria-hidden removes the whole subtree, form included, from the accessibility tree while leaving it visible and clickable."
- **suggestedRepair:** "Move aria-hidden from the stage to the decorative `.feature-art` element only."
- **suspectedFiles:** `apps/storefront/src/feature-layout.ts`
- **confidence:** high

**Fix:**

<!-- prettier-ignore-start -->
```diff
--- a/apps/storefront/src/feature-layout.ts
+++ b/apps/storefront/src/feature-layout.ts
@@ -4,13 +4,7 @@
 /**
  * Page template for featured hardware (audio): a large art stage with the buy box floating
  * over it, followed by a spec table.
- *
- * DEMO BUG E ("Buy box inside an aria-hidden stage").
- * The stage was marked aria-hidden="true" back when it only held decorative artwork. The buy box
- * (price, options, Add to cart) was later moved inside it so it could sit on top of the art.
- * aria-hidden removes the whole subtree from the accessibility tree but changes nothing on screen,
- * so sighted shoppers can still see and click everything. An agent reading the tree finds the
- * heading and the specs and no way to buy.
+ * Only the artwork is aria-hidden; the buy box stays in the accessibility tree.
  */
 export function featureLayout(product: Product, buyForm: string): string {
   const specs = Object.entries(product.specs ?? {})
@@ -23,8 +17,8 @@
   <h1>${esc(product.name)}</h1>
   <p class="lede">${esc(product.description)}</p>
 </header>
-<section class="feature-stage" aria-hidden="true">
-  <div class="feature-art">${productImage(product.slug, '', { className: 'large', placeholder: product.name })}</div>
+<section class="feature-stage">
+  <div class="feature-art" aria-hidden="true">${productImage(product.slug, '', { className: 'large', placeholder: product.name })}</div>
   <div class="feature-buy">${buyForm}</div>
 </section>
 <section class="feature-specs" aria-labelledby="specs-heading">
```
<!-- prettier-ignore-end -->

**After the fix:** the buy box appears in the tree as `paragraph: $89.00`, `group "Connectivity"` (`radio "Wired" [checked]`, `radio "Wireless"`), `spinbutton "Quantity"` and `button "Add to cart"`. Alpha checks `radio:Wired`, adds to cart and reaches checkout. The cart is `HP-100-WIRED x1 $89`, and every checkpoint passes.

### Not a bug: wireless headphones over budget (spec example C)

The headphones are advertised "from $89", and the wireless variant costs $119. A mission like `Find wireless studio headphones under $100` has no valid answer, so the correct agent outcome is `fail`.

Once Bug E is fixed, an agent that adds the wireless variant anyway fails `price_within_budget` ($119 > $100). This tests the verifier's arithmetic, not the store, so it has no patch.

---

## Applying and reverting fixes

```bash
git apply --check docs/storefront/patches/bug-a-size-picker.patch   # dry run
git apply docs/storefront/patches/bug-a-size-picker.patch           # fix A
git apply -R docs/storefront/patches/bug-a-size-picker.patch        # put bug A back
```

- **Applying them together:** all five patches apply independently and in any combination.
- **Typecheck and format:** the fully fixed tree passes `pnpm --filter @agentproof/storefront typecheck` and `prettier --check`.
- **Reloading:** `tsx watch` restarts the store on each change.
- **Resetting:** once this storefront is committed, `git checkout apps/storefront` restores every bug at once. Until then, use `git apply -R`.

The patches are also the fallback in the WORKPLAN cut list ("hand-write the two diffs, keep the apply flow"). They are real, minimal diffs, so `applyRepair()` can be tested against them before `proposeRepair()` exists.

## Product images

Photos are optional. Every page shows a labelled placeholder tile until one exists, and none of the bugs depend on images. Drop files into `apps/storefront/public/images/` using these names (`.jpg`, `.png` and `.webp` are all accepted, and no restart is needed):

| File                              | Shows                                        | Notes                                                                 |
| --------------------------------- | -------------------------------------------- | --------------------------------------------------------------------- |
| `black-hoodie.jpg`                | Plain black pullover hoodie, front           | Square, plain light background                                        |
| `grey-hoodie.jpg`                 | Heather grey pullover hoodie, front          | Same framing as the black one                                         |
| `crewneck-sweatshirt.jpg`         | Crewneck sweatshirt (navy is a good default) | Shown before a color is picked                                        |
| `crewneck-sweatshirt-navy.jpg`    | Navy crewneck                                | Optional; swaps in when the navy swatch is picked                     |
| `crewneck-sweatshirt-forest.jpg`  | Forest green crewneck                        | Optional                                                              |
| `crewneck-sweatshirt-oatmeal.jpg` | Oatmeal / cream crewneck                     | Optional                                                              |
| `merino-socks.jpg`                | A pair of charcoal crew socks                | Square                                                                |
| `studio-headphones.jpg`           | Over-ear headphones, black                   | Sits on a dark panel: a transparent PNG or dark background looks best |
| `canvas-tote.jpg`                 | Natural (off-white) canvas tote bag          | Square                                                                |

Unsplash or Pexels photos are fine (free license). Use about 1000×1000 px, under 300 KB each. The images do not affect the semantic tree, because alt text comes from the product name. They do help Agent Beta and the demo video.
