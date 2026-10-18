import { describe, expect, it, vi } from 'vitest';
import type { Page } from 'playwright';
import type { AgentKind } from '@agentproof/shared';
import {
  ARIA_ROLES,
  TARGET_ACTION_TIMEOUT_MS,
  chooseOption,
  describeTarget,
  describeTargetGrammar,
  parseTarget,
  resolveRoleTarget,
  setQuantity,
  targetGrammars,
  targetShape,
  toLocator,
} from './targets';

const ALPHA: AgentKind = 'alpha_semantic';
const BETA: AgentKind = 'beta_vision';
const SIGMA: AgentKind = 'sigma_hybrid';
const GAMMA: AgentKind = 'gamma_structured';
const VIEWPORT = { width: 1280, height: 800 };

function invalidReason(target: string, kind: AgentKind, viewport?: typeof VIEWPORT): string {
  const t = parseTarget(target, kind, viewport);
  expect(t.kind).toBe('invalid');
  return t.kind === 'invalid' ? t.reason : '';
}

describe('targetGrammars', () => {
  it('gives each kind its grammar', () => {
    expect(targetGrammars(ALPHA)).toEqual(['role:name']);
    expect(targetGrammars(BETA)).toEqual(['x,y']);
    expect(targetGrammars(SIGMA)).toEqual(['role:name', 'x,y']);
    expect(targetGrammars(GAMMA)).toEqual([]);
  });

  it('describes the grammar with a concrete example the model can copy', () => {
    expect(describeTargetGrammar(ALPHA)).toContain('button:Add to cart');
    expect(describeTargetGrammar(BETA)).toContain('412,388');
    expect(describeTargetGrammar(SIGMA)).toContain('button:Add to cart');
    expect(describeTargetGrammar(SIGMA)).toContain('412,388');
  });
});

describe('targetShape', () => {
  it('classifies before validating', () => {
    expect(targetShape('button:Add to cart')).toBe('role:name');
    expect(targetShape('412,388')).toBe('x,y');
    expect(targetShape(' (412, 388) ')).toBe('x,y');
    expect(targetShape('-1,5')).toBe('x,y');
    expect(targetShape('Size')).toBe('none');
    expect(targetShape('.chip')).toBe('none');
    expect(targetShape('text=M')).toBe('none');
  });
});

describe('parseTarget: role:name (Alpha)', () => {
  it('parses role and exact name', () => {
    expect(parseTarget('button:Add to cart', ALPHA)).toEqual({
      kind: 'role',
      role: 'button',
      name: 'Add to cart',
    });
    expect(parseTarget('link:Black Hoodie', ALPHA)).toEqual({
      kind: 'role',
      role: 'link',
      name: 'Black Hoodie',
    });
  });

  it('lowercases and trims the role, trims the name, strips one layer of quotes', () => {
    expect(parseTarget('  Button : "Add to cart" ', ALPHA)).toEqual({
      kind: 'role',
      role: 'button',
      name: 'Add to cart',
    });
    expect(parseTarget("radio:'M'", ALPHA)).toEqual({ kind: 'role', role: 'radio', name: 'M' });
    expect(parseTarget('spinbutton:`Quantity`', ALPHA)).toEqual({
      kind: 'role',
      role: 'spinbutton',
      name: 'Quantity',
    });
  });

  it('splits on the FIRST colon so names may contain colons', () => {
    expect(parseTarget('link:Products: Hoodies', ALPHA)).toEqual({
      kind: 'role',
      role: 'link',
      name: 'Products: Hoodies',
    });
  });

  it('accepts every role in ARIA_ROLES', () => {
    for (const role of ARIA_ROLES) {
      expect(parseTarget(`${role}:Some name`, ALPHA)).toEqual({
        kind: 'role',
        role,
        name: 'Some name',
      });
    }
    expect(ARIA_ROLES).toEqual(
      expect.arrayContaining([
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
      ]),
    );
  });

  it('rejects unknown roles (text, div, css) and lists the valid ones', () => {
    for (const bad of ['text:M', 'div:M', 'css=div:nth-child(2)', 'a:has-text("M")']) {
      const reason = invalidReason(bad, ALPHA);
      expect(reason).toContain('unknown role');
      expect(reason).toContain('button, link, radio');
    }
  });

  it('rejects an empty name', () => {
    expect(invalidReason('radio:', ALPHA)).toContain('no accessible name');
    expect(invalidReason('radio:""', ALPHA)).toContain('no accessible name');
  });

  it('rejects an empty target', () => {
    expect(invalidReason('', ALPHA)).toContain('empty');
    expect(invalidReason('   ', ALPHA)).toContain('empty');
  });

  it('rejects CSS, text= and xpath selectors with a hint toward role:name', () => {
    for (const bad of ['.chip', '#add-to-cart', 'text=M', 'xpath=//div[@class="chip"]', 'M']) {
      const reason = invalidReason(bad, ALPHA);
      expect(reason).toContain('is not role:name');
      expect(reason).toContain('button:Add to cart');
    }
  });

  it('rejects coordinates for Alpha and names the allowed grammar', () => {
    const reason = invalidReason('412,388', ALPHA);
    expect(reason).toContain('x,y coordinates');
    expect(reason).toContain('cannot use');
    expect(reason).toContain('role:name');
  });

  it('starts every reason for a non-empty target with the quoted target, never "target"', () => {
    const cases: Array<[string, AgentKind]> = [
      ['M', ALPHA],
      ['412,388', ALPHA],
      ['text:M', ALPHA],
      ['radio:', ALPHA],
      ['button:Add to cart', BETA],
      ['-1,5', BETA],
      ['2000,100', BETA],
      ['.chip', SIGMA],
    ];
    for (const [target, kind] of cases) {
      const reason = invalidReason(target, kind, VIEWPORT);
      expect(reason.startsWith(`"${target}"`), reason).toBe(true);
      expect(reason).not.toMatch(/^target\b/);
    }
  });
});

