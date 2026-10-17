# Architecture

Engineering companion to [SPEC.md](./SPEC.md). This describes what is actually in the repo and how the pieces talk to each other.

## Runtime topology (local dev)

```
 browser (you)                    browser (Playwright, headless)
      |                                      ^
      v                                      | drives
+-------------+   HTTP/JSON + SSE   +-----------------+   HTTP    +------------------+
|  apps/web   | ------------------> |   apps/runner   | --------> |  apps/storefront |
|  Next.js    |                     |   Fastify       |           |  Fastify + HTML  |
|  :3000      | <------------------ |   :4000         |           |  :5000           |
+-------------+                     +--------+--------+           +------------------+
                                             |
                       +---------------------+---------------------+
                       |                     |                     |
               packages/agent        packages/verifier    packages/diagnostics
               Claude + Playwright   pure TypeScript       Claude
                       |
                 data/agentproof.db (SQLite)   data/artifacts/<runId>/ (png, trace.zip)
```

All three services read `.env` at the repo root (via `tsx --env-file-if-exists` and Next's own loader).

## Packages

| Package                   | Depends on                            | What lives there                                                                                                                                     |
| ------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@agentproof/shared`      | zod                                   | Every schema and type. `Mission`, `Run`, `Checkpoint`, `Evidence`, `Issue`, `Repair`, `RunEvent`, API request/response shapes, id helpers, fixtures. |
| `@agentproof/verifier`    | shared                                | `verify()` turns a mission + observed cart/page facts into checkpoints. `compareRuns()` builds the rematch delta table. No network, no LLM.          |
| `@agentproof/agent`       | shared, @anthropic-ai/sdk, playwright | `getClaude()` client, `generateMission()` (structured output), browser agent loop skeleton, policy checks, Gamma inspector.                          |
| `@agentproof/diagnostics` | shared, agent                         | `diagnose()` (Claude, evidence in / `Issue` out) and `proposeRepair()` / `applyRepair()`.                                                            |

Packages are consumed as raw TypeScript (`exports` point at `src/index.ts`). `tsx` runs them directly in the Node apps; Next compiles them through `transpilePackages`. There is no build step.

## Data flow for one test

1. **POST /missions** `{ storeUrl, prompt }` → `generateMission()` asks Claude for a `MissionDraft` using `output_config.format` so the response is schema-valid. Server fills `id`, `createdAt`, `storeUrl`, `rawPrompt`. Saved to SQLite.
2. **POST /missions/:id/runs** `{ agents: ['alpha_semantic', ...] }` → one `Run` per agent, status `queued`, pushed into the in-process job queue (`apps/runner/src/jobs.ts`, concurrency 2).
3. **Executor** (`executeRun`):
   - Alpha/Beta: `runBrowserAgent()` loop → `observe` → `decide` (Claude) → `checkAction` (policy) → `act` (Playwright) → `RunStep` + `Evidence`. Each step is persisted and published on the event bus.
   - Gamma: `runGamma()` reads `/api/catalog.json`, exercises `/api/cart`, compares.
4. **Verify**: runner assembles `VerificationInput` (observed cart from `/api/cart` with the session cookies, product page facts, checkout reached) and calls `verify()`. Status becomes `passed` or `failed`.
5. **GET /runs/:id/events** streams `RunEvent`s as SSE until a terminal status. **GET /runs/:id** returns the full document for polling or reload.
6. **POST /runs/:id/diagnose** → `diagnose()` with the first failed checkpoint and its evidence → `Issue` (observed text comes from the verifier, inferred cause from Claude).
7. **POST /issues/:id/repair** → `proposeRepair()` → unified diff limited to `apps/storefront`. **POST /repairs/:id/apply** applies it with `git apply`; `tsx watch` reloads the store.
8. **POST /runs/:id/rematch** → new `Run` with `label: 'rematch'`, `parentRunId`. **GET /runs/:id/compare/:otherId** → `RunComparison`.

## Design rules

- **Deterministic verdicts.** Checkpoint status is computed in `packages/verifier`. Claude never decides pass/fail, never does budget arithmetic, never compares variant ids.
- **Observed vs inferred.** `Issue.observed` is written by code. `Issue.inferredCause`, `confidence`, `suggestedRepair` come from Claude and are rendered as hypotheses in the UI.
- **Policy before action.** Every `AgentAction` passes `checkAction()` (allowed action types, allowed hosts, step cap, never click payment controls) before Playwright touches it.
- **Page content is untrusted.** Accessibility trees, page text, and screenshots go to Claude as data inside the user turn, never as instructions. Keep the system prompt fixed.
- **Repairs only target `apps/storefront`.** `applyRepair` must refuse any path outside `config.storefrontDir`.
- **Replays are labeled.** If the dashboard replays a persisted run, it says "recording", not "live".

## Planted storefront bugs

| Marker         | File                             | What it breaks                                                                 | Caught by                |
| -------------- | -------------------------------- | ------------------------------------------------------------------------------ | ------------------------ |
| `DEMO BUG A`   | `apps/storefront/src/views.ts`   | Size picker is `<div>` chips with no role/label/keyboard support               | Agent Alpha (semantic)   |
| `DEMO BUG B`   | `apps/storefront/src/cart.ts`    | `LEGACY_VARIANT_MAP` sends `HOODIE-001-M` to the small variant on the API path | Agent Gamma (structured) |
| Example C data | `apps/storefront/src/catalog.ts` | Headphones advertised "from $89", wireless config is $119                      | Verifier budget check    |

The repair for A is a semantic radio group; the repair for B is deleting or fixing the map entry. Both are small, reviewable diffs.

## Evidence on disk

```
data/
  agentproof.db              SQLite (missions, runs, issues, repairs as JSON documents)
  artifacts/<runId>/
    step-000.png             screenshot per step
    trace.zip                Playwright trace (open with `npx playwright show-trace`)
```

`Evidence.path` is relative to `data/artifacts`. The runner should expose it as static files (TODO) so the dashboard can show screenshots.

## Environment variables

See `.env.example`. The important ones: `ANTHROPIC_API_KEY`, `AGENTPROOF_MODEL` (default `claude-opus-5-5`), `AGENTPROOF_ALLOWED_HOSTS` (default `localhost,127.0.0.1`), `PLAYWRIGHT_HEADED=1` for recording video.
