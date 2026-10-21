# Northwind Threads test site: open, verify, and export to its own repo

This guide has two parts:

1. Run the test store, check it in a browser, and confirm with one command that every planted bug is present.
2. Copy the store into its own git repo so the AgentProof code-fix agent can be tested against it. The repo it works in should contain only the store, and you should be able to grade and reset it after every attempt.

The bugs themselves are explained in [bugs-and-fixes.md](bugs-and-fixes.md), which covers each bug's mission, evidence, diagnosis and reference fix.

## What's in this folder

| File                                         | Purpose                                                                                    |
| -------------------------------------------- | ------------------------------------------------------------------------------------------ |
| [bugs-and-fixes.md](bugs-and-fixes.md)       | Answer key: one section per bug                                                            |
| [patches/](patches/)                         | Reference fix for each bug, applicable with `git apply`                                    |
| [verify-scenarios.mjs](verify-scenarios.mjs) | Grader: runs a semantic "agent" shopper and a mouse "human" shopper against every scenario |
| [export-standalone.sh](export-standalone.sh) | Copies the store into a new repo, optionally with the hint comments stripped               |

All of these are the answer key in one form or another. Keep them out of whatever repo the code-fix agent can read. They are committed in the AgentProof repo; keep them out of the exported store repo (the export script does not copy them).

---

## Part 1: Open and verify the test site

### 1. One-time setup (AgentProof monorepo)

```bash
pnpm install
pnpm playwright:install    # Chromium, used by the grader
```

If `pnpm` fails with "Failed to switch pnpm to v12.14.0", the global pnpm's v12 download is broken. Reinstall it with `npm install -g --allow-scripts=pnpm pnpm@12`, or run pnpm 12 directly: `node ~/Library/pnpm/.tools/pnpm/12.14.0/node_modules/pnpm/bin/pnpm.mjs <args>`.

### 2. Start the store

```bash
STOREFRONT_PORT=5050 pnpm dev:store
```

The default port is 5000, but on macOS the AirPlay Receiver usually holds it. Any free port works, except ones browsers refuse to connect to, such as 5060, 5061, 6000 and 6665-6669. Chrome and Node's `fetch` both fail on those with "bad port" or `ERR_UNSAFE_PORT`.

The examples below use `http://localhost:5050`. Export it once so the grader picks it up:

```bash
export STORE_URL=http://localhost:5050
```

### 3. Look at it as a human

Open http://localhost:5050. You should see six products. Everything below should work with a mouse:

| Page                            | Try                                            | Expected in the cart                      |
| ------------------------------- | ---------------------------------------------- | ----------------------------------------- |
| `/products/canvas-tote`         | Add to cart                                    | Canvas Tote, Color: Natural, qty 1        |
| `/products/black-hoodie`        | Click **M**, then Add to cart                  | Black Hoodie, Size: M                     |
| `/products/crewneck-sweatshirt` | Click the **blue** swatch and **L**, then add  | Crewneck Sweatshirt, Color: Navy, Size: L |
| `/products/merino-socks`        | Click **M**, click **+** twice, then add       | Merino Crew Socks, Size: M, qty 3         |
| `/products/studio-headphones`   | Click **Wired** in the white buy box, then add | Studio Headphones, Connectivity: Wired    |

From `/cart`, "Proceed to checkout" opens the review page. "Place order" returns 403 by design: orders are never placed.

The Grey Hoodie's M is sold out (struck through). The Oatmeal crewneck is sold out in L, so that swatch greys out once L is selected.

### 4. Look at it as the agent

The grader can print what Agent Alpha sees, which is the page's accessibility tree:

```bash
node docs/storefront/verify-scenarios.mjs --snapshot=black-hoodie
node docs/storefront/verify-scenarios.mjs --snapshot=crewneck-sweatshirt
node docs/storefront/verify-scenarios.mjs --snapshot=merino-socks
node docs/storefront/verify-scenarios.mjs --snapshot=studio-headphones
```

What to look for on each page:

