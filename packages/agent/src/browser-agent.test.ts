import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import type { Page } from 'playwright';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type {
  AgentConfig,
  AgentKind,
  Evidence,
  LlmUsage,
  Mission,
  RunStep,
} from '@agentproof/shared';
import { hoodieMission } from '@agentproof/shared/fixtures';
import {
  STUCK_STEP_LIMIT,
  act,
  observe,
  runBrowserAgent,
  type AgentCallbacks,
  type BrowserAgentDeps,
  type BrowserSession,
} from './browser-agent';
import { LlmError, createMockLlm, type MockLlmScriptEntry } from './llm';
import type { LlmContentBlock, LlmRequest } from './llm-types';
import { checkAction, isPaymentControl } from './policy';
import { systemPromptFor } from './prompts';

/**
 * No browser, no network, no API key: a scripted FakePage that behaves like the storefront
 * (role controls navigate between four pages; Bug A has no size control) drives the real loop
 * through deps.openSession, and createMockLlm() plays the model.
 */

const STORE = 'http://localhost:5000';
const VIEWPORT = { width: 1280, height: 800 };
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const RUN_ID = 'run_test0001';

// Trees as the storefront grader prints them (docs/storefront/bugs-and-fixes.md, Bug A).
const TREES: Record<string, string> = {
  '/': [
    '- main:',
    '  - heading "All products" [level=1]',
    '  - link "Black Hoodie":',
    '    - /url: /products/black-hoodie',
    '  - link "Canvas Tote"',
  ].join('\n'),
  '/products/black-hoodie': [
    '- main:',
    '  - heading "Black Hoodie" [level=1]',
    '  - paragraph: $49.00',
    '  - text: Size S M L Color Black Quantity',
    '  - spinbutton "Quantity": "1"',
    '  - button "Add to cart"',
  ].join('\n'),
  '/cart': [
    '- main:',
    '  - heading "Your cart" [level=1]',
    '  - text: Black Hoodie Size: S',
    '  - link "Proceed to checkout"',
  ].join('\n'),
  '/checkout': [
    '- main:',
    '  - heading "Review your order" [level=1]',
    '  - button "Place order"',
  ].join('\n'),
};
const TITLES: Record<string, string> = {
  '/': 'Northwind Threads',
  '/products/black-hoodie': 'Black Hoodie - Northwind Threads',
  '/cart': 'Your cart - Northwind Threads',
  '/checkout': 'Checkout - Northwind Threads',
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyArgs = any[];
type AsyncMock = Mock<(...args: AnyArgs) => Promise<unknown>>;
const asyncFn = (impl?: (...args: AnyArgs) => unknown): AsyncMock =>
  vi.fn(async (...args: AnyArgs) => impl?.(...args));

// --- fake DOM for the coordinate policy gate (document.elementFromPoint) --------------------

interface FakeDomElement {
  tagName: string;
  textContent: string;
  value?: string;
  parent?: FakeDomElement;
  /** DOM name for `parent`, read by the guard's ancestor walk. */
  parentElement?: FakeDomElement;
  /** HTMLLabelElement.control: the element a <label for=...> labels. */
  control?: FakeDomElement;
  attrs: Record<string, string>;
  getAttribute(name: string): string | null;
  closest(selector: string): FakeDomElement | null;
}

function domElement(spec: {
  tag: string;
  text: string;
  role?: string;
  ariaLabel?: string;
  title?: string;
  value?: string;
  parent?: FakeDomElement;
  control?: FakeDomElement;
}): FakeDomElement {
  const attrs: Record<string, string> = {};
  if (spec.role) attrs.role = spec.role;
  if (spec.ariaLabel) attrs['aria-label'] = spec.ariaLabel;
  if (spec.title) attrs.title = spec.title;
  const el: FakeDomElement = {
    tagName: spec.tag.toUpperCase(),
    textContent: spec.text,
    ...(spec.value === undefined ? {} : { value: spec.value }),
    ...(spec.parent === undefined ? {} : { parent: spec.parent, parentElement: spec.parent }),
    ...(spec.control === undefined ? {} : { control: spec.control }),
    attrs,
    getAttribute: (name) => attrs[name] ?? null,
    closest(selector) {
      const simple = selector.split(',').map((s) => s.trim());
      let cur: FakeDomElement | undefined = el;
      while (cur) {
        const c: FakeDomElement = cur;
        const tag = c.tagName.toLowerCase();
        if (simple.some((s) => s === tag || (s === '[role]' && 'role' in c.attrs))) return c;
        cur = c.parent;
      }
      return null;
    },
  };
  return el;
}

// --- fake Playwright --------------------------------------------------------------------------

interface FakeLocator {
  count: () => Promise<number>;
  first: () => FakeLocator;
  click: AsyncMock;
  fill: AsyncMock;
  check: AsyncMock;
  selectOption: AsyncMock;
}

/** A control that is in the tree; acting on it runs `onAct` (e.g. a navigation). */
function presentLocator(onAct?: () => void): FakeLocator {
  const locator: FakeLocator = {
    count: async () => 1,
    first: () => locator,
    click: asyncFn(onAct),
    fill: asyncFn(onAct),
    check: asyncFn(onAct),
    selectOption: asyncFn(onAct),
  };
  return locator;
}

/** A control that is not in the tree: count 0, and every action times out like Playwright. */
function missingLocator(role: string, name: string): FakeLocator {
  const timeout = (method: string) => () => {
    throw new Error(
      `locator.${method}: Timeout 5000ms exceeded.\nCall log:\n  - waiting for getByRole('${role}', { name: '${name}', exact: true })`,
    );
  };
  const locator: FakeLocator = {
    count: async () => 0,
    first: () => locator,
    click: asyncFn(timeout('click')),
    fill: asyncFn(timeout('fill')),
    check: asyncFn(timeout('check')),
    selectOption: asyncFn(timeout('selectOption')),
  };
  return locator;
}

class FakePage {
  current = `${STORE}/`;
  /** Role controls by "role:name"; anything else behaves like a Playwright timeout. */
  readonly controls = new Map<string, FakeLocator>();
  /** What document.elementFromPoint returns to the coordinate policy gate. */
  elementAtPoint: (x: number, y: number) => FakeDomElement | null = () => null;
  /** page.locator('main').count() */
  mainCount = 1;

  readonly goto = asyncFn((url: string) => {
    this.current = url;
  });
  readonly screenshot = asyncFn(() => PNG);
  readonly waitForLoadState = asyncFn();
  readonly waitForURL = asyncFn();
  readonly waitForTimeout = asyncFn();
  readonly mouse = { click: asyncFn(), wheel: asyncFn() };
  readonly keyboard = { type: asyncFn(), press: asyncFn() };
  readonly mainSnapshot = asyncFn(() => TREES[this.pathname()] ?? '- main:');
  readonly bodySnapshot = asyncFn(() => `- document:\n${TREES[this.pathname()] ?? ''}`);
  readonly bodyText = asyncFn(() => `TEXT OF ${this.pathname()}`);

  constructor() {
    this.controls.set(
      'link:Black Hoodie',
      presentLocator(() => this.go('/products/black-hoodie')),
    );
    this.controls.set(
      'button:Add to cart',
      presentLocator(() => this.go('/cart')),
    );
    this.controls.set(
      'link:Proceed to checkout',
      presentLocator(() => this.go('/checkout')),
    );
  }

  pathname(): string {
    return new URL(this.current).pathname;
  }
  go(pathname: string): void {
    this.current = `${STORE}${pathname}`;
  }
  url(): string {
    return this.current;
  }
  async title(): Promise<string> {
    return TITLES[this.pathname()] ?? 'Northwind Threads';
  }
  locator(selector: string) {
    if (selector === 'main')
      return { count: async () => this.mainCount, ariaSnapshot: this.mainSnapshot };
    if (selector === 'body') return { ariaSnapshot: this.bodySnapshot, innerText: this.bodyText };
    throw new Error(`FakePage: unexpected selector ${selector}`);
  }
  getByRole(role: string, options: { name: string; exact: boolean }): FakeLocator {
    return this.controls.get(`${role}:${options.name}`) ?? missingLocator(role, options.name);
  }
  /**
   * Runs the page function the way Playwright does: serialised, in a context with a fake
   * `document` and nothing from this module's scope, so a closure over a module constant fails
   * here instead of in a real Chromium. (It cannot catch helpers that only tsx's esbuild
   * keepNames transform injects, such as __name; the live scripted run covers those.)
   */
  async evaluate(fn: (arg: unknown) => unknown, arg: unknown): Promise<unknown> {
    const sandbox = {
      document: { elementFromPoint: (x: number, y: number) => this.elementAtPoint(x, y) },
      arg,
    };
    return vm.runInNewContext(`(${fn.toString()})(arg)`, sandbox);
  }
  asPage(): Page {
    return this as unknown as Page;
  }
}

const COOKIE = {
  name: 'nw_session',
  value: 'abc123',
  domain: 'localhost',
  path: '/',
  expires: -1,
  httpOnly: true,
  secure: false,
  sameSite: 'Lax',
};

function fakeSession(page: FakePage) {
  const tracing = {
    start: asyncFn(),
    stop: asyncFn((opts: { path: string }) => fs.writeFileSync(opts.path, 'trace')),
  };
  const context = { cookies: asyncFn(() => [COOKIE]), tracing };
  const browser = { close: asyncFn() };
  const session = { browser, context, page } as unknown as BrowserSession;
  return { session, browser, context, tracing };
}

// --- harness ----------------------------------------------------------------------------------

let root: string;
let artifactDir: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentproof-browser-agent-'));
  artifactDir = path.join(root, RUN_ID);
  vi.stubEnv('AGENTPROOF_ALLOWED_HOSTS', 'localhost,127.0.0.1');
  vi.stubEnv('AGENTPROOF_MAX_STEPS', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

function clock(): () => number {
  let t = 1_760_000_000_000;
  return () => (t += 50);
}

interface RunOptions {
  page?: FakePage;
  config?: Partial<AgentConfig>;
  mission?: Mission;
  deps?: Partial<BrowserAgentDeps>;
}

async function run(kind: AgentKind, script: MockLlmScriptEntry[], options: RunOptions = {}) {
  const page = options.page ?? new FakePage();
  const fake = fakeSession(page);
  const openSession = vi.fn(async (_config: AgentConfig) => fake.session);
  const steps: RunStep[] = [];
  const evidence: Evidence[] = [];
  const logs: string[] = [];
  const events: string[] = [];
  const cb: AgentCallbacks = {
    onStep: (step) => {
      steps.push(step);
      events.push(`step:${step.index}`);
    },
    onEvidence: (e) => {
      evidence.push(e);
      events.push(`evidence:${e.kind}:${e.stepIndex ?? '-'}`);
    },
    onLog: (message) => logs.push(message),
  };
  const llm = createMockLlm(script);
  const config: AgentConfig = {
    kind,
    model: 'grok-test',
    viewport: VIEWPORT,
    headed: false,
    ...options.config,
  };
  const result = await runBrowserAgent(options.mission ?? hoodieMission, config, artifactDir, cb, {
    llm,
    openSession,
    now: clock(),
    ...options.deps,
  });
  return { result, page, llm, openSession, steps, evidence, logs, events, ...fake };
}

// --- scripted model replies -------------------------------------------------------------------

const usageOf = (inputTokens: number): LlmUsage => ({
  calls: 1,
  inputTokens,
  outputTokens: 7,
  reasoningTokens: 0,
  cachedInputTokens: 0,
  imageInputs: 0,
  llmLatencyMs: 5,
});

function reply(draft: Record<string, unknown>, inputTokens?: number): MockLlmScriptEntry {
  const json = {
    reason: 'test',
    target: null,
    url: null,
    text: null,
    value: null,
    direction: null,
    what: null,
    ...draft,
  };
  return inputTokens === undefined ? { json } : { json, usage: usageOf(inputTokens) };
}
const click = (target: string, tokens?: number) => reply({ type: 'click', target }, tokens);
const select = (target: string, value: string, tokens?: number) =>
  reply({ type: 'select', target, value }, tokens);
const navigate = (url: string) => reply({ type: 'navigate', url });
const typeInto = (target: string, text: string) => reply({ type: 'type', target, text });
const scrollDown = () => reply({ type: 'scroll', direction: 'down' });
const done = (summary: string, tokens?: number) => reply({ type: 'done', reason: summary }, tokens);

const texts = (req: LlmRequest): string =>
  (req.messages[0]?.content ?? [])
    .flatMap((b: LlmContentBlock) => (b.type === 'text' ? [b.text] : []))
    .join('\n');
const images = (req: LlmRequest) =>
  (req.messages[0]?.content ?? []).filter((b) => b.type === 'image');

// --- tests ------------------------------------------------------------------------------------

describe('runBrowserAgent: Alpha on Bug A', () => {
  it('runs observe -> decide -> police -> act -> record and returns the claim with its evidence', async () => {
    const r = await run('alpha_semantic', [
      click('link:Black Hoodie', 100),
      select('Size', 'M', 100),
      click('button:Add to cart', 100),
      click('link:Proceed to checkout', 100),
      done('Reached checkout review; size S in the cart (no size control existed)', 100),
    ]);

    expect(r.result.outcome).toBe('done');
    expect(r.result.summary).toContain('Reached checkout review');
    expect(r.result.finalUrl).toBe(`${STORE}/checkout`);
    expect(r.result.visitedUrls).toEqual([
      STORE,
      `${STORE}/products/black-hoodie`,
      `${STORE}/cart`,
      `${STORE}/checkout`,
    ]);
    expect(r.result.cookies).toEqual([
      { name: 'nw_session', value: 'abc123', domain: 'localhost', path: '/' },
    ]);
    expect(r.result.resolvedModel).toBe('grok-test');
    expect(r.result.provider).toBe('mock');
    expect(r.result.effort).toBe('low');
    expect(r.result.stepsUsed).toBe(5);
    expect(r.result.durationMs).toBeGreaterThan(0);

    // Steps, in order, with the Bug A failure recorded as an error, not a crash.
    expect(r.steps.map((s) => s.outcome)).toEqual(['ok', 'error', 'ok', 'ok', 'ok']);
    expect(r.steps.map((s) => s.index)).toEqual([0, 1, 2, 3, 4]);
    expect(r.steps[0]?.url).toBe(STORE);
    expect(r.steps[0]?.action).toEqual({
      type: 'click',
      target: 'link:Black Hoodie',
      reason: 'test',
    });
    expect(r.steps[1]?.url).toBe(`${STORE}/products/black-hoodie`);
    expect(r.steps[1]?.outcomeDetail).toBe(
      'no radio "M", combobox "Size", or button "M" in the accessibility tree',
    );
    expect(r.steps[4]?.action).toEqual({
      type: 'done',
      summary: 'Reached checkout review; size S in the cart (no size control existed)',
    });
    for (const step of r.steps) {
      expect(step.usage?.inputTokens).toBe(100);
      expect(step.durationMs).toBeGreaterThan(0);
      expect(Date.parse(step.at)).not.toBeNaN();
    }

    // Usage is summed over every model call.
    expect(r.result.usage.calls).toBe(5);
    expect(r.result.usage.inputTokens).toBe(500);
    expect(r.result.usage.outputTokens).toBe(35);
    expect(r.result.usage.llmLatencyMs).toBe(25);

    // Evidence: a screenshot and an aria snapshot per step, emitted before the step, as files
    // under <artifactsRoot>/<runId> with paths relative to <artifactsRoot>.
    const byId = new Map(r.evidence.map((e) => [e.id, e]));
    for (const step of r.steps) {
      const nnn = String(step.index).padStart(3, '0');
      const shot = byId.get(step.screenshotEvidenceId ?? '');
      expect(shot?.kind).toBe('screenshot');
      expect(shot?.stepIndex).toBe(step.index);
      expect(shot?.runId).toBe(RUN_ID);
      expect(shot?.path).toBe(`${RUN_ID}/step-${nnn}.png`);
      expect(fs.readFileSync(path.join(root, shot?.path ?? ''))).toEqual(PNG);
      const tree = byId.get(step.snapshotEvidenceId ?? '');
      expect(tree?.kind).toBe('dom_snapshot');
      expect(tree?.path).toBe(`${RUN_ID}/step-${nnn}.aria.txt`);
      expect(fs.existsSync(path.join(root, tree?.path ?? ''))).toBe(true);
    }
    expect(fs.readFileSync(path.join(root, RUN_ID, 'step-001.aria.txt'), 'utf8')).toContain(
      'text: Size S M L',
    );
    expect(r.events.slice(0, 6)).toEqual([
      'evidence:screenshot:0',
      'evidence:dom_snapshot:0',
      'step:0',
      'evidence:screenshot:1',
      'evidence:dom_snapshot:1',
      'step:1',
    ]);

    // Trace saved on close and reported.
    const trace = r.evidence.find((e) => e.kind === 'trace');
    expect(trace?.path).toBe(`${RUN_ID}/trace.zip`);
    expect(r.result.tracePath).toBe(`${RUN_ID}/trace.zip`);
    expect(fs.existsSync(path.join(root, RUN_ID, 'trace.zip'))).toBe(true);
    expect(r.tracing.stop).toHaveBeenCalledWith({ path: path.join(artifactDir, 'trace.zip') });
    expect(r.browser.close).toHaveBeenCalledTimes(1);
    expect(r.openSession).toHaveBeenCalledTimes(1);

    // Log lines: the model header, then one per step.
    expect(r.logs[0]).toBe('model: grok-test (mock, effort low)');
    expect(r.logs[1]).toBe('#0 click link:Black Hoodie -> ok');
    expect(r.logs[2]).toBe(
      '#1 select Size = M -> error: no radio "M", combobox "Size", or button "M" in the accessibility tree',
    );

    // The model saw the tree (never an image), and the failed select in its history next turn.
    expect(r.llm.requests).toHaveLength(5);
    const product = r.llm.requests[1]!;
    expect(product.model).toBe('grok-test');
    expect(product.effort).toBe('low');
    expect(product.jsonSchema?.name).toBe('agent_action');
    // No explicit cap: llm.ts picks it by effort (8192 for medium/high, which includes reasoning).
    expect(product.maxTokens).toBeUndefined();
    expect(product.timeoutMs).toBe(120_000);
    expect(images(product)).toHaveLength(0);
    expect(texts(product)).toContain('ACCESSIBILITY TREE');
    expect(texts(product)).toContain('text: Size S M L');
    expect(texts(product)).toContain('PAGE TEXT');
    expect(texts(product)).toContain('STEPS REMAINING: 19'); // alpha profile cap 20, one step used
    expect(product.system).toBe(systemPromptFor('alpha_semantic')); // fixed, no page content
    expect(product.system).not.toContain('Northwind');
    expect(product.system).not.toContain('localhost');
    expect(texts(r.llm.requests[2]!)).toContain(
      '#1 select Size = M -> error: no radio "M", combobox "Size", or button "M"',
    );
  });

  it('fails as stuck after STUCK_STEP_LIMIT consecutive error steps', async () => {
    const r = await run('alpha_semantic', [select('Size', 'M')]);
    expect(r.steps.map((s) => s.outcome)).toEqual(
      Array.from({ length: STUCK_STEP_LIMIT }, () => 'error'),
    );
    expect(r.result.outcome).toBe('fail');
    expect(r.result.summary).toBe(
      'stuck: 5 consecutive failed steps; last: select Size = M -> no radio "M", combobox "Size", or button "M" in the accessibility tree',
    );
    expect(r.result.stepsUsed).toBe(STUCK_STEP_LIMIT);
    expect(r.llm.requests).toHaveLength(STUCK_STEP_LIMIT);
    expect(r.browser.close).toHaveBeenCalledTimes(1);
  });

  it('caps the stuck summary at 300 characters and keeps the last attempted action', async () => {
    // A long absent name makes the step's detail (capped at 300 by the loop) push the summary over.
    const longName = 'Q'.repeat(250);
    const r = await run('alpha_semantic', [typeInto(`textbox:${longName}`, 'hello')]);
    expect(r.result.outcome).toBe('fail');
    expect(r.result.summary.length).toBe(300);
    expect(
      r.result.summary.startsWith(
        'stuck: 5 consecutive failed steps; last: type "hello" into textbox:QQQ',
      ),
    ).toBe(true);
    expect(r.result.summary.endsWith('...')).toBe(true);
  });

  it('fails an absent role click at once with the tree message, without waiting for a timeout', async () => {
    const absent = missingLocator('button', 'Add to cart');
    const page = new FakePage();
    page.controls.set('button:Add to cart', absent);
    const r = await run('alpha_semantic', [click('button:Add to cart'), done('ok')], { page });
    expect(r.steps[0]?.outcome).toBe('error');
    expect(r.steps[0]?.outcomeDetail).toBe('no button "Add to cart" in the accessibility tree');
    expect(absent.click).not.toHaveBeenCalled();
    expect(r.result.outcome).toBe('done');
  });

  it('records a policy rejection without executing it and lets the run continue', async () => {
    const r = await run('alpha_semantic', [navigate('http://evil.example.com/'), done('gave up')]);
    expect(r.steps[0]?.outcome).toBe('rejected_by_policy');
    expect(r.steps[0]?.outcomeDetail).toContain('not in AGENTPROOF_ALLOWED_HOSTS');
    expect(r.steps[0]?.action).toMatchObject({ type: 'navigate', url: 'http://evil.example.com/' });
    expect(r.page.goto).toHaveBeenCalledTimes(1); // only the initial store navigation
    expect(r.page.goto).toHaveBeenCalledWith(
      STORE,
      expect.objectContaining({ waitUntil: 'domcontentloaded' }),
    );
    expect(r.result.outcome).toBe('done');
    expect(texts(r.llm.requests[1]!)).toContain('rejected_by_policy');
  });

  it('records unusable model output as invalid_action and shows the reason next turn', async () => {
    const r = await run('alpha_semantic', [
      { text: 'I would click the hoodie link.' }, // not JSON
      { json: { type: 'click' } }, // JSON, but not the schema (no reason)
      done('ok'),
    ]);
    expect(r.steps.map((s) => s.outcome)).toEqual(['invalid_action', 'invalid_action', 'ok']);
    expect(r.steps[0]?.outcomeDetail).toBe('model returned no JSON');
    expect(r.steps[0]?.action).toBeUndefined();
    expect(r.steps[1]?.outcomeDetail).toContain('does not match the schema');
    expect(texts(r.llm.requests[1]!)).toContain(
      '#0 (no action) -> invalid_action: model returned no JSON',
    );
    expect(r.result.outcome).toBe('done');
  });

  it('names a reply cut off at the token cap so the truncation is visible in the step log', async () => {
    const r = await run('alpha_semantic', [
      { text: '{"type":"cli', finishReason: 'max_output_tokens' },
      done('ok'),
    ]);
    expect(r.steps[0]?.outcome).toBe('invalid_action');
    expect(r.steps[0]?.outcomeDetail).toBe(
      'model output truncated at the token cap (finishReason=max_output_tokens): no JSON action',
    );
    expect(r.logs[1]).toContain('truncated at the token cap');
    expect(r.result.outcome).toBe('done');
  });

  it('refuses a select whose value names a payment control instead of clicking it', async () => {
    // chooseOption()'s last rung is button:<value>, so without the policy this would place the order.
    const page = new FakePage();
    const placeOrder = presentLocator(() => page.go('/checkout/place-order'));
    page.controls.set('button:Place order', placeOrder);
    const r = await run(
      'alpha_semantic',
      [select('Order', 'Place order'), select('Size', 'button:Place order'), done('gave up')],
      { page },
    );
    expect(r.steps.map((s) => s.outcome)).toEqual([
      'rejected_by_policy',
      'rejected_by_policy',
      'ok',
    ]);
    expect(r.steps[0]?.outcomeDetail).toBe(
      'Selecting a payment-submission control is never permitted',
    );
    expect(placeOrder.click).not.toHaveBeenCalled();
    expect(placeOrder.check).not.toHaveBeenCalled();
    expect(r.result.finalUrl).toBe(STORE); // never left the catalog page
    expect(texts(r.llm.requests[1]!)).toContain('rejected_by_policy');

    // Belt and braces: act() itself refuses, for callers that skip checkAction().
    await expect(
      act(
        page.asPage(),
        { type: 'select', target: 'Order', value: 'Place order', reason: 'test' },
        'alpha_semantic',
        VIEWPORT,
      ),
    ).rejects.toThrow('names a payment control');
    expect(placeOrder.click).not.toHaveBeenCalled();
  });

  it('refuses a role:name click or type on a payment control', async () => {
    const page = new FakePage();
    const placeOrder = presentLocator();
    page.controls.set('button:Place order', placeOrder);
    const r = await run(
      'alpha_semantic',
      [click('button:Place order'), typeInto('button:Pay now', 'x'), done('gave up')],
      { page },
    );
    expect(r.steps.map((s) => s.outcome)).toEqual([
      'rejected_by_policy',
      'rejected_by_policy',
      'ok',
    ]);
    expect(r.steps[0]?.outcomeDetail).toBe(
      'Clicking a payment-submission control is never permitted',
    );
    expect(r.steps[1]?.outcomeDetail).toBe(
      'Typing into a payment-submission control is never permitted',
    );
    expect(placeOrder.click).not.toHaveBeenCalled();
    expect(placeOrder.fill).not.toHaveBeenCalled();
  });

  it('flattens line breaks before typing (keyboard.type would press Enter and submit the form)', async () => {
    const page = new FakePage();
    const quantity = presentLocator();
    page.controls.set('spinbutton:Quantity', quantity);
    const r = await run(
      'alpha_semantic',
      [
        typeInto('spinbutton:Quantity', '2\n'),
        typeInto('spinbutton:Quantity', 'a\r\nb\nc'),
        done('ok'),
      ],
      { page },
    );
    expect(r.steps.map((s) => s.outcome)).toEqual(['ok', 'ok', 'ok']);
    expect(quantity.fill).toHaveBeenNthCalledWith(1, '2', { timeout: 5000 });
    expect(quantity.fill).toHaveBeenNthCalledWith(2, 'a b c', { timeout: 5000 });
    expect(page.keyboard.press).not.toHaveBeenCalledWith('Enter');
  });

  it('records an act error as the first line of the message, capped', async () => {
    const r = await run('alpha_semantic', [click('button:Does not exist'), done('ok')]);
    expect(r.steps[0]?.outcome).toBe('error');
    expect(r.steps[0]?.outcomeDetail).toBe('no button "Does not exist" in the accessibility tree');
    expect(r.result.outcome).toBe('done');
  });

  it('stops at the step limit (config cap and mission cap)', async () => {
    const r = await run('alpha_semantic', [scrollDown()], { config: { maxSteps: 2 } });
    expect(r.steps.map((s) => s.outcome)).toEqual(['ok', 'ok']);
    expect(r.result.outcome).toBe('step_limit');
    expect(r.result.summary).toBe('step limit reached');
    expect(r.page.mouse.wheel).toHaveBeenCalledTimes(2);
    expect(r.page.mouse.wheel).toHaveBeenCalledWith(0, 600);
    expect(r.page.waitForTimeout).toHaveBeenCalledTimes(2); // a settle after each scroll
    expect(texts(r.llm.requests[0]!)).toContain('STEPS REMAINING: 2');
    expect(texts(r.llm.requests[1]!)).toContain('STEPS REMAINING: 1');

    const capped = await run('alpha_semantic', [scrollDown()], {
      mission: { ...hoodieMission, maxSteps: 1 },
    });
    expect(capped.result.outcome).toBe('step_limit');
    expect(capped.steps).toHaveLength(1);
    expect(capped.steps[0]?.outcome).toBe('ok');
  });

  it('routes select through setQuantity for a quantity group and chooseOption otherwise', async () => {
    const page = new FakePage();
    const quantity = presentLocator();
    const size = presentLocator();
    page.controls.set('spinbutton:Quantity', quantity);
    page.controls.set('combobox:Size', size);
    const r = await run(
      'alpha_semantic',
      [select('Quantity', '3'), select('combobox:Size', 'M'), done('ok')],
      { page },
    );
    expect(r.steps.map((s) => s.outcome)).toEqual(['ok', 'ok', 'ok']);
    expect(quantity.fill).toHaveBeenCalledWith('3', { timeout: 2000 });
    expect(size.selectOption).toHaveBeenCalledWith({ label: 'M' }, { timeout: 2000 });
    expect(page.waitForLoadState).toHaveBeenCalledWith('domcontentloaded');
    expect(page.waitForTimeout).toHaveBeenCalledWith(250);
  });
});

describe('runBrowserAgent: Beta', () => {
  it('sends the screenshot and no tree, and clicks and types by coordinate', async () => {
    const page = new FakePage();
    page.elementAtPoint = () => domElement({ tag: 'div', text: 'M' });
    const r = await run('beta_vision', [click('412,388'), typeInto('300,500', '3'), done('ok')], {
      page,
    });

    const first = r.llm.requests[0]!;
    const imageBlocks = images(first);
    expect(imageBlocks).toHaveLength(1);
    expect(imageBlocks[0]).toEqual({
      type: 'image',
      mediaType: 'image/png',
      base64: PNG.toString('base64'),
    });
    expect(texts(first)).toContain('SCREENSHOT above: 1280x800 pixels');
    expect(texts(first)).not.toContain('ACCESSIBILITY TREE');
    expect(texts(first)).not.toContain('PAGE TEXT');
    expect(first.effort).toBe('medium');

    expect(r.steps.map((s) => s.outcome)).toEqual(['ok', 'ok', 'ok']);
    expect(r.result.effort).toBe('medium');
    expect(r.result.usage.imageInputs).toBe(3);
    // The screenshot file is still evidence for humans; no tree was captured.
    expect(r.steps[0]?.screenshotEvidenceId).toBeDefined();
    expect(r.steps[0]?.snapshotEvidenceId).toBeUndefined();
    expect(fs.existsSync(path.join(root, RUN_ID, 'step-000.png'))).toBe(true);
    expect(fs.existsSync(path.join(root, RUN_ID, 'step-000.aria.txt'))).toBe(false);
  });

  it('clicks and types through the mouse and keyboard', async () => {
    const page = new FakePage();
    page.elementAtPoint = () => domElement({ tag: 'div', text: 'M' });
    const getByRole = vi.spyOn(page, 'getByRole');
    const r = await run('beta_vision', [click('412,388'), typeInto('300,500', '3'), done('ok')], {
      page,
    });
    expect(r.steps.map((s) => s.outcome)).toEqual(['ok', 'ok', 'ok']);
    expect(page.mouse.click).toHaveBeenNthCalledWith(1, 412, 388);
    expect(page.mouse.click).toHaveBeenNthCalledWith(2, 300, 500);
    expect(page.keyboard.press).toHaveBeenCalledWith('ControlOrMeta+a');
    expect(page.keyboard.type).toHaveBeenCalledWith('3');
    expect(getByRole).not.toHaveBeenCalled(); // a vision agent never resolves roles
  });

  it('gives a mouse click time to commit a navigation before observing again', async () => {
    const page = new FakePage();
    page.elementAtPoint = () => domElement({ tag: 'div', text: 'M' });
    // Start on the product page (its href is already normalised, as page.url() returns it).
    const product = `${STORE}/products/black-hoodie`;
    // First click: the URL has not changed yet, so the loop waits (bounded) for one.
    const r = await run('beta_vision', [click('412,388'), click('713,402'), done('ok')], {
      page,
      mission: { ...hoodieMission, storeUrl: product },
    });
    expect(r.steps.map((s) => s.outcome)).toEqual(['ok', 'ok', 'ok']);
    expect(page.waitForURL).toHaveBeenCalledTimes(2);
    const [predicate, options] = page.waitForURL.mock.calls[0] as [
      (u: URL) => boolean,
      { timeout: number; waitUntil: string },
    ];
    expect(options).toEqual({ timeout: 1000, waitUntil: 'domcontentloaded' });
    expect(predicate(new URL(product))).toBe(false);
    expect(predicate(new URL(`${STORE}/cart`))).toBe(true);
    // The wait is ordered after the click and before the settle, and a timeout is swallowed.
    const order = [
      page.mouse.click.mock.invocationCallOrder[0]!,
      page.waitForURL.mock.invocationCallOrder[0]!,
      page.waitForLoadState.mock.invocationCallOrder[0]!,
    ];
    expect([...order].sort((a, b) => a - b)).toEqual(order);

    // A click whose navigation already committed does not wait.
    const quick = new FakePage();
    quick.elementAtPoint = () => domElement({ tag: 'div', text: 'M' });
    quick.mouse.click.mockImplementationOnce(async () => quick.go('/cart'));
    const r2 = await run('beta_vision', [click('412,388'), done('ok')], { page: quick });
    expect(r2.steps[0]?.outcome).toBe('ok');
    expect(quick.waitForURL).not.toHaveBeenCalled();
    expect(r2.result.finalUrl).toBe(`${STORE}/cart`);

    const slow = new FakePage();
    slow.elementAtPoint = () => domElement({ tag: 'div', text: 'M' });
    slow.waitForURL.mockImplementationOnce(async () => {
      throw new Error('page.waitForURL: Timeout 1000ms exceeded.');
    });
    const r3 = await run('beta_vision', [click('412,388'), done('ok')], { page: slow });
    expect(r3.steps[0]?.outcome).toBe('ok');
  });

  it('types by coordinate without line breaks', async () => {
    const page = new FakePage();
    page.elementAtPoint = () => domElement({ tag: 'input', text: '' });
    const r = await run('beta_vision', [typeInto('300,500', '2\n'), done('ok')], { page });
    expect(r.steps[0]?.outcome).toBe('ok');
    expect(page.keyboard.type).toHaveBeenCalledWith('2');
    expect(page.keyboard.press).toHaveBeenCalledTimes(1); // only the select-all
  });

  it('refuses a coordinate click that would land on a payment control', async () => {
    const page = new FakePage();
    const button = domElement({ tag: 'button', text: ' Place order ' });
    page.elementAtPoint = () => domElement({ tag: 'span', text: 'Place order', parent: button });
    const r = await run('beta_vision', [click('640,700'), done('ok')], { page });
    expect(r.steps[0]?.outcome).toBe('rejected_by_policy');
    expect(r.steps[0]?.outcomeDetail).toBe(
      'coordinate click would hit a payment control: "Place order"',
    );
    expect(page.mouse.click).not.toHaveBeenCalled();
    expect(r.result.outcome).toBe('done');
  });

  it('reads the control under the point, not a role-bearing container around plain text', async () => {
    const page = new FakePage();
    const region = domElement({
      tag: 'section',
      role: 'region',
      text: 'Ships in 3 days Place order',
    });
    page.elementAtPoint = () => domElement({ tag: 'p', text: 'Ships in 3 days', parent: region });
    const allowed = await run('beta_vision', [click('100,100'), done('ok')], { page });
    expect(allowed.steps[0]?.outcome).toBe('ok');
    expect(page.mouse.click).toHaveBeenCalledWith(100, 100);

    const labelled = new FakePage();
    labelled.elementAtPoint = () =>
      domElement({ tag: 'input', text: '', value: 'Pay now', parent: region });
    const rejected = await run('beta_vision', [click('100,100'), done('ok')], { page: labelled });
    expect(rejected.steps[0]?.outcome).toBe('rejected_by_policy');
    expect(rejected.steps[0]?.outcomeDetail).toContain('"Pay now"');
  });

  it('catches a role-less div button hit on its text-less icon child, but not a page wrapper', async () => {
    const divButton = domElement({ tag: 'div', text: 'Place order' });
    const icon = new FakePage();
    icon.elementAtPoint = () => domElement({ tag: 'span', text: '', parent: divButton });
    const r = await run('beta_vision', [click('193,405'), done('ok')], { page: icon });
    expect(r.steps[0]?.outcome).toBe('rejected_by_policy');
    expect(r.steps[0]?.outcomeDetail).toBe(
      'coordinate click would hit a payment control: "Place order"',
    );
    expect(icon.mouse.click).not.toHaveBeenCalled();

    // Two levels up (icon -> inner span -> div button) is still caught.
    const inner = domElement({ tag: 'span', text: '', parent: divButton });
    const nested = new FakePage();
    nested.elementAtPoint = () => domElement({ tag: 'svg', text: '', parent: inner });
    const r2 = await run('beta_vision', [click('193,405'), done('ok')], { page: nested });
    expect(r2.steps[0]?.outcome).toBe('rejected_by_policy');

    // A wrapper with long text that happens to contain "Place order" is not a button.
    const wrapper = domElement({
      tag: 'div',
      text: `Review your order. ${'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(2)}Place order`,
    });
    const spacer = new FakePage();
    spacer.elementAtPoint = () => domElement({ tag: 'span', text: '', parent: wrapper });
    const r3 = await run('beta_vision', [click('50,50'), done('ok')], { page: spacer });
    expect(r3.steps[0]?.outcome).toBe('ok');
    expect(spacer.mouse.click).toHaveBeenCalledWith(50, 50);

    // The walk stops at a non-generic or role-bearing ancestor.
    const region = domElement({ tag: 'section', role: 'region', text: 'Place order' });
    const inRegion = new FakePage();
    inRegion.elementAtPoint = () => domElement({ tag: 'span', text: '', parent: region });
    const r4 = await run('beta_vision', [click('50,50'), done('ok')], { page: inRegion });
    expect(r4.steps[0]?.outcome).toBe('ok');
  });

  it('judges a label by the control it labels too, and reads a lone "Pay" once', async () => {
    const submit = domElement({ tag: 'input', text: '', value: 'Place order' });
    const labelled = new FakePage();
    labelled.elementAtPoint = () => domElement({ tag: 'label', text: 'Finish', control: submit });
    const r = await run('beta_vision', [click('100,100'), done('ok')], { page: labelled });
    expect(r.steps[0]?.outcome).toBe('rejected_by_policy');
    expect(r.steps[0]?.outcomeDetail).toContain('"Finish Place order"');

    // textContent and title both "Pay": deduplicated so the anchored pattern still matches.
    const pay = new FakePage();
    pay.elementAtPoint = () => domElement({ tag: 'button', text: 'Pay', title: 'Pay' });
    const r2 = await run('beta_vision', [click('100,100'), done('ok')], { page: pay });
    expect(r2.steps[0]?.outcome).toBe('rejected_by_policy');
    expect(r2.steps[0]?.outcomeDetail).toContain('"Pay"');
  });

  it('rejects select for a vision agent as an invalid action', async () => {
    const r = await run('beta_vision', [select('Size', 'M'), done('ok')]);
    expect(r.steps[0]?.outcome).toBe('invalid_action');
    expect(r.steps[0]?.outcomeDetail).toContain('x,y');
  });
});

describe('runBrowserAgent: Sigma', () => {
  it('sends image, tree and text, and uses both target grammars', async () => {
    const page = new FakePage();
    page.elementAtPoint = () => domElement({ tag: 'div', text: 'M' });
    const r = await run(
      'sigma_hybrid',
      [click('link:Black Hoodie'), click('412,388'), click('button:Add to cart'), done('ok')],
      { page },
    );

    const product = r.llm.requests[1]!;
    expect(images(product)).toHaveLength(1);
    expect(texts(product)).toContain('ACCESSIBILITY TREE');
    expect(texts(product)).toContain('text: Size S M L');
    expect(texts(product)).toContain('PAGE TEXT');
    expect(product.effort).toBe('high');

    expect(r.steps.map((s) => s.outcome)).toEqual(['ok', 'ok', 'ok', 'ok']);
    expect(page.mouse.click).toHaveBeenCalledWith(412, 388);
    expect(r.result.finalUrl).toBe(`${STORE}/cart`);
    expect(r.result.effort).toBe('high');
    expect(r.result.usage.imageInputs).toBe(4);
    for (const step of r.steps) {
      expect(step.screenshotEvidenceId).toBeDefined();
      expect(step.snapshotEvidenceId).toBeDefined();
    }
  });
});

describe('runBrowserAgent: guards and errors', () => {
  it('refuses to run Gamma', async () => {
    const r = await run('gamma_structured', [done('ok')]);
    expect(r.result.outcome).toBe('error');
    expect(r.result.summary).toBe('gamma is not a browser agent');
    expect(r.openSession).not.toHaveBeenCalled();
    expect(r.llm.requests).toHaveLength(0);
    expect(r.result.stepsUsed).toBe(0);
  });

  it('refuses a store host outside the allowlist before opening a browser', async () => {
    const r = await run('alpha_semantic', [done('ok')], {
      mission: { ...hoodieMission, storeUrl: 'http://evil.example.com' },
    });
    expect(r.result.outcome).toBe('error');
    expect(r.result.summary).toContain('not in AGENTPROOF_ALLOWED_HOSTS');
    expect(r.openSession).not.toHaveBeenCalled();
    expect(r.llm.requests).toHaveLength(0);
  });

  it('turns a model error into outcome error and still closes the browser', async () => {
    const r = await run('alpha_semantic', [
      () => {
        throw new LlmError('xai 500 after 3 retries', {
          provider: 'xai',
          status: 500,
          retryable: true,
        });
      },
    ]);
    expect(r.result.outcome).toBe('error');
    expect(r.result.summary).toBe('xai 500 after 3 retries');
    expect(r.browser.close).toHaveBeenCalledTimes(1);
    expect(r.tracing.stop).toHaveBeenCalledTimes(1);
    expect(r.result.tracePath).toBe(`${RUN_ID}/trace.zip`);
    expect(r.result.finalUrl).toBe(STORE);
    expect(r.result.cookies).toHaveLength(1);
    expect(r.logs).toContain('error: xai 500 after 3 retries');
    // The evidence captured before the failing decide() is referenced by an error step, not orphaned.
    expect(r.evidence.map((e) => e.kind)).toEqual(['screenshot', 'dom_snapshot', 'trace']);
    expect(r.steps).toHaveLength(1);
    expect(r.result.stepsUsed).toBe(1);
    const step = r.steps[0]!;
    expect(step.outcome).toBe('error');
    expect(step.outcomeDetail).toBe('xai 500 after 3 retries');
    expect(step.action).toBeUndefined();
    expect(step.usage).toBeUndefined();
    expect(step.screenshotEvidenceId).toBe(r.evidence[0]?.id);
    expect(step.snapshotEvidenceId).toBe(r.evidence[1]?.id);
    expect(step.durationMs).toBeGreaterThan(0);
    expect(r.logs).toContain('#0 (no action) -> error: xai 500 after 3 retries');
    expect(r.result.usage.calls).toBe(0);
  });

  it('turns a browser failure into outcome error', async () => {
    const page = new FakePage();
    page.goto.mockImplementationOnce(async () => {
      throw new Error('page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:5000\nCall log:');
    });
    const r = await run('alpha_semantic', [done('ok')], { page });
    expect(r.result.outcome).toBe('error');
    expect(r.result.summary).toBe(
      'page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:5000',
    );
    expect(r.browser.close).toHaveBeenCalledTimes(1);
    expect(r.llm.requests).toHaveLength(0);
  });

  it('never throws when closing the browser fails', async () => {
    const fake = fakeSession(new FakePage());
    fake.browser.close.mockImplementationOnce(async () => {
      throw new Error('Target closed');
    });
    const logs: string[] = [];
    const result = await runBrowserAgent(
      hoodieMission,
      { kind: 'alpha_semantic', model: 'grok-test', viewport: VIEWPORT, headed: false },
      artifactDir,
      { onStep: () => {}, onEvidence: () => {}, onLog: (m) => logs.push(m) },
      { llm: createMockLlm([done('ok')]), openSession: async () => fake.session },
    );
    expect(result.outcome).toBe('done');
    expect(logs).toContain('browser close failed: Target closed');
  });
});

describe('policy: payment controls', () => {
  it.each([
    'Place order',
    ' place  order ',
    'button:Place order',
    'Pay now',
    'Submit payment',
    'Confirm purchase',
    'Buy now',
    'Complete order',
    'Complete purchase',
    'Confirm order',
    'Submit order',
    'Pay',
    'button:Pay',
    'Pay $49.00',
    'Pay 49.00 USD',
  ])('refuses %j', (text) => {
    expect(isPaymentControl(text)).toBe(true);
  });

  it.each([
    'Add to cart',
    'Proceed to checkout',
    'Payment methods',
    'Order history',
    'Order summary',
    'link:Checkout',
    'Review your order',
    '',
  ])('allows %j', (text) => {
    expect(isPaymentControl(text)).toBe(false);
  });

  it('screens click and type targets and both halves of a select', () => {
    const m = hoodieMission;
    expect(checkAction(m, { type: 'click', target: 'button:Add to cart', reason: 'r' }, 0)).toEqual(
      {
        ok: true,
      },
    );
    expect(checkAction(m, { type: 'click', target: 'button:Place order', reason: 'r' }, 0)).toEqual(
      {
        ok: false,
        reason: 'Clicking a payment-submission control is never permitted',
      },
    );
    expect(
      checkAction(m, { type: 'type', target: 'textbox:Pay now', text: 'x', reason: 'r' }, 0),
    ).toEqual({ ok: false, reason: 'Typing into a payment-submission control is never permitted' });
    expect(checkAction(m, { type: 'select', target: 'Size', value: 'M', reason: 'r' }, 0)).toEqual({
      ok: true,
    });
    expect(
      checkAction(m, { type: 'select', target: 'Order', value: 'Place order', reason: 'r' }, 0),
    ).toEqual({ ok: false, reason: 'Selecting a payment-submission control is never permitted' });
    expect(
      checkAction(m, { type: 'select', target: 'Place order', value: 'Yes', reason: 'r' }, 0),
    ).toEqual({ ok: false, reason: 'Selecting a payment-submission control is never permitted' });
  });
});

describe('observe', () => {
  it('captures what each kind perceives, falling back to body when main is absent', async () => {
    const page = new FakePage();
    page.mainCount = 0;
    const alpha = await observe(page.asPage(), 'alpha_semantic', VIEWPORT);
    expect(alpha.url).toBe(`${STORE}/`);
    expect(alpha.title).toBe('Northwind Threads');
    expect(alpha.ariaSnapshot?.startsWith('- document:')).toBe(true);
    expect(alpha.textExcerpt).toBe('TEXT OF /');
    expect(alpha.screenshotBase64).toBeUndefined();
    expect(alpha.viewport).toEqual(VIEWPORT);
    expect(page.screenshot).not.toHaveBeenCalled();

    page.mainCount = 1;
    const beta = await observe(page.asPage(), 'beta_vision', VIEWPORT);
    expect(beta.screenshotBase64).toBe(PNG.toString('base64'));
    expect(beta.ariaSnapshot).toBeUndefined();
    expect(beta.textExcerpt).toBeUndefined();

    const sigma = await observe(page.asPage(), 'sigma_hybrid', VIEWPORT);
    expect(sigma.ariaSnapshot?.startsWith('- main:')).toBe(true);
    expect(sigma.textExcerpt).toBe('TEXT OF /');
    expect(sigma.screenshotBase64).toBe(PNG.toString('base64'));
  });
});
