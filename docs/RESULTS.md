# Results

Live validation, 2026-10-18, on Anthropic models. Alpha, Beta, the narrator and the code-fix roles ran on `claude-haiku-5-5`. Beta's default has since moved to Sonnet. Sigma ran on `claude-sonnet-5-5`, and Gamma makes no model call. Two stores:

- **Bugged:** `apps/storefront` with its five planted bugs.
- **Fixed:** the same store with the reference patches applied (`scripts/make-fixed-store.sh`).

An independent grader (`docs/storefront/verify-scenarios.mjs`) agrees with both. Reports are under `data/artifacts/` on the machine that ran them, which is gitignored. The ids below locate them.

A run that disagrees with these tables is a regression or a flaky model turn. Run it once more before you debug.

## Agents on the bugged store

| Scenario                       | Alpha (tree, Haiku)                            | Beta (screens, Haiku) | Sigma (all, Sonnet) | Gamma (API)                       |
| ------------------------------ | ---------------------------------------------- | --------------------- | ------------------- | --------------------------------- |
| A: black hoodie, M, under $60  | **failed** `correct_size_identified`, $0.0025  | passed, $0.0027       | passed, $0.0540     | **failed** `cart_matches_variant` |
| C: crewneck, navy, L           | **failed** `correct_color_identified`, $0.0074 | passed, $0.0034       | passed, $0.0711     | passed                            |
| D: merino socks, M, quantity 3 | **failed** `cart_quantity_correct`, $0.0030    | passed, $0.0035       | passed, $0.0730     | passed                            |
| E: studio headphones, wired    | **failed** `added_to_cart`, $0.0028            | passed, $0.0020       | passed, $0.0439     | passed                            |
| Control: canvas tote           | passed, $0.0019                                | passed, $0.0023       | passed, $0.0406     | passed                            |

Every cell matches the answer key in [storefront/bugs-and-fixes.md](storefront/bugs-and-fixes.md). Attribution named a semantic interface problem for each Alpha failure and a product data inconsistency for Gamma on A. Sigma costs 21 to 24 times what Alpha does, and it reports which steps it had to do by coordinates: the mismatch between the tree and the screen that the bug creates.

On the fixed store, the same Alpha with the same prompts passes A, C, D, E and the control ($0.0016 to $0.0027 per run), and Gamma passes A. Only the store changed.

Mission ids. Bugged: A `mis_4d8c056edb7d`, C `mis_6177b3fb3842`, D `mis_26da8fa2ca09`, E `mis_99b33da6911e`, control `mis_b431779e01c1`. Fixed: A `mis_fef5fb3a30b1`, C `mis_714309b79284`, D `mis_e4ae8325549d`, E `mis_0751f66d8b2a`, control `mis_f0c8af7fb1fe`.

## Code-fix agent on the private store repository

Target: `rjhxu/northwind-storefront` (the bugged store exported with its hint comments stripped, tag `baseline`). Every fix ran in `pull_request` mode with typecheck, review and rematch enabled.

| Scenario | Root-cause file (answer key) | Agent's change                                                 | Diff  | Checks | Rematch | Grader | Draft PR                                                   | Fix cost |
| -------- | ---------------------------- | -------------------------------------------------------------- | ----- | ------ | ------- | ------ | ---------------------------------------------------------- | -------- |
| A        | `views.ts`                   | radio-group roles, names, `aria-checked` and keyboard on chips | +5/−4 | 7/7    | passed  | FIXED  | [#1](https://github.com/rjhxu/northwind-storefront/pull/1) | $0.0037  |
| B        | `cart.ts`                    | removed the `HOODIE-001-M` to S entry from the legacy map      | +0/−1 | 7/7    | passed  | FIXED  | [#2](https://github.com/rjhxu/northwind-storefront/pull/2) | $0.0024  |
| C        | `swatches.ts`, `catalog.ts`  | swatch labels reordered to match the variant order             | +1/−1 | 7/7    | passed  | FIXED  | [#3](https://github.com/rjhxu/northwind-storefront/pull/3) | $0.0027  |
| D        | `quantity-stepper.ts`        | `aria-label` on plus and minus, a named `role="group"`         | +3/−3 | 7/7    | passed  | FIXED  | [#4](https://github.com/rjhxu/northwind-storefront/pull/4) | $0.0028  |
| E        | `feature-layout.ts`          | `aria-hidden` removed from the stage around the buy form       | +1/−1 | 7/7    | passed  | FIXED  | [#5](https://github.com/rjhxu/northwind-storefront/pull/5) | $0.0025  |

- **Every fix succeeded on the first attempt.** Each touched one file, the one the answer key names (for C, the data half of a two-file cause). The grader found no collateral damage: the human shopper still completes every scenario, and the control is unaffected.
- **Cost.** A fix is two Haiku calls, about 15k input and 2k to 4k output tokens. All five scenarios end to end, including the failing runs and the proof reruns, cost about $0.04.
- **Merged together**, the five branches (5 files, +10/−10) grade FIXED on every scenario, and Alpha and Gamma pass every mission against that store.
- **The reviewer is advisory.** Haiku rejected fix A over keyboard support, which is correct for a radio group. The prompt was corrected afterwards. `AGENTPROOF_MODEL_REVIEW=claude-sonnet-5-5` gives sharper reviews for about a cent per fix.
- **GitHub App.** A sixth fix (scenario B again) ran with no token in any request. The clone used a `contents: read` installation token, and the push and draft PR [#6](https://github.com/rjhxu/northwind-storefront/pull/6) used a separate `contents: write` and `pull_requests: write` token.

Fix ids: A `fix_34c85d45e822`, B `fix_4259e7e2078b`, C `fix_fca71d3f042e`, D `fix_5f393cb011d0`, E `fix_96a077ee5541`.

## What the runs changed

- **Alpha cleared the cart twice on C** because the first clear had scrolled out of its five-step history. Every user turn now carries a `RUN SUMMARY` computed from the whole run.
- **Alpha on E waited out Playwright timeouts** on a control that was not in the tree. Absent role targets now fail at once with `no button "Add to cart" in the accessibility tree`.
- **No run reached a payment control.** The store logs show no `PLACE ORDER` error.

## Reproduce

```bash
pnpm dev:store && pnpm dev:runner
node scripts/run-mission.mjs --bug A --agents alpha,beta,sigma,gamma        # likewise C, D, E, control

scripts/make-fixed-store.sh ../northwind-fixed
(cd ../northwind-fixed && STOREFRONT_PORT=5050 npm run start)
node scripts/run-mission.mjs --bug A --agents alpha,gamma --store http://localhost:5050
STORE_URL=http://localhost:5050 node docs/storefront/verify-scenarios.mjs --expect=fixed

node scripts/codefix.mjs --run <failedRunId> --repo https://github.com/rjhxu/northwind-storefront \
  --store-root "" --mode pull_request --rematch
```

A four-agent mission costs about $0.06 to $0.08. An Alpha run costs under a cent.
