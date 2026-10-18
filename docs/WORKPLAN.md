# Work plan: what is left, and who does it

Owners: **Zach** (browser agents, LLM layer, reports, dashboard, demo), **Ryan** (storefront, bug scenarios, the standalone store repo), **Vihan** (runner, verification, Gamma, diagnosis, repair, the code-fix agent).

> Updated 2026-10-18, after PR #4 merged the agents into `main` and the live validation in [RESULTS.md](./RESULTS.md). Deadlines ([TRACKS.md](./TRACKS.md)): Devpost draft Saturday 10:30 PM, final submission Sunday 10:00 AM, judging Sunday 11:30 AM.

## Delivered

Shared schemas and fixtures; the storefront with five planted bugs, a control product, an answer key, reference patches and a grader; the runner with SQLite, a job queue, SSE, reports and artifact serving; the provider-neutral LLM layer with tiered models; the Alpha, Beta and Sigma browser loop; Gamma; deterministic verification and cross-agent attribution; agent and mission reports as JSON and Markdown; the CLI, the runner driver, the fixed-store export and the scripted harness; the Gamma dashboard flow with diagnosis, repair, rematch and the GitHub repository connection. 344 tests, the workspace typechecks, and every scenario behaves as the answer key predicts on both the bugged and the fixed store.

## The order of the next steps

1. **Code-fix agent** (Vihan, with Zach on the model layer). Input: `MissionReport` and `AgentReport` (`GET /missions/:id/report`, `GET /runs/:id/report`) plus the repository snapshot from the connection. Output: an `Issue` and a unified diff against the store repo. It must go through `getLlm()` with the `diagnosis` role (Haiku by default; set `AGENTPROOF_MODEL_DIAGNOSIS=claude-sonnet-5-5` if Haiku cannot find the root causes; the answer key says a small model found all five from the evidence alone).
2. **Validate its output** (Vihan, Ryan). Apply the diff to the exported store repo, run `verify-scenarios.mjs` for FIXED with no HUMAN BROKEN, run the rematch and `compare`, and check the diff stays inside the root-cause file the answer key names. The rubric is in `docs/storefront/test-site-guide.md`, Part 2.
3. **Dashboard** (Zach). The multi-agent arena on top of the existing Gamma page: pick agents, one panel per run with the latest screenshot and steps, the checkpoint matrix, the attribution line, cost per agent, report links, the diff and Apply, the before/after table. Everything it needs is already served by the runner.
4. **Demo and Devpost** (Zach, everyone). Record per [DEMO.md](./DEMO.md); write the Devpost draft before Saturday 10:30 PM.

## Zach

| Task                                                                                                                                                                      | Status                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| LLM layer, tiered models, prompts, targets, the loop, reports, attribution, runner wiring, CLI, scripted harness                                                          | **done**                                         |
| Live runs of all four agents on A to E and the control, bugged and fixed; prompt tuning from them (run summary in the user turn, fast failure on absent controls)         | **done** ([RESULTS.md](./RESULTS.md))            |
| Dashboard: agent checkboxes, run panels, checkpoint matrix, attribution, cost, report links, diff and Apply, rematch before/after. Keep the Gamma flow working underneath | next                                             |
| Demo recording (`--headed` or `PLAYWRIGHT_HEADED=1`, OBS) and the Devpost draft                                                                                           | after the dashboard; draft due Saturday 10:30 PM |
| Decide whether the code-fix agent may use Sonnet (`AGENTPROOF_MODEL_DIAGNOSIS`); the default is Haiku                                                                     | when Vihan has a first run                       |

## Ryan

| Task                                                                                                                                                                | Done when                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Publish the standalone store as its own GitHub repo (`docs/storefront/export-standalone.sh ../northwind-storefront --blind`, then `gh repo create`), tag `baseline` | The runner can connect to it like any GitHub repo; the code-fix agent works there |
| Shrink `public/images/canvas-tote.jpeg` (5.3 MB) to under 300 KB                                                                                                    | Clones are small                                                                  |
| Keep the five reference patches applying (`git apply --check`) and both grader modes green after any store change                                                   | `--expect=bugs` on the monorepo store, `--expect=fixed` on the fixed export       |
| Pair with Vihan on scoring the code-fix agent's diffs against the rubric                                                                                            | A scored table per scenario                                                       |

## Vihan

| Task                                                                                                                                                                                                   | Status / done when                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| Gamma, runner verification, artifact serving, repository connection, Gamma diagnosis and repair                                                                                                        | **done**                                                                                |
| Move `diagnose()` off `getClaude()` onto `getLlm()` with the `diagnosis` role; pass `sourceExcerpts` from the store repo only (never `docs/`) and the attribution from the mission report as the prior | A real `Issue` for an Alpha run on A, C, D and E with `category` from the attribution   |
| Repair path: `git apply` of a unified diff restricted to the store directory; `AGENTPROOF_STOREFRONT_DIR` to target the exported repo; route the Bug B rule through the same path                      | A diff from the agent applies to `../northwind-fixed`-style repos and the grader passes |
| The code-fix agent itself: reports in, diff out (see step 1 above)                                                                                                                                     | Five scenarios fixed on the blind export with no HUMAN BROKEN                           |
| Rematch: run the fixed scenario through `POST /runs/:id/rematch` and `compare`; confirm the deltas                                                                                                     | Before/after shows Alpha going green on A, Gamma on B                                   |
| `registerErrorHandler()` from `routes.ts` in `server.ts` (one-line swap) so plugin 4xx statuses are kept                                                                                               | small follow-up                                                                         |

## Handoff points

| Who -> who       | What                                                                                    | Status  |
| ---------------- | --------------------------------------------------------------------------------------- | ------- |
| Zach -> Vihan    | Real failed runs and mission reports for every scenario (ids in RESULTS.md)             | done    |
| Ryan -> Vihan    | The blind standalone store repo on GitHub                                               | pending |
| Vihan -> Zach    | First `Issue` and `Repair` from a browser-agent run, and the original + rematch run ids | pending |
| everyone -> Zach | Feature freeze; bug fixes and polish only                                               | pending |

## If we fall behind

Cut in this order: dashboard polish → generated repair (hand-apply the reference patches through the same Apply flow and say so on screen) → Beta and Sigma in the live demo (the recorded mission reports already show them). The scripted run reproduces Alpha without a model if the key fails on camera.