- **black-hoodie:** `text: Size S M L`, with no radios or buttons for sizes.
- **crewneck-sweatshirt:** the color radios read `"Forest"`, `"Navy"`, `"Oatmeal"`, even though the swatches on screen run blue, green, beige.
- **merino-socks:** two `button:` entries with no name, around `text: "1"`.
- **studio-headphones:** no price, no options and no "Add to cart". There is only a heading, a description and the specs.

You can see the same thing in Chrome DevTools: open Elements, then the Accessibility pane, and turn on "Enable full-page accessibility tree".

### 5. Run the grader

```bash
node docs/storefront/verify-scenarios.mjs --expect=bugs
```

Expected output, with exit code 0:

```
Scenario  Status       Agent cart             Human cart         Correct cart
--------  -----------  ---------------------  -----------------  -----------------
Control   OK           TOTE-001-NAT x1        -                  TOTE-001-NAT x1
A         BUG PRESENT  HOODIE-001-S x1        HOODIE-001-M x1    HOODIE-001-M x1
B         BUG PRESENT  HOODIE-001-S x1        -                  HOODIE-001-M x1
C         BUG PRESENT  CREW-001-FOR-L x1      CREW-001-NVY-L x1  CREW-001-NVY-L x1
D         BUG PRESENT  SOCK-001-M x1          SOCK-001-M x3      SOCK-001-M x3
E         BUG PRESENT  (empty) (no checkout)  HP-100-WIRED x1    HP-100-WIRED x1
```

For each scenario the grader runs two shoppers in fresh browser sessions, then reads the cart back from `GET /api/cart`:

- **Agent:** finds controls only by role and exact accessible name, like Alpha. For Bug B it posts to the cart API instead, like Gamma.
- **Human:** clicks visible text, the navy-colored swatch, and the `+` icon.

| Status         | Meaning                                                                       |
| -------------- | ----------------------------------------------------------------------------- |
| BUG PRESENT    | The agent got the known wrong cart, as shipped                                |
| FIXED          | The agent got the correct cart                                                |
| UNEXPECTED     | The agent got some other cart (a half-working fix, or something else broke)   |
| HUMAN BROKEN   | The human shopper no longer gets the correct cart, so the change broke the UI |
| CONTROL BROKEN | The bug-free tote failed: the store or the grader is broken                   |

The exit code is 1 for any UNEXPECTED, HUMAN BROKEN or CONTROL BROKEN. Two flags add stricter checks:

- `--expect=bugs` also fails unless every bug is present.
- `--expect=fixed` also fails unless every bug is fixed.

Other useful flags: `--only=C` runs one scenario, and `--json` gives machine-readable output.

### 6. Check the reference fixes (optional)

```bash
git apply docs/storefront/patches/*.patch
node docs/storefront/verify-scenarios.mjs --expect=fixed    # all FIXED, exit 0
git apply -R docs/storefront/patches/*.patch                # bugs back
```

`tsx watch` reloads the store on every file change, so there's no restart. Once the storefront is committed, `git checkout apps/storefront` also restores every bug.

---

## Part 2: Duplicate the store into its own repo for the code-fix agent

### Why a separate repo

The code-fix agent reads source and writes a patch. Inside the AgentProof monorepo it could also read:

- the answer key (`docs/storefront/`, if present)
- AgentProof's own code and docs, which describe the planted bugs (`ARCHITECTURE.md`, `RESULTS.md`, the fixtures)

A standalone repo contains only the store. It has one commit tagged `baseline` to reset to, and its diffs are clean to review. For the "after the fix" half of a demo, `scripts/make-fixed-store.sh <dest>` does this export and then applies the five reference patches (tag `fixed`), so the monorepo store keeps its bugs.

### 1. Export

From the AgentProof repo root:

```bash
docs/storefront/export-standalone.sh ../northwind-storefront           # hinted
docs/storefront/export-standalone.sh ../northwind-storefront --blind   # blind
```

