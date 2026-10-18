# The shopping agents: Alpha, Beta, Gamma, Sigma

What the agents in `packages/agent` are, how each one perceives the store, and what it produces. This describes the code on `main` as of 2026-10-18. What the agents did live, on the bugged and the fixed store, is in [RESULTS.md](./RESULTS.md); the five planted bugs and their expected results are in [storefront/bugs-and-fixes.md](./storefront/bugs-and-fixes.md); the decisions behind the design are in section 9.

## 1. Why four agents

The product claim is that a store can be "agent-ready" for one kind of AI shopper and broken for another. One agent cannot show that. Each of ours stands in for a real class of AI shopping client:

| Agent                  | Stands in for                                                                                                                                               | How it sees the store                                                                                                                     |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **Alpha** (semantic)   | Agents built on the accessibility tree and DOM. Most production browser agents, and every screen reader, work this way.                                     | Roles, names, states: `button "Add to cart"`, `combobox "Size"`. Never pixels. If a control has no role or label, it does not exist.      |
| **Beta** (vision)      | Agents that take screenshots and reason visually, then click coordinates. Computer-use style agents.                                                        | What a human sees. Tolerates sloppy HTML, but slower, costlier, and can misread layout.                                                   |
| **Gamma** (structured) | Agents that never open a browser. They consume product feeds, catalog JSON, and cart or checkout APIs, which is where agent-commerce protocols are heading. | Machine-readable data only. Fast and precise, but only as correct as the merchant's data.                                                 |
| **Sigma** (hybrid)     | The most capable, human-like shopper. Real products (ChatGPT agent, Claude for Chrome) are hybrids that use both the tree and screenshots.                  | Everything: accessibility tree, screenshots, and page text. Targets by role when a control is in the tree, by coordinates when it is not. |

Alpha, Beta, and Gamma each isolate one way an agent can perceive a store. Real browser agents are hybrids; Alpha and Beta are a deliberate decomposition of one. Sigma is the reference: it shows what a powerful agent achieves on the same mission, so the gap between Sigma's result and the others' is the bug.

The thesis in one line: **a store should be navigable by the cheapest agent.** Alpha runs the cheapest model at low effort on text alone. Beta and Sigma exist to show what stronger, costlier agents achieve on the same store, and every report puts that cost next to the verdict.

The demo store is built so each agent hits a different outcome on the same hoodie mission:

- **Alpha fails** because the size picker is a row of unlabeled `<div>` chips (`DEMO BUG A`, `apps/storefront/src/views.ts`).
- **Beta passes** because the chips look obvious on screen.
- **Gamma fails** because the catalog says the medium variant is `HOODIE-001-M` but the cart API maps that id to small (`DEMO BUG B`, `apps/storefront/src/cart.ts`).
- **Sigma passes** because it sees the chips in the screenshot, clicks one by coordinate when the tree has nothing to offer, and confirms the cart on the cart page.

A recorded human session (`human_replay`) was planned as a second reference and is deferred: Sigma is the reference, and Ryan's grader (`docs/storefront/verify-scenarios.mjs`) already proves a mouse user completes every scenario.

## 2. Capability contracts

### Agent Alpha, semantic browser agent

