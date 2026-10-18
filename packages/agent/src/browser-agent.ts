import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import {
  EMPTY_USAGE,
  addUsage,
  newId,
  type AgentAction,
  type AgentConfig,
  type AgentKind,
  type Evidence,
  type LlmUsage,
  type Mission,
  type RunStep,
} from '@agentproof/shared';
import { actionDraftJsonSchema, summarizeStep, toAgentAction } from './actions';
import { getLlm } from './llm';
import type { LlmClient, LlmEffort, LlmResponse } from './llm-types';
import { checkAction, hostIsAllowed, isPaymentControl, type PolicyVerdict } from './policy';
import { AGENT_PROFILES, resolveRunSettings } from './profiles';
import { TEXT_CHAR_CAP, buildUserTurn, systemPromptFor, type ObservationInput } from './prompts';
import { ARIA_ROLES, chooseOption, parseTarget, setQuantity, toLocator } from './targets';

/**
 * Browser agent loop for Alpha (accessibility tree), Beta (screenshots + coordinates) and Sigma
 * (both, strongest model). One loop, three sets of senses:
 *
 *   observe  -> what this kind perceives (profiles.ts): tree, text, screenshot
 *   decide   -> one model call through getLlm(); strict JSON -> toAgentAction()
 *   police   -> checkAction() (allowed actions, hosts, step cap, payment controls) and, for an
 *               x,y target, the element under the point (isPaymentControl)
 *   act      -> Playwright: role:name locators, x,y mouse, chooseOption / setQuantity ladders
 *   record   -> RunStep + Evidence (screenshot per step, aria snapshot when captured, trace)
 *
 * until done / fail / three stuck steps / step limit. `done` is a claim; the verifier decides.
 * Page content only ever reaches the model inside the user turn (prompts.ts).
 *
 * OWNER: Zach.
 */

export interface AgentCallbacks {
  onStep(step: RunStep): void;
  onEvidence(evidence: Evidence): void;
  onLog(message: string): void;
}

export interface BrowserAgentResult {
  outcome: 'done' | 'fail' | 'step_limit' | 'error';
  /** The agent's done summary / fail reason / 'step limit reached' / the error message */
  summary: string;
  finalUrl?: string;
  /** Unique, in order of first visit */
  visitedUrls: string[];
  cookies: Array<{ name: string; value: string; domain: string; path: string }>;
  /** Summed over every model call in the run */
  usage: LlmUsage;
  resolvedModel: string;
  provider: string;
  effort?: LlmEffort;
  stepsUsed: number;
  durationMs: number;
  /** Relative to the artifacts root, e.g. 'run_x/trace.zip' */
  tracePath?: string;
}

export interface BrowserSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
}

/** What the model receives for one step. Which fields are filled depends on the agent kind. */
export interface Observation extends ObservationInput {}

export interface BrowserAgentDeps {
  /** Defaults to getLlm(). Tests inject createMockLlm(). */
  llm?: LlmClient;
  /** Defaults to openSession() (a real Chromium). Tests inject a fake session. */
  openSession?: (config: AgentConfig) => Promise<BrowserSession>;
  /** Clock for timestamps and durations. Defaults to Date.now. */
  now?: () => number;
}

type Viewport = { width: number; height: number };
type Outcome = BrowserAgentResult['outcome'];
type Ending = { outcome: Outcome; summary: string };

const NAVIGATION_TIMEOUT_MS = 15_000;
const ACTION_TIMEOUT_MS = 5_000;
const SETTLE_MS = 250;
const MODEL_TIMEOUT_MS = 120_000;
const MODEL_MAX_TOKENS = 2048;
const SCROLL_PX = 600;
/** Consecutive error / invalid_action / rejected_by_policy steps before the run fails as stuck. */
export const STUCK_STEP_LIMIT = 3;
const DETAIL_MAX_CHARS = 300;
const TRACE_FILE = 'trace.zip';

// ---------------------------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------------------------

