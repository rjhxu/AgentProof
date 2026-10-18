/*
 * Where the store lives inside a connected repository, from its file list alone: '' when the
 * repository is only the store, else the directory that holds it. The code-fix agent takes this
 * as `storeRoot` and keeps every edit inside it. A guess the merchant can correct, never a verdict.
 */

function normalize(file: string): string {
  return file.replace(/\\/g, '/').replace(/^\.?\/+/, '');
}

/** A directory named for a store wins over a shorter path: this monorepo also has a runner server. */
const STORE_WORDS = /store|shop/i;

function preferStoreThenShortest(a: string, b: string): number {
  const storeA = STORE_WORDS.test(a) ? 0 : 1;
  const storeB = STORE_WORDS.test(b) ? 0 : 1;
  return storeA - storeB || a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
}

export function detectStoreRoot(files: string[]): string {
  const paths = files.map(normalize).filter((f) => f !== '');
  const hasSrcAtRoot = paths.some((f) => f.startsWith('src/'));
  const markerAtRoot = paths.some((f) => f === 'src/server.ts' || f === 'package.json');
  if (markerAtRoot && hasSrcAtRoot) return '';

  const servers = paths
    .filter((f) => /(^|\/)src\/server\.ts$/.test(f))
    .map((f) => f.replace(/(^|\/)src\/server\.ts$/, ''))
    .sort(preferStoreThenShortest);
  const server = servers[0];
  if (server !== undefined) return server;

  const manifests = paths
    .filter((f) => /\/package\.json$/.test(f))
    .map((f) => f.replace(/\/package\.json$/, ''))
    .sort(preferStoreThenShortest);
  const manifest = manifests[0];
  if (manifest !== undefined) return manifest;

  return '';
}
