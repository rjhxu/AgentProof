# Work plan: three developers, 24 hours

Owners: **Zach** (browser agents Alpha/Beta/Sigma + dashboard + demo), **Ryan** (storefront + bug scenarios), **Vihan** (runner, verification, Gamma, diagnosis, repair).

> Updated 2026-10-17 after PR #1 (Ryan's five-bug store) and PR #2 (Vihan's Gamma, repair, GitHub connection). The detailed agent work is in [AGENTS-IMPLEMENTATION-PLAN.md](./AGENTS-IMPLEMENTATION-PLAN.md); rows below marked **done** were delivered by those PRs.

The one milestone that matters: **a real Alpha run against the store, verified by code, visible in the dashboard, by hour 6.** Everything else is layered on top of that.

Already done in the scaffold: shared schemas + fixtures, verifier with tests, storefront with both planted bugs, runner API surface with SQLite + SSE + job queue, mission generator, dashboard shell, docs. Each item below says which file to open first.

---

## Phase 0 (hour 0â€“1): everyone

- [ ] Clone, `pnpm install`, `pnpm playwright:install`, create `.env` with your own `ANTHROPIC_API_KEY`.
- [ ] `pnpm typecheck && pnpm test` green. `pnpm --filter @agentproof/agent smoke` passes (needs the store running: `pnpm dev:store`).
- [ ] Read `packages/shared/src/*.ts` together (15 min). Agree on any schema changes **now**; after this, schema edits are additive only.

---

## Zach: dashboard, replay, video

**Owns:** `apps/web`. **Starts from:** `src/app/page.tsx`, `src/lib/api.ts`, fixtures in `packages/shared/fixtures`.

| Hours   | Task                                                                                                                                                                                                                                                                                                                     | Done when                                                     |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| 1â€“3   | `npx shadcn@latest init` + Button/Card/Table/Badge/Dialog/Tabs. Mission form (`store URL`, `prompt`, agent checkboxes) â†’ `api.createMission` â†’ `api.startRuns`. Route to `/missions/[id]`.                                                                                                                           | Submitting the form creates runs in the runner and redirects. |
| 3â€“6   | **Arena page** `/missions/[id]`: one panel per run. Subscribe with `api.subscribe(runId)`; render `RunStep`s as a timeline, latest screenshot, status badge. Build against `alphaFailedRun` fixture first, then live.                                                                                                    | Live steps from Zach's Alpha run appear as they happen.       |
| 6â€“9   | **Compatibility report** component: the checkpoint table (`CHECKPOINT_LABELS`, colored by `CheckpointStatus`). Evidence drawer: click a checkpoint â†’ show its `evidenceIds` (screenshot image, JSON for cart/catalog/dom).                                                                                             | Report renders from `run.verification`; evidence opens.       |
| 9â€“12  | **Issue + repair view**: "Diagnose" button â†’ `api.diagnose`. Render `Issue` with _Observed_ (fact) and _Inferred cause_ (hypothesis) visually separate, category badge, confidence. Repair diff viewer (use a `<pre>` with +/- line coloring; `react-diff-viewer-continued` if time). "Apply" + "Run Rematch" buttons. | Full issue â†’ diff â†’ rematch flow clickable.               |
| 12â€“15 | **Rematch comparison**: side-by-side before/after table from `api.compare`, "N improved / N regressed" headline, Motion transitions on status changes.                                                                                                                                                                   | Comparison renders from two real runs.                        |
| 15â€“18 | Replay mode: play a finished run's steps on a timer with a visible "Recording" badge. Polish: loading states, error toasts, empty states.                                                                                                                                                                                | Any persisted run can be replayed.                            |
| 18â€“24 | Record the video (OBS, `PLAYWRIGHT_HEADED=1`), edit, submit. Follow `docs/DEMO.md`.                                                                                                                                                                                                                                      | Three-minute video uploaded.                                  |

