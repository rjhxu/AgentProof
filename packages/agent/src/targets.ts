import type { AgentKind } from '@agentproof/shared';
import type { Locator, Page } from 'playwright';

/**
 * Target grammar shared by the LLM-driven browser agents.
 *
 *   Alpha  role:name  exact accessible name from the accessibility tree, nothing else
 *   Beta   x,y        pixel coordinates inside the screenshot, nothing else
 *   Sigma  both       role:name when the control is in the tree, x,y when it is only visible
 *   Gamma  none       no browser
 *
 * The grammar is deliberately strict. A semantic agent that could fall back to text or CSS
 * selectors would click its way past Bug A (plain-text size chips) and the scenario would prove
 * nothing. Invalid targets are rejected with a reason that is shown back to the model, so every
 * reason names what the agent should have sent instead.
 */

export type ParsedTarget =
  | { kind: 'role'; role: string; name: string }
  | { kind: 'coord'; x: number; y: number }
  | { kind: 'invalid'; reason: string };

// Same union as profiles.ts's exported TargetGrammar; kept local so index.ts's `export *` stays unambiguous.
type TargetGrammar = 'role:name' | 'x,y';

type Viewport = { width: number; height: number };

/** ARIA roles a target may name. Anything else (text, div, css, xpath) is rejected. */
export const ARIA_ROLES = [
  'button',
  'link',
  'radio',
  'checkbox',
  'combobox',
  'textbox',
  'spinbutton',
  'option',
  'tab',
  'menuitem',
  'heading',
  'img',
  'cell',
  'row',
  'listitem',
  'group',
  'region',
  'navigation',
  'dialog',
  'switch',
  'slider',
  'searchbox',
] as const;
export type AriaRole = (typeof ARIA_ROLES)[number];

const ROLE_SET: ReadonlySet<string> = new Set<string>(ARIA_ROLES);

/** Playwright action timeout for the option / quantity helpers. Short: the tree was just read. */
export const TARGET_ACTION_TIMEOUT_MS = 2000;

export function targetGrammars(kind: AgentKind): TargetGrammar[] {
  switch (kind) {
    case 'alpha_semantic':
      return ['role:name'];
    case 'beta_vision':
      return ['x,y'];
    case 'sigma_hybrid':
      return ['role:name', 'x,y'];
    case 'gamma_structured':
      return [];
  }
}

/** One phrase, model-facing, describing what a valid target looks like for this agent. */
export function describeTargetGrammar(kind: AgentKind): string {
  switch (kind) {
    case 'alpha_semantic':
      return 'role:name with the exact accessible name from the accessibility tree, e.g. button:Add to cart or radio:M';
    case 'beta_vision':
      return 'x,y pixel coordinates inside the screenshot, e.g. 412,388';
    case 'sigma_hybrid':
      return 'role:name when the control is in the accessibility tree (e.g. button:Add to cart), or x,y pixel coordinates inside the screenshot (e.g. 412,388) when it is only visible';
    case 'gamma_structured':
      return 'no target grammar (this agent does not drive a browser)';
  }
}

// "412,388", "(412, 388)", "412.5,388", "-1,5": anything coordinate-shaped, valid or not.
const COORD_LIKE = /^[([]?\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*[)\]]?$/;

/** Trim, and remove one layer of matching quotes ("...", '...', `...`) around the whole string. */
function stripQuotes(s: string): string {
  const t = s.trim();
  if (t.length >= 2) {
    const first = t[0];
    const last = t[t.length - 1];
    if ((first === '"' || first === "'" || first === '`') && first === last) {
      return t.slice(1, -1).trim();
    }
  }
  return t;
}

/**
 * Which grammar a raw target string is shaped like, before validation. A target quoted as a
 * whole ("button:Add to cart", as a model echoing the prompt's quoting may send) is classified
 * like the unquoted one.
 */
export function targetShape(target: string): TargetGrammar | 'none' {
  const t = stripQuotes(target);
  if (COORD_LIKE.test(t)) return 'x,y';
  if (t.includes(':')) return 'role:name';
  return 'none';
}

const invalid = (reason: string): ParsedTarget => ({ kind: 'invalid', reason });

function parseRole(raw: string): ParsedTarget {
  const i = raw.indexOf(':');
  const role = raw.slice(0, i).trim().toLowerCase();
  const name = stripQuotes(raw.slice(i + 1));
  if (!ROLE_SET.has(role)) {
    return invalid(
      `"${raw}" has an unknown role "${role}"; the role must be one of ${ARIA_ROLES.join(', ')}`,
    );
  }
  if (!name) {
    return invalid(
      `"${raw}" has no accessible name after the role; use role:name with the exact name from the accessibility tree, e.g. button:Add to cart`,
    );
  }
  return { kind: 'role', role, name };
}

function parseCoord(raw: string, viewport?: Viewport): ParsedTarget {
  const m = COORD_LIKE.exec(raw);
  const x = Number(m?.[1] ?? NaN);
  const y = Number(m?.[2] ?? NaN);
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0) {
    return invalid(
      `"${raw}" must be two non-negative integers x,y inside the screenshot, e.g. 412,388`,
    );
  }
  if (viewport && (x >= viewport.width || y >= viewport.height)) {
    return invalid(
      `"${raw}" is outside the ${viewport.width}x${viewport.height} screenshot; coordinates must be inside the image`,
    );
  }
  return { kind: 'coord', x, y };
}

