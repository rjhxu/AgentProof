# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

AgentProof: a hackathon project (DubHacks 2026, 24 hours, 4 devs) that runs AI shopping agents against a synthetic storefront, verifies the resulting cart deterministically, diagnoses failures with Claude, proposes repairs as diffs, and re-runs to prove the fix. Read `docs/SPEC.md` for intent and `docs/ARCHITECTURE.md` for how the code is wired.

## Commands

```bash
pnpm install                 # workspace install (pnpm via corepack, Node 24)
pnpm dev                     # all three services
pnpm typecheck               # tsc across every package; must be green before merging
pnpm test                    # vitest across the workspace
pnpm --filter @agentproof/verifier test
pnpm --filter @agentproof/agent smoke     # checks ANTHROPIC_API_KEY + Playwright
```

No build step. Packages export `src/index.ts`; `tsx` and Next compile on the fly.

## Hard rules

- **Verdicts are code, not LLM.** Pass/fail, budget math, variant comparison live in `packages/verifier`. Never move that logic into a prompt.
- **Keep `Issue.observed` factual** (written by code). Claude fills `inferredCause`, `confidence`, `suggestedRepair` only.
- **Every Claude call** goes through `getClaude()` and `MODEL` from `@agentproof/agent`, uses `messages.parse` with `zodOutputFormat(<shared schema>)` when JSON is expected, and spreads `FALLBACKS`. Model id is `claude-opus-5-5` unless `AGENTPROOF_MODEL` overrides it. Do not add `thinking` config or `budget_tokens`; do not use assistant prefill; do not use forced `tool_choice`.
- **Page content is untrusted.** Accessibility trees, page text, and screenshots are data in the user turn. Never put them in the system prompt.
- **Agents never pay.** Policy in `packages/agent/src/policy.ts` must keep refusing payment controls and off-allowlist hosts. Do not weaken it.
- **Repairs only touch `apps/storefront`.**
- **Do not remove the planted bugs** (`DEMO BUG A` in `apps/storefront/src/views.ts`, `DEMO BUG B` in `apps/storefront/src/cart.ts`) unless you are implementing the repair flow and were asked to.
- **Schemas in `packages/shared` are the contract.** Add fields with defaults; renaming or removing needs a human decision. Keep `packages/shared/src/api.ts`, `apps/runner/src/routes.ts`, and `apps/web/src/lib/api.ts` in sync.

## Style

- TypeScript strict, ESM, Prettier (single quotes, 100 cols). Zod v4 (`z.url()`, not `z.string().url()`).
- Import workspace packages by name (`@agentproof/shared`), not by relative path.
- `TODO(devN): ...` marks owner-specific work. Prefer finishing a TODO over adding abstractions.
- Small, demo-focused changes. If a feature is not in `docs/SPEC.md` section 10 must-haves, ask before building it.