describe('parseTarget: x,y (Beta)', () => {
  it('parses two non-negative integers', () => {
    expect(parseTarget('412,388', BETA)).toEqual({ kind: 'coord', x: 412, y: 388 });
    expect(parseTarget(' 0 , 0 ', BETA)).toEqual({ kind: 'coord', x: 0, y: 0 });
    expect(parseTarget('(412, 388)', BETA)).toEqual({ kind: 'coord', x: 412, y: 388 });
  });

  it('checks viewport bounds when a viewport is given', () => {
    expect(parseTarget('1279,799', BETA, VIEWPORT)).toEqual({ kind: 'coord', x: 1279, y: 799 });
    expect(invalidReason('1280,100', BETA, VIEWPORT)).toContain('outside the 1280x800');
    expect(invalidReason('100,800', BETA, VIEWPORT)).toContain('outside the 1280x800');
    expect(invalidReason('5000,5000', BETA, VIEWPORT)).toContain('outside');
    // no viewport: no bounds check
    expect(parseTarget('5000,5000', BETA)).toEqual({ kind: 'coord', x: 5000, y: 5000 });
  });

  it('rejects negative and non-integer coordinates', () => {
    expect(invalidReason('-1,5', BETA)).toContain('non-negative integers');
    expect(invalidReason('412.5,388', BETA)).toContain('non-negative integers');
  });

  it('rejects role:name for Beta and names the allowed grammar', () => {
    const reason = invalidReason('button:Add to cart', BETA);
    expect(reason).toContain('role:name');
    expect(reason).toContain('cannot use');
    expect(reason).toContain('x,y');
    expect(reason).toContain('412,388');
  });

  it('rejects anything else with a hint toward x,y', () => {
    const reason = invalidReason('M', BETA);
    expect(reason).toContain('is not x,y');
    expect(reason).toContain('412,388');
    expect(invalidReason('.chip', BETA)).toContain('is not x,y');
  });
});

describe('parseTarget: Sigma accepts both grammars', () => {
  it('parses role:name and x,y', () => {
    expect(parseTarget('button:Add to cart', SIGMA)).toEqual({
      kind: 'role',
      role: 'button',
      name: 'Add to cart',
    });
    expect(parseTarget('412,388', SIGMA, VIEWPORT)).toEqual({ kind: 'coord', x: 412, y: 388 });
  });

  it('still rejects selectors, unknown roles and out-of-bounds coordinates', () => {
    const reason = invalidReason('.chip', SIGMA);
    expect(reason).toContain('is not role:name or x,y');
    expect(invalidReason('text:M', SIGMA)).toContain('unknown role');
    expect(invalidReason('2000,10', SIGMA, VIEWPORT)).toContain('outside');
  });
});

