/**
 * The store URL as the runner wants it (`CreateMissionRequest.storeUrl` is a URL): a bare host
 * gets http://, the origin and path are kept without a trailing slash, query and hash are
 * dropped. Undefined when the text is not an http(s) URL; the caller shows the field error.
 */
export function normalizeStoreUrl(input: string): string | undefined {
  const trimmed = input.trim();
  if (trimmed === '') return undefined;
  const withScheme = trimmed.includes('://') ? trimmed : `http://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  const path = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '');
  return `${url.origin}${path}`;
}
