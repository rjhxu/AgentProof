# Architecture

How the pieces fit together. The agents are described in [AGENTS.md](AGENTS.md), the fix pipeline in [CODEFIX.md](CODEFIX.md), and the security model in [SECURITY.md](SECURITY.md).

## Topology

```
 browser (operator)                       headless Chromium (Playwright)
      |                                              ^
      v                                              | drives
+-------------+   HTTP/JSON + SSE   +-----------------+   HTTP    +------------------------+
|  apps/web   | ------------------> |   apps/runner   | --------> |  store under test       |
|  Next.js    | <------------------ |   Fastify       |           |  (apps/storefront :5000 |
|  :3000      |                     |   :4000         |           |   in development)       |
+-------------+                     +--------+--------+           +------------------------+
                                             |                         ^
         +-------------------+---------------+-----------+             | clone, draft PR
         |                   |               |           |             |
   packages/agent    packages/verifier  packages/   packages/codefix --> GitHub (App or token)
   getLlm(), agents  pure verdicts      diagnostics
         |
   data/agentproof.db (SQLite)    data/artifacts/ (evidence, reports)    data/repositories/ (bare clones)
```

All services read `.env` at the repo root. There is no build step: packages are raw TypeScript run by `tsx`, and Next compiles `@agentproof/shared` through `transpilePackages`.

## Packages

| Package                   | Depends on    | Responsibility                                                                                                                                                                                                                        |
| ------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@agentproof/shared`      | zod           | Every schema and type (`Mission`, `Run`, `RunStep`, `Checkpoint`, `Evidence`, `Issue`, `CodeFix`, `AgentReport`, `MissionReport`, API shapes), id helpers and fixtures. The contract between packages.                                |
| `@agentproof/verifier`    | shared        | `verify()` turns a mission plus observed facts into checkpoints. `attributeMission()` and `recommendationsFrom()` handle attribution, and `compareRuns()` builds the rematch delta. No network, no model.                             |
| `@agentproof/agent`       | shared        | `getLlm()` (Anthropic, xAI and mock adapters), per-role models and prices (`profiles.ts`), the browser loop for Alpha, Beta and Sigma, Gamma, the action policy, reports and narration, scenarios, the mission generator and the CLI. |
| `@agentproof/diagnostics` | shared, agent | `diagnose()`: evidence in, an `Issue` out, with code-written `observed` facts and a model-written hypothesis.                                                                                                                         |
| `@agentproof/codefix`     | shared, agent | The code-fix agent: evidence bundle, file localization, proposer and reviewer calls, edits to a diff, scope and content checks, the toolchain runners, the allowlisted GitHub client, GitHub App auth and the Markdown record.        |

| App               | Responsibility                                                                                                                                                                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/runner`     | HTTP API (`routes.ts`), job queue and run execution (`jobs.ts`), reports (`reports.ts`), SSE (`events.ts`), SQLite (`db.ts`), repository connection, code-fix orchestrator (`codefix.ts`) and GitHub App routes.                     |
| `apps/web`        | The dashboard. `/` is the four-step flow (Store, Scan, Findings, Fixes) in `src/live/`, `/gamma` is the single-agent Gamma flow, and `/design/flow` is a fixture-only sandbox. It talks to the runner only through `src/lib/api.ts`. |
| `apps/storefront` | "Northwind Threads", the synthetic test store with five planted bugs and a control product. It exposes `/api/catalog.json`, `/api/variants/:id` and `/api/cart`.                                                                     |

## Run lifecycle

1. **Mission.** `POST /missions { storeUrl, prompt? }` creates the mission. With a prompt, `generateMission()` structures it through a strict JSON schema. Without one, the runner derives a mission from the store's `/api/catalog.json` with no model call. `POST /missions/fixture { bug }` loads a test scenario instead.
2. **Runs.** `POST /missions/:id/runs { agents }` creates one `Run` per agent kind and enqueues it. The queue is in-process with concurrency 2.
3. **Execute.** Browser agents loop: observe, `decide()` (one `getLlm()` call returning a strict `AgentActionDraft`), `checkAction()` (policy), act (Playwright), record (`RunStep` and `Evidence`, persisted and streamed). Gamma reads the catalog, posts to the cart API and reads the cart back.
4. **Verify.** The runner reads `GET /api/cart` with the run's session cookies, derives the product page and checkout from the visited URLs, and calls `verify()`. The status becomes `passed` or `failed`. A browser or model failure becomes `error`, never a verdict.
5. **Report.** `buildAgentReport()` writes the run report. `buildMissionReport()` writes the cross-agent report: the checkpoint × agent matrix, attribution, cost comparison and recommendations. The verdict and the report path are saved in one write, and the terminal status is emitted last.
6. **Diagnose.** `POST /runs/:id/diagnose` returns an `Issue`.
7. **Fix.** `POST /runs/:id/repository` connects a GitHub repository (a bare, shallow clone). `POST /runs/:id/codefix` runs the code-fix pipeline and delivers a diff, an `agentproof/*` branch or a draft pull request. With `rematch: true`, the failing agent reruns against the patched store and the record carries the before/after `RunComparison`.

## API

Request and response shapes are in `packages/shared/src/api.ts` and `codefix.ts`. Keep them in sync with `apps/runner/src/routes.ts` and `apps/web/src/lib/api.ts`.

