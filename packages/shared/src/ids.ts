/**
 * Short, prefixed ids so logs and URLs are readable: run_3f9a..., mis_..., ev_...
 * Uses the Web Crypto global (Node 19+ and browsers) so this file is safe to import from Next
 * and needs no ambient node/dom types in consumers.
 */
const webCrypto = (globalThis as unknown as { crypto: { randomUUID(): string } }).crypto;

export function newId(prefix: 'mis' | 'run' | 'ev' | 'iss' | 'rep'): string {
  return `${prefix}_${webCrypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}
