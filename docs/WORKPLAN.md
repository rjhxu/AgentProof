# Work plan: three developers, 24 hours

Owners: **Zach** (browser agents Alpha/Beta/Sigma, LLM layer, reports, dashboard, demo), **Ryan** (storefront + bug scenarios), **Vihan** (runner, verification, Gamma, diagnosis, repair).

> Updated 2026-10-17 (evening) after PR #1 (Ryan's five-bug store), PR #2 (Vihan's Gamma, repair, GitHub connection) and the agent work on `abg-agents-impl` (not yet merged). Rows marked **done** are delivered. The detailed agent status is in [AGENTS-IMPLEMENTATION-PLAN.md](./AGENTS-IMPLEMENTATION-PLAN.md) and the agents as built in [AGENTS.md](./AGENTS.md).

The one milestone that mattered: **a real Alpha run against the store, verified by code, visible in the dashboard.** Done: the loop, verification and reports exist, and the live Alpha, Beta and Sigma runs on bug A behave as the answer key predicts (Alpha fails on the missing size control, Beta and Sigma pass) on the Anthropic key.

Where we are: shared schemas and fixtures, verifier with attribution, storefront with five planted bugs and a control, runner API with SQLite, SSE, job queue, reports and artifacts, LLM layer with tiered models, the Alpha/Beta/Sigma loop, Gamma, the CLI and a scripted harness, docs. 333 tests, whole workspace typechecks.

---

## Phase 0 (hour 0-1): everyone

- [x] Clone, `pnpm install`, `pnpm playwright:install`, create `.env` with the shared `ANTHROPIC_API_KEY`. A `GROK_API_KEY`/`XAI_API_KEY` selects the xAI adapter instead.
- [x] `pnpm typecheck && pnpm test` green. `pnpm llm:smoke` proves the key (needs credits); `pnpm cli -- --agent gamma --bug A` proves the store and the pipeline without one.
- [x] Read `packages/shared/src/*.ts` together. Schema edits are additive only from here.

---

## Zach: LLM layer, browser agents, reports, CLI

