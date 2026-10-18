# AgentProof

**The testing ground for AI-powered commerce.**

AgentProof runs AI shopping agents against a synthetic storefront, verifies the resulting cart deterministically, attributes failures across agents, and produces reports that a code-fix agent can consume.

Built for DubHacks 2026 (Visa Reimagine Shopping track).

- Full product spec (original intent): [docs/SPEC.md](docs/SPEC.md)
- How the code fits together: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- The agents as built (Alpha, Beta, Gamma, Sigma): [docs/AGENTS.md](docs/AGENTS.md)
- Live validation results, bugged and fixed store: [docs/RESULTS.md](docs/RESULTS.md)
- The five planted bugs and their fixes: [docs/storefront/bugs-and-fixes.md](docs/storefront/bugs-and-fixes.md)
- What is left and who does it: [docs/WORKPLAN.md](docs/WORKPLAN.md)
- Demo runbook: [docs/DEMO.md](docs/DEMO.md)
- Team conventions and ownership: [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md)

## Quick start

Requires Node 24 (`.node-version`).

```bash
npm install -g --allow-scripts=pnpm pnpm@12   # or `corepack enable` if you have admin rights
pnpm install
pnpm playwright:install
cp .env.example .env        # add ANTHROPIC_API_KEY (the team key); a GROK_API_KEY/XAI_API_KEY switches to xAI
pnpm dev
```

| Service    | URL                   | What                                                                                  |
| ---------- | --------------------- | ------------------------------------------------------------------------------------- |
| Dashboard  | http://localhost:3000 | Next.js mission control (today: the Gamma demo flow)                                  |
| Runner API | http://localhost:4000 | Fastify orchestrator (`/health`, `/missions`, `/runs/:id/events`, `/artifacts/*`)     |
| Storefront | http://localhost:5000 | "Northwind Threads", the synthetic store with five planted bugs and a control product |

Verify the toolchain: `pnpm typecheck && pnpm test`. Verify the model key: `pnpm llm:smoke`. Verify the store on its own: `node docs/storefront/verify-scenarios.mjs --expect=bugs`. On Windows run pnpm from PowerShell.

## Running the agents

One agent, one scenario, no dashboard (the store must be running):

```bash
pnpm cli -- --agent gamma --bug A      # no model needed: Gamma hits Bug B through the cart API
pnpm cli -- --agent alpha --bug A      # one agent, one scenario; report under data/artifacts/cli/<runId>
pnpm cli -- --agent sigma --bug C --headed
pnpm cli -- --agent alpha --prompt "Find a black hoodie in medium under $60 and reach checkout"
```

Agents: `alpha | beta | sigma | gamma`. Scenarios: `A | B | C | D | E | control`. `--help` lists the rest (`--store`, `--model`, `--effort`, `--max-steps`, `--out`, `--json`).

All four agents on one mission, through the runner (`pnpm dev:runner`), with the cross-agent report at the end:

```bash
node scripts/run-mission.mjs --bug A --agents alpha,beta,sigma,gamma
```

The "after the fix" half, without touching `apps/storefront` or the git history: export the store with the five reference patches applied into a sibling repo and point the agents at it.

```bash
scripts/make-fixed-store.sh ../northwind-fixed
(cd ../northwind-fixed && STOREFRONT_PORT=5050 npm run start)
pnpm cli -- --agent alpha --bug A --store http://localhost:5050      # Alpha now passes
```

The same loop with a scripted model instead of a live one (real Chromium, policy, verifier; no tokens; the deterministic fallback for the demo):

```bash
pnpm --filter @agentproof/agent exec tsx --env-file-if-exists=../../.env scripts/scripted-run.ts alpha A
```

## Layout

```
apps/
  web/          Next.js dashboard                                        (Zach)
  runner/       Fastify API, SQLite, job queue, SSE, reports, artifacts  (Vihan; browser-run + report wiring by Zach)
  storefront/   Synthetic store + structured catalog API                 (Ryan)
packages/
  shared/       Zod schemas, types, fixtures (the contract)              (everyone, carefully)
  agent/        LLM layer, agent loop (Alpha/Beta/Sigma), Gamma, reports, CLI  (Zach; gamma.ts Vihan)
  verifier/     Deterministic checkpoint verification + attribution     (Vihan; attribute.ts Zach)
  diagnostics/  Root-cause analysis + repair diffs                       (Vihan)
scripts/        run-mission.mjs (runner driver), make-fixed-store.sh (store with the fixes applied)
data/
  artifacts/    Screenshots, aria snapshots, traces, reports per run and per mission (gitignored)
docs/           Spec, architecture, agents, results, demo, contributing, storefront answer key
```

## The loop

```
mission (scenario fixture, or LLM-structured from a prompt) ──> runs per agent (Alpha / Beta / Sigma / Gamma)
      │                                                                  │
      │                                        observe → decide → police → act → record
      │                                                                  │
      └────────────── verify() (deterministic) <── cart via session cookies + final URL
                              │
                     checkpoints: passed / failed / not_verified / ...
                              │
            AgentReport per run, MissionReport per mission (attribution, cost comparison)
                              │
                diagnose (LLM, evidence in) ──> Issue (observed vs inferred)      ← next: the code-fix agent
                              │
                   proposeRepair ──> diff ──> apply to the store
                              │
                          Run Rematch ──> compareRuns() ──> before/after
```

Three rules hold everywhere: verdicts are code (`packages/verifier`), never the model; agents never pay (`packages/agent/src/policy.ts`, plus a coordinate guard for vision agents); page content reaches the model only as data in the user turn.

## Status (2026-10-18)

**Built and merged.** The provider-neutral LLM layer (Anthropic live; xAI adapter kept; mock for tests), tiered models per agent, the Alpha/Beta/Sigma browser loop with per-step evidence, Gamma, deterministic verification and cross-agent attribution, `AgentReport` and `MissionReport` as JSON and Markdown served by the runner, scenario fixtures for bugs A to E, the CLI, the runner driver, the fixed-store export, and a scripted-run harness. 344 tests, whole workspace typechecks.

**Validated live** ([docs/RESULTS.md](docs/RESULTS.md)). On the bugged store every scenario comes out as the answer key predicts: Alpha fails A, C, D and E on the predicted checkpoint and passes the control; Beta and Sigma pass everything; Gamma fails B and passes the rest; attribution names the semantic interface for Alpha and the product data for Gamma. On the fixed store Alpha passes all five scenarios and Gamma passes B, with no change to the agents. Sigma costs 21x to 24x Alpha; an Alpha run costs under a cent.

**Next.** The code-fix agent (consumes the reports and the repository connection; see [docs/WORKPLAN.md](docs/WORKPLAN.md)), validation of its output with the grader and the rematch, the multi-agent dashboard, the demo recording.