| Route                                                                                                  | Purpose                                                                                           |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `GET /health`                                                                                          | Liveness                                                                                          |
| `POST /missions`, `POST /missions/fixture`, `GET /missions/:id`                                        | Create or read a mission and its runs (400 for a disallowed host, 422 for a store without a feed) |
| `POST /missions/:id/runs`                                                                              | Start runs for a list of agent kinds                                                              |
| `GET /missions/:id/report`, `/report.md`                                                               | Cross-agent mission report (`?refresh=1` rebuilds it)                                             |
| `GET /runs`, `GET /runs/:id`, `GET /runs/:id/events`                                                   | Runs, one run, and a live SSE stream (load `GET /runs/:id` first; the stream does not replay)     |
| `GET /runs/:id/report`, `/report.md`                                                                   | Agent report                                                                                      |
| `POST /runs/:id/diagnose`                                                                              | Diagnosis                                                                                         |
| `POST /runs/:id/rematch`, `GET /runs/:id/compare/:otherId`                                             | Rerun and before/after comparison                                                                 |
| `POST /issues/:id/repair`, `POST /repairs/:id/apply`, `POST /demo/hoodie`                              | The deterministic Gamma demo repair (Bug B only)                                                  |
| `POST`/`GET`/`DELETE /runs/:id/repository` \*                                                          | Connect, inspect or disconnect a GitHub repository snapshot                                       |
| `POST /runs/:id/codefix` \*, `GET /runs/:id/codefixes`                                                 | Start a fix on a failed run, or list its fixes                                                    |
| `GET /codefix/:id`, `/events`, `/report.md`, `/patch.diff`                                             | Fix record, SSE stream, Markdown rendering, validated diff                                        |
| `GET /github/app` \*, `/github/app/setup` \*, `/github/app/callback` \*, `/github/app/repositories` \* | GitHub App status (never the key), one-click registration, and installed repositories             |
| `GET /artifacts/*`                                                                                     | Screenshots, snapshots, traces and reports (path traversal refused)                               |

\* Loopback callers only.

## Storage

SQLite tables (`missions`, `runs`, `issues`, `repairs`, `repositories`, `codefixes`) hold whole JSON documents, parsed through the shared Zod schemas on every read and write. After a non-additive schema change, delete `data/agentproof.db`.

```
data/
  agentproof.db
  artifacts/                         paths in Evidence and reports are relative to here; served at /artifacts/*
    <runId>/                         step-NNN.png, step-NNN.aria.txt, trace.zip, report.json, report.md
    missions/<missionId>/            report.json, report.md
    codefix/<fixId>/                 codefix.json, codefix.md, patch.diff
    cli/<runId>/, scripted/<runId>/  the same, for CLI and scripted runs
  repositories/<id>/                 bare shallow clones (<id>.work: a worktree while a fix runs)
```

## Scripts

| Script                                       | Purpose                                                                               |
| -------------------------------------------- | ------------------------------------------------------------------------------------- |
| `scripts/run-mission.mjs`                    | Run one scenario through the runner for a list of agents and print the mission report |
| `scripts/codefix.mjs --run <runId>`          | Drive the code-fix agent for one failed run and print the record                      |
| `scripts/make-fixed-store.sh <dir>`          | Export the store with the reference patches applied, as a sibling repo                |
| `docs/storefront/export-standalone.sh <dir>` | Export the bugged store as its own repo (`--blind` strips the hint comments)          |
| `docs/storefront/verify-scenarios.mjs`       | Independent grader: a semantic shopper and a mouse shopper on every scenario          |
| `pnpm llm:smoke`                             | Provider and key check                                                                |
| `packages/agent/scripts/scripted-run.ts`     | The real browser loop with a scripted model (no tokens), as a deterministic fallback  |

## Configuration

`.env.example` lists every variable with its default. The main ones:

| Variable                                      | Purpose                                                                                                                                                      |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ANTHROPIC_API_KEY`                           | Model provider. `GROK_API_KEY`/`XAI_API_KEY` selects xAI instead, and `AGENTPROOF_LLM_PROVIDER` forces one.                                                  |
| `AGENTPROOF_MODEL_<ROLE>`, `AGENTPROOF_MODEL` | Model override per role (`ALPHA`, `BETA`, `SIGMA`, `NARRATOR`, `MISSION`, `DIAGNOSIS`, `CODEFIX`, `REVIEW`) or for all roles. Defaults are in `profiles.ts`. |
| `AGENTPROOF_GITHUB_APP_*`                     | GitHub App id, private key (or key file) and slug, written by `/github/app/setup`                                                                            |
| `AGENTPROOF_ALLOWED_HOSTS`                    | Hosts the agents may visit (default `localhost,127.0.0.1`)                                                                                                   |
| `AGENTPROOF_MAX_STEPS`                        | Step cap per run (default 25)                                                                                                                                |
| `STOREFRONT_PORT`, `STOREFRONT_URL`           | Test store address (default 5000; macOS holds 5000, so use 5050)                                                                                             |
| `AGENTPROOF_DATA_DIR`                         | Where the database, artifacts and clones live (default `./data`)                                                                                             |
| `PLAYWRIGHT_HEADED`, `AGENTPROOF_LLM_DEBUG`   | Show the browser, or log one line per model call (never keys or image data)                                                                                  |
