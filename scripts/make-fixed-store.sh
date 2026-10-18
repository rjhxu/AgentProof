#!/usr/bin/env bash
# Creates a bug-free copy of the storefront OUTSIDE the workspace, for "after the fix" agent runs.
# apps/storefront keeps its planted bugs and the git history stays clean: no apply/revert commits.
#
#   scripts/make-fixed-store.sh ../northwind-fixed
#   (cd ../northwind-fixed && STOREFRONT_PORT=5050 npm run start)
#   STORE_URL=http://localhost:5050 node docs/storefront/verify-scenarios.mjs --expect=fixed
#   pnpm cli -- --agent alpha --bug A --store http://localhost:5050
#
# The copy is its own git repo with two tags: `baseline` (every bug present, from
# docs/storefront/export-standalone.sh) and `fixed` (the five reference patches applied).
set -euo pipefail

DEST="${1:?usage: make-fixed-store.sh <dest-dir>}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

"$ROOT/docs/storefront/export-standalone.sh" "$DEST"
DEST="$(cd "$DEST" && pwd)"

# The patches are written against apps/storefront/src/...; -p3 strips a/apps/storefront/.
for p in "$ROOT"/docs/storefront/patches/bug-*.patch; do
  git -C "$DEST" apply --check -p3 "$p"
  git -C "$DEST" apply -p3 "$p"
  echo "applied $(basename "$p")"
done
git -C "$DEST" add -A
git -C "$DEST" commit -q -m "Apply the five reference fixes from docs/storefront/patches"
git -C "$DEST" tag fixed

(cd "$DEST" && npm install --no-audit --no-fund >/dev/null && npm run typecheck >/dev/null)

echo "Fixed store at $DEST (tags: baseline = all bugs present, fixed = all five patched)"
echo "Run it:    cd \"$DEST\" && STOREFRONT_PORT=5050 npm run start"
echo "Grade it:  STORE_URL=http://localhost:5050 node docs/storefront/verify-scenarios.mjs --expect=fixed"
echo "Agents:    pnpm cli -- --agent alpha --bug A --store http://localhost:5050"