**Owns:** `packages/agent` (except `gamma.ts`, which is Vihan's). **Read first:** [AGENTS.md](./AGENTS.md). Alpha targets are **role + exact accessible name only**; Beta is `x,y` only; Sigma both.

| Task                                                                                                                                                                                                                           | Status                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| LLM layer: `llm.ts` (xAI Responses API with strict JSON schema and cost, Anthropic fallback, mock), `llm-types.ts`, tiered models in `profiles.ts`, mission generator on `getLlm()`.                                           | **done**                                                                                                                            |
| Target grammar (`targets.ts`), fixed prompts with the two-attempt rule (`prompts.ts`), flat action draft to `AgentAction` (`actions.ts`).                                                                                      | **done**                                                                                                                            |
| The loop (`browser-agent.ts`): observe, decide, police, act, record; `step-NNN.png`, `step-NNN.aria.txt`, `trace.zip`; cookies and final URL returned; three-strike stuck cutoff; coordinate payment guard for Beta and Sigma. | **done**; validated live with the scripted model on Bug A and the control                                                           |
| Reports: `AgentReport` and `MissionReport` schemas, builders, Markdown renderers, narrator with deterministic fallback; attribution in `packages/verifier/src/attribute.ts`.                                                   | **done**                                                                                                                            |
| Runner wiring (in Vihan's `apps/runner`, additive): browser-run branch with cart fetch through cookies, report files, report and artifact routes, `POST /missions/fixture`.                                                    | **done**                                                                                                                            |
| CLI (`pnpm cli -- --agent alpha --bug A`) and the scripted harness (`scripts/scripted-run.ts`).                                                                                                                                | **done**                                                                                                                            |
| Live runs of Alpha, Beta and Sigma on bugs A to E; prompt tuning from what they do.                                                                                                                                            | **bug A done live** (Alpha fails, Beta and Sigma pass); bugs B to E and prompt tuning next                                          |
| Dashboard: agent checkboxes, one panel per run with latest screenshot and steps, checkpoint table, report links, attribution line, cost per agent, diff viewer and Apply, rematch before/after.                                | later (the runner already serves everything the page needs: `GET /runs/:id/report`, `GET /missions/:id/report`, `GET /artifacts/*`) |
| Record the video (OBS, `--headed` or `PLAYWRIGHT_HEADED=1`). Follow [DEMO.md](./DEMO.md).                                                                                                                                      | later                                                                                                                               |

**Needs from others:** nothing blocks; the Anthropic key is in `.env`.

---

## Ryan: storefront + bug scenarios

**Owns:** `apps/storefront`, `docs/storefront` (answer key, patches, grader). **Delivered in PR #1:** five planted bugs across page templates, control product, answer key, reference patches, `verify-scenarios.mjs`.

| Task                                                                                                                                                                          | Done when                                                           |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Shrink `public/images/canvas-tote.jpeg` (5.3 MB) to under 300 KB. Add the remaining product photos from the table in `bugs-and-fixes.md` if time allows.                      | Repo clone is small; Beta and the video have real photos.           |
| Decide `docs/storefront/`: your guide says it is gitignored but it is committed. Either gitignore it or keep it and rely on the diagnosis never reading `docs/`.              | Guide and repo agree.                                               |
| Mark `handoff.md` as superseded by `bugs-and-fixes.md` (or delete it).                                                                                                        | One authoritative scenario doc.                                     |
| Pair with Zach once live runs are possible: Alpha against each of the five bugs (`--snapshot=<slug>` shows what Alpha sees). Fix any store behavior that is not reproducible. | Alpha fails A, C, D, E on the expected checkpoint; passes the tote. |
| Confirm each reference patch still applies after any store changes (`git apply --check`); keep `verify-scenarios.mjs --expect=bugs` and `--expect=fixed` both green.          | Repair flow has five working patches.                               |
| Separate repo for the storefront (so the code-fix agent can clone it through the repository connection).                                                                      | The runner can connect to it like any GitHub repo.                  |

**Needs from others:** nothing blocks Ryan.

---

## Vihan: runner, verification, diagnosis, repair, code-fix agent

**Owns:** `apps/runner`, `packages/verifier`, `packages/diagnostics`, `packages/agent/src/gamma.ts`. **Delivered in PR #2:** Gamma with tests, runner Gamma wiring, deterministic Bug-B diagnosis and repair, GitHub repository connection, Gamma dashboard flow. Zach added, additively: the browser-run branch in `jobs.ts`, `reports.ts`, the report, fixture and artifact routes, `attribute.ts`.

| Task                                                                                                                                                                                                                                 | Status / done when                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| Evidence serving: `GET /artifacts/*` (`@fastify/static`, root `config.artifactsDir`).                                                                                                                                                | **done**                                                                      |
| Wire verification in `executeRun`: cart through the session cookies, product page from visited URLs, checkout from the final URL, `cart_state` evidence, checkpoint events.                                                          | **done**                                                                      |
| Gamma (`gamma.ts`): catalog match, `POST /api/cart`, read back, `catalog_variant_resolves`; `GET /checkout` check. `catalog_price_matches_page` is in the schema but not produced yet.                                               | **done** (price check optional)                                               |
| Use `registerErrorHandler()` from `routes.ts` in `server.ts` so plugin 4xx statuses are kept (one-line swap); count errored runs in the mission cost table if wanted.                                                                | small follow-ups                                                              |
| Diagnosis: pass `repoFiles` and `sourceExcerpts` (`apps/storefront/src/**` only) and the attribution prior into `diagnose()`. Check `category` is `semantic_interface_problem` for Alpha and `product_data_inconsistency` for Gamma. | Two real `Issue`s saved, observed/inferred clearly separated.                 |
| Repair: converge on `git apply` of a unified diff restricted to `apps/storefront/`; route the Gamma repair through the same path; reference patches from `docs/storefront/patches/` for known bug classes.                           | Both planted bugs are fixed by applying diffs; `tsx watch` reloads the store. |
| Code-fix agent: consumes `MissionReport` and `AgentReport` (`GET /missions/:id/report`, `GET /runs/:id/report`) plus the repository connection, proposes a diff.                                                                     | later; the reports are the input contract                                     |
| Rematch: confirm `POST /runs/:id/rematch` + `compare` produce the expected deltas after repairs. Script to reset the store between takes (`git checkout apps/storefront`).                                                           | Before/after shows Alpha and Gamma going green.                               |

**Needs from others:** a live Alpha run id (Zach, once credits exist) to test diagnosis against; until then the scripted run and the CLI produce real reports.

---

## Handoff points

| Who -> who       | What                                                                      | Status                                              |
| ---------------- | ------------------------------------------------------------------------- | --------------------------------------------------- |
| Vihan -> Zach    | Runner serves artifacts; endpoints return real shapes                     | done                                                |
| Zach -> Vihan    | `runBrowserAgent` returns cookies + final URL; reports written and served | done                                                |
| Zach -> Vihan    | First real failed Alpha run id to build the diagnosis against             | scripted run available; live run blocked on credits |
| Vihan -> Zach    | First real `Issue` and `Repair` from a browser-agent run                  | pending                                             |
| Vihan -> Zach    | Original + rematch run ids for the comparison view                        | pending                                             |
| everyone -> Zach | Freeze features; only bug fixes and polish                                | pending                                             |

## If we fall behind

Cut in this order: dashboard polish -> generated repair (hand-written diffs, keep the apply flow) -> Beta and Sigma live runs (Alpha's failure plus Gamma's already tells the story, and the scripted run reproduces Alpha without a model).
