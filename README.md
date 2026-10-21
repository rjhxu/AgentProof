# AgentProof

**Find out whether AI shopping agents can buy from your store, and get the fix as a pull request.**

Built at DubHacks 2026 (Visa: Reimagine Shopping).

## The problem

Customers are starting to shop through AI agents: "find a black hoodie in medium under $60 and add it to my cart." Stores were built for people with a mouse, and a store that works for a person can fail an agent without anyone noticing:

- **Agents perceive stores differently.** Some read the accessibility tree, some read screenshots, some call catalog and cart APIs. A size picker built from unlabeled `<div>`s looks fine on screen and does not exist for a tree-reading agent.
- **A successful click is not a correct purchase.** The agent can reach checkout with the wrong size in the cart. Nothing errors.
- **Merchants can't test for it.** Accessibility linters and UI tests don't answer the business question: _can this kind of agent complete this customer's request on my store?_ When it fails, nobody can say why, and nobody can prove a fix works.

The result is lost sales and wrong orders from a channel the merchant can't see.

## What AgentProof does

1. **Scan.** Paste a store URL. AgentProof derives a shopping mission from the store's catalog, or from a goal you type, and sends four agents after it. Each agent stands for one way real agents perceive a store.
2. **Verify.** Code, not a model, reads the final cart through the session and checks it against the mission: product, size, color, quantity, budget, checkout reached. The agents never pay.
3. **Attribute.** A deterministic rule compares the agents. If the strongest agent passes and the cheapest fails, the store has a semantic interface problem. If the browser agents pass and the API agent fails, the product data disagrees with the page.
4. **Fix.** Connect the store's GitHub repository. The code-fix agent finds the cause, writes a minimal change, validates it with code, reruns the failing agent against the patched store, and opens a **draft** pull request. It cannot merge.

| Agent     | Perceives                          | Stands in for                               | Default model     |
| --------- | ---------------------------------- | ------------------------------------------- | ----------------- |
| **Alpha** | accessibility tree and page text   | DOM and accessibility-tree agents           | Claude Haiku, low |
| **Beta**  | screenshots, clicks by coordinates | computer-use agents                         | Claude Sonnet     |
| **Gamma** | catalog JSON and cart API          | protocol and feed-based agents (no browser) | none (zero cost)  |
| **Sigma** | all of the above                   | the most capable agent; the reference       | Claude Sonnet     |

The thesis: **a store should work for the cheapest agent.** Every report shows the cost next to each verdict.

## Results

Validated live against "Northwind Threads", a synthetic store with five planted agent-compatibility bugs and a control product ([details](docs/RESULTS.md)):

- Every bug was caught by the agent the answer key predicts, on the predicted checkpoint. The control passed for all four agents.
- The code-fix agent fixed all five bugs **on the first attempt**, each in one file and 1 to 9 changed lines. Each fix was proven by a real rerun and by an independent grader, and delivered as a draft pull request.
- Each fix cost under half a cent of model time. All five scenarios end to end, with failing runs, fixes and proof reruns, cost about $0.04. Sigma costs 21 to 24 times what Alpha does.

## Architecture

```
 apps/web (Next.js :3000) ──HTTP + SSE──> apps/runner (Fastify :4000) ──Playwright / HTTP──> store under test
                                              │
          ┌───────────────┬──────────────────┼──────────────────┬────────────────┐
   packages/agent   packages/verifier   packages/diagnostics   packages/codefix   packages/shared
   LLM layer, the   verdicts and        diagnosis (model,      evidence in,       Zod schemas:
   four agents,     attribution (pure   labelled as a          validated diff /   the contract
   reports          code, no model)     hypothesis)            draft PR out
                                              │
                         SQLite (data/agentproof.db) + evidence files (data/artifacts/)
```

- **apps/runner** queues runs, drives the agents, verifies, writes reports, streams progress over SSE, and runs the code-fix pipeline.
- **apps/storefront** is the synthetic test store with its planted bugs. It is the demo target, not part of the product.
- Every model call goes through one door (`getLlm()`) with per-role models, strict JSON output validated by Zod, and token and cost accounting on every call. Anthropic is the default provider; an xAI adapter and a mock exist.

More: [ARCHITECTURE.md](docs/ARCHITECTURE.md) (data flow, routes, storage), [AGENTS.md](docs/AGENTS.md) (the agents), [CODEFIX.md](docs/CODEFIX.md) (the fix pipeline).

