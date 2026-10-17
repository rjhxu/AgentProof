# AgentProof

**The testing ground for AI-powered commerce.**

AgentProof tests whether AI shopping agents can reliably purchase from online stores, diagnoses compatibility failures, and verifies that proposed repairs work.

Built for DubHacks 2026 (Visa Reimagine Shopping track).

- Full product spec: [docs/SPEC.md](docs/SPEC.md)
- How the code fits together: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- Team conventions and ownership: [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md)
- Demo runbook: [docs/DEMO.md](docs/DEMO.md)
- Who builds what, hour by hour: [docs/WORKPLAN.md](docs/WORKPLAN.md)

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

Scaffold. Schemas, verifier, storefront, runner API surface, and dashboard shell are in place. See `TODO(zach|ryan|vihan)` markers and [docs/WORKPLAN.md](docs/WORKPLAN.md) for what each owner picks up first.
