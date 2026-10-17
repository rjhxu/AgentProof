# Work plan: three developers, 24 hours

Owners: **Zach** (dashboard + demo), **Ryan** (browser agents), **Vihan** (store, runner, verification, diagnosis, repair).

The one milestone that matters: **a real Alpha run against the store, verified by code, visible in the dashboard, by hour 6.** Everything else is layered on top of that.

Already done in the scaffold: shared schemas + fixtures, verifier with tests, storefront with both planted bugs, runner API surface with SQLite + SSE + job queue, mission generator, dashboard shell, docs. Each item below says which file to open first.

---

## Phase 0 (hour 0–1): everyone

- [ ] Clone, `pnpm install`, `pnpm playwright:install`, create `.env` with your own `ANTHROPIC_API_KEY`.
- [ ] `pnpm typecheck && pnpm test` green. `pnpm --filter @agentproof/agent smoke` passes (needs the store running: `pnpm dev:store`).
- [ ] Read `packages/shared/src/*.ts` together (15 min). Agree on any schema changes **now**; after this, schema edits are additive only.

---

## Zach: dashboard, replay, video

**Owns:** `apps/web`. **Starts from:** `src/app/page.tsx`, `src/lib/api.ts`, fixtures in `packages/shared/fixtures`.

| Hours | Task                                                                                                                                                                                                                                                                                                                   | Done when                                                     |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| 1–3   | `npx shadcn@latest init` + Button/Card/Table/Badge/Dialog/Tabs. Mission form (`store URL`, `prompt`, agent checkboxes) → `api.createMission` → `api.startRuns`. Route to `/missions/[id]`.                                                                                                                             | Submitting the form creates runs in the runner and redirects. |
| 3–6   | **Arena page** `/missions/[id]`: one panel per run. Subscribe with `api.subscribe(runId)`; render `RunStep`s as a timeline, latest screenshot, status badge. Build against `alphaFailedRun` fixture first, then live.                                                                                                  | Live steps from Ryan's Alpha run appear as they happen.       |
| 6–9   | **Compatibility report** component: the checkpoint table (`CHECKPOINT_LABELS`, colored by `CheckpointStatus`). Evidence drawer: click a checkpoint → show its `evidenceIds` (screenshot image, JSON for cart/catalog/dom).                                                                                             | Report renders from `run.verification`; evidence opens.       |
| 9–12  | **Issue + repair view**: "Diagnose" button → `api.diagnose`. Render `Issue` with _Observed_ (fact) and _Inferred cause_ (hypothesis) visually separate, category badge, confidence. Repair diff viewer (use a `<pre>` with +/- line coloring; `react-diff-viewer-continued` if time). "Apply" + "Run Rematch" buttons. | Full issue → diff → rematch flow clickable.                   |
| 12–15 | **Rematch comparison**: side-by-side before/after table from `api.compare`, "N improved / N regressed" headline, Motion transitions on status changes.                                                                                                                                                                 | Comparison renders from two real runs.                        |
| 15–18 | Replay mode: play a finished run's steps on a timer with a visible "Recording" badge. Polish: loading states, error toasts, empty states.                                                                                                                                                                              | Any persisted run can be replayed.                            |
| 18–24 | Record the video (OBS, `PLAYWRIGHT_HEADED=1`), edit, submit. Follow `docs/DEMO.md`.                                                                                                                                                                                                                                    | Three-minute video uploaded.                                  |

**Needs from others:** runner endpoints returning real data (Vihan, hour 3+), a real run id to test against (Ryan, hour 6).

---

## Ryan: browser agents + mission generator

**Owns:** `packages/agent` (except `claude.ts`, which is shared). **Starts from:** `src/browser-agent.ts` (the `TODO(ryan)` markers), `src/policy.ts`, `src/mission-generator.ts`.

| Hours | Task                                                                                                                                                                                                                                                                                                                                                                                                               | Done when                                                                                                                                          |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1–3   | Implement `decide()`: `getClaude().messages.parse` with `zodOutputFormat(AgentAction)`. System prompt is fixed; user turn carries mission requirements, allowed actions, steps remaining, last 5 steps, and the observation. Alpha observation = `ariaSnapshot()` text.                                                                                                                                            | Given the fixture mission and a hand-made observation, Claude returns a valid `AgentAction`.                                                       |
| 3–6   | Implement `runBrowserAgent()` loop: `openSession` → observe → decide → `checkAction` → `act` → emit `RunStep` + screenshot `Evidence` (`step-NNN.png` into `artifactDir`) → repeat until `done`/`fail`/step cap → `closeSession` (trace.zip). Target resolution for Alpha: accept `role:name` (→ `page.getByRole`) and CSS. **Return the session cookies** in `BrowserAgentResult` so Vihan can fetch `/api/cart`. | **Hour 6 milestone:** Alpha completes the hoodie mission end to end on the store (it will pick size S because of Bug A; that is correct behavior). |
| 6–9   | Harden Alpha: retries on locator timeout, `fail` when stuck 3 steps, never click payment controls (policy already blocks; make the prompt say so too). Capture `dom_snapshot` evidence when a `select`/`click` fails so the diagnosis has something to point at.                                                                                                                                                   | Alpha runs are deterministic enough to demo twice in a row.                                                                                        |
| 9–12  | Agent Beta (vision): observation = screenshot as an image block, targets as `"x,y"`, `act` → `page.mouse.click`. Same loop, `kind === 'beta_vision'` branch.                                                                                                                                                                                                                                                       | Beta picks size M via the chips and reaches checkout.                                                                                              |
| 12–15 | Tune `generateMission()` prompt on 5 varied prompts (headphones under $100, grey hoodie large, quantity 2). Token/cost check: cap observation text, use `effort: 'medium'` in `output_config` if runs are slow.                                                                                                                                                                                                    | Mission JSON correct on all 5.                                                                                                                     |
| 15–20 | Support Vihan on the rematch run (Alpha must pass after the semantic fix). Record two clean Alpha/Beta runs for Zach's fallback replay.                                                                                                                                                                                                                                                                            | Rematch Alpha run passes `correct_size_identified`.                                                                                                |

