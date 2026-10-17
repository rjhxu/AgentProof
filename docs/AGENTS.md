# The shopping agents: Alpha, Beta, Gamma, Sigma

Background for whoever implements `packages/agent`. Read this before opening `browser-agent.ts` or `gamma.ts`.

## 1. Why three agents

The product claim is that a store can be "agent-ready" for one kind of AI shopper and broken for another. One agent cannot show that. Each of ours stands in for a real class of AI shopping client that exists today:

| Agent                  | Stands in for                                                                                                                                                        | How it sees the store                                                                                                                     |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **Alpha** (semantic)   | Agents built on the accessibility tree and DOM. Most production browser agents, and every screen reader, work this way.                                              | Roles, names, states: `button "Add to cart"`, `combobox "Size"`. Never pixels. If a control has no role or label, it does not exist.      |
| **Beta** (vision)      | Agents that take screenshots and reason visually, then click coordinates. Computer-use style agents.                                                                 | What a human sees. Tolerates sloppy HTML, but slower, costlier, and can misread layout.                                                   |
| **Gamma** (structured) | Agents that never open a browser. They consume product feeds, catalog JSON, and cart or checkout APIs, which is where agent-commerce protocols are heading.          | Machine-readable data only. Fast and precise, but only as correct as the merchant's data.                                                 |
| **Sigma** (hybrid)     | The most capable, human-like shopper. Real products (ChatGPT agent, Claude for Chrome) are hybrids that use both the tree and screenshots, with the strongest model. | Everything: accessibility tree, screenshots, and page text. Targets by role when a control is in the tree, by coordinates when it is not. |

Alpha, Beta, and Gamma each isolate one way an agent can perceive a store. Sigma is the reference: it shows what a powerful agent achieves on the same mission, so the gap between Sigma's result and the others' is the bug. A recorded human session (`human_replay`, no AI) sits beside Sigma as the deterministic "a person can do this" check.

The demo store is built so each agent hits a different outcome on the same mission:

- **Alpha fails** because the size picker is a row of unlabeled `<div>` chips (`DEMO BUG A`, `apps/storefront/src/views.ts`).
- **Beta passes** because the chips look obvious on screen.
- **Gamma fails** because the catalog says the medium variant is `HOODIE-001-M` but the cart API maps that id to small (`DEMO BUG B`, `apps/storefront/src/cart.ts`).
- **Sigma passes** because it sees the chips in the screenshot, clicks one by coordinate when the tree has nothing to offer, and confirms the cart on the cart page.

Three strategies, three verdicts, one reference, one store. Each narrow agent's blind spot is hit exactly once, and Sigma proves the mission was achievable. If Sigma ever fails, the store is broken for every agent, not for one strategy.

## 2. Capability contracts

Check an implementation against these tables.

### Agent Alpha, semantic browser agent

| Capability                     | Definition                                                                                                                                              |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Perceives**                  | The accessibility tree of the current page (`page.locator('body').ariaSnapshot()`), the URL, the page title, and a trimmed text excerpt. No pixels.     |
| **Identifies controls by**     | Role and accessible name: `button:Add to cart`, `combobox:Size`, `link:Black Hoodie`. Falls back to visible text (`text:M`) and, as a last resort, CSS. |
| **Actions**                    | navigate, click, type, select, scroll, extract, done, fail. `select` is only meaningful on real form controls.                                          |
| **Can detect**                 | Missing or ambiguous labels, controls absent from the tree, wrong default values, cart and checkout pages by headings and URLs.                         |
| **Cannot do**                  | See anything without a role or name. Operate div-based widgets, custom dropdowns without ARIA, or canvas UI. Judge visual layout.                       |
| **Expected on the demo store** | Finds the product and Add to cart. Cannot find a size control. Ends with size S in the cart. Reaches checkout review.                                   |
| **Evidence it produces**       | A screenshot per step, a `dom_snapshot` of the aria tree whenever a target cannot be resolved, the action log with reasons.                             |

