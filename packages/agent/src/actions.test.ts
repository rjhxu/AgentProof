import { describe, expect, it } from 'vitest';
import {
  AgentActionDraft,
  type AgentAction,
  type AgentKind,
  type RunStep,
} from '@agentproof/shared';
import { alphaFailedRun } from '@agentproof/shared/fixtures';
import {
  ACTION_SCHEMA_NAME,
  actionDraftJsonSchema,
  summarizeAction,
  summarizeStep,
  toAgentAction,
} from './actions';

const ALPHA: AgentKind = 'alpha_semantic';
const BETA: AgentKind = 'beta_vision';
const SIGMA: AgentKind = 'sigma_hybrid';
const VIEWPORT = { width: 1280, height: 800 };

/** A complete draft with every optional field null, overridden per test. */
function draft(over: Record<string, unknown>): Record<string, unknown> {
  return {
    type: 'click',
    reason: 'because',
    target: null,
    url: null,
    text: null,
    value: null,
    direction: null,
    what: null,
    ...over,
  };
}

function expectOk(draftObj: unknown, kind: AgentKind): AgentAction {
  const res = toAgentAction(draftObj, kind, VIEWPORT);
  expect(res.ok, res.ok ? '' : res.reason).toBe(true);
  return res.ok ? res.action : (undefined as never);
}

/** The target of a click/type/select action; undefined for the others. */
function targetOf(action: AgentAction): string | undefined {
  return 'target' in action ? action.target : undefined;
}

function expectFail(draftObj: unknown, kind: AgentKind): string {
  const res = toAgentAction(draftObj, kind, VIEWPORT);
  expect(res.ok).toBe(false);
  return res.ok ? '' : res.reason;
}

function walk(node: unknown, visit: (key: string, value: unknown) => void): void {
  if (Array.isArray(node)) return node.forEach((n) => walk(n, visit));
  if (typeof node !== 'object' || node === null) return;
  for (const [k, v] of Object.entries(node)) {
    visit(k, v);
    walk(v, visit);
  }
}

describe('actionDraftJsonSchema', () => {
  const { name, schema } = actionDraftJsonSchema();
  const props = schema.properties as Record<string, Record<string, unknown>>;

  it('is named and rooted at a strict object', () => {
    expect(name).toBe(ACTION_SCHEMA_NAME);
    expect(schema.type).toBe('object');
    expect(schema.additionalProperties).toBe(false);
    expect(schema).not.toHaveProperty('$schema');
  });

  it('requires every property of AgentActionDraft', () => {
    const keys = Object.keys(AgentActionDraft.shape);
    expect(Object.keys(props).sort()).toEqual([...keys].sort());
    expect([...(schema.required as string[])].sort()).toEqual([...keys].sort());
  });

  it('expresses nullable fields with a null type', () => {
    for (const field of ['target', 'url', 'text', 'value', 'what']) {
      expect(props[field]?.type).toEqual(['string', 'null']);
    }
    const direction = props.direction?.anyOf as Array<Record<string, unknown>>;
    expect(direction).toEqual(
      expect.arrayContaining([{ type: 'null' }, expect.objectContaining({ enum: ['up', 'down'] })]),
    );
    expect(props.type?.enum).toEqual([
      'navigate',
      'click',
      'type',
      'select',
      'scroll',
      'extract',
      'done',
      'fail',
    ]);
  });

  it('contains no default or $schema keys anywhere', () => {
    walk(schema, (key) => {
      expect(key).not.toBe('default');
      expect(key).not.toBe('$schema');
    });
  });

  it('describes each field for the model', () => {
    for (const field of Object.keys(props)) expect(typeof props[field]?.description).toBe('string');
  });

  it('is a fresh object each call', () => {
    expect(actionDraftJsonSchema().schema).not.toBe(schema);
  });
});

