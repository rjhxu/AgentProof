#!/usr/bin/env bash
# Copies apps/storefront into a new, self-contained git repo (npm, no workspace), so a code-fix
# agent can be tested against a repo that holds only the store: no AgentProof code, no answer key.
#
#   docs/storefront/export-standalone.sh <dest-dir>           # keep the DEMO BUG hint comments
#   docs/storefront/export-standalone.sh <dest-dir> --blind   # strip every comment that hints at a bug
#
# The new repo gets one commit tagged `baseline` (all bugs present). Reset between attempts with
#   git reset --hard baseline && git clean -fd
set -euo pipefail

DEST="${1:?usage: export-standalone.sh <dest-dir> [--blind]}"
MODE="${2:-}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SRC="$ROOT/apps/storefront"

if [ -e "$DEST" ]; then
  echo "refusing to overwrite: $DEST already exists" >&2
  exit 1
fi
if [ -n "$MODE" ] && [ "$MODE" != "--blind" ]; then
  echo "unknown option: $MODE (expected --blind)" >&2
  exit 1
fi

mkdir -p "$DEST"
DEST="$(cd "$DEST" && pwd)"
cp -R "$SRC/src" "$SRC/public" "$DEST/"

# package.json and tsconfig.json, derived from the monorepo's so versions and compiler options match.
node --input-type=module - "$SRC/package.json" "$ROOT/tsconfig.base.json" "$DEST" <<'JS'
import fs from 'node:fs';
const [pkgPath, basePath, dest] = process.argv.slice(2);
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const base = JSON.parse(fs.readFileSync(basePath, 'utf8'));
const { vitest, ...devDependencies } = pkg.devDependencies;
const out = {
  name: 'northwind-storefront',
  version: '0.1.0',
  private: true,
  type: 'module',
  description: 'Northwind Threads: a small synthetic storefront used as a test target.',
  engines: { node: '>=22' },
  scripts: {
    dev: 'tsx watch --env-file-if-exists=.env src/server.ts',
    start: 'tsx --env-file-if-exists=.env src/server.ts',
    typecheck: 'tsc -p tsconfig.json',
  },
  dependencies: pkg.dependencies,
  devDependencies,
};
fs.writeFileSync(`${dest}/package.json`, JSON.stringify(out, null, 2) + '\n');
const tsconfig = {
  compilerOptions: { ...base.compilerOptions, types: ['node'] },
  include: ['src'],
};
fs.writeFileSync(`${dest}/tsconfig.json`, JSON.stringify(tsconfig, null, 2) + '\n');
JS

cat > "$DEST/.gitignore" <<'EOF'
node_modules/
.env
*.log
.DS_Store
EOF

cat > "$DEST/.env.example" <<'EOF'
# Port the store listens on. macOS AirPlay Receiver often holds 5000; use 5050 there.
STOREFRONT_PORT=5000
LOG_LEVEL=warn
EOF

cat > "$DEST/README.md" <<'EOF'
# Northwind Threads

A small synthetic storefront used as a test target for automated shopping agents.
Server-rendered HTML on Fastify, in-memory carts, no payments, no accounts.

```bash
npm install
npm run dev            # http://localhost:5000  (STOREFRONT_PORT=5050 npm run dev to change)
npm run typecheck
```

| Route                         | What                                                    |
| ----------------------------- | ------------------------------------------------------- |
| `GET /`                       | Product listing                                         |
| `GET /products/:slug`         | Product page with options and Add to cart               |
| `GET /cart`, `GET /checkout`  | Cart and order review (placing an order is disabled)    |
| `GET /api/catalog.json`       | Machine-readable catalog                                |
| `GET/POST/DELETE /api/cart`   | Cart for the current session (`nw_session` cookie)      |

Product photos go in `public/images/<slug>.jpg` (`.png`/`.webp` also work); pages show a
placeholder until one exists. Carts live in memory and reset when the server restarts.
EOF

if [ "$MODE" = "--blind" ]; then
  # Strip comments that describe a bug or its fix. Code is untouched.
  python3 - "$DEST/src" <<'PY'
import pathlib, re, sys

HINT = re.compile(
    r'DEMO BUG|BUG:|planted|[Ss]pec example|mis-mapped|never notice|bites the API'
    r'|legacy id map|mouse only'
)
BLOCK = re.compile(r'^[ \t]*/\*.*?\*/[ \t]*\n', re.S | re.M)

for f in sorted(pathlib.Path(sys.argv[1]).glob('*.ts')):
    text = BLOCK.sub(lambda m: '' if HINT.search(m.group(0)) else m.group(0), f.read_text())
    out, run = [], []

    def flush():
        if not any(HINT.search(l) for l in run):
            out.extend(run)
        run.clear()

    for line in text.split('\n'):
        if re.match(r'\s*//', line):
            run.append(line)
            continue
        flush()
        trailing = re.search(r'\s+//(.*)$', line)
        if trailing and HINT.search(trailing.group(1)):
            line = line[: trailing.start()]
        out.append(line)
    flush()
    f.write_text(re.sub(r'\n{3,}', '\n\n', '\n'.join(out)))
PY
  if grep -rniE 'DEMO BUG|planted|BUG:' "$DEST/src"; then
    echo "warning: hint text survived the strip (lines above)" >&2
  fi
fi

# Commit a lockfile with the baseline so resets (git clean -fd) never touch it.
if ! (cd "$DEST" && npm install --package-lock-only --no-audit --no-fund >/dev/null 2>&1); then
  echo "warning: could not generate package-lock.json (offline?); run npm install and commit it" >&2
fi

git -C "$DEST" init -q -b main
git -C "$DEST" add -A
git -C "$DEST" commit -q -m "Northwind Threads test storefront${MODE:+ (blind)}"
git -C "$DEST" tag baseline

echo "Created $DEST ($(git -C "$DEST" rev-parse --short HEAD), tagged baseline)${MODE:+ in blind mode}"
echo "Next: cd \"$DEST\" && npm install && npm run dev"