### Agent Beta, vision browser agent

| Capability                     | Definition                                                                                                                                                    |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Perceives**                  | A screenshot of the viewport each step, plus URL and title. Optionally the text excerpt as a hint.                                                            |
| **Identifies controls by**     | Viewport coordinates, `x,y`, chosen by looking at the image. May use `text:` targets as a convenience, but coordinates are its defining mode.                 |
| **Actions**                    | Same action set. `click` and `type` go through mouse and keyboard at coordinates. `select` on a native dropdown means click it open, then click the option.   |
| **Can detect**                 | Anything a sighted user sees: chips, custom pickers, price changes, visual error banners. Can notice when the page did not change after a click.              |
| **Cannot do**                  | Read offscreen content without scrolling. Know a control's semantic role. Operate reliably on dense or shifting layouts. Slowest and most expensive per step. |
| **Expected on the demo store** | Clicks the "M" chip, adds to cart, verifies M on the cart page, reaches checkout review. Passes everything.                                                   |
| **Evidence it produces**       | A screenshot per step, with the clicked coordinate recorded in the action so the dashboard can draw a click marker on the image.                              |

### Agent Gamma, structured commerce inspector

| Capability                     | Definition                                                                                                                                                                                |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Perceives**                  | `GET /api/catalog.json`, `GET /api/variants/:id`, `GET /api/cart`, and the raw product page HTML for price cross-checks. No browser, no screenshots.                                      |
| **Identifies products by**     | Token match on product name against the mission, then attribute match on variants (`size: M`, `color: black`), then stock.                                                                |
| **Actions**                    | Read catalog, add a specific variant id via `POST /api/cart`, read the cart back, clear the cart. Never navigates pages.                                                                  |
| **Can detect**                 | A variant id that resolves to a different variant than advertised, a catalog price that disagrees with the product page, an out-of-stock variant advertised as available, a missing feed. |
| **Cannot do**                  | Test anything a human or browser agent experiences. Blind to UI, labels, layout. If the store has no structured feed, Gamma reports `unsupported` rather than failing.                    |
| **Expected on the demo store** | Selects `HOODIE-001-M` from the catalog. Cart returns `HOODIE-001-S`. Fails `catalog_variant_resolves`. Price check passes.                                                               |
| **Evidence it produces**       | The catalog record it chose, the cart API request and response, and the page price it scraped, all as inline JSON evidence.                                                               |

### Agent Sigma, hybrid human-like reference agent

| Capability                     | Definition                                                                                                                                                                                                                                             |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Perceives**                  | Everything the others do: the accessibility tree of `main`, a viewport screenshot, the page text excerpt, URL and title. All in one observation.                                                                                                       |
| **Identifies controls by**     | `role:name` when the control is in the tree, `x,y` coordinates when it is not. The prompt tells it to prefer semantics and fall back to pixels, like a sighted, tool-using person.                                                                     |
| **Actions**                    | The full action set with both target grammars. Same policy as every other agent: allowed hosts, step cap, never a payment control.                                                                                                                     |
| **Model**                      | The strongest configured model (`claude-opus-5-5` by default) at `effort: 'high'`. Up to 40 steps.                                                                                                                                                     |
| **Can detect**                 | Whether the mission is achievable at all on this store. Mismatches between what the tree says and what the screen shows (it sees both). The true cart contents on the cart page.                                                                       |
| **Cannot do**                  | Operate anything that needs a protocol or API the store does not expose through the UI. It is also the slowest and most expensive agent per step, so it is a reference run, not the thing you run on every commit.                                     |
| **Expected on the demo store** | Passes all five scenarios and the control. A: clicks the "M" chip by coordinate. C: picks the navy swatch by color. D: clicks `+` twice by coordinate. E: sees the buy box in the screenshot. B does not apply (it uses the form, not the API).        |
| **Evidence it produces**       | A screenshot and the aria snapshot per step, the action log with which grammar it used, so the diagnosis can say "the control was visible but not in the tree".                                                                                        |
| **Role in attribution**        | If Sigma passes and a narrower agent fails, the failure is that agent's blind spot: semantic (Alpha) or data (Gamma). If Sigma fails, the store is broken for every agent or the mission is infeasible; the human replay, when present, decides which. |