/**
 * Parse a target string under the grammar of `kind`.
 *
 *   role:name  text before the FIRST colon is the role (lowercased, must be in ARIA_ROLES);
 *              everything after it is the accessible name (trimmed, one layer of quotes stripped)
 *   x,y        two non-negative integers; when a viewport is given, inside it
 *
 * One layer of quotes around the whole target is ignored, so "button:Add to cart" (quoted) parses
 * like button:Add to cart. A grammar the kind does not allow, an unknown role, an empty name, and
 * anything else (CSS, text=, xpath) are invalid, with a reason the model can act on next turn.
 *
 * Invalid reasons for a non-empty target start with the quoted target itself ('"M" is not
 * role:name; use ...'), never with the word "target", so a caller may prefix the action and the
 * noun: toAgentAction() turns them into 'click target "M" is not role:name; use ...'.
 */
export function parseTarget(target: string, kind: AgentKind, viewport?: Viewport): ParsedTarget {
  const allowed = targetGrammars(kind);
  if (allowed.length === 0) {
    return invalid(`agent ${kind} does not take targets (it has no browser)`);
  }
  const raw = typeof target === 'string' ? stripQuotes(target) : '';
  if (!raw) return invalid(`empty target; use ${describeTargetGrammar(kind)}`);

  const shape = targetShape(raw);
  if (shape === 'x,y') {
    if (!allowed.includes('x,y')) {
      return invalid(
        `"${raw}" is x,y coordinates, which this agent cannot use; use ${describeTargetGrammar(kind)}`,
      );
    }
    return parseCoord(raw, viewport);
  }
  if (shape === 'role:name') {
    if (!allowed.includes('role:name')) {
      return invalid(
        `"${raw}" is role:name, which this agent cannot use; use ${describeTargetGrammar(kind)}`,
      );
    }
    return parseRole(raw);
  }
  return invalid(`"${raw}" is not ${allowed.join(' or ')}; use ${describeTargetGrammar(kind)}`);
}

/** Canonical one-line form: `button:Add to cart`, `412,388`, or `invalid target (...)`. */
export function describeTarget(t: ParsedTarget): string {
  switch (t.kind) {
    case 'role':
      return `${t.role}:${t.name}`;
    case 'coord':
      return `${t.x},${t.y}`;
    case 'invalid':
      return `invalid target (${t.reason})`;
  }
}

type RoleArg = Parameters<Page['getByRole']>[0];

/** Role + exact accessible name. The only way a semantic agent may address an element. */
export function toLocator(page: Page, t: Extract<ParsedTarget, { kind: 'role' }>): Locator {
  return page.getByRole(t.role as RoleArg, { name: t.name, exact: true });
}

async function firstByRole(page: Page, role: AriaRole, name: string): Promise<Locator | null> {
  const loc = page.getByRole(role as RoleArg, { name, exact: true });
  return (await loc.count()) > 0 ? loc.first() : null;
}

/**
 * Accept either a bare label ("Size") or a role:name target ("combobox:Size", "group:Size").
 * The ladder decides which role to look for, so a role prefix is informational only.
 */
function labelOf(groupOrTarget: string): string {
  const t = stripQuotes(groupOrTarget);
  const i = t.indexOf(':');
  if (i > 0 && ROLE_SET.has(t.slice(0, i).trim().toLowerCase())) {
    return stripQuotes(t.slice(i + 1));
  }
  return t;
}

/**
 * Pick an option by accessible name only, the way the storefront grader does:
 * radio named `value` -> combobox named `group` -> button named `value`.
 * Returns which rung worked; throws when none exists in the accessibility tree.
 *
 * This is the only option executor and it never takes coordinates: toAgentAction() rejects every
 * `select` from Beta (it picks options by clicking them) and any `select` whose target is x,y, so
 * a vision agent cannot reach the accessibility tree through this ladder. Names are matched
 * exactly and case-sensitively, as the grader does: "navy" does not find the radio "Navy".
 */
export async function chooseOption(
  page: Page,
  group: string,
  value: string,
): Promise<'radio' | 'combobox' | 'button'> {
  const groupLabel = labelOf(group);
  const optionLabel = labelOf(value);
  const timeout = TARGET_ACTION_TIMEOUT_MS;

  const radio = await firstByRole(page, 'radio', optionLabel);
  if (radio) {
    await radio.check({ timeout });
    return 'radio';
  }
  const combo = await firstByRole(page, 'combobox', groupLabel);
  if (combo) {
    try {
      await combo.selectOption({ label: optionLabel }, { timeout });
    } catch {
      await combo.selectOption(optionLabel, { timeout });
    }
    return 'combobox';
  }
  const button = await firstByRole(page, 'button', optionLabel);
  if (button) {
    await button.click({ timeout });
    return 'button';
  }
  throw new Error(
    `no radio "${optionLabel}", combobox "${groupLabel}", or button "${optionLabel}" in the accessibility tree`,
  );
}

/**
 * Set the quantity by accessible name only: spinbutton "Quantity" -> fill, else click
 * button "Increase quantity" n-1 times. Throws when neither exists and n > 1. A quantity of 1
 * needs no control (the page's default stands, as in the grader's no-op), so with neither control
 * it returns 'increase' with zero clicks instead of recording a spurious error.
 */
export async function setQuantity(page: Page, n: number): Promise<'spinbutton' | 'increase'> {
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`quantity must be a positive integer, got ${String(n)}`);
  }
  const timeout = TARGET_ACTION_TIMEOUT_MS;
  const field = await firstByRole(page, 'spinbutton', 'Quantity');
  if (field) {
    await field.fill(String(n), { timeout });
    return 'spinbutton';
  }
  const plus = await firstByRole(page, 'button', 'Increase quantity');
  if (plus) {
    for (let i = 1; i < n; i++) await plus.click({ timeout });
    return 'increase';
  }
  if (n === 1) return 'increase';
  throw new Error(
    'no spinbutton "Quantity" or button "Increase quantity" in the accessibility tree',
  );
}
