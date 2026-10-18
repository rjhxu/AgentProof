# Architecture

Engineering companion to [SPEC.md](./SPEC.md). This describes what is in the repo and how the pieces talk to each other, as of 2026-10-18. The agents are described in [AGENTS.md](./AGENTS.md); what they produced live is in [RESULTS.md](./RESULTS.md). The code-fix agent is in [CODEFIX.md](./CODEFIX.md) and its live results in [CODEFIX-RESULTS.md](./CODEFIX-RESULTS.md).

## Runtime topology (local dev)

```
 browser (you)                    browser (Playwright, headless Chromium)
      |                                      ^
      v                                      | drives
+-------------+   HTTP/JSON + SSE   +-----------------+   HTTP    +------------------+
|  apps/web   | ------------------> |   apps/runner   | --------> |  apps/storefront |  :5000  (planted bugs)
|  Next.js    |                     |   Fastify       |           |  Fastify + HTML  |
|  :3000      | <------------------ |   :4000         |           +------------------+
+-------------+                     +--------+--------+           +------------------+
                                             |                    | ../northwind-fixed|  :5050  (same store, patches applied;
                       +---------------------+---------------------+   scripts/make-fixed-store.sh)
                       |                     |                     |
               packages/agent        packages/verifier    packages/diagnostics
               getLlm() + Playwright pure TypeScript       diagnose(), repair
                       |
                 data/agentproof.db (SQLite)   data/artifacts/<runId>/ and missions/<missionId>/
```