/**
 * A fresh Chromium, context (viewport from the config, tracing on) and page. `artifactDir` is
 * accepted for callers written against the earlier skeleton and is not used; the trace path is
 * given to closeSession() instead.
 */
export async function openSession(
  config: AgentConfig,
  _artifactDir?: string,
): Promise<BrowserSession> {
  const browser = await chromium.launch({
    headless: !(config.headed || process.env.PLAYWRIGHT_HEADED === '1'),
  });
  try {
    const context = await browser.newContext({ viewport: config.viewport });
    // Trace captures DOM snapshots + screenshots for every action; saved on close.
    await context.tracing.start({ screenshots: true, snapshots: true });
    const page = await context.newPage();
    return { browser, context, page };
  } catch (err) {
    await browser.close().catch(() => undefined);
    throw err;
  }
}

/** Stops tracing into `tracePath` and closes the browser, even when the trace cannot be written. */
export async function closeSession(session: BrowserSession, tracePath: string): Promise<void> {
  try {
    await session.context.tracing.stop({ path: tracePath });
  } finally {
    await session.browser.close();
  }
}

// ---------------------------------------------------------------------------------------------
// Observe
// ---------------------------------------------------------------------------------------------

function sensesOf(kind: AgentKind): ReadonlySet<string> {
  return new Set<string>(AGENT_PROFILES[kind].perceives);
}

/**
 * Aria snapshot of `main` (what the storefront grader prints), falling back to `body` when the
 * page has no main or its snapshot is empty. count() first: ariaSnapshot() on a missing element
 * would wait for it.
 */
async function ariaSnapshotOf(page: Page): Promise<string> {
  const main = page.locator('main');
  if ((await main.count()) > 0) {
    const snapshot = (await main.ariaSnapshot()).trim();
    if (snapshot) return snapshot;
  }
  return (await page.locator('body').ariaSnapshot()).trim();
}

async function buildObservation(
  page: Page,
  kind: AgentKind,
  viewport: Viewport,
  png: Buffer | undefined,
): Promise<Observation> {
  const senses = sensesOf(kind);
  const observation: Observation = { url: page.url(), title: await page.title(), viewport };
  if (senses.has('tree')) observation.ariaSnapshot = await ariaSnapshotOf(page);
  if (senses.has('text')) {
    const text = await page.locator('body').innerText({ timeout: ACTION_TIMEOUT_MS });
    observation.textExcerpt = text.slice(0, TEXT_CHAR_CAP);
  }
  if (senses.has('screenshot') && png) observation.screenshotBase64 = png.toString('base64');
  return observation;
}

/**
 * Capture what `kind` perceives: the aria tree of main (Alpha, Sigma), the body text excerpt
 * (Alpha, Sigma), a PNG screenshot of the viewport (Beta, Sigma); always the URL and title.
 */
export async function observe(
  page: Page,
  kind: AgentKind,
  viewport: Viewport,
): Promise<Observation> {
  const png = sensesOf(kind).has('screenshot') ? await page.screenshot({ type: 'png' }) : undefined;
  return buildObservation(page, kind, viewport, png);
}

// ---------------------------------------------------------------------------------------------
// Decide
// ---------------------------------------------------------------------------------------------

export interface DecideArgs {
  llm: LlmClient;
  kind: AgentKind;
  model: string;
  effort?: LlmEffort;
  mission: Mission;
  observation: Observation;
  /** Every step so far; the prompt keeps the last few */
  history: RunStep[];
  stepsRemaining: number;
}

export type Decision =
  | { ok: true; response: LlmResponse; action: AgentAction }
  | { ok: false; response: LlmResponse; reason: string };

/**
 * One model call: fixed system prompt per kind, the mission + history + observation as the user
 * turn, strict JSON output converted by toAgentAction(). When the output is unusable the reason
 * comes back instead of an action (the loop records it and the model reads it next turn through
 * the history). Client errors (after its own retries) propagate.
 */