|                   | Hinted (default)                                               | Blind (`--blind`)                                                                                |
| ----------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Code              | Identical to `apps/storefront`                                 | Identical                                                                                        |
| Comments          | Keeps the `DEMO BUG` comments, which say what is wrong and why | Strips every comment that describes a bug or its fix                                             |
| Reference patches | Apply with `git apply -p3`                                     | Do not apply (their context lines include the stripped comments). Grade with the grader instead. |
| Use for           | First runs, demos, checking the pipeline works end to end      | Actually measuring whether the agent can find and fix the bugs                                   |

The script:

1. Copies `apps/storefront/src` and `public`, including any product images already in `public/images/`.
2. Writes a standalone `package.json` (npm, same dependency versions as the monorepo) and a self-contained `tsconfig.json`.
3. Writes a neutral `README.md` that does not mention bugs, plus `.env.example`, `.gitignore` and `package-lock.json`.
4. Runs `git init`, commits, and tags the commit `baseline`.

It refuses to overwrite an existing directory. The lockfile step needs network access to the npm registry.

### 2. Install, run, and confirm the baseline

```bash
cd ../northwind-storefront
npm install
STOREFRONT_PORT=5050 npm run dev
```

In another terminal, from AgentProof (the grader stays there):

```bash
STORE_URL=http://localhost:5050 node docs/storefront/verify-scenarios.mjs --expect=bugs   # exit 0
```

The grader only needs Playwright, not the monorepo. To run it from elsewhere, copy `verify-scenarios.mjs` into any folder with `npm i -D playwright && npx playwright install chromium`. Never copy it into the store repo.

If you want the agent to work on it through GitHub, publish it as a private repo:

```bash
gh repo create <owner>/northwind-storefront --private --source . --push --remote origin
git push origin baseline
```

### 3. Point AgentProof at it