All three services read `.env` at the repo root (`tsx --env-file-if-exists` and Next's own loader). On Windows run pnpm from PowerShell.

## Packages

| Package                   | Depends on                                                                     | What lives there                                                                                                                                                                                                                                                                                                                       |
| ------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@agentproof/shared`      | zod                                                                            | Every schema and type: `Mission`, `Run`, `RunStep`, `Checkpoint`, `Evidence`, `Issue`, `Repair`, `RunEvent`, `LlmUsage`, `AgentReport`, `MissionReport`, `Attribution`, API request and response shapes, id helpers, fixtures. The contract between packages.                                                                          |
| `@agentproof/verifier`    | shared                                                                         | `verify()` turns a mission plus observed cart and page facts into checkpoints. `attributeMission()` and `recommendationsFrom()` do cross-agent attribution. `compareRuns()` builds the rematch delta. No network, no model.                                                                                                            |
| `@agentproof/agent`       | shared, playwright, `@anthropic-ai/sdk` (inside `llm.ts` and `claude.ts` only) | `getLlm()` with the Anthropic, xAI and mock adapters; `profiles.ts` (tiered models, price table); the browser loop for Alpha, Beta and Sigma; `gamma.ts`; `policy.ts`; `assess.ts` (cart through cookies, verifier input); reports and the narrator; `scenarios.ts`; the mission generator; the CLI; `scripts/` (smoke, scripted run). |
| `@agentproof/diagnostics` | shared, agent                                                                  | `diagnose()` (evidence in, `Issue` out; one strict-JSON call through `getLlm()` with the `diagnosis` role, Haiku by default), `proposeRepair()` and `applyRepair()`.                                                                                                                                                                   |
| `@agentproof/codefix`     | shared, agent                                                                  | The code-fix agent ([CODEFIX.md](./CODEFIX.md)): evidence bundle, file localization, the proposer and reviewer calls, exact edits to a unified diff, scope checks, `git apply`/`npm`/`tsc` runners, a GitHub client that can only open draft pull requests, and the Markdown record. The orchestrator is `apps/runner/src/codefix.ts`. |

Packages are consumed as raw TypeScript (`exports` point at `src/index.ts`). `tsx` runs them directly in the Node apps; Next compiles them through `transpilePackages`. There is no build step.

## One test, end to end

1. **Mission.** `POST /missions/fixture { bug, storeUrl? }` inserts one of the six scenario missions from `scenarios.ts` (no model call); `POST /missions { storeUrl, prompt }` asks `generateMission()` (strict JSON schema through `getLlm()`) to structure a free-text prompt. Saved to SQLite.
2. **Runs.** `POST /missions/:id/runs { agents }` creates one `Run` per agent kind, status `queued`, in the in-process job queue (`apps/runner/src/jobs.ts`, concurrency 2).
3. **Execute.** Browser kinds run `runBrowserAgent()`: observe (what the kind perceives) → decide (one `getLlm()` call, strict `AgentActionDraft`) → police (`checkAction()`, plus the element-under-point check for coordinates) → act (Playwright) → record (`RunStep` + `Evidence`, persisted and published). Gamma runs `runGamma()`: catalog, `POST /api/cart`, read back.
4. **Verify.** The runner reads `GET /api/cart` with the run's session cookies, derives the product page from the visited URLs and checkout from the final URL, and calls `verify()`. Status becomes `passed` or `failed`. A browser or model failure is `error`, never a verdict.
5. **Agent report.** `buildAgentReport()` writes `<runId>/report.json` and `report.md` (profile, checkpoints, cart, step log with evidence paths, failure point, the narrator's account, usage). The verdict and the report path are saved in one write and the terminal status is emitted last, so a poller never sees a finished run without its report.
6. **Mission report.** Whenever a run finishes, `buildMissionReport()` writes `missions/<missionId>/report.json` and `report.md`: the checkpoint x agent matrix, deterministic attribution, cost comparison, headline, recommendations. `GET /missions/:id/report` serves it (`?refresh=1` rebuilds).
7. **Watch.** `GET /runs/:id/events` streams `RunEvent`s over SSE until the terminal status; `GET /runs/:id` returns the full document for polling.
8. **Fix loop (partly built).** `POST /runs/:id/diagnose` → `diagnose()` → `Issue` (observed text from the verifier, inferred cause from the model). `POST /issues/:id/repair` → `Repair` (a diff limited to the store). `POST /repairs/:id/apply` applies it; today this path is the deterministic rule for Bug B. `POST /runs/:id/rematch` and `GET /runs/:id/compare/:otherId` produce the before/after. The repository connection routes clone a GitHub repo shallowly into `data/repositories/`; the code-fix agent ([CODEFIX.md](./CODEFIX.md)) consumes the reports and that snapshot and produces a code-validated diff, a pushed `agentproof/*` branch or a draft pull request. It never merges.

## Runner routes

| Route                                                                                          | What                                                                                                                                                                                                                                                             |
| ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /health`                                                                                  | liveness                                                                                                                                                                                                                                                         |
| `POST /missions`, `POST /missions/fixture`, `GET /missions/:id`                                | create and read a mission with its runs; `POST /missions` structures a prompt with the model or, with no prompt, derives one from the store's `/api/catalog.json` with no model call (400 for a bad or disallowed store address, 422 when the store has no feed) |
| `POST /missions/:id/runs`                                                                      | start runs for a list of agent kinds                                                                                                                                                                                                                             |
| `GET /missions/:id/report`, `GET /missions/:id/report.md`                                      | cross-agent mission report (JSON, Markdown)                                                                                                                                                                                                                      |
| `GET /runs`, `GET /runs/:id`, `GET /runs/:id/events`                                           | runs, one run, live SSE stream                                                                                                                                                                                                                                   |
| `GET /runs/:id/report`, `GET /runs/:id/report.md`                                              | agent report                                                                                                                                                                                                                                                     |
| `POST /runs/:id/diagnose`, `POST /issues/:id/repair`, `POST /repairs/:id/apply`                | diagnosis, repair proposal, apply                                                                                                                                                                                                                                |
| `POST /runs/:id/rematch`, `GET /runs/:id/compare/:otherId`                                     | rematch and comparison                                                                                                                                                                                                                                           |
| `POST /demo/hoodie`                                                                            | the preset Gamma demo mission                                                                                                                                                                                                                                    |
| `GET /artifacts/*`                                                                             | screenshots, aria snapshots, traces, reports (static; path traversal refused)                                                                                                                                                                                    |
| repository routes (`apps/runner/src/repository-routes.ts`)                                     | connect, inspect and disconnect a GitHub repo snapshot (localhost only)                                                                                                                                                                                          |
| `POST /runs/:id/codefix`, `GET /runs/:id/codefixes`                                            | start the code-fix agent on a failed run with a connected repository (localhost only), list its fixes                                                                                                                                                            |
| `GET /codefix/:id`, `/codefix/:id/events`, `/codefix/:id/report.md`, `/codefix/:id/patch.diff` | the fix record, its SSE stream, the Markdown rendering, the validated diff                                                                                                                                                                                       |

The request and response shapes are in `packages/shared/src/api.ts`; keep them in sync with `routes.ts` and `apps/web/src/lib/api.ts`.

## Design rules

- **Deterministic verdicts.** Checkpoint status is computed in `packages/verifier`. The model never decides pass or fail, never does budget arithmetic, never compares variant ids, never attributes.
- **Observed vs inferred.** `Issue.observed`, every checkpoint and every number in a report are written by code. The model writes only narratives and hypotheses, labelled as such.
- **One LLM door.** Every model call goes through `getLlm()` (`packages/agent/src/llm.ts`) with the provider-neutral types in `llm-types.ts`. Models come from `profiles.ts` per role, overridable with `AGENTPROOF_MODEL_<ROLE>`. Cost rule: the cheapest model everywhere, Sonnet only for Sigma, nothing defaults to Opus. Every call records `LlmUsage`.
- **Policy before action.** Every `AgentAction` passes `checkAction()` (allowed action types, allowed hosts, step cap, never a payment control) before Playwright touches it; a coordinate target is also checked against the element under the point.
- **Page content is untrusted.** Accessibility trees, page text and screenshots go to the model as data inside the user turn, never as instructions. The system prompt is fixed per agent kind.
- **Perception is the variable.** Alpha targets by role and exact accessible name only, Beta by coordinates only, Sigma by both. No text or CSS fallback, or Alpha would click past Bug A.
- **Repairs only target the store.** `applyRepair` refuses any path outside `config.storefrontDir` (today `apps/storefront`; an override for the exported repo is on the work plan).
- **Replays are labelled.** If the dashboard replays a persisted run, it says "recording", not "live".

## Planted storefront bugs

| Marker       | File                                            | What it breaks                                                             | Caught by                                                  |
| ------------ | ----------------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `DEMO BUG A` | `apps/storefront/src/views.ts`                  | Hoodie size picker is `<div>` chips with no role, label or keyboard access | Alpha (`correct_size_identified`)                          |
| `DEMO BUG B` | `apps/storefront/src/cart.ts`                   | `LEGACY_VARIANT_MAP` sends `HOODIE-001-M` to small on `POST /api/cart`     | Gamma (`catalog_variant_resolves`, `cart_matches_variant`) |
| `DEMO BUG C` | `apps/storefront/src/swatches.ts`, `catalog.ts` | Crewneck swatch names do not match swatch colors                           | Alpha (`correct_color_identified`)                         |
| `DEMO BUG D` | `apps/storefront/src/quantity-stepper.ts`       | Icon-only quantity stepper with no accessible names                        | Alpha (`cart_quantity_correct`)                            |
| `DEMO BUG E` | `apps/storefront/src/feature-layout.ts`         | Headphones buy box inside an `aria-hidden` stage                           | Alpha (`added_to_cart`)                                    |
| none         | canvas tote                                     | control product, no bug                                                    | every agent passes                                         |

The answer key with missions, snapshots, expected checkpoints and reference patches is `docs/storefront/bugs-and-fixes.md`; the grader is `docs/storefront/verify-scenarios.mjs`.

## Evidence on disk

```
data/
  agentproof.db                      SQLite (missions, runs, issues, repairs, repositories as JSON documents)
  artifacts/
    <runId>/
      step-NNN.png                   screenshot per step (every browser agent)
      step-NNN.aria.txt              accessibility snapshot per step (Alpha, Sigma)
      trace.zip                      Playwright trace (npx playwright show-trace)
      report.json, report.md         the agent report
    missions/<missionId>/
      report.json, report.md         the cross-agent mission report
    cli/<runId>/                     the same, for `pnpm cli` runs
    scripted/<runId>/                the same, for the scripted harness
  repositories/<id>/                 shallow bare clones from the repository connection (<id>.work: a worktree while a fix runs)
```

`Evidence.path` and the report paths are relative to `data/artifacts`; the runner serves them at `GET /artifacts/*`.

## Scripts

| Script                                       | What                                                                                                     |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `scripts/run-mission.mjs`                    | One scenario mission through the runner for a list of agents; prints verdicts, matrix, attribution, cost |
| `scripts/make-fixed-store.sh <dir>`          | Exports the store with the five reference patches applied into a sibling repo (tags `baseline`, `fixed`) |
| `scripts/codefix.mjs --run <runId>`          | Drives the code-fix agent for one failed run through the runner and prints the record                    |
| `docs/storefront/export-standalone.sh <dir>` | Exports the bugged store as its own repo, optionally with the hint comments stripped (`--blind`)         |
| `docs/storefront/verify-scenarios.mjs`       | Grader: semantic and mouse shoppers on every scenario; `STORE_URL` picks the store                       |
| `packages/agent/scripts/llm-smoke.ts`        | Provider and key check (`pnpm llm:smoke`)                                                                |
| `packages/agent/scripts/scripted-run.ts`     | The real browser loop driven by a scripted mock model (no tokens)                                        |

## Environment variables

See `.env.example` for the full list with defaults. The ones that matter: `ANTHROPIC_API_KEY` (the team key; `GROK_API_KEY`/`XAI_API_KEY` selects xAI, `AGENTPROOF_LLM_PROVIDER` forces one), `AGENTPROOF_MODEL_<ALPHA|BETA|SIGMA|NARRATOR|MISSION|DIAGNOSIS|CODEFIX|REVIEW>` and `AGENTPROOF_MODEL` (model overrides; defaults in `profiles.ts`), `STOREFRONT_PORT` and `STOREFRONT_URL` (5000 by default; macOS usually holds 5000, use 5050), `AGENTPROOF_ALLOWED_HOSTS` (default `localhost,127.0.0.1`), `AGENTPROOF_MAX_STEPS` (default 25), `PLAYWRIGHT_HEADED=1` for recording, `AGENTPROOF_LLM_DEBUG=1` for one line per model call (never keys or image data).
