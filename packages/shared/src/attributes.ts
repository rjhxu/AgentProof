/**
 * Attribute comparison shared by the verifier, Gamma, and the report builder.
 * Case-insensitive, tolerant of common size spellings ("M" vs "medium").
 */
const SIZE_ALIASES: Record<string, string[]> = {
  xs: ['extra small', 'x-small', 'xsmall'],
  s: ['small', 'sm'],
  m: ['medium', 'med'],
  l: ['large', 'lg'],
  xl: ['extra large', 'x-large', 'xlarge'],
};

export const normalizeAttribute = (value: string | undefined): string =>
  (value ?? '').trim().toLowerCase();

export function attributeMatches(required: string, observed: string | undefined): boolean {
  if (observed === undefined) return false;
  const r = normalizeAttribute(required);
  const o = normalizeAttribute(observed);
  if (r === o) return true;
  return (SIZE_ALIASES[r] ?? []).includes(o) || (SIZE_ALIASES[o] ?? []).includes(r);
}

/** True when every required attribute is satisfied by the observed attributes. */
export function attributesSatisfy(
  required: Record<string, string>,
  observed: Record<string, string>,
): boolean {
  return Object.entries(required).every(([k, v]) => attributeMatches(v, observed[k]));
}

/** Simple token match: every word of `query` appears in `name` (case-insensitive). */
export function productNameMatches(query: string, name: string): boolean {
  const n = name.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => n.includes(word));
}