describe('parseTarget: Gamma has no grammar', () => {
  it('rejects every target', () => {
    expect(invalidReason('button:Add to cart', GAMMA)).toContain('does not take targets');
    expect(invalidReason('412,388', GAMMA)).toContain('does not take targets');
  });
});

describe('describeTarget', () => {
  it('prints the canonical form', () => {
    expect(describeTarget({ kind: 'role', role: 'button', name: 'Add to cart' })).toBe(
      'button:Add to cart',
    );
    expect(describeTarget({ kind: 'coord', x: 412, y: 388 })).toBe('412,388');
    expect(describeTarget({ kind: 'invalid', reason: 'nope' })).toBe('invalid target (nope)');
  });

  it('round-trips through parseTarget', () => {
    const t = parseTarget('  LINK: "Proceed to checkout" ', SIGMA);
    expect(describeTarget(t)).toBe('link:Proceed to checkout');
    expect(parseTarget(describeTarget(t), ALPHA)).toEqual(t);
  });
});

// ---- Playwright-facing helpers, against a fake Page ----------------------------------------

type FakeLocator = {
  count: ReturnType<typeof vi.fn>;
  first: ReturnType<typeof vi.fn>;
  check: ReturnType<typeof vi.fn>;
  click: ReturnType<typeof vi.fn>;
  fill: ReturnType<typeof vi.fn>;
  selectOption: ReturnType<typeof vi.fn>;
};

function fakeLocator(exists: boolean, opts: { labelSelectFails?: boolean } = {}): FakeLocator {
  const loc: FakeLocator = {
    count: vi.fn(async () => (exists ? 1 : 0)),
    first: vi.fn(),
    check: vi.fn(async () => undefined),
    click: vi.fn(async () => undefined),
    fill: vi.fn(async () => undefined),
    selectOption: vi.fn(async (arg: unknown) => {
      if (opts.labelSelectFails && typeof arg === 'object') throw new Error('no option label');
      return [];
    }),
  };
  loc.first.mockImplementation(() => loc);
  return loc;
}

/** `present` maps "role:name" to a locator that exists; everything else has count 0. */
function fakePage(present: Record<string, FakeLocator>) {
  const getByRole = vi.fn(
    (role: string, o: { name: string; exact: boolean }) =>
      present[`${role}:${o.name}`] ?? fakeLocator(false),
  );
  return { page: { getByRole } as unknown as Page, getByRole };
}

describe('toLocator', () => {
  it('uses getByRole with the exact accessible name', () => {
    const { page, getByRole } = fakePage({});
    toLocator(page, { kind: 'role', role: 'button', name: 'Add to cart' });
    expect(getByRole).toHaveBeenCalledWith('button', { name: 'Add to cart', exact: true });
  });
});

describe('resolveRoleTarget', () => {
  const addToCart = { kind: 'role', role: 'button', name: 'Add to cart' } as const;

  it('returns the role locator unchanged when the control is in the tree', async () => {
    const button = fakeLocator(true);
    const { page, getByRole } = fakePage({ 'button:Add to cart': button });
    await expect(resolveRoleTarget(page, addToCart)).resolves.toBe(button);
    expect(getByRole).toHaveBeenCalledWith('button', { name: 'Add to cart', exact: true });
    expect(button.first).not.toHaveBeenCalled();
    expect(button.click).not.toHaveBeenCalled();
  });

  it('throws at once when the control is not in the accessibility tree', async () => {
    const { page } = fakePage({});
    await expect(resolveRoleTarget(page, addToCart)).rejects.toThrow(
      'no button "Add to cart" in the accessibility tree',
    );
  });
});