| Capability                     | Definition                                                                                                                                                                                                                                                                                                                         |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Perceives**                  | The accessibility tree of `main` (`ariaSnapshot()`, falling back to `body`) capped at 6,000 characters, a 2,000-character text excerpt, the URL and the title. No pixels.                                                                                                                                                          |
| **Identifies controls by**     | `role:name` only: an ARIA role from the allowlist in `targets.ts` and the exact accessible name, resolved with `page.getByRole(role, { name, exact: true })`. No text or CSS fallback, by decision: the Bug A snapshot still contains the text "S M L", and a text fallback would click past the bug.                              |
| **Actions**                    | navigate, click, type, select, scroll, extract, done, fail. `select` names the option group (`Size`) and the option's exact accessible name; the harness tries `radio:M`, then `combobox:Size`, then `button:M`, and reports when none exists. Quantity goes through `spinbutton:Quantity` or repeated `button:Increase quantity`. |
| **Can detect**                 | Missing or ambiguous labels, controls absent from the tree, wrong default values, cart and checkout pages by headings and URLs.                                                                                                                                                                                                    |
| **Cannot do**                  | See anything without a role or name. Operate div-based widgets, custom dropdowns without ARIA, or canvas UI. Judge visual layout.                                                                                                                                                                                                  |
| **Expected on the demo store** | A: finds the product and Add to cart, cannot find a size control, ends with size S in the cart, reaches checkout review (`correct_size_identified` and `cart_matches_variant` fail). C: `correct_color_identified`. D: `cart_quantity_correct`. E: `added_to_cart`. Control: passes.                                               |
| **Evidence it produces**       | `step-NNN.png` and `step-NNN.aria.txt` for every step, `trace.zip`, and the step log with the model's reason and the outcome of each action.                                                                                                                                                                                       |

### Agent Beta, vision browser agent

| Capability                     | Definition                                                                                                                                                                                                                                            |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Perceives**                  | A PNG screenshot of the viewport (1280x800 by default) each step, its size in pixels, the URL and the title. Never the tree or the text.                                                                                                              |
| **Identifies controls by**     | `x,y` pixel coordinates inside the screenshot, nothing else.                                                                                                                                                                                          |
| **Actions**                    | The same set minus `select`, which is dropped from its allowed actions (it picks options by clicking them). `click` is `page.mouse.click(x, y)`; `type` clicks, selects all, then types, with line breaks flattened so Enter can never submit a form. |
| **Can detect**                 | Anything a sighted user sees: chips, custom pickers, price changes, visual error banners. Can notice when the page did not change after a click.                                                                                                      |
| **Cannot do**                  | Read offscreen content without scrolling. Know a control's semantic role. Operate reliably on dense or shifting layouts. Slower and costlier per step (image tokens).                                                                                 |
| **Expected on the demo store** | Clicks the "M" chip, adds to cart, verifies M on the cart page, reaches checkout review. Passes everything; confirmed live on A, C, D, E and the control ([RESULTS.md](./RESULTS.md)).                                                                |
| **Evidence it produces**       | `step-NNN.png` per step and `trace.zip`; the clicked coordinate is in the recorded action so a dashboard can draw the click marker on the image.                                                                                                      |

### Agent Gamma, structured commerce inspector

| Capability                     | Definition                                                                                                                                                                                                                |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Perceives**                  | `GET /api/catalog.json`, `POST /api/cart` and `GET /api/cart` in its own cookie session, and the `GET /checkout` HTML for the review heading. No browser, no model.                                                       |
| **Identifies products by**     | Token match on product name against the mission, then attribute match on in-stock variants within the budget.                                                                                                             |
| **Actions**                    | Read the catalog, add the chosen variant id, read the cart back. Never navigates pages.                                                                                                                                   |
| **Can detect**                 | A variant id that resolves to a different variant than advertised, a feed with no matching in-stock variant.                                                                                                              |
| **Cannot do**                  | Test anything a human or browser agent experiences. Blind to UI, labels, layout. `catalog_price_matches_page` is in the checkpoint schema but is not produced yet.                                                        |
| **Expected on the demo store** | Selects `HOODIE-001-M`; the cart returns `HOODIE-001-S`; `catalog_variant_resolves` and `cart_matches_variant` fail. Product, color and size count as identified from the catalog record. Passes C, D, E and the control. |
| **Evidence it produces**       | `catalog_record`, `cart_state` and `network` (checkout response) evidence as inline JSON. Model `none`, cost line zero, so it never skews the cost comparison.                                                            |

### Agent Sigma, hybrid reference agent

