# Demo runbook

Everything below is real execution unless marked as a recording. The numbers come from [RESULTS.md](./RESULTS.md).

## The story in one mission

> Find a black hoodie in medium for less than $60, add it to the cart, and reach checkout. Do not place the order.

Four agents shop the same store. Two fail for two different reasons, two succeed, and the report says what each one cost.

| Checkpoint                  | Alpha (tree only, Haiku)               | Beta (screenshots, Haiku) | Sigma (all senses, Sonnet) | Gamma (catalog + cart API)     |
| --------------------------- | -------------------------------------- | ------------------------- | -------------------------- | ------------------------------ |
| Product discovered          | pass                                   | pass                      | pass                       | pass (from the catalog)        |
| Correct size identified     | **fail** (no size control in the tree) | pass                      | pass                       | pass (from the catalog)        |
| Added to cart               | pass (default size S)                  | pass                      | pass                       | pass                           |
| Cart matches variant        | **fail** (S, wanted M)                 | pass                      | pass                       | **fail** (`HOODIE-001-M` to S) |
| Price within budget         | pass ($49)                             | pass                      | pass                       | pass                           |
| Checkout review reached     | pass                                   | pass                      | pass                       | pass                           |
| Catalog variant id resolves | n/a                                    | n/a                       | n/a                        | **fail**                       |
| Cost (estimate)             | $0.0025                                | $0.0027                   | $0.054                     | $0                             |

Attribution reads: Sigma passed and Alpha failed on "Correct size identified", a semantic interface problem; a browser agent passed while Gamma failed through the cart API, a product data inconsistency. Then the fixed store: the same Alpha, unchanged, passes in five steps.

## Running it today (no dashboard panels yet)

Start the bugged store and the runner, then drive the mission:

```bash
pnpm dev:store                                  # :5000
pnpm dev:runner                                 # :4000
node scripts/run-mission.mjs --bug A --agents alpha,beta,sigma,gamma
```

The script prints each run's verdict as it finishes, then the mission report's matrix, attribution, cost comparison and recommendations, and the path of the Markdown report (`data/artifacts/missions/<missionId>/report.md`). Per-agent reports with screenshots and the failure point are at `data/artifacts/<runId>/report.md`, also served at `http://localhost:4000/artifacts/<runId>/report.md`. Scenarios C, D and E tell the same story with a different bug each (`--bug C`, and so on); `control` passes for everyone.

The "after" half, without touching `apps/storefront`:

```bash
scripts/make-fixed-store.sh ../northwind-fixed  # once: the store with the five reference patches applied, its own repo
(cd ../northwind-fixed && STOREFRONT_PORT=5050 npm run start)
node scripts/run-mission.mjs --bug A --agents alpha,gamma --store http://localhost:5050
```

Alpha selects M through a real radio group and passes every checkpoint; Gamma gets `HOODIE-001-M` back. Nothing about the agents changed.

One agent at a time, with a visible browser for recording:

```bash
pnpm cli -- --agent alpha --bug A --headed      # alpha | beta | sigma | gamma; A | B | C | D | E | control
pnpm cli -- --agent alpha --bug A --headed --store http://localhost:5050
```

## The four-step flow (wired 2026-10-18)

The dashboard at http://localhost:3000 runs the whole story live, with the runner on :4000 and the store on :5000:

1. **Store.** Paste the store address (`localhost:5000` is enough; the page adds the scheme) and choose "Scan my store". The runner reads the store's catalog feed, derives the mission with no model call, and starts the four runs: the black hoodie in size M under $60. Coming back to this step shows that mission; "Change" edits the request and the edited text goes through the mission generator.
2. **Scan.** The stage shows one shopper at a time in stage order (Alpha, Beta, Gamma, Sigma) at a readable pace while the runner runs them two at a time; the roster carries each verdict and cost. When the report is in, Findings opens. "Change" returns to the mission with the editor open.
3. **Findings.** A compact left-aligned header carries the count, the one-line summary, "Get fixes" and the report download. Shopper chips sit under it, also on the left, and open that shopper's scan review. Short tabs on the detail card ("1 · Choose", "All checkpoints" at the right) select the problem; the card holds the full title, what the verifier saw, what the shopper read, how each shopper did, what it means, and what to change. Titles come from the diagnosis (a code-written title stands in when the model cannot answer). "Get fixes" only leaves for Fixes. With no problems, that button is absent. When a repository is already connected and the fixes are ready, the button says "See the fixes".
4. **Fixes.** Before a repository is connected, this step asks to install the GitHub App or connect by URL. With the GitHub App configured, it asks you to add AgentProof to repositories on GitHub, then offers those repositories in a dropdown (the only one is selected for you). One click connects and opens a draft pull request for each fix that validates. A repository URL and token is the secondary path, and that path does not open pull requests. The consent sentence sits above the button; there is no checkbox. The repository then connects to every failed run, one diff-mode fix runs per run (reading, proposing, validating, a second opinion, a rerun of the failing shopper against the patched store), and each card shows the seven code-written checks, the reviewer's opinion, the patch and the delivery line. A connection made through the GitHub App opens the draft pull requests on its own once the cards are ready; "Open draft pull requests" stays for a connection made by URL. Without the app on the repository, the action is "Download the patches".