describe('toAgentAction: schema validation', () => {
  it('rejects non-objects and unknown types with a readable reason', () => {
    expect(expectFail(null, ALPHA)).toContain('must be a JSON object');
    expect(expectFail('click', ALPHA)).toContain('must be a JSON object');
    expect(expectFail([1], ALPHA)).toContain('must be a JSON object');
    const reason = expectFail(draft({ type: 'hover' }), ALPHA);
    expect(reason).toContain('does not match the schema');
    expect(reason).toContain('type');
  });

  it('treats missing optional fields as null', () => {
    const action = expectOk({ type: 'scroll', reason: 'look', direction: 'down' }, ALPHA);
    expect(action).toEqual({ type: 'scroll', direction: 'down', reason: 'look' });
  });

  it('rejects a missing reason', () => {
    expect(expectFail({ type: 'scroll', direction: 'down' }, ALPHA)).toContain('reason');
  });
});

describe('toAgentAction: navigate', () => {
  it('accepts absolute http(s) urls', () => {
    expect(expectOk(draft({ type: 'navigate', url: 'http://localhost:5000/cart' }), ALPHA)).toEqual(
      { type: 'navigate', url: 'http://localhost:5000/cart', reason: 'because' },
    );
    expect(expectOk(draft({ type: 'navigate', url: ' https://shop.test/ ' }), BETA).type).toBe(
      'navigate',
    );
  });

  it('rejects missing, relative and non-http urls', () => {
    expect(expectFail(draft({ type: 'navigate' }), ALPHA)).toContain('navigate needs "url"');
    expect(expectFail(draft({ type: 'navigate', url: '/cart' }), ALPHA)).toContain(
      'not an absolute http(s) URL',
    );
    expect(expectFail(draft({ type: 'navigate', url: 'javascript:alert(1)' }), ALPHA)).toContain(
      'must use http or https',
    );
    expect(expectFail(draft({ type: 'navigate', url: 'file:///etc/passwd' }), ALPHA)).toContain(
      'must use http or https',
    );
  });
});

describe('toAgentAction: click', () => {
  it('accepts a role:name target for Alpha and canonicalizes it', () => {
    expect(expectOk(draft({ type: 'click', target: ' Button: "Add to cart" ' }), ALPHA)).toEqual({
      type: 'click',
      target: 'button:Add to cart',
      reason: 'because',
    });
  });

  it('accepts x,y for Beta inside the viewport and canonicalizes it', () => {
    expect(expectOk(draft({ type: 'click', target: '(412, 388)' }), BETA)).toEqual({
      type: 'click',
      target: '412,388',
      reason: 'because',
    });
  });

  it('accepts both grammars for Sigma', () => {
    expect(targetOf(expectOk(draft({ type: 'click', target: 'radio:M' }), SIGMA))).toBe('radio:M');
    expect(targetOf(expectOk(draft({ type: 'click', target: '412,388' }), SIGMA))).toBe('412,388');
  });

  it('rejects a missing target with the grammar hint', () => {
    expect(expectFail(draft({ type: 'click' }), ALPHA)).toContain('click needs "target"');
    expect(expectFail(draft({ type: 'click', target: '  ' }), BETA)).toContain('412,388');
  });

  it('rejects the wrong grammar for the kind, naming the right one', () => {
    const alpha = expectFail(draft({ type: 'click', target: '412,388' }), ALPHA);
    expect(alpha).toContain('click target');
    expect(alpha).toContain('role:name');
    const beta = expectFail(draft({ type: 'click', target: 'button:Add to cart' }), BETA);
    expect(beta).toContain('x,y');
    expect(expectFail(draft({ type: 'click', target: '2000,100' }), BETA)).toContain('outside');
    expect(expectFail(draft({ type: 'click', target: 'text:M' }), ALPHA)).toContain('unknown role');
    expect(expectFail(draft({ type: 'click', target: '.chip' }), ALPHA)).toContain(
      'is not role:name',
    );
  });
});