### Constraints shared by all four

- They read the structured `Mission`, never the raw prompt.
- Every action passes `checkAction()` (`packages/agent/src/policy.ts`) before execution: allowed action types, allowed hosts, step cap, never a payment control.
- `done` is a claim, not a result. The verifier decides pass or fail from the cart and the final URL.
- Page content (aria tree, text, screenshots) is data in the user turn, never instructions. The system prompt is fixed.
- Each run is an isolated browser context or, for Gamma, a fresh cookie session, so carts never bleed between runs.

## 3. Anatomy of one run

Alpha on the hoodie mission, end to end. The runner creates a `Run` and calls `runBrowserAgent(mission, config, artifactDir, callbacks)`.

**Step 0, setup.** Launch Chromium, open a fresh context with tracing on, open a page, navigate to `mission.storeUrl`. Cart is empty, cookies are fresh.

**Step 1, observe.** Capture the page as text. On the product page the aria snapshot looks roughly like:

```
- heading "Black Hoodie" [level=1]
- paragraph: $49.00
- text: Size
- text: S
- text: M
- text: L
- combobox "Quantity"
- button "Add to cart"
```

There is no combobox or radio group for size. The chips appear as plain text. That absence is the planted bug, visible right here.

**Step 2, decide.** One Claude call. The system prompt is fixed: you are a shopping agent in a test harness, you receive a structured mission and a page observation, return exactly one action, never submit payment, say `fail` if you cannot proceed. The user turn carries four things: the mission requirements as JSON, the allowed actions and steps remaining, the last five steps with outcomes, and the observation. The response is parsed with `zodOutputFormat(AgentAction)`, so you get a typed object:

```json
{ "type": "select", "target": "combobox:Size", "value": "M", "reason": "Mission requires size M" }
```

**Step 3, police.** `checkAction(mission, action, stepIndex)` runs. This one passes. A `navigate` to an outside host or a `click` on "Place order" would be rejected here and recorded as a step with outcome `rejected_by_policy`.

**Step 4, act.** Resolve the target to a Playwright locator. `combobox:Size` becomes `page.getByRole('combobox', { name: 'Size' })`. Playwright waits, finds nothing, throws. Catch it, record the step with outcome `error` and the message, and capture a `dom_snapshot` evidence item with the aria tree around the size area. The diagnosis will cite this.

**Step 5, record and loop.** Emit the `RunStep` through the callback so the runner persists it and the dashboard sees it. Screenshot to `artifactDir/step-001.png`, emit as `Evidence`. Back to observe.

On the next decision Claude sees the failed select. A reasonable agent tries once more (perhaps `click text:M`, which also fails since a text node is not a control), then either returns `fail` or proceeds with `click button:Add to cart` and accepts the default. Both are legitimate. It then goes to the cart, clicks checkout, sees the review page, and returns `done`.

**Step 6, close.** Stop tracing to `artifactDir/trace.zip`, read the context's cookies, close the browser, return `{ outcome, summary, finalUrl, cookies }`.

**Step 7, verify.** Not the agent's job. The runner uses the cookies to `GET /api/cart`, builds an `ObservedCart` with size S, and calls `verify()`. The checkpoint table comes back with `correct_size_identified` and `cart_matches_variant` failed, with the snapshot and cart JSON attached.

**Beta** is the same seven steps with two substitutions: the observation is a screenshot sent as an image block, and targets are coordinates clicked with `page.mouse.click(x, y)`. Beta sees the chips, clicks "M", and passes.