A reload keeps the mission (`?mission=<id>` is in the address bar). A finished scan opens Findings; the fixes already run are adopted instead of started again.

## The Gamma dashboard flow (built)

The Gamma page at http://localhost:3000/gamma (the root now opens the four-step flow) runs the hoodie mission for Gamma end to end without a model key:

1. Click **Run Gamma test**. Gamma requests `HOODIE-001-M` from the live catalog in its own cart session; the planted mapping returns `HOODIE-001-S`; the report fails cart variant matching and catalog variant resolution.
2. Expand the captured catalog and cart evidence. **Inspect failure & propose repair** shows the deterministic diagnosis and the one-line source diff (a known rule for this bug, not a model).
3. **Apply reviewed repair** edits only the known mapping in `apps/storefront/src/cart.ts`; `tsx watch` reloads the store.
4. **Run rematch**: the same mission now receives size M; two checkpoints improve, none regress.

The repair stays in the source file; restore the planted mapping (`git checkout apps/storefront/src/cart.ts`) before the next take. `pnpm demo:smoke` checks this flow in a browser and restores the mapping afterwards.

After a failed run the dashboard also offers **Connect your Git repository**: a GitHub HTTPS URL (public, or private with a fine-grained read-only token that is never persisted) is cloned shallowly into `data/repositories/` and linked to the run. That snapshot is the input for the code-fix agent; generic repair generation, commits and pushes are not built yet. `pnpm demo:repository` and `pnpm demo:repository:live` exercise the connection UI.

## Deterministic fallback

When the model is unavailable or a live take flakes, the real browser loop still runs against the store with a scripted model:

```bash
pnpm --filter @agentproof/agent exec tsx --env-file-if-exists=../../.env scripts/scripted-run.ts alpha A [--headed]
```

Chromium, the policy, the Playwright actions, the evidence files, the cookies, the cart fetch and the verifier are all real; only the decisions are scripted. It reproduces the documented Bug A outcome. Artifacts go to `data/artifacts/scripted/<runId>/`.

## The video (three minutes, to record once the dashboard panels exist)

1. **Launch** (0:00-0:30). Paste the mission, pick all four agents, run. Four panels fill in.
2. **Failures** (0:30-1:10). Alpha goes red on "Correct size identified", Gamma on "Cart matches variant"; Beta and Sigma are green with the cost beside each. Open Alpha's evidence: the accessibility snapshot with no size control. Open Gamma's: catalog says M, cart says S.
3. **Diagnose** (1:10-1:40). The mission report: attribution per failed checkpoint and the recommendations. Then the diagnosis for Alpha (observed vs inferred, "Semantic interface problem") and for Gamma ("Product data inconsistency").
4. **Repair** (1:40-2:10). The diffs. Apply. The store reloads.
5. **Rematch** (2:10-2:50). Before/after: Alpha green, Gamma green. "2 checkpoints improved, 0 regressed."
6. **Close** (2:50-3:00). The store now works for the cheapest agent, at a fraction of what the strongest one costs.

Until the panels exist, scenes 1 to 3 can be shown from `scripts/run-mission.mjs` output and the Markdown reports, and scene 5 from the fixed store.

## Recording tips

- `--headed` on the CLI, or `PLAYWRIGHT_HEADED=1`, so the browser window is visible for OBS.
- Run each take once ahead of time and keep the run ids; if a live run flakes on camera, show the recorded report with the "recording" label, or fall back to the scripted run.
- Carts are per session cookie, so runs never share a cart; restarting `pnpm dev:store` clears everything.
- Keep `apps/storefront` bugged; use the fixed export for the after shots. If a repair was applied in the monorepo, `git checkout apps/storefront` restores the bugs.
- A four-agent mission costs about $0.06 to $0.08; rehearsals are cheap.

## Pre-flight checklist

- [ ] `pnpm typecheck && pnpm test` green
- [ ] `.env` has the Anthropic key; `pnpm llm:smoke` passes (two Haiku calls)
- [ ] Planted bugs present: `node docs/storefront/verify-scenarios.mjs --expect=bugs` passes; `pnpm cli -- --agent gamma --bug A` fails on `catalog_variant_resolves`
- [ ] Fixed store up on :5050 and `STORE_URL=http://localhost:5050 node docs/storefront/verify-scenarios.mjs --expect=fixed` passes
- [ ] All three services up, `curl localhost:4000/health` ok
- [ ] One rehearsed four-agent mission report and one fixed-store Alpha run saved as fallbacks
