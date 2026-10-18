# Working Gamma demo

This is the implemented dashboard milestone. No model key or browser-agent setup is required.

1. Install dependencies with `pnpm install` and start all three services with `pnpm dev`.
2. Open http://localhost:3000 and click **Run Gamma test**.
3. Gamma requests `HOODIE-001-M` from the live catalog in its own cart session. The planted mapping returns `HOODIE-001-S`. The report fails cart variant matching and catalog variant resolution.
4. Expand the captured catalog/cart evidence. Click **Inspect failure & propose repair** to see the deterministic diagnosis and one-line source diff.
5. Click **Apply reviewed repair**. This edits only the known mapping in `apps/storefront/src/cart.ts`; `tsx watch` reloads the storefront. Stale diffs and unexpected paths are rejected.
6. Click **Run rematch**. The same mission now receives size M: two checkpoints improve, none regress. Checkout review is checked through a real GET; payment is never submitted.

The repair stays in the source file. To repeat the failure, manually restore the `HOODIE-001-M` mapping to `HOODIE-001-S` and its original `// BUG: should be HOODIE-001-M` comment. A new test against an already repaired store passes and needs no repair.

Automated browser check: with all services running, run `pnpm playwright:install` then `pnpm demo:smoke`. It checks the actual dashboard flow and desktop/mobile layouts, saves screenshots under `data/artifacts/demo-smoke/`, and restores the planted mapping afterward. It requires the buggy mapping at startup.

The targeted diagnosis and repair use a known rule and source precondition, not a model. The browser agents (Alpha, Beta, Sigma) are implemented and run through the CLI and the runner (next section); the dashboard panels for them and generic repairs remain work in progress.

## Connect GitHub source after a failed run

After Gamma finishes with failures, the dashboard shows **Connect your Git repository**. Enter the store's GitHub HTTPS URL and allow AgentProof to download its source. Public repositories need no token. For private repositories, create a fine-grained token limited to that repository with **Contents: read-only**, then enter it in the password field. [GitHub token instructions](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens).

The runner downloads a shallow source snapshot and shows its default branch, commit, and tracked files. Metadata is linked to the run in SQLite; source is stored in the gitignored `data/repositories/` directory. The token is used only during the connection, cleared from the form, and never saved in Git config, SQLite, or logs. Repository code, hooks, dependencies, and submodules are not executed.

**Disconnect repository** removes the local snapshot and connection metadata. Token revocation on GitHub is separate. These endpoints accept only local requests from the dashboard on `localhost:3000` or `127.0.0.1:3000`; this prototype has no hosted user accounts.

This step connects source for the future code-fix agent, which will consume the mission and agent reports together with this snapshot. Generic repair generation, commits, and pushes are not implemented. The existing hoodie repair is still an independent bundled storefront demonstration.

UI check: `pnpm demo:repository` uses live Gamma and connection lookup with fixture connection responses to exercise consent, token clearing, authentication errors/retry, connected metadata, disconnect, and mobile layout. `pnpm demo:repository:live` exercises the complete dashboard flow against the public `octocat/Hello-World` GitHub repository, including restoring the saved connection after a page reload and disconnecting. Backend tests separately exercise real Git cloning against a local fixture. No private token is needed for these tests.

# Running the agents without the dashboard

The store must be running (`pnpm dev:store`). Each command writes `report.json` and `report.md` next to the run's screenshots and prints the checkpoint table and the cost line.

```bash
pnpm cli -- --agent gamma --bug A        # no model: Gamma fails catalog_variant_resolves (Bug B)
pnpm cli -- --agent alpha --bug A        # live model: Alpha ends with size S in the cart (Bug A)
pnpm cli -- --agent beta --bug A         # live model: Beta clicks the chip and passes
pnpm cli -- --agent sigma --bug A        # live model: the reference run, strongest model
pnpm cli -- --agent alpha --bug C --headed
```

Reports land under `data/artifacts/cli/<runId>/`. Through the runner (`pnpm dev:runner`) the same runs are started with `POST /missions/fixture { "bug": "A" }` then `POST /missions/:id/runs { "agents": ["alpha_semantic", "beta_vision", "sigma_hybrid", "gamma_structured"] }`; `GET /runs/:id/report(.md)` returns each agent's report, `GET /missions/:id/report(.md)` the cross-agent report with attribution and the cost comparison, and `GET /artifacts/<runId>/step-003.png` any screenshot, aria snapshot or trace.