| What                       | Where                                                        | Status                                                                                                                                                                                                            |
| -------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Store URL for missions     | `storeUrl` in `POST /missions`, e.g. `http://localhost:5050` | Works today. `localhost` is in the default `AGENTPROOF_ALLOWED_HOSTS`.                                                                                                                                            |
| Repo the repair applies to | `config.storefrontDir` in `apps/runner/src/config.ts`        | **Hard-coded to `apps/storefront`.** Needs an override, e.g. `AGENTPROOF_STOREFRONT_DIR=/abs/path/to/northwind-storefront`, before `applyRepair` can target the external repo. Not built yet (runner is Vihan's). |
| Source given to diagnosis  | `repoFiles` / `sourceExcerpts` in `diagnose()`               | Should read from the same directory as above (not wired in `routes.ts` yet).                                                                                                                                      |
| Patch paths                | Diffs from the code-fix agent                                | Should be relative to the store repo root (`src/views.ts`) and applied with `git -C <store> apply`. The monorepo reference patches need `-p3` there.                                                              |

Missions to run (exact prompts and expected structured requirements are in bugs-and-fixes.md):

| Scenario | Prompt                                                                                                                       | Agent |
| -------- | ---------------------------------------------------------------------------------------------------------------------------- | ----- |
| Control  | Add the canvas tote to the cart and reach checkout. Do not place the order.                                                  | Alpha |
| A        | Find a black hoodie in medium for less than $60, add it to the cart, and reach checkout. Do not place the order.             | Alpha |
| B        | (same as A)                                                                                                                  | Gamma |
| C        | Find the crewneck sweatshirt in navy, size L, for under $70, add it to the cart, and reach checkout. Do not place the order. | Alpha |
| D        | Add 3 pairs of the merino crew socks in size M to the cart and reach checkout. Do not place the order.                       | Alpha |
| E        | Find the studio headphones, wired, under $100, add them to the cart, and reach checkout. Do not place the order.             | Alpha |

### 4. The test loop (one attempt)

Set two variables first:

```bash
STORE=../northwind-storefront           # the exported repo
export STORE_URL=http://localhost:5050  # where its dev server listens
```

1. **Reset to the buggy baseline.** `tsx watch` picks up the change and restarts by itself.

   ```bash
   git -C $STORE reset --hard baseline && git -C $STORE clean -fd
   ```

2. **Confirm the starting point.**

   ```bash
   node docs/storefront/verify-scenarios.mjs --expect=bugs
   ```

3. **Run AgentProof on one or more missions:** run, then diagnose, then propose a repair, then apply the repair to `$STORE`.

4. **Grade the result.**

   ```bash
   node docs/storefront/verify-scenarios.mjs
   ```

5. **Review what the agent changed.**

   ```bash
   git -C $STORE diff --stat baseline
   git -C $STORE diff baseline
   (cd $STORE && npm run typecheck)
   ```

6. **Record the result,** then go back to step 1.

Here is the output from a dry run where only E was fixed properly and D got a bad "fix" that hid the stepper buttons with CSS. The exit code was 1:

```
B         BUG PRESENT   HOODIE-001-S x1    -                  HOODIE-001-M x1
C         BUG PRESENT   CREW-001-FOR-L x1  CREW-001-NVY-L x1  CREW-001-NVY-L x1
D         HUMAN BROKEN  SOCK-001-M x1      (empty)            SOCK-001-M x3
E         FIXED         HP-100-WIRED x1    HP-100-WIRED x1    HP-100-WIRED x1
```

### 5. Scoring an attempt

A suggested rubric, per scenario the agent was asked to fix:

| Check                | How                          | Pass when                                                                                                                                                                |
| -------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Fixed                | `verify-scenarios.mjs`       | Status `FIXED`                                                                                                                                                           |
| Humans unaffected    | same run                     | No `HUMAN BROKEN` anywhere, and `Control OK`                                                                                                                             |
| No collateral damage | same run                     | Scenarios it did not touch keep their previous status                                                                                                                    |
| Right place          | `git diff --stat baseline`   | Touches only the root-cause file(s) in bugs-and-fixes.md                                                                                                                 |
| Minimal              | `git diff baseline`          | Comparable in size to the reference patch: A +3/−42 (mostly deleting the old chip code), B +1/−3, C +4/−16, D +9/−14, E +3/−9. Most removed lines are the hint comments. |
| Still compiles       | `npm run typecheck`          | Exit 0                                                                                                                                                                   |
| Diagnosis was honest | the `Issue` AgentProof saved | `observed` matches the grader's evidence; the cause matches bugs-and-fixes.md                                                                                            |

Any fix that gets the semantic shopper to the correct cart without breaking the human shopper is fine, even if it differs from the reference patch. For example, the blind diagnosis test fixed D with a labelled number input instead of named buttons, and it passed.

### 6. Product images

`export-standalone.sh` copies whatever is in `apps/storefront/public/images/` at export time.

To add photos later, put them in `$STORE/public/images/`. If you commit them, move the baseline tag so resets keep them:

```bash
git -C $STORE add public/images
git -C $STORE commit -m "Add product photos"
git -C $STORE tag -f baseline
```

Images never change what the semantic agent sees: the alt text is always the product name.

---

## Troubleshooting

| Symptom                                                     | Cause / fix                                                                                               |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `EADDRINUSE ... :5000`                                      | macOS AirPlay Receiver. Use `STOREFRONT_PORT=5050`.                                                       |
| Grader: "Store not reachable" but `curl` works              | The port is on the browser/`fetch` blocklist (5060, 5061, ...). Pick another port.                        |
| Grader: "Playwright not found"                              | Run `pnpm playwright:install` in AgentProof, or `npm i -D playwright` next to the script.                 |
| Everything `BUG PRESENT` after the agent "applied" a fix    | The repair went to `apps/storefront` in the monorepo, not to `$STORE`. See step 3 of Part 2.              |
| `git apply` of a reference patch fails in the exported repo | Hinted repo: add `-p3`. Blind repo: expected, because the patches carry the stripped comments as context. |
| Carts look stale                                            | Each grader shopper gets a fresh session. Restarting the store clears all carts.                          |