export async function decide(args: DecideArgs): Promise<Decision> {
  const { llm, kind, model, effort, mission, observation, history, stepsRemaining } = args;
  const response = await llm.complete({
    model,
    system: systemPromptFor(kind),
    messages: [
      {
        role: 'user',
        content: buildUserTurn({ kind, mission, observation, history, stepsRemaining }),
      },
    ],
    jsonSchema: actionDraftJsonSchema(),
    ...(effort === undefined ? {} : { effort }),
    maxTokens: MODEL_MAX_TOKENS,
    timeoutMs: MODEL_TIMEOUT_MS,
  });
  if (response.json === undefined) return { ok: false, response, reason: 'model returned no JSON' };
  // toAgentAction treats nulls and empty strings as absent; the strict-schema output goes in raw.
  const conversion = toAgentAction(response.json, kind, observation.viewport);
  return conversion.ok
    ? { ok: true, response, action: conversion.action }
    : { ok: false, response, reason: conversion.reason };
}

// ---------------------------------------------------------------------------------------------
// Police (coordinates)
// ---------------------------------------------------------------------------------------------

const CONTROL_SELECTOR = 'button,a,input,[role],label';
const INTERACTIVE_TAGS = ['button', 'a', 'input', 'label', 'select', 'textarea'];
const INTERACTIVE_ROLES = [
  'button',
  'link',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'radio',
  'checkbox',
  'option',
  'tab',
  'switch',
  'treeitem',
  'textbox',
  'combobox',
  'spinbutton',
];

interface PointArg {
  x: number;
  y: number;
  selector: string;
  tags: string[];
  roles: string[];
}

/**
 * Text of the control under a viewport point: textContent, aria-label, value and title of the
 * closest button/link/input/label/role element, or of the hit element itself when the closest
 * match is a non-interactive container (a click on plain text inside a role="region" must not
 * inherit the whole region's text). The function runs inside the page, so it uses no closures,
 * and reaches `document` through globalThis because this package compiles without DOM types.
 */
async function controlTextAt(page: Page, x: number, y: number): Promise<string> {
  const arg: PointArg = {
    x,
    y,
    selector: CONTROL_SELECTOR,
    tags: INTERACTIVE_TAGS,
    roles: INTERACTIVE_ROLES,
  };
  const text = await page.evaluate((a: PointArg) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const doc = (globalThis as unknown as { document?: any }).document;
    const hit = doc?.elementFromPoint?.(a.x, a.y);
    if (!hit) return '';
    const control = typeof hit.closest === 'function' ? hit.closest(a.selector) : null;
    const tag = String(control?.tagName ?? '').toLowerCase();
    const role = String(control?.getAttribute?.('role') ?? '').toLowerCase();
    const source = control && (a.tags.includes(tag) || a.roles.includes(role)) ? control : hit;
    const parts: unknown[] = [
      source.textContent,
      source.getAttribute?.('aria-label'),
      source.value,
      source.getAttribute?.('title'),
    ];
    return parts
      .filter((p): p is string => typeof p === 'string' && p.trim() !== '')
      .map((p) => p.trim())
      .join(' ');
  }, arg);
  return typeof text === 'string'
    ? text.replace(/\s+/g, ' ').trim().slice(0, DETAIL_MAX_CHARS)
    : '';
}

/**
 * Second policy gate for x,y targets (Beta, Sigma): checkAction() can only read the target
 * string, so for a coordinate the element under the point is inspected before the mouse moves.
 */
