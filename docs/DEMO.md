# Flagship demo runbook

Target: a three-minute video showing the full loop on the synthetic store. Everything below is real execution; replays must be labeled as recordings.

## Mission

> Find a black hoodie in medium for less than $60, add it to the cart, and reach checkout. Do not place the order.

Store: `http://localhost:5000` (Northwind Threads).

## Expected first-run results

| Checkpoint              | Alpha (semantic)                        | Beta (vision) | Gamma (structured)            |
| ----------------------- | --------------------------------------- | ------------- | ----------------------------- |
| Product discovered      | pass                                    | pass          | pass                          |
| Correct size identified | **fail** (no size control in a11y tree) | pass          | n/a                           |
| Added to cart           | pass (default size S)                   | pass          | pass                          |
| Cart matches variant    | **fail** (S, wanted M)                  | pass          | **fail** (`HOODIE-001-M` → S) |
| Price within budget     | pass ($49)                              | pass          | pass                          |
| Checkout review reached | pass                                    | pass          | n/a                           |

Two distinct failures, two distinct causes, one agent succeeds. That contrast is the story.

## Scene list

1. **Launch** (0:00–0:30). Paste the mission, pick all three agents, hit Run. Arena shows three panels filling in.
2. **Failures** (0:30–1:10). Alpha's panel goes red on "Correct size identified". Gamma's goes red on "Cart matches variant". Beta is green. Open Alpha's evidence: the accessibility snapshot with no size control. Open Gamma's: catalog says M, cart says S.
3. **Diagnose** (1:10–1:40). Click Diagnose on Alpha's issue. Show observed vs inferred, category "Semantic interface problem", suggested repair. Same for Gamma: "Product data inconsistency".
4. **Repair** (1:40–2:10). Show both diffs. Click Apply. Storefront hot-reloads.
5. **Rematch** (2:10–2:50). Click Run Rematch. Side-by-side before/after table: Alpha now green, Gamma now green. "2 checkpoints improved, 0 regressed."
6. **Close** (2:50–3:00). Tagline.

## Recording tips

- `PLAYWRIGHT_HEADED=1` so the real browser window is visible for OBS.
- Run each agent once ahead of time and keep the run ids; if a live run flakes on camera, replay the recorded run with the "recording" badge visible.
- Reset the store between takes: `curl -X DELETE localhost:5000/api/cart` clears the current session, or just restart `pnpm dev:store`.
- Revert the applied repairs between takes with `git checkout apps/storefront`.

## Pre-flight checklist

- [ ] `pnpm typecheck && pnpm test` green
- [ ] `.env` has a working key; `pnpm --filter @agentproof/agent smoke` passes
- [ ] All three services up, `curl localhost:4000/health` ok
- [ ] Planted bugs present: `grep -n "DEMO BUG" apps/storefront/src/*.ts`
- [ ] Two recorded runs saved as fallback
