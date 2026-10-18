# AgentProof

**The testing ground for AI-powered commerce.**

AgentProof runs AI shopping agents against a synthetic storefront, verifies the resulting cart deterministically, attributes failures across agents, and produces reports that a code-fix agent can consume.

Built for DubHacks 2026 (Visa Reimagine Shopping track).

- Full product spec: [docs/SPEC.md](docs/SPEC.md)
- How the code fits together: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- Team conventions and ownership: [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md)
- Demo runbook: [docs/DEMO.md](docs/DEMO.md)
- Who builds what: [docs/WORKPLAN.md](docs/WORKPLAN.md)
- The agents as built (Alpha, Beta, Gamma, Sigma): [docs/AGENTS.md](docs/AGENTS.md)
- Agent implementation plan and status: [docs/AGENTS-IMPLEMENTATION-PLAN.md](docs/AGENTS-IMPLEMENTATION-PLAN.md)
- The five planted bugs: [docs/storefront/bugs-and-fixes.md](docs/storefront/bugs-and-fixes.md)

## Quick start

Requires Node 24 (`.node-version`). Docker is optional.

```bash
npm install -g --allow-scripts=pnpm pnpm@12   # or `corepack enable` if you have admin rights
pnpm install
pnpm playwright:install
cp .env.example .env        # add ANTHROPIC_API_KEY (the team key); a GROK_API_KEY/XAI_API_KEY switches to xAI
pnpm dev
```

| Service    | URL                   | What                                                                                  |
| ---------- | --------------------- | ------------------------------------------------------------------------------------- |
| Dashboard  | http://localhost:3000 | Next.js mission control                                                               |
| Runner API | http://localhost:4000 | Fastify orchestrator (`/health`, `/missions`, `/runs/:id/events`, `/artifacts/*`)     |
| Storefront | http://localhost:5000 | "Northwind Threads", the synthetic store with five planted bugs and a control product |

Verify the toolchain: `pnpm typecheck && pnpm test`. Verify the model key: `pnpm llm:smoke`. The store on its own: `node docs/storefront/verify-scenarios.mjs --expect=bugs`.

## Running one agent

With the store running:

```bash
pnpm cli -- --agent gamma --bug A      # no model needed: Gamma hits Bug B through the cart API
pnpm cli -- --agent alpha --bug A      # one agent, one scenario; report under data/artifacts/cli/<runId>
pnpm cli -- --agent sigma --bug C --headed
pnpm cli -- --agent alpha --prompt "Find a black hoodie in medium under $60 and reach checkout"
```

Agents: `alpha | beta | sigma | gamma`. Scenarios: `A | B | C | D | E | control`. `--help` lists the rest (`--store`, `--model`, `--effort`, `--max-steps`, `--out`, `--json`).

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
data/
  artifacts/    Screenshots, aria snapshots, traces, reports per run (gitignored)
docs/           Spec, architecture, agents, contributing, demo, storefront answer key
```

## The loop

```
mission prompt ──> Mission (LLM, structured) ──> runs per agent (Alpha / Beta / Sigma / Gamma)
      │                                                     │
      │                                   observe → decide → police → act → record
      │                                                     │
      └────────────── verify() (deterministic) <── cart via session cookies + final URL
                              │
                     checkpoints: passed / failed / not_verified / ...
                              │
            AgentReport per run, MissionReport per mission (attribution, cost comparison)
                              │
                diagnose (LLM, evidence in) ──> Issue (observed vs inferred)
                              │
                   proposeRepair ──> diff ──> apply to apps/storefront
                              │
                          Run Rematch ──> compareRuns() ──> before/after
```

Three rules hold everywhere: verdicts are code (`packages/verifier`), never the model; agents never pay (`packages/agent/src/policy.ts`, plus a coordinate guard for vision agents); page content reaches the model only as data in the user turn.

## Status (2026-10-17)

**Implemented.** The LLM layer (`packages/agent/src/llm.ts`: xAI Grok through the Responses API with strict JSON schema and per-request cost; Anthropic fallback; mock for tests), tiered models per agent (`profiles.ts`), the Alpha/Beta/Sigma browser loop with per-step evidence (`step-NNN.png`, `step-NNN.aria.txt`, `trace.zip`), Gamma, deterministic cross-agent attribution, `AgentReport` and `MissionReport` written as JSON and Markdown and served by the runner, scenario fixtures for bugs A to E, the CLI, and a scripted-run harness. See [docs/AGENTS.md](docs/AGENTS.md).

**Validated.** The workspace typechecks and 333 tests pass. Gamma through the CLI and the scripted Alpha run reproduce the Bug A outcome against the live store (size S in the cart, checkout reached, `correct_size_identified` and `cart_matches_variant` fail). Live model-driven runs on bug A with the Anthropic key: Alpha (`claude-haiku-5-5`, text only) fails because no size control exists in the accessibility tree, at about $0.002; Beta (`claude-haiku-5-5`, screenshots) passes by clicking the chips, at about $0.003; Sigma (`claude-sonnet-5-5`, all senses) passes at about $0.05. That cost gap is the thesis.

**Gamma milestone, end to end without a model key.** Run the preset hoodie mission in the dashboard, inspect live catalog/cart evidence, review and apply the targeted mapping repair, then run a rematch and compare checkpoints. Start all three services with `pnpm dev`; storefront watch mode is required to reload repairs. Failed Gamma runs also prompt for GitHub repository access (public repo or temporary read token; tokens are not persisted). See [docs/DEMO.md](docs/DEMO.md).

**Not yet.** Live Alpha/Beta/Sigma runs on bugs A to E and prompt tuning from them (needs credits); a separate repo for the storefront; the code-fix agent that consumes the reports and the repository connection; the final dashboard; the demo recording. The Gamma diagnosis and repair is a deterministic rule for the known hoodie bug, not a model-generated fix.