| Capability                     | Definition                                                                                                                                                                                                                                             |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Perceives**                  | Everything: the tree of `main`, a viewport screenshot, the text excerpt, URL and title, in one observation (image first, then tree, then text).                                                                                                        |
| **Identifies controls by**     | `role:name` when the control is in the tree; `x,y` when it is only visible, or when the tree's name for a control contradicts the screenshot (Bug C). The prompt asks it to say which grammar it used and why: that mismatch is a finding.             |
| **Actions**                    | The full set with both grammars. `select` never takes `x,y`. Same policy as every other agent.                                                                                                                                                         |
| **Model**                      | The strongest configured model (`grok-4.7` on xAI, `claude-sonnet-5-5` on Anthropic) at `effort: 'high'`. Profile cap 30 steps, bounded by `AGENTPROOF_MAX_STEPS` (default 25) and the mission's own cap.                                              |
| **Can detect**                 | Whether the mission is achievable at all on this store. Mismatches between what the tree says and what the screen shows. The true cart contents on the cart page.                                                                                      |
| **Cannot do**                  | Operate anything that needs a protocol or API the store does not expose through the UI. The most expensive agent per step: a reference run, not the thing you run on every commit.                                                                     |
| **Expected on the demo store** | Passes all five scenarios and the control. A: clicks the "M" chip by coordinate. C: picks the navy swatch by what it looks like. D: clicks `+` by coordinate. E: sees the buy box in the screenshot. B does not apply (it uses the form, not the API). |
| **Role in attribution**        | If Sigma passes and a narrower agent fails, the failure is that agent's blind spot. If Sigma fails, the store is broken for every agent or the mission is infeasible.                                                                                  |

### Constraints shared by all four

- They read the structured `Mission`, never the raw prompt.
- Every action passes `checkAction()` (`policy.ts`) before execution: allowed action types, allowed hosts, step cap, never a payment control (click and type targets, and both halves of a select). For an `x,y` target the loop also reads the text of the element under the point before the mouse moves and refuses it when it reads like a payment control.
- `done` is a claim, not a result. The verifier decides pass or fail from the cart, read through the session cookies, and the final URL.
- Page content (tree, text, screenshot, URL, title) is data in the user turn. The system prompt is fixed per kind and never contains page content.
- Each run is an isolated browser context or, for Gamma, a fresh cookie session, so carts never bleed between runs.

## 3. Anatomy of one run

Alpha on the hoodie mission, end to end. The runner (or the CLI) creates a `Run` and calls `runBrowserAgent(mission, config, artifactDir, callbacks)`.

**Setup.** `resolveRunSettings()` picks the model, effort and step cap from the profile and the environment. Launch Chromium, open a fresh context with tracing on, navigate to `mission.storeUrl`. Cart is empty, cookies are fresh.

**Observe.** A screenshot every step (`step-000.png`, kept as evidence for humans whatever the kind), then what this kind perceives: the aria snapshot of `main` (saved as `step-000.aria.txt`), the text excerpt, and for Beta and Sigma the screenshot as base64. On the product page the snapshot looks roughly like:

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

**Decide.** One `getLlm().complete()` call. The system prompt is fixed per kind. The user turn carries the mission requirements as JSON, the allowed actions and steps remaining, the last five steps with their outcomes, a `RUN SUMMARY` computed over the whole run (steps taken, cart clears, failed attempts per target, so the rules about retries and clears hold even once the steps have scrolled out of the five-step window), and the observation. The provider is asked for strict JSON matching the flat `AgentActionDraft` schema; `toAgentAction()` converts and validates it into a typed `AgentAction`:

```json
{ "type": "select", "target": "Size", "value": "M", "reason": "Mission requires size M" }
```

An unusable reply (no JSON, output truncated at the token cap, a target in the wrong grammar) becomes a step with outcome `invalid_action` and a reason the model reads on its next turn.

**Police.** `checkAction(mission, action, stepIndex)`. This one passes. A `navigate` to an outside host or a click on "Place order" is recorded as a step with outcome `rejected_by_policy`.