**Deterministic fallback.** When the model is unavailable or a live take flakes, the real browser loop still runs against the store with a scripted model:

```bash
pnpm --filter @agentproof/agent exec tsx --env-file-if-exists=../../.env scripts/scripted-run.ts alpha A [--headed]
```

Chromium, the policy, the Playwright actions, the evidence files, the cookies, the cart fetch and the verifier are all real; only the decisions are scripted. It prints the steps, the cart and the verdict, and reproduces the documented Bug A outcome (two failed size attempts, size S in the cart, checkout reached, `correct_size_identified` and `cart_matches_variant` fail). Artifacts go to `data/artifacts/scripted/<runId>/`.

# Planned flagship demo

Target: a three-minute video showing the full loop on the synthetic store. Everything below is real execution; replays must be labeled as recordings.

## Mission

> Find a black hoodie in medium for less than $60, add it to the cart, and reach checkout. Do not place the order.

Store: `http://localhost:5000` (Northwind Threads).

## Expected first-run results

| Checkpoint                  | Alpha (semantic)                        | Beta (vision) | Sigma (hybrid) | Gamma (structured)             |
| --------------------------- | --------------------------------------- | ------------- | -------------- | ------------------------------ |
| Product discovered          | pass                                    | pass          | pass           | pass (from the catalog)        |
| Correct size identified     | **fail** (no size control in a11y tree) | pass          | pass           | pass (from the catalog)        |
| Added to cart               | pass (default size S)                   | pass          | pass           | pass                           |
| Cart matches variant        | **fail** (S, wanted M)                  | pass          | pass           | **fail** (`HOODIE-001-M` to S) |
| Price within budget         | pass ($49)                              | pass          | pass           | pass                           |
| Checkout review reached     | pass                                    | pass          | pass           | pass (GET /checkout)           |
| Catalog variant id resolves | n/a                                     | n/a           | n/a            | **fail**                       |

Two distinct failures, two distinct causes, two agents succeed, and the mission report says what each one cost. Attribution reads: Sigma passed and Alpha failed on "Correct size identified" (semantic interface problem); a browser agent passed while Gamma failed through the cart API (product data inconsistency). That contrast is the story.

## Scene list

1. **Launch** (0:00-0:30). Paste the mission, pick all four agents, hit Run. Arena shows four panels filling in.
2. **Failures** (0:30-1:10). Alpha's panel goes red on "Correct size identified". Gamma's goes red on "Cart matches variant". Beta and Sigma are green, with the cost per agent beside each. Open Alpha's evidence: the accessibility snapshot with no size control. Open Gamma's: catalog says M, cart says S.
3. **Diagnose** (1:10-1:40). Open the mission report: attribution per failed checkpoint and the recommendations. Click Diagnose on Alpha's issue. Show observed vs inferred, category "Semantic interface problem", suggested repair. Same for Gamma: "Product data inconsistency".
4. **Repair** (1:40-2:10). Show both diffs. Click Apply. Storefront hot-reloads.
5. **Rematch** (2:10-2:50). Click Run Rematch. Side-by-side before/after table: Alpha now green, Gamma now green. "2 checkpoints improved, 0 regressed."
6. **Close** (2:50-3:00). Tagline: the store now works for the cheapest agent.

## Recording tips

- `--headed` on the CLI, or `PLAYWRIGHT_HEADED=1`, so the real browser window is visible for OBS.
- Run each agent once ahead of time and keep the run ids; if a live run flakes on camera, replay the recorded run with the "recording" badge visible, or fall back to the scripted run.
- Reset the store between takes: `curl -X DELETE localhost:5000/api/cart` clears the current session, or just restart `pnpm dev:store`.
- Revert the applied repairs between takes with `git checkout apps/storefront`.

## Pre-flight checklist

- [ ] `pnpm typecheck && pnpm test` green
- [ ] `.env` has the Anthropic key; `pnpm llm:smoke` passes (two Haiku calls)
- [ ] `pnpm cli -- --agent gamma --bug A` fails on `catalog_variant_resolves`; the scripted Alpha run ends with size S in the cart
- [ ] All three services up, `curl localhost:4000/health` ok
- [ ] Planted bugs present: `grep -n "DEMO BUG" apps/storefront/src/*.ts`; `node docs/storefront/verify-scenarios.mjs --expect=bugs` passes
- [ ] Two recorded runs saved as fallback