describe('toAgentAction: type', () => {
  it('needs a target and text', () => {
    expect(
      expectOk(draft({ type: 'type', target: 'spinbutton:Quantity', text: '3' }), ALPHA),
    ).toEqual({ type: 'type', target: 'spinbutton:Quantity', text: '3', reason: 'because' });
    expect(targetOf(expectOk(draft({ type: 'type', target: '640,300', text: '3' }), BETA))).toBe(
      '640,300',
    );
    expect(expectFail(draft({ type: 'type', text: '3' }), ALPHA)).toContain('type needs "target"');
    expect(expectFail(draft({ type: 'type', target: 'spinbutton:Quantity' }), ALPHA)).toContain(
      'type needs "text"',
    );
    expect(expectFail(draft({ type: 'type', target: '640,300', text: '3' }), ALPHA)).toContain(
      'type target',
    );
  });
});

describe('toAgentAction: select', () => {
  it('accepts an option group label plus value for tree-reading agents', () => {
    expect(expectOk(draft({ type: 'select', target: 'Size', value: 'M' }), ALPHA)).toEqual({
      type: 'select',
      target: 'Size',
      value: 'M',
      reason: 'because',
    });
    expect(expectOk(draft({ type: 'select', target: '"Color"', value: 'navy' }), SIGMA)).toEqual({
      type: 'select',
      target: 'Color',
      value: 'navy',
      reason: 'because',
    });
  });

  it('accepts a role:name target for Alpha and Sigma', () => {
    expect(expectOk(draft({ type: 'select', target: 'combobox:Size', value: 'M' }), ALPHA)).toEqual(
      { type: 'select', target: 'combobox:Size', value: 'M', reason: 'because' },
    );
  });

  it('accepts x,y for Beta but not a label (Beta has no accessibility tree)', () => {
    expect(targetOf(expectOk(draft({ type: 'select', target: '412,388', value: 'M' }), BETA))).toBe(
      '412,388',
    );
    const reason = expectFail(draft({ type: 'select', target: 'Size', value: 'M' }), BETA);
    expect(reason).toContain('label');
    expect(reason).toContain('x,y');
  });

  it('rejects a missing target or value, and invalid targets', () => {
    expect(expectFail(draft({ type: 'select', value: 'M' }), ALPHA)).toContain(
      'select needs "target"',
    );
    expect(expectFail(draft({ type: 'select', target: 'Size' }), ALPHA)).toContain(
      'select needs "value"',
    );
    expect(expectFail(draft({ type: 'select', target: 'text:Size', value: 'M' }), ALPHA)).toContain(
      'select target unknown role',
    );
    expect(expectFail(draft({ type: 'select', target: '412,388', value: 'M' }), ALPHA)).toContain(
      'select target',
    );
  });
});

describe('toAgentAction: scroll, extract, done, fail', () => {
  it('scroll needs a direction', () => {
    expect(expectOk(draft({ type: 'scroll', direction: 'up' }), BETA)).toEqual({
      type: 'scroll',
      direction: 'up',
      reason: 'because',
    });
    expect(expectFail(draft({ type: 'scroll' }), BETA)).toContain('scroll needs "direction"');
    expect(expectFail(draft({ type: 'scroll', direction: 'left' }), BETA)).toContain(
      'does not match the schema',
    );
  });

  it('extract needs what', () => {
    expect(expectOk(draft({ type: 'extract', what: 'unit price' }), ALPHA)).toEqual({
      type: 'extract',
      what: 'unit price',
      reason: 'because',
    });
    expect(expectFail(draft({ type: 'extract' }), ALPHA)).toContain('extract needs "what"');
  });

  it('done maps reason to summary; fail keeps reason', () => {
    expect(expectOk(draft({ type: 'done', reason: 'On checkout review' }), ALPHA)).toEqual({
      type: 'done',
      summary: 'On checkout review',
    });
    expect(expectOk(draft({ type: 'fail', reason: 'No size control' }), ALPHA)).toEqual({
      type: 'fail',
      reason: 'No size control',
    });
    expect(expectOk(draft({ type: 'done', reason: '' }), ALPHA)).toEqual({
      type: 'done',
      summary: expect.stringContaining('no summary'),
    });
    expect(expectOk(draft({ type: 'fail', reason: '  ' }), ALPHA)).toEqual({
      type: 'fail',
      reason: expect.stringContaining('without giving a reason'),
    });
  });
});