**Needs from others:** store running (done), runner calling `runBrowserAgent` (Vihan, hour 3).

---

## Vihan: store, runner, verification, diagnosis, repair

**Owns:** `apps/storefront`, `apps/runner`, `packages/verifier`, `packages/diagnostics`, `packages/agent/src/gamma.ts`. **Starts from:** `apps/runner/src/jobs.ts` (`TODO(vihan)` / `TODO(ryan+vihan)`), `packages/agent/src/gamma.ts`.

| Hours | Task                                                                                                                                                                                                                                                                                                                                    | Done when                                                                                                 |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 1–3   | **Evidence serving**: `GET /artifacts/<runId>/<file>` static route in the runner (`@fastify/static`, root `config.artifactsDir`) so Zach can show screenshots. Add `GET /missions` list. Smoke the whole API with curl.                                                                                                                 | Zach can hit every endpoint in `packages/shared/src/api.ts`.                                              |
| 3–6   | **Wire verification** in `executeRun`: after Ryan's loop returns, GET `{storeUrl}/api/cart` with the session cookies → `ObservedCart` (`source: 'api'`), derive `productPage` from the last product URL in steps, `checkoutReached` from a final URL containing `/checkout`. Attach `cart_state` evidence. Publish `checkpoint` events. | **Hour 6 milestone:** Alpha's run ends `failed` on `cart_matches_variant` with the cart JSON as evidence. |
| 6–9   | **Agent Gamma** (`gamma.ts`): pick product + variant from catalog, POST `/api/cart` with the variant id, GET cart, compare → `catalog_variant_resolves` (fails: Bug B), fetch product page and compare price → `catalog_price_matches_page`. Merge into `verify()` output in `jobs.ts`.                                                 | Gamma run shows the M→S mismatch with catalog + cart evidence.                                            |
| 9–12  | **Diagnosis**: pass `repoFiles` (list of `apps/storefront/src/*.ts`) and `sourceExcerpts` (contents of files mentioned in evidence) into `diagnose()`. Test on both real failures; check `category` is `semantic_interface_problem` for Alpha and `product_data_inconsistency` for Gamma.                                               | Two real `Issue`s saved, observed/inferred clearly separated.                                             |
| 12–15 | **Repair**: implement `proposeRepair()` (Claude → `{ summary, diff, files }` via structured output, limited to `apps/storefront`), validate with `git apply --check`. Implement `applyRepair()` with `git apply`; refuse paths outside `config.storefrontDir`. Wire `POST /issues/:id/repair` and `POST /repairs/:id/apply`.            | Both planted bugs are fixed by applying generated diffs; `tsx watch` reloads the store.                   |
| 15–18 | **Rematch**: confirm `POST /runs/:id/rematch` + `compare` produce the expected deltas after repairs. Script to reset the store between takes (`git checkout apps/storefront`).                                                                                                                                                          | Before/after shows Alpha and Gamma going green.                                                           |
| 18–24 | Integration bugs, run the demo loop five times, keep a pair of recorded runs as fallback. Support video recording.                                                                                                                                                                                                                      | Demo loop is boring because it always works.                                                              |

**Needs from others:** `runBrowserAgent` returning cookies + final URL (Ryan, hour 6), dashboard calling the endpoints (Zach, hour 3+).

---

## Handoff points

| Hour | Who → who           | What                                                  |
| ---- | ------------------- | ----------------------------------------------------- |
| 3    | Vihan → Zach        | Runner serves artifacts; endpoints return real shapes |
| 6    | Ryan → Vihan        | `runBrowserAgent` returns cookies + final URL         |
| 6    | Vihan → Zach        | First real failed run id to build the report against  |
| 12   | Vihan → Zach        | First real `Issue` and `Repair`                       |
| 15   | Vihan + Ryan → Zach | Original + rematch run ids for the comparison view    |
| 18   | everyone → Zach     | Freeze features; only bug fixes and polish            |

## If we fall behind

Cut in this order: Beta agent → replay mode → generated repair (hand-write the two diffs, keep the apply flow) → Gamma (Alpha's failure alone still tells the story).