async function checkCoordinateTarget(
  page: Page,
  action: AgentAction,
  kind: AgentKind,
  viewport: Viewport,
): Promise<PolicyVerdict> {
  if (action.type !== 'click' && action.type !== 'type') return { ok: true };
  const target = parseTarget(action.target, kind, viewport);
  if (target.kind !== 'coord') return { ok: true };
  const text = await controlTextAt(page, target.x, target.y);
  if (isPaymentControl(text)) {
    return { ok: false, reason: `coordinate click would hit a payment control: "${text}"` };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------
// Act
// ---------------------------------------------------------------------------------------------

const ROLE_PREFIXES: ReadonlySet<string> = new Set<string>(ARIA_ROLES);

/** "Size" from "Size", "combobox:Size" or "group:Size": the option group label for the ladder. */
function groupLabelOf(target: string): string {
  const t = target.trim();
  const i = t.indexOf(':');
  if (i > 0 && ROLE_PREFIXES.has(t.slice(0, i).trim().toLowerCase())) return t.slice(i + 1).trim();
  return t;
}

/** After a click / type / select: let a navigation land, then a short settle for page scripts. */
async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('domcontentloaded').catch(() => undefined);
  await page.waitForTimeout(SETTLE_MS);
}

/**
 * Execute a policy-approved action. role:name targets go through toLocator() (exact accessible
 * name, nothing else); x,y targets through the mouse. `select` resolves the option group through
 * chooseOption()'s radio -> combobox -> button ladder, or setQuantity() for a quantity group.
 * Throws on anything Playwright cannot do; the loop records that as a step error.
 */
export async function act(
  page: Page,
  action: AgentAction,
  kind: AgentKind,
  viewport: Viewport,
): Promise<void> {
  switch (action.type) {
    case 'navigate':
      await page.goto(action.url, {
        waitUntil: 'domcontentloaded',
        timeout: NAVIGATION_TIMEOUT_MS,
      });
      return;
    case 'click': {
      const target = parseTarget(action.target, kind, viewport);
      if (target.kind === 'invalid') throw new Error(`click target ${target.reason}`);
      if (target.kind === 'role') {
        await toLocator(page, target).click({ timeout: ACTION_TIMEOUT_MS });
      } else {
        await page.mouse.click(target.x, target.y);
      }
      await settle(page);
      return;
    }
    case 'type': {
      const target = parseTarget(action.target, kind, viewport);
      if (target.kind === 'invalid') throw new Error(`type target ${target.reason}`);
      if (target.kind === 'role') {
        // fill() clears the field first.
        await toLocator(page, target).fill(action.text, { timeout: ACTION_TIMEOUT_MS });
      } else {
        // Click to focus, select whatever is there (a quantity field holds "1"), then type.
        await page.mouse.click(target.x, target.y);
        await page.keyboard.press('ControlOrMeta+a');
        await page.keyboard.type(action.text);
      }
      await settle(page);
      return;
    }
    case 'select': {
      const group = groupLabelOf(action.target);
      if (group.toLowerCase() === 'quantity') await setQuantity(page, Number(action.value));
      else await chooseOption(page, group, action.value);
      await settle(page);
      return;
    }
    case 'scroll':
      await page.mouse.wheel(0, action.direction === 'down' ? SCROLL_PX : -SCROLL_PX);
      return;
    case 'extract':
    case 'done':
    case 'fail':
      return; // no browser effect: the observation already holds the page
  }
}

// ---------------------------------------------------------------------------------------------
// Loop
// ---------------------------------------------------------------------------------------------

/** First line of an error message, capped, so a Playwright call log never floods a step. */
function errorDetail(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const firstLine =
    message.split(/\r?\n/, 1)[0]?.trim() || (err instanceof Error ? err.name : 'unknown error');
  return firstLine.length <= DETAIL_MAX_CHARS
    ? firstLine
    : `${firstLine.slice(0, DETAIL_MAX_CHARS - 3)}...`;
}

const stepFile = (index: number, suffix: string): string =>
  `step-${String(index).padStart(3, '0')}${suffix}`;

/**
 * Entry point used by apps/runner. openSession -> navigate to the store -> loop(observe, decide,
 * police, act, record) -> closeSession. Never throws: a browser crash, an unreachable store or
 * a model error (after the client's own retries) come back as outcome 'error'. The runner then
 * fetches the cart with the returned cookies and calls the verifier.
 *
 * `artifactDir` is absolute (<artifactsRoot>/<runId>); evidence paths are relative to
 * <artifactsRoot>, e.g. '<runId>/step-003.png'.
 */
export async function runBrowserAgent(
  mission: Mission,
  config: AgentConfig,
  artifactDir: string,
  cb: AgentCallbacks,
  deps: BrowserAgentDeps = {},
): Promise<BrowserAgentResult> {
  const now = deps.now ?? Date.now;
  const iso = (ms: number): string => new Date(ms).toISOString();
  const startedAt = now();
  const runId = path.basename(artifactDir);
  const kind = config.kind;
  const viewport = config.viewport;

  const steps: RunStep[] = [];
  const visitedUrls: string[] = [];
  const visit = (url: string): void => {
    if (url && !visitedUrls.includes(url)) visitedUrls.push(url);
  };
  let usage: LlmUsage = { ...EMPTY_USAGE };
  let resolvedModel = 'none';
  let provider = 'none';
  let effort: LlmEffort | undefined;
  let session: BrowserSession | undefined;
  let finalUrl: string | undefined;
  let cookies: BrowserAgentResult['cookies'] = [];
  let tracePath: string | undefined;

  const finish = (ending: Ending): BrowserAgentResult => ({
    outcome: ending.outcome,
    summary: ending.summary,
    ...(finalUrl === undefined ? {} : { finalUrl }),
    visitedUrls: [...visitedUrls],
    cookies,
    usage,
    resolvedModel,
    provider,
    ...(effort === undefined ? {} : { effort }),
    stepsUsed: steps.length,
    durationMs: Math.max(0, now() - startedAt),
    ...(tracePath === undefined ? {} : { tracePath }),
  });

  if (kind === 'gamma_structured') {
    return finish({ outcome: 'error', summary: 'gamma is not a browser agent' });
  }

  const execute = async (): Promise<Ending> => {
    const llm = deps.llm ?? getLlm();
    const settings = resolveRunSettings(config, llm.provider);
    resolvedModel = settings.model;
    provider = llm.provider;
    effort = settings.effort;
    cb.onLog(`model: ${settings.model} (${llm.provider}, effort ${settings.effort ?? 'default'})`);

    if (!hostIsAllowed(mission.storeUrl)) {
      return {
        outcome: 'error',
        summary: `store host of ${mission.storeUrl} is not in AGENTPROOF_ALLOWED_HOSTS`,
      };
    }
    // The mission's own cap still applies (checkAction would reject every step past it).
    const stepLimit = Math.min(settings.maxSteps, mission.maxSteps);

    fs.mkdirSync(artifactDir, { recursive: true });
    session = await (deps.openSession ?? openSession)(config);
    const { page } = session;
    await page.goto(mission.storeUrl, {
      waitUntil: 'domcontentloaded',
      timeout: NAVIGATION_TIMEOUT_MS,
    });
    visit(page.url());

    let stuck = 0;
    for (let i = 0; i < stepLimit; i++) {
      const stepStart = now();
      const at = iso(stepStart);

      // Observe. The screenshot file is evidence for humans on every kind; only Beta and Sigma
      // receive it in the prompt. The aria tree is saved whenever it was captured.
      const png = await page.screenshot({ type: 'png' });
      const observation = await buildObservation(page, kind, viewport, png);
      const screenshotFile = stepFile(i, '.png');
      await fs.promises.writeFile(path.join(artifactDir, screenshotFile), png);
      const screenshotEvidence: Evidence = {
        id: newId('ev'),
        runId,
        kind: 'screenshot',
        stepIndex: i,
        capturedAt: at,
        path: `${runId}/${screenshotFile}`,
        label: `Step ${i} screenshot: ${observation.url}`,
      };
      cb.onEvidence(screenshotEvidence);
      let snapshotEvidenceId: string | undefined;
      if (observation.ariaSnapshot !== undefined) {
        const ariaFile = stepFile(i, '.aria.txt');
        await fs.promises.writeFile(
          path.join(artifactDir, ariaFile),
          observation.ariaSnapshot,
          'utf8',
        );
        const snapshotEvidence: Evidence = {
          id: newId('ev'),
          runId,
          kind: 'dom_snapshot',
          stepIndex: i,
          capturedAt: at,
          path: `${runId}/${ariaFile}`,
          label: `Step ${i} accessibility tree: ${observation.url}`,
        };
        cb.onEvidence(snapshotEvidence);
        snapshotEvidenceId = snapshotEvidence.id;
      }

      // Decide.
      const decision = await decide({
        llm,
        kind,
        model: settings.model,
        ...(settings.effort === undefined ? {} : { effort: settings.effort }),
        mission,
        observation,
        history: steps,
        stepsRemaining: stepLimit - i,
      });
      usage = addUsage(usage, decision.response.usage);

      const step: RunStep = {
        index: i,
        at,
        url: observation.url,
        outcome: 'ok',
        screenshotEvidenceId: screenshotEvidence.id,
        ...(snapshotEvidenceId === undefined ? {} : { snapshotEvidenceId }),
        usage: decision.response.usage,
      };
      let ending: Ending | undefined;

      if (!decision.ok) {
        step.outcome = 'invalid_action';
        step.outcomeDetail = decision.reason;
      } else {
        const action = decision.action;
        step.action = action;
        // Police, then act.
        const verdict = checkAction(mission, action, i);
        if (!verdict.ok) {
          step.outcome = 'rejected_by_policy';
          step.outcomeDetail = verdict.reason;
        } else if (action.type === 'done') {
          ending = { outcome: 'done', summary: action.summary };
        } else if (action.type === 'fail') {
          ending = { outcome: 'fail', summary: action.reason };
        } else {
          try {
            const coordinateVerdict = await checkCoordinateTarget(page, action, kind, viewport);
            if (!coordinateVerdict.ok) {
              step.outcome = 'rejected_by_policy';
              step.outcomeDetail = coordinateVerdict.reason;
            } else {
              await act(page, action, kind, viewport);
            }
          } catch (err) {
            step.outcome = 'error';
            step.outcomeDetail = errorDetail(err);
          }
        }
      }

      // Record.
      step.durationMs = Math.max(0, now() - stepStart);
      steps.push(step);
      cb.onStep(step);
      cb.onLog(summarizeStep(step));
      visit(page.url());

      if (ending) return ending;
      stuck = step.outcome === 'ok' ? 0 : stuck + 1;
      if (stuck >= STUCK_STEP_LIMIT) {
        return { outcome: 'fail', summary: `stuck: ${step.outcomeDetail ?? step.outcome}` };
      }
    }
    return { outcome: 'step_limit', summary: 'step limit reached' };
  };

  /** Always runs, never throws: final URL and cookies (best effort), trace, browser close. */
  const teardown = async (): Promise<void> => {
    if (!session) return;
    const traceFile = path.join(artifactDir, TRACE_FILE);
    try {
      finalUrl = session.page.url();
      visit(finalUrl);
    } catch {
      // page gone (crash): keep what we have
    }
    try {
      cookies = (await session.context.cookies()).map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
      }));
    } catch {
      // context gone: no cookies
    }
    try {
      await closeSession(session, traceFile);
    } catch (err) {
      cb.onLog(`browser close failed: ${errorDetail(err)}`);
    }
    if (fs.existsSync(traceFile)) {
      tracePath = `${runId}/${TRACE_FILE}`;
      cb.onEvidence({
        id: newId('ev'),
        runId,
        kind: 'trace',
        capturedAt: iso(now()),
        path: tracePath,
        label: 'Playwright trace (screenshots + DOM snapshots per action)',
      });
    }
  };

  let ending: Ending;
  try {
    ending = await execute();
  } catch (err) {
    ending = { outcome: 'error', summary: errorDetail(err) };
  }
  await teardown();
  if (ending.outcome === 'error') cb.onLog(`error: ${ending.summary}`);
  return finish(ending);
}