## Security

The trust model rests on three rules: **code decides verdicts, agents never pay, and nothing merges without a human.**

- **Verdicts are code.** Pass, fail, budget math and attribution live in `packages/verifier`. Model output is shown as a labelled hypothesis, never as a status.
- **Agents never pay.** A policy check runs before every action: allowed hosts, allowed action types, step cap, and a ban on payment controls. Coordinate clicks are checked against the element under the point.
- **Page and repository content are untrusted.** Page content reaches the model as data, never as instructions. Repository text is sanitized, scanned for injections and secrets, and fenced with a per-fix nonce.
- **Model edits are validated by code.** Paths must stay in scope, dependencies can't change, size is bounded, a content policy applies, and the diff must pass `git apply`, `tsc` and an optional real rerun before it is delivered.
- **Least-privilege GitHub access.** A GitHub App mints one-hour tokens scoped to one repository and the minimum permissions. Tokens are never stored. The client's operation allowlist has no way to express a merge, and pull requests are always drafts.

Full threat model and known limitations: [SECURITY.md](docs/SECURITY.md).

## Quick start

Requires Node 24 and pnpm.

```bash
pnpm install && pnpm playwright:install
cp .env.example .env              # set ANTHROPIC_API_KEY
pnpm dev                          # dashboard :3000, runner :4000, test store :5000
```

Run with `STOREFRONT_PORT=5050 STOREFRONT_URL=http://localhost:5050`.

Open http://localhost:3000, enter the store address, and choose **Scan my store**. Without the dashboard:

```bash
pnpm cli -- --agent gamma --bug A                                    # no model needed
pnpm cli -- --agent alpha --bug A                                    # one agent, one scenario
node scripts/run-mission.mjs --bug A --agents alpha,beta,sigma,gamma # all four, cross-agent report
node scripts/codefix.mjs --run <runId> --repo <github-url>           # fix a failed run
```

Checks: `pnpm typecheck && pnpm test && pnpm format:check` (what CI runs) and `pnpm llm:smoke` (model key).

## Documentation

| Doc                                              | For                                                         |
| ------------------------------------------------ | ----------------------------------------------------------- |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md)          | Packages, run lifecycle, API routes, storage, configuration |
| [AGENTS.md](docs/AGENTS.md)                      | The four agents: perception, models, cost, reports          |
| [CODEFIX.md](docs/CODEFIX.md)                    | The code-fix pipeline, GitHub access, threat model          |
| [SECURITY.md](docs/SECURITY.md)                  | Trust boundaries, safeguards, known limitations             |
| [RESULTS.md](docs/RESULTS.md)                    | Live validation of the agents and the code-fix agent        |
| [DESIGN.md](docs/DESIGN.md)                      | Dashboard flow and visual system                            |
| [storefront/](docs/storefront/bugs-and-fixes.md) | The test store's planted bugs, reference fixes and grader   |

## Status and limits

AgentProof runs locally as a single-node service. Before you expose the runner to a network, read the known limitations in [SECURITY.md](docs/SECURITY.md#known-limitations). In short: the runner has no authentication, so keep it on a trusted host. Jobs run in an in-process queue, and state lives in SQLite.

## Team

Built at DubHacks 2026 by three people. Who built what, by area of the repository:

| Who         | GitHub                                                 | Built                                                                                                                                                                                                                                                                                               |
| ----------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ryan Xu     | [@rjhxu](https://github.com/rjhxu)                     | The agents package (LLM layer, Alpha, Beta and Sigma, reports, CLI, scripted harness) and cross-agent attribution; the code-fix agent, its validation and GitHub App delivery; the runner's browser-run and report wiring; the test store's products, planted bugs, answer key and grader; the docs |
| Zachary Li  | [@zacharyli293680](https://github.com/zacharyli293680) | The initial scaffold (spec, shared schemas, verifier, service skeletons); the dashboard (design system, the four-step flow, replay) and its GitHub App connection; store-URL missions derived from the catalog; diagnostics on the shared LLM layer                                                 |
| Vihan Bagal | [@Vihan-Bagal](https://github.com/Vihan-Bagal)         | The Gamma agent and the runner's Gamma fix loop (diagnose, repair, apply, rematch); GitHub repository connections and persistence                                                                                                                                                                   |
