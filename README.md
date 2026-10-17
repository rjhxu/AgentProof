# AgentProof

**The testing ground for AI-powered commerce.**

AgentProof tests whether AI shopping agents can reliably purchase from online stores, diagnoses compatibility failures, and verifies that proposed repairs work.

Built for DubHacks 2026 (Visa Reimagine Shopping track).

- Full product spec: [docs/SPEC.md](docs/SPEC.md)
- How the code fits together: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- Team conventions and ownership: [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md)
- Demo runbook: [docs/DEMO.md](docs/DEMO.md)
- Who builds what, hour by hour: [docs/WORKPLAN.md](docs/WORKPLAN.md)
- Agent design and capabilities (Alpha, Beta, Gamma): [docs/AGENTS.md](docs/AGENTS.md)

## Quick start

Requires Node 24 (`.node-version`). Docker is optional.

```bash
npm install -g --allow-scripts=pnpm pnpm@12   # or `corepack enable` if you have admin rights
pnpm install
pnpm playwright:install
cp .env.example .env        # add ANTHROPIC_API_KEY
pnpm dev
```

| Service    | URL                   | What                                                              |
| ---------- | --------------------- | ----------------------------------------------------------------- |
| Dashboard  | http://localhost:3000 | Next.js mission control                                           |
| Runner API | http://localhost:4000 | Fastify orchestrator (`/health`, `/missions`, `/runs/:id/events`) |
| Storefront | http://localhost:5000 | "Northwind Threads", the synthetic store with planted bugs        |

Verify the toolchain: `pnpm typecheck && pnpm test`. Verify the API key and browser: `pnpm --filter @agentproof/agent smoke`.

## Layout

```
apps/
  web/          Next.js dashboard                         (Zach)
  runner/       Fastify API, SQLite, job queue, SSE       (Vihan)
  storefront/   Synthetic store + structured catalog API  (Vihan)
packages/
  shared/       Zod schemas, types, fixtures              (everyone, carefully)
  agent/        Claude + Playwright agents, policy        (Ryan)
  verifier/     Deterministic checkpoint verification    (Vihan)
  diagnostics/  Root-cause analysis + repair diffs        (Vihan)
data/
  artifacts/    Screenshots and traces per run (gitignored)
docs/           Spec, architecture, contributing, demo
```

## The loop

```
mission prompt ──> Mission (Claude, structured) ──> runs per agent (Alpha / Beta / Gamma)
      │                                                     │
      │                                   observe → decide → policy → act → record
      │                                                     │
      └────────────── verify() (deterministic) <── observed cart + page facts
                              │
                     checkpoints: passed / failed / not_verified / ...
                              │
                diagnose (Claude, evidence in) ──> Issue (observed vs inferred)
                              │
                   proposeRepair ──> diff ──> apply to apps/storefront
                              │
                          Run Rematch ──> compareRuns() ──> before/after
```

## Status

The Gamma milestone works end to end without an API key: run the preset hoodie mission in the dashboard, inspect live catalog/cart evidence, review and apply the targeted mapping repair, then run a rematch and compare checkpoints. Start all three services with `pnpm dev`; storefront watch mode is required to reload repairs. See [docs/DEMO.md](docs/DEMO.md).

Failed Gamma runs also prompt for GitHub repository access. Connect a public repo or provide a temporary read token for a private repo; the runner saves a source snapshot and displays its branch, commit, and file inventory. Tokens are not persisted. Model-generated suggestions will be added separately.

Shared schemas, deterministic verification, SQLite persistence, and the synthetic storefront are implemented. Alpha/Beta browser execution and general AI-generated repairs remain unfinished. The Gamma diagnosis/repair is a deterministic rule for the known hoodie bug, not an AI-generated fix.