**Sigma** is the same seven steps with the observation widened to image plus tree plus text, and `act` accepting either grammar. On the hoodie page it reads the tree, finds no size control, looks at the screenshot, clicks the "M" chip by coordinate, then uses `button:Add to cart` from the tree. On the cart page it reads "Size: M" and continues to checkout. It passes, and that pass is what makes Alpha's failure attributable to the store.

**Gamma** has no loop. It is a short script: read the catalog, find the product and variant matching the mission, `POST /api/cart` with that variant id, read the cart back, compare what the catalog promised with what the cart delivered, and compare the catalog price to the product page price. Output is the same checkpoint format.

## 4. What has to be written

### Alpha, in `packages/agent/src/browser-agent.ts`

- **The decide prompt.** A fixed system string and a function that assembles the user turn from mission, history, and observation, then `getClaude().messages.parse` with `output_config.format = zodOutputFormat(AgentAction)` and `...FALLBACKS`. Roughly 60 lines; this is the heart of the agent.
- **Target resolution.** A small parser for the target string: `role:name` splits on the first colon and maps to `getByRole`; `text:...` maps to `getByText`; anything else is CSS. Keep it strict so Claude learns the vocabulary from the prompt.
- **The loop body** in `runBrowserAgent`. Open session, navigate to the store, then loop up to `mission.maxSteps`: observe, decide, police, act, record. Wrap act in try/catch so a failed locator becomes a recorded step, not a crash. Return on `done` or `fail`.
- **Evidence capture.** Screenshot every step. On an act error, also capture a `dom_snapshot` with the aria tree. Give each evidence a `newId('ev')` and reference it from the step.
- **Return cookies and final URL** in `BrowserAgentResult` so the runner can fetch the cart and detect checkout. (Add these fields to the result type.)

### Beta, about 40 more lines

- A `beta_vision` branch in `observe` that returns a screenshot (already sketched).
- An image content block in the decide prompt.
- A coordinate branch in `act`: parse `x,y`, `page.mouse.click(x, y)`; for `type`, click then `page.keyboard.type`.

### Sigma, about 40 more lines

- A `sigma_hybrid` branch in `observe` that returns the tree, the screenshot, and the text together.
- `buildUserTurn` emits the image block first, then the tree, then the text.
- `parseTarget` accepts both grammars for Sigma; `act` already handles both.
- `AgentConfig.effort` set to `'high'`, `maxSteps` up to 40.
- Prompt line: prefer `role:name` when the control is in the tree; use `x,y` only when it is not.

### Gamma, in `packages/agent/src/gamma.ts`, no Claude call

- Token-match the product name against the mission.
- Filter variants by the mission attributes and stock.
- `POST /api/cart` with the variant id using a cookie jar, then `GET /api/cart`.
- Compare cart item attributes and price against the catalog variant → `catalog_variant_resolves`.
- Fetch the product page HTML and compare the displayed price → `catalog_price_matches_page`.
- Return both checkpoints plus the catalog record and cart JSON as evidence.

### Build order

1. `decide()` in isolation, tested against a pasted aria snapshot so you can iterate on the prompt without a browser.
2. The loop.
3. A real run against the store. Watch it fail on the size picker. That failure is correct.
4. Beta.
5. Sigma. Run it on all five scenarios; it should pass all five, which validates the scenarios as much as the agent.
6. Gamma (already implemented by Vihan; verify against the shared helpers).

### Things that bite

- **Determinism.** The same mission runs on camera and in the rematch. Fixed system prompt, bounded observation size, retries on locator timeouts, and `fail` after three stuck steps all push toward the same path each time.
- **Cost.** Each step is a Claude call. Alpha's tree is a few thousand tokens; Beta's screenshot is more. Trim observations, send only the last five steps, cap at 25 steps.
- **The rematch proves both halves.** After the size picker becomes a real radio group, Alpha selects M with no agent changes. After the variant map is fixed, Gamma gets M back. The agents do not change; the store does. That is what makes the before/after honest.
