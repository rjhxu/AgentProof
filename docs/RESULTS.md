# Live validation results

Every agent on every scenario, against the store with its planted bugs and against the same store with the five reference fixes applied. Produced on 2026-10-18 (the night before submission) through the runner API with `scripts/run-mission.mjs`. The reports live under `data/artifacts/` (gitignored); the mission ids are listed so the files can be found on the machine that ran them.

Provider: Anthropic. Models: Alpha, Beta and the narrator on `claude-haiku-5-5`; Sigma on `claude-sonnet-5-5`; Gamma makes no model call. Stores: `apps/storefront` at `main` `89df4d4` on port 5000 (bugged), and the same source with every patch from `docs/storefront/patches/` applied, exported with `scripts/make-fixed-store.sh ../northwind-fixed`, on port 5050 (fixed). Ryan's grader agrees with both: `--expect=bugs` on 5000 reports every bug present and the control OK; `--expect=fixed` on 5050 reports every bug FIXED.

## Bugged store: four agents on every scenario

Cost is the run's estimate from the price table, narrator call included. Steps count the agent's actions including its final done or fail.

| Scenario                                | Alpha (tree only, Haiku)                                                                  | Beta (screenshots, Haiku) | Sigma (all senses, Sonnet) | Gamma (catalog + cart API)                              | Attribution                                                           |
| --------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------- | -------------------------- | ------------------------------------------------------- | --------------------------------------------------------------------- |
| A: black hoodie, M, under $60           | **failed** `correct_size_identified` (cart holds S); 6 steps, $0.0025                     | passed; 5 steps, $0.0027  | passed; 5 steps, $0.0540   | **failed** `cart_matches_variant` (the API maps M to S) | Alpha: semantic interface problem. Gamma: product data inconsistency. |
| C: crewneck, navy, L, under $70         | **failed** `correct_color_identified` (cart holds forest); 18 steps, $0.0074              | passed; 7 steps, $0.0034  | passed; 6 steps, $0.0711   | passed                                                  | Alpha: semantic interface problem.                                    |
| D: merino socks, M, quantity 3          | **failed** `cart_quantity_correct` (1 of 3); 7 steps, $0.0030                             | passed; 7 steps, $0.0035  | passed; 7 steps, $0.0730   | passed                                                  | Alpha: semantic interface problem.                                    |
| E: studio headphones, wired, under $100 | **failed** `added_to_cart` (cart empty: the buy box is not in the tree); 6 steps, $0.0028 | passed; 4 steps, $0.0020  | passed; 4 steps, $0.0439   | passed                                                  | Alpha: semantic interface problem.                                    |
| Control: canvas tote                    | passed; 4 steps, $0.0019                                                                  | passed; 4 steps, $0.0023  | passed; 4 steps, $0.0406   | passed                                                  | none                                                                  |

Every cell is what `docs/storefront/bugs-and-fixes.md` predicts. Sigma costs 21x to 24x Alpha on every scenario; Beta costs about the same as Alpha on pages this small; Gamma costs nothing. Sigma's own claims say which step it did by coordinates (the chip on A, the swatch on C, the `+` on D): that is the mismatch between tree and screen that the hybrid agent exists to surface.

Mission ids: A `mis_4d8c056edb7d`, C `mis_6177b3fb3842`, D `mis_26da8fa2ca09`, E `mis_99b33da6911e`, control `mis_b431779e01c1`.

Earlier CLI runs the same evening agree: Alpha on A three times (one run before prompt tuning stopped with an empty cart; the two after fail on size), C twice, D three times, E once, the control once; Beta and Sigma on A twice each; Gamma on the hoodie mission many times.

## Fixed store: the cheapest agent passes

Same agents, same prompts, same models. Only the store changed.

| Scenario | Alpha                                                                              | Gamma                                 |
| -------- | ---------------------------------------------------------------------------------- | ------------------------------------- |
| A        | passed; 5 steps, $0.0020 (`select "M" in Size` works: the chips are a radio group) | passed (`HOODIE-001-M` resolves to M) |
| C        | passed; 6 steps, $0.0024                                                           | not run                               |
| D        | passed; 7 steps, $0.0027 (two clicks on `button:Increase quantity`)                | not run                               |
| E        | passed; 6 steps, $0.0024                                                           | not run                               |
| Control  | passed; 4 steps, $0.0016                                                           | not run                               |

Mission ids: A `mis_fef5fb3a30b1`, C `mis_714309b79284`, D `mis_e4ae8325549d`, E `mis_0751f66d8b2a`, control `mis_f0c8af7fb1fe`.

The whole validation was 20 model-driven runs and 6 Gamma runs, about $0.33 in tokens.

## What the runs showed, and what changed because of them

- **Alpha on C cleared the cart twice** although the rules allow one clear. The user turn only showed the last five steps, so by the second contradiction the first clear was out of view. Fix: every user turn now carries a `RUN SUMMARY` computed from the whole run (steps taken, cart clears, failed attempts per target), and the rules point at it. Confirmed with one CLI run (`run_e0a1671bf45c`): one clear, then "the cart was already cleared once this run, so I did not clear again"; 12 steps and $0.0049 instead of 18 and $0.0074.
- **Alpha on E stopped with a raw message**, `stuck: locator.click: Timeout 5000ms exceeded.`, after four clicks that each waited the full five seconds. Fix: a `role:name` click or type on a control absent from the tree now fails at once with `no button "Add to cart" in the accessibility tree`, and the stuck summary names the last action. Confirmed with one CLI run (`run_9450cd748e1a`): instant, readable failures, and the agent ended with an explicit `fail` naming the missing control.
- **The deprecated Claude client** that `packages/diagnostics` still uses defaulted to Opus. It now takes its model from a `diagnosis` role in `profiles.ts` (Haiku by default; `AGENTPROOF_MODEL_DIAGNOSIS` overrides it).
- **Beta sometimes clicks the same coordinate twice** in a row (the size chip on C). Harmless: the second click is a no-op on a selected option.
- **No run reached a payment control.** Both store logs are free of the `PLACE ORDER` error and the runner log has no errors.

## Reproduce

```bash
pnpm dev:store                                    # bugged store on :5000
pnpm dev:runner                                   # runner on :4000
node scripts/run-mission.mjs --bug A --agents alpha,beta,sigma,gamma
node scripts/run-mission.mjs --bug C --agents alpha,beta,sigma,gamma   # likewise D, E, control

scripts/make-fixed-store.sh ../northwind-fixed    # once: the store with the five patches applied, as its own repo
(cd ../northwind-fixed && STOREFRONT_PORT=5050 npm run start)
node scripts/run-mission.mjs --bug A --agents alpha,gamma --store http://localhost:5050
STORE_URL=http://localhost:5050 node docs/storefront/verify-scenarios.mjs --expect=fixed

pnpm cli -- --agent alpha --bug C                 # one agent, no runner; add --store http://localhost:5050 for the fixed store
```

A four-agent mission costs about $0.06 to $0.08 (Sigma is most of it); an Alpha run costs under a cent.