describe('chooseOption ladder: radio -> combobox -> button', () => {
  it('checks a radio named after the value', async () => {
    const radio = fakeLocator(true);
    const { page, getByRole } = fakePage({ 'radio:M': radio });
    await expect(chooseOption(page, 'Size', 'M')).resolves.toBe('radio');
    expect(radio.check).toHaveBeenCalledWith({ timeout: TARGET_ACTION_TIMEOUT_MS });
    expect(getByRole).toHaveBeenCalledWith('radio', { name: 'M', exact: true });
  });

  it('falls back to a combobox named after the group, selecting by label', async () => {
    const combo = fakeLocator(true);
    const { page } = fakePage({ 'combobox:Size': combo });
    await expect(chooseOption(page, 'Size', 'M')).resolves.toBe('combobox');
    expect(combo.selectOption).toHaveBeenCalledTimes(1);
    expect(combo.selectOption).toHaveBeenCalledWith(
      { label: 'M' },
      { timeout: TARGET_ACTION_TIMEOUT_MS },
    );
  });

  it('retries the combobox by value when selecting by label fails', async () => {
    const combo = fakeLocator(true, { labelSelectFails: true });
    const { page } = fakePage({ 'combobox:Size': combo });
    await expect(chooseOption(page, 'Size', 'M')).resolves.toBe('combobox');
    expect(combo.selectOption).toHaveBeenCalledTimes(2);
    expect(combo.selectOption).toHaveBeenLastCalledWith('M', {
      timeout: TARGET_ACTION_TIMEOUT_MS,
    });
  });

  it('falls back to a button named after the value', async () => {
    const button = fakeLocator(true);
    const { page } = fakePage({ 'button:M': button });
    await expect(chooseOption(page, 'Size', 'M')).resolves.toBe('button');
    expect(button.click).toHaveBeenCalledWith({ timeout: TARGET_ACTION_TIMEOUT_MS });
  });

  it('throws a message listing everything it looked for (Bug A)', async () => {
    const { page } = fakePage({});
    await expect(chooseOption(page, 'Size', 'M')).rejects.toThrow(
      'no radio "M", combobox "Size", or button "M" in the accessibility tree',
    );
  });

  it('accepts a role:name group such as combobox:Size and uses its name', async () => {
    const combo = fakeLocator(true);
    const { page, getByRole } = fakePage({ 'combobox:Size': combo });
    await expect(chooseOption(page, 'combobox:Size', '"M"')).resolves.toBe('combobox');
    expect(getByRole).toHaveBeenCalledWith('combobox', { name: 'Size', exact: true });
    expect(getByRole).toHaveBeenCalledWith('radio', { name: 'M', exact: true });
  });

  it('never touches text or CSS selectors', async () => {
    const { page, getByRole } = fakePage({});
    await chooseOption(page, 'Size', 'M').catch(() => undefined);
    for (const call of getByRole.mock.calls) {
      expect(['radio', 'combobox', 'button']).toContain(call[0]);
      expect(call[1]).toMatchObject({ exact: true });
    }
  });
});

describe('setQuantity', () => {
  it('fills a spinbutton named Quantity', async () => {
    const field = fakeLocator(true);
    const { page } = fakePage({ 'spinbutton:Quantity': field });
    await expect(setQuantity(page, 3)).resolves.toBe('spinbutton');
    expect(field.fill).toHaveBeenCalledWith('3', { timeout: TARGET_ACTION_TIMEOUT_MS });
  });

  it('otherwise clicks "Increase quantity" n-1 times', async () => {
    const plus = fakeLocator(true);
    const { page } = fakePage({ 'button:Increase quantity': plus });
    await expect(setQuantity(page, 3)).resolves.toBe('increase');
    expect(plus.click).toHaveBeenCalledTimes(2);
    plus.click.mockClear();
    await expect(setQuantity(page, 1)).resolves.toBe('increase');
    expect(plus.click).not.toHaveBeenCalled();
  });

  it('throws when neither control is in the tree (Bug D)', async () => {
    const { page } = fakePage({});
    await expect(setQuantity(page, 3)).rejects.toThrow(
      'no spinbutton "Quantity" or button "Increase quantity" in the accessibility tree',
    );
  });

  it('is a no-op for quantity 1 when neither control exists (the default stands)', async () => {
    const { page, getByRole } = fakePage({});
    await expect(setQuantity(page, 1)).resolves.toBe('increase');
    for (const call of getByRole.mock.calls) expect(['spinbutton', 'button']).toContain(call[0]);
  });

  it('rejects a non-positive or fractional quantity', async () => {
    const { page } = fakePage({ 'spinbutton:Quantity': fakeLocator(true) });
    await expect(setQuantity(page, 0)).rejects.toThrow('positive integer');
    await expect(setQuantity(page, 1.5)).rejects.toThrow('positive integer');
  });
});