describe('summarizeAction', () => {
  it('is one line per action type', () => {
    expect(summarizeAction({ type: 'navigate', url: 'http://localhost:5000/', reason: '' })).toBe(
      'navigate http://localhost:5000/',
    );
    expect(summarizeAction({ type: 'click', target: 'button:Add to cart', reason: '' })).toBe(
      'click button:Add to cart',
    );
    expect(
      summarizeAction({ type: 'type', target: 'spinbutton:Quantity', text: '3', reason: '' }),
    ).toBe('type "3" into spinbutton:Quantity');
    expect(summarizeAction({ type: 'select', target: 'Size', value: 'M', reason: '' })).toBe(
      'select Size = M',
    );
    expect(summarizeAction({ type: 'scroll', direction: 'down', reason: '' })).toBe('scroll down');
    expect(summarizeAction({ type: 'extract', what: 'price', reason: '' })).toBe('extract price');
    expect(summarizeAction({ type: 'done', summary: 'Reached checkout review' })).toBe(
      'done: Reached checkout review',
    );
    expect(summarizeAction({ type: 'fail', reason: 'No buy box' })).toBe('fail: No buy box');
  });

  it('caps at 120 characters and collapses whitespace', () => {
    const long = summarizeAction({ type: 'done', summary: 'x'.repeat(500) });
    expect(long.length).toBeLessThanOrEqual(120);
    expect(long.endsWith('...')).toBe(true);
    expect(summarizeAction({ type: 'fail', reason: 'line one\n\n  line two' })).toBe(
      'fail: line one line two',
    );
  });
});

describe('summarizeStep', () => {
  it('formats the fixture steps', () => {
    const [s0, s1, s2] = alphaFailedRun.steps;
    expect(summarizeStep(s0!)).toBe('#0 click link:Black Hoodie -> ok');
    expect(summarizeStep(s1!)).toBe(
      '#1 select combobox:Size = M -> error: No element with role=combobox and name "Size" found in accessibility tree',
    );
    expect(summarizeStep(s2!)).toBe('#2 click button:Add to cart -> ok');
  });

  it('shows policy rejections and invalid actions', () => {
    const rejected: RunStep = {
      index: 7,
      at: 't',
      action: { type: 'click', target: 'button:Place order', reason: 'finish' },
      outcome: 'rejected_by_policy',
      outcomeDetail: 'Clicking a payment-submission control is never permitted',
    };
    expect(summarizeStep(rejected)).toBe(
      '#7 click button:Place order -> rejected_by_policy: Clicking a payment-submission control is never permitted',
    );
    const invalid: RunStep = {
      index: 8,
      at: 't',
      outcome: 'invalid_action',
      outcomeDetail: 'click target "M" is not role:name; use ...',
    };
    expect(summarizeStep(invalid)).toBe(
      '#8 (no action) -> invalid_action: click target "M" is not role:name; use ...',
    );
  });

  it('flattens multi-line Playwright errors and caps the detail', () => {
    const step: RunStep = {
      index: 4,
      at: 't',
      action: { type: 'select', target: 'Size', value: 'M', reason: '' },
      outcome: 'error',
      outcomeDetail: `locator.check: Timeout 2000ms exceeded.\nCall log:\n  - waiting for getByRole('radio', { name: 'M', exact: true })\n${'x'.repeat(400)}`,
    };
    const line = summarizeStep(step);
    expect(line).not.toContain('\n');
    expect(
      line.startsWith(
        '#4 select Size = M -> error: locator.check: Timeout 2000ms exceeded. Call log:',
      ),
    ).toBe(true);
    expect(line.length).toBeLessThan(260);
  });
});