**Act.** `select` on `Size` runs the ladder: `radio:M`, `combobox:Size`, `button:M`. None exists, the ladder throws, and the step is recorded with outcome `error` and the message. A plain `click` or `type` on a role target that is absent from the tree fails the same way, at once, with `no button "Add to cart" in the accessibility tree`, instead of waiting out Playwright's action timeout. The prompt's retry rule allows one more attempt at the same target, after which the agent must continue with what the page offers or say `fail`. The loop ends a run as `fail` after five consecutive non-`ok` steps, with a summary that names the last attempted action; the two-attempt rule sits deliberately below that cutoff so Alpha continues, adds size S, and the verifier records the mismatch, which is the documented Bug A result.

**Record.** The `RunStep` (index, URL, action, outcome, detail, this call's usage, evidence ids) goes out through `onStep`, evidence through `onEvidence`, so the runner persists it and the dashboard sees it. Back to observe.

**Close.** Stop tracing to `trace.zip`, read the context's cookies, close the browser. The result carries `outcome` (`done`, `fail`, `step_limit`, `error`), the agent's summary, `finalUrl`, `visitedUrls`, `cookies`, the summed `usage`, the resolved model, provider and effort, steps used and duration. `runBrowserAgent` never throws: a browser or model-client failure comes back as `outcome: 'error'` with the step that hit it recorded.

**Verify.** Not the agent's job. `fetchCartWithCookies()` reads `GET /api/cart` with the session cookies, `verificationInputFromBrowserRun()` derives the product page (a `/products/<slug>` URL whose slug matches the mission product) and checkout (final URL on `/checkout`), and `verify()` returns the checkpoint table with `correct_size_identified` and `cart_matches_variant` failed and the cart JSON attached.

**Report.** `buildAgentReport()` turns the run into an `AgentReport` (section 6), with the narrator's account of the run, written as `report.json` and `report.md` next to the screenshots.

**Beta** is the same loop with the screenshot as the observation and coordinates as targets; the element under the point is checked before the mouse moves, and a mouse click waits up to a second for a navigation to commit so the next screenshot shows the new page. **Sigma** is the same loop with the widened observation and both grammars. **Gamma** has no loop (`gamma.ts`): read the catalog, pick the variant, `POST /api/cart`, read the cart back, compare; `gammaVerification()` in `assess.ts` turns that into evidence and checkpoints.

## 4. Models and cost

Every model call goes through `getLlm()` (`llm.ts`), which has two real adapters and a mock: Anthropic (the team's key, `ANTHROPIC_API_KEY`; strict JSON-schema output through `output_config.format`, effort through `output_config.effort`) and xAI Grok (Responses API with strict JSON-schema output and per-request cost from `usage.cost_in_usd_ticks`; `XAI_API_MODE` and `XAI_BASE_URL` tune the endpoint); `createMockLlm()` scripts responses for tests. The provider is chosen from the environment (`ANTHROPIC_API_KEY`, or `GROK_API_KEY`/`XAI_API_KEY` for xAI, or `AGENTPROOF_LLM_PROVIDER` to force one). Nothing outside `llm.ts` touches a provider.

Cost rule (Zach, 2026-10-17): the cheapest model everywhere, Sonnet for Beta and Sigma. On Anthropic that is `claude-haiku-5-5` for Alpha, the narrator, the mission generator and diagnosis, and `claude-sonnet-5-5` for Beta and Sigma. Nothing defaults to Opus; a test guards it.

Models are tiered in `profiles.ts`, overridable per role with `AGENTPROOF_MODEL_<ALPHA|BETA|SIGMA|NARRATOR|MISSION|DIAGNOSIS>` and globally with `AGENTPROOF_MODEL`:

| Role              | xAI default                    | Anthropic default   | Effort | Steps | Why                                                                                          |
| ----------------- | ------------------------------ | ------------------- | ------ | ----- | -------------------------------------------------------------------------------------------- |
| Alpha             | `grok-4.3`                     | `claude-haiku-5-5`  | low    | 20    | The cheap path: text tokens only. If the store needs more than this, it is not agent-ready.  |
| Beta              | `grok-4.3`                     | `claude-sonnet-5-5` | medium | 20    | Sonnet, an image every step (detail high): what vision buys and what it costs.               |
| Sigma             | `grok-4.7`                     | `claude-sonnet-5-5` | high   | 30    | The ceiling: strongest model, all senses. Shows what the ceiling costs.                      |
| Gamma             | none                           | none                | n/a    | 1     | No model call.                                                                               |
| Narrator          | `grok-4.20-0309-non-reasoning` | `claude-haiku-5-5`  | n/a    | n/a   | Report prose only; cheapest, no reasoning tokens.                                            |
| Mission generator | `grok-4.3`                     | `claude-haiku-5-5`  | low    | n/a   | Structured extraction only.                                                                  |
| Diagnosis         | `grok-4.3`                     | `claude-haiku-5-5`  | n/a    | n/a   | `packages/diagnostics` and the future code-fix agent. Raise it per run if Haiku falls short. |

Every call returns an `LlmUsage` (calls, input and output tokens, image inputs, estimated USD). The loop sums it per step, the narrator call is added to the run total, and the mission report compares agents side by side with a relative-cost column. When the provider reports no cost, `estimateCostUsd()` uses the price table in `profiles.ts`; unknown models show "unknown" rather than a wrong number.

## 5. Where it lives

| File                                                 | What                                                                                                                      |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `llm-types.ts`, `llm.ts`                             | Provider-neutral request and response types; xAI, Anthropic and mock adapters; `toStrictJsonSchema()`                     |
| `profiles.ts`                                        | Per-kind senses, target grammars, default models, efforts, step caps, price table                                         |
| `targets.ts`                                         | `parseTarget()` for both grammars, `toLocator()`, `resolveRoleTarget()`, the `chooseOption()` and `setQuantity()` ladders |
| `prompts.ts`                                         | Fixed system prompt per kind, `buildUserTurn()`, `summarizeRun()`, the narrator prompt, the retry rule                    |
| `actions.ts`                                         | Strict JSON schema for `AgentActionDraft`, `toAgentAction()`, `summarizeStep()`                                           |
| `policy.ts`                                          | `checkAction()`, `isPaymentControl()`, `hostIsAllowed()`                                                                  |
| `browser-agent.ts`                                   | The observe, decide, police, act, record loop; evidence files; the coordinate payment guard                               |
| `gamma.ts`                                           | Gamma (Vihan)                                                                                                             |
| `assess.ts`                                          | Cart fetch through cookies, verifier input from a browser run, Gamma verification glue, screenshot evidence lookup        |
| `scenarios.ts`                                       | Scenarios A to E and the control, verbatim from the answer key                                                            |
| `narrative.ts`                                       | The narrator call with a deterministic fallback                                                                           |
| `report.ts`                                          | `buildAgentReport()`, `buildMissionReport()`, Markdown renderers, `writeReportFiles()`                                    |
| `mission-generator.ts`                               | Natural-language prompt to `Mission`                                                                                      |
| `cli.ts`                                             | One agent, one scenario, no dashboard                                                                                     |
| `scripts/scripted-run.ts`                            | The real browser loop driven by a scripted mock model                                                                     |
| `scripts/llm-smoke.ts`                               | Provider and key check (two cheap calls)                                                                                  |
| `packages/verifier/src/attribute.ts`                 | Cross-agent attribution and recommendations                                                                               |
| `apps/runner/src/jobs.ts`, `reports.ts`, `routes.ts` | Run execution and verification, report files, HTTP                                                                        |

## 6. Reports and attribution

Reports are the hand-off from the agents to the dashboard and to the future code-fix agent. Schemas live in `packages/shared/src/report.ts`; everything in them is written by code except `narrative`.

**AgentReport**, one per run, `<runId>/report.json` and `report.md` under `data/artifacts/`: the agent's profile (senses, grammars, model, provider, effort), the verifier's status and checkpoints, the observed cart, the step log with screenshot and snapshot paths, the failure point (the step where the run diverged, what was attempted, the outcome, and an excerpt of what the agent could perceive there), the narrative (the model's own account, labelled as such; deterministic text when the narrator call fails or times out), usage, duration and artifacts.

**MissionReport**, one per mission, `missions/<missionId>/report.json` and `report.md`: every agent side by side, the checkpoint x agent matrix, attributions, the cost comparison with relative cost, a deterministic headline, and recommendations.

**Attribution** (`packages/verifier/src/attribute.ts`) is deterministic. It takes the latest finished run per kind (errored runs count as not run) and produces nothing when fewer than two agents have a verdict. The reference is Sigma, or Beta when Sigma did not run:

| Pattern                                | Category                     |
| -------------------------------------- | ---------------------------- |
| Gamma failed, any browser agent passed | `product_data_inconsistency` |
| Reference passed, Alpha failed         | `semantic_interface_problem` |
| Sigma passed, Beta failed              | `agent_execution_error`      |
| Reference failed, Alpha passed         | `agent_execution_error`      |
| Reference failed, otherwise            | `cart_checkout_defect`       |

Recommendations follow from the categories: expose the controls behind the failed checkpoints with real roles and names; make the catalog and cart API agree with the page; fix the purchase path when the most capable agent could not complete it; re-run the failing agent before changing the store when the evidence points at the agent.

## 7. Running the agents

The store must be running (`pnpm dev:store`, http://localhost:5000).

```bash
pnpm llm:smoke                                   # provider + key: a strict-JSON ping and one generateMission()
pnpm cli -- --agent gamma --bug A                # Gamma, no model, Bug B outcome through the API
pnpm cli -- --agent alpha --bug A                # one agent, one scenario, report under data/artifacts/cli/<runId>
pnpm cli -- --agent sigma --bug C --headed       # alpha | beta | sigma | gamma; A | B | C | D | E | control
pnpm cli -- --agent alpha --prompt "..."         # mission from the generator instead of a scenario
pnpm --filter @agentproof/agent exec tsx --env-file-if-exists=../../.env scripts/scripted-run.ts alpha A
                                                 # real browser, scripted mock model: the deterministic fallback
node docs/storefront/verify-scenarios.mjs --expect=bugs   # Ryan's grader for the store itself
node scripts/run-mission.mjs --bug A --agents alpha,beta,sigma,gamma   # all four through the runner, with the mission report
scripts/make-fixed-store.sh ../northwind-fixed   # the store with the five fixes applied, as its own repo (then --store http://localhost:5050)
```

Through the runner (`pnpm dev:runner`): `POST /missions/fixture { bug, storeUrl? }` inserts a scenario mission, `POST /missions/:id/runs { agents }` starts runs, `GET /runs/:id/events` streams steps, and the reports come back from `GET /runs/:id/report(.md)`, `GET /missions/:id/report(.md)` and `GET /artifacts/*`.

Validation state (2026-10-18): the workspace typechecks and 344 tests pass. Every scenario was run with all four agents on the bugged store and with Alpha (plus Gamma on the hoodie) on the fixed store; every verdict matches the answer key and attribution names the right cause. Sigma costs 21x to 24x Alpha; an Alpha run costs under a cent. The full tables, mission ids and what was changed because of the runs are in [RESULTS.md](./RESULTS.md).

## 8. Things that bite

- **Determinism.** The same mission runs on camera and in the rematch. Fixed system prompt, capped observation (6,000 characters of tree, 2,000 of text, five steps of history plus the whole-run summary), a two-attempt rule on the same target, and `fail` after five consecutive stuck steps all push toward the same path each time. The scripted run removes the model entirely when the demo must not flake.
- **The model forgets what scrolled off.** The five-step history is what keeps a run cheap, but a rule such as "clear the cart at most once" needs the whole run. The `RUN SUMMARY` block (steps taken, cart clears, failed attempts per target) is computed by code from every step and sits in each user turn; the live run that cleared twice before it existed is in RESULTS.md.
- **Absent controls fail fast.** A role target that is not in the tree is reported at once as `no <role> "<name>" in the accessibility tree` (`resolveRoleTarget()`), so a failed step costs no wall-clock and the detail tells the code-fix agent what was missing. Only a control that exists gets Playwright's full action timeout.
- **Two attempts, five strikes.** `MAX_ATTEMPTS_PER_CONTROL` (prompt) must stay below `STUCK_STEP_LIMIT` (loop). If they were equal the harness would fail Alpha before it could continue with the default size, and the Bug A report would show an empty cart instead of the mismatch.
- **Cost.** Each step is a model call. Alpha's tree is a few thousand tokens; Beta's screenshot is more; Sigma sends both. Output caps include reasoning tokens, so medium and high effort get a larger cap (8192) than low (4096); `decide()` leaves the cap to `llm.ts`.
- **`page.evaluate()` under tsx.** Code that runs inside the page must not define name-inferred inner functions (`const f = () => ...`): tsx runs esbuild with `keepNames`, which injects a `__name` helper that does not exist in the page. Vitest does not, so only a live run catches it.
- **The rematch proves both halves.** After the size picker becomes a real radio group, Alpha selects M with no agent changes. After the variant map is fixed, Gamma gets M back. The agents do not change; the store does. `scripts/make-fixed-store.sh` produces that fixed store as a sibling repo, so the monorepo keeps its bugs and its history stays clean.

## 9. Decisions

| Decision        | Choice                                                                                                                                                                   | Why                                                                                                                                                           |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent model     | Perception strategies (Alpha semantic, Beta vision, Gamma structured), not capability tiers                                                                              | A failure must map to a store property so a repair exists. Tiers blame the agent, not the store.                                                              |
| Sigma           | A fourth agent with every sense and both target grammars on the strongest allowed model: the human-like reference                                                        | Shows what a powerful agent achieves on the same store, so the gap between it and the others is the bug. If Sigma fails, the store is broken for every agent. |
| Human baseline  | Deferred. Ryan's mouse-driven grader proves a human completes every scenario; Sigma is the reference in attribution                                                      | Saved a day of work for a signal the grader already gives.                                                                                                    |
| Attribution     | Deterministic rule over the cross-agent pass/fail pattern (`packages/verifier/src/attribute.ts`), before any model writes a diagnosis                                    | Consistent categories across takes; the diagnosis anchors on a code-derived prior.                                                                            |
| Alpha targeting | Role + exact accessible name only. No text or CSS fallback                                                                                                               | The Bug A snapshot still contains the text "S M L"; a text fallback would click past the bug.                                                                 |
| Beta targeting  | Coordinates only; `select` removed from its action set                                                                                                                   | A vision agent must prove it can operate the page from pixels alone.                                                                                          |
| Loop            | One loop for Alpha, Beta and Sigma, branched on what the profile perceives and which grammars it accepts; Stagehand assessed and rejected (no autonomous agent, no Grok) | One policy layer, one evidence format, one report shape.                                                                                                      |
| Gamma           | Vihan's deterministic inspector, no model, cost line zero                                                                                                                | The structured path is about data correctness, not perception; a model would add noise.                                                                       |
| Provider        | Provider-neutral `getLlm()`; Anthropic live (the xAI hackathon key had no credits), xAI adapter kept                                                                     | Switching keys must not touch agent code.                                                                                                                     |
| Models          | Cheapest everywhere, Sonnet for Beta and Sigma, never Opus by default; one `diagnosis` role for the fix side                                                             | The thesis is about cost; the reports must show it.                                                                                                           |
| Verdicts        | Code decides pass/fail, budget math, variant comparison and attribution; the model writes narratives and hypotheses, labelled                                            | Judges and the code-fix agent need facts they can trust.                                                                                                      |
| Repairs         | `git apply` of a unified diff restricted to the store; Ryan's reference patches are the oracle; the fixed store is an exported sibling repo                              | Clean history, reviewable diffs, and a repair path that also works on the standalone repo.                                                                    |
| Ownership       | Zach: `packages/agent`, `apps/web`. Ryan: `apps/storefront`, `docs/storefront`. Vihan: `apps/runner`, `packages/verifier`, `packages/diagnostics`, `gamma.ts`            | Reflects who built what.                                                                                                                                      |