**Needs from others:** runner endpoints returning real data (Vihan, hour 3+), a real Alpha run id to test against (Zach's own agent work, hour 6).

---

## Zach: browser agents (Alpha, Beta, Sigma) + mission generator + human replay

**Owns:** `packages/agent` (except `claude.ts`, which is shared, and `gamma.ts`, which is Vihan's). **Starts from:** `src/browser-agent.ts` (the `TODO(zach)` markers), `src/policy.ts`, `src/mission-generator.ts`. **Read first:** [AGENTS.md](./AGENTS.md) and [AGENTS-IMPLEMENTATION-PLAN.md](./AGENTS-IMPLEMENTATION-PLAN.md) sections 4 and 5. Alpha targets are **role + exact accessible name only** (see [storefront/bugs-and-fixes.md](./storefront/bugs-and-fixes.md)).

| Hours   | Task                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Done when                                                                                                                                          |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1â€“3   | Implement `decide()`: `getClaude().messages.parse` with `zodOutputFormat(AgentAction)`. System prompt is fixed; user turn carries mission requirements, allowed actions, steps remaining, last 5 steps, and the observation. Alpha observation = `ariaSnapshot()` text.                                                                                                                                                                                                        | Given the fixture mission and a hand-made observation, Claude returns a valid `AgentAction`.                                                       |
| 3â€“6   | Implement `runBrowserAgent()` loop: `openSession` â†’ observe â†’ decide â†’ `checkAction` â†’ `act` â†’ emit `RunStep` + screenshot `Evidence` (`step-NNN.png` into `artifactDir`) â†’ repeat until `done`/`fail`/step cap â†’ `closeSession` (trace.zip). Target resolution for Alpha: `role:name` only (â†’ `page.getByRole(role, { name, exact: true })`), no text or CSS fallback. **Return the session cookies** in `BrowserAgentResult` so Vihan can fetch `/api/cart`. | **Hour 6 milestone:** Alpha completes the hoodie mission end to end on the store (it will pick size S because of Bug A; that is correct behavior). |
| 6â€“9   | Harden Alpha: retries on locator timeout, `fail` when stuck 3 steps, never click payment controls (policy already blocks; make the prompt say so too). Capture `dom_snapshot` evidence when a `select`/`click` fails so the diagnosis has something to point at.                                                                                                                                                                                                               | Alpha runs are deterministic enough to demo twice in a row.                                                                                        |
| 9â€“12  | Agent Beta (vision): observation = screenshot as an image block, targets as `"x,y"`, `act` â†’ `page.mouse.click`. Same loop, `kind === 'beta_vision'` branch.                                                                                                                                                                                                                                                                                                                 | Beta picks size M via the chips and reaches checkout.                                                                                              |
| 12â€“15 | Tune `generateMission()` prompt on 5 varied prompts (headphones under $100, grey hoodie large, quantity 2). Token/cost check: cap observation text, use `effort: 'medium'` in `output_config` if runs are slow.                                                                                                                                                                                                                                                                | Mission JSON correct on all 5.                                                                                                                     |
| 15â€“20 | Support Vihan on the rematch run (Alpha must pass after the semantic fix). Record two clean Alpha/Beta runs for Zach's fallback replay.                                                                                                                                                                                                                                                                                                                                        | Rematch Alpha run passes `correct_size_identified`.                                                                                                |

**Needs from others:** store running (done), runner calling `runBrowserAgent` (Vihan, hour 3).

---

## Ryan: storefront + bug scenarios

**Owns:** `apps/storefront`, `docs/storefront` (answer key, patches, grader). **Delivered in PR #1:** five planted bugs across page templates, control product, answer key, reference patches, `verify-scenarios.mjs`.

| Hours   | Task                                                                                                                                                                                    | Done when                                                           |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| now     | Shrink `public/images/canvas-tote.jpeg` (5.3 MB) to under 300 KB. Add the remaining product photos from the table in `bugs-and-fixes.md` if time allows.                                | Repo clone is small; Beta and the video have real photos.           |
| now     | Decide `docs/storefront/`: your guide says it is gitignored but it is committed. Either gitignore it or keep it and rely on the diagnosis never reading `docs/`.                        | Guide and repo agree.                                               |
| now     | Mark `handoff.md` as superseded by `bugs-and-fixes.md` (or delete it).                                                                                                                  | One authoritative scenario doc.                                     |
| 6â€“12  | Pair with Zach to test Alpha against each of the five bugs using `--snapshot=<slug>` and the expected checkpoint tables. Fix any store behavior that makes a scenario non-reproducible. | Alpha fails A, C, D, E on the expected checkpoint; passes the tote. |
| 12â€“18 | Confirm each reference patch still applies after any store changes (`git apply --check`); keep `verify-scenarios.mjs --expect=bugs` and `--expect=fixed` both green.                    | Repair flow has five working patches.                               |

**Needs from others:** nothing blocks Ryan.

---

## Vihan: runner, verification, Gamma, diagnosis, repair

**Owns:** `apps/runner`, `packages/verifier`, `packages/diagnostics`, `packages/agent/src/gamma.ts`. **Delivered in PR #2:** Gamma with tests, runner Gamma wiring, deterministic Bug-B diagnosis and repair, GitHub repository connection, Gamma dashboard flow. **Starts from:** [AGENTS-IMPLEMENTATION-PLAN.md](./AGENTS-IMPLEMENTATION-PLAN.md) sections 6 and 7 (`attribute.ts`, `git apply` repairs, fixture missions, artifacts route), then `apps/runner/src/jobs.ts` (`TODO(zach+vihan)`) once Alpha returns cookies.

| Hours   | Task                                                                                                                                                                                                                                                                                                                                      | Done when                                                                                                 |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 1â€“3   | **Evidence serving**: `GET /artifacts/<runId>/<file>` static route in the runner (`@fastify/static`, root `config.artifactsDir`) so Zach can show screenshots. Add `GET /missions` list. Smoke the whole API with curl.                                                                                                                   | Zach can hit every endpoint in `packages/shared/src/api.ts`.                                              |
| 3â€“6   | **Wire verification** in `executeRun`: after Zach's loop returns, GET `{storeUrl}/api/cart` with the session cookies â†’ `ObservedCart` (`source: 'api'`), derive `productPage` from the last product URL in steps, `checkoutReached` from a final URL containing `/checkout`. Attach `cart_state` evidence. Publish `checkpoint` events. | **Hour 6 milestone:** Alpha's run ends `failed` on `cart_matches_variant` with the cart JSON as evidence. |
| 6â€“9   | **Agent Gamma** (`gamma.ts`): pick product + variant from catalog, POST `/api/cart` with the variant id, GET cart, compare â†’ `catalog_variant_resolves` (fails: Bug B), fetch product page and compare price â†’ `catalog_price_matches_page`. Merge into `verify()` output in `jobs.ts`.                                               | Gamma run shows the Mâ†’S mismatch with catalog + cart evidence.                                          |
| 9â€“12  | **Diagnosis**: pass `repoFiles` (list of `apps/storefront/src/*.ts`) and `sourceExcerpts` (contents of files mentioned in evidence) into `diagnose()`. Test on both real failures; check `category` is `semantic_interface_problem` for Alpha and `product_data_inconsistency` for Gamma.                                                 | Two real `Issue`s saved, observed/inferred clearly separated.                                             |
| 12â€“15 | **Repair**: implement `proposeRepair()` (Claude â†’ `{ summary, diff, files }` via structured output, limited to `apps/storefront`), validate with `git apply --check`. Implement `applyRepair()` with `git apply`; refuse paths outside `config.storefrontDir`. Wire `POST /issues/:id/repair` and `POST /repairs/:id/apply`.            | Both planted bugs are fixed by applying generated diffs; `tsx watch` reloads the store.                   |
| 15â€“18 | **Rematch**: confirm `POST /runs/:id/rematch` + `compare` produce the expected deltas after repairs. Script to reset the store between takes (`git checkout apps/storefront`).                                                                                                                                                            | Before/after shows Alpha and Gamma going green.                                                           |
| 18â€“24 | Integration bugs, run the demo loop five times, keep a pair of recorded runs as fallback. Support video recording.                                                                                                                                                                                                                        | Demo loop is boring because it always works.                                                              |

**Needs from others:** `runBrowserAgent` returning cookies + final URL (Zach, hour 6), dashboard calling the endpoints (Zach, hour 3+).

---

## Handoff points

| Hour | Who â†’ who       | What                                                  |
| ---- | ----------------- | ----------------------------------------------------- |
| 3    | Vihan â†’ Zach    | Runner serves artifacts; endpoints return real shapes |
| 6    | Zach â†’ Vihan    | `runBrowserAgent` returns cookies + final URL         |
| 6    | Vihan â†’ Zach    | First real failed run id to build the report against  |
| 12   | Vihan â†’ Zach    | First real `Issue` and `Repair`                       |
| 15   | Vihan â†’ Zach    | Original + rematch run ids for the comparison view    |
| 18   | everyone â†’ Zach | Freeze features; only bug fixes and polish            |

## If we fall behind

Cut in this order: Beta agent â†’ replay mode â†’ generated repair (hand-write the two diffs, keep the apply flow) â†’ Gamma (Alpha's failure alone still tells the story).
