import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import type { AgentAction, AgentConfig, Evidence, Mission, RunStep } from '@agentproof/shared';

/**
 * Browser Agent Engine (spec section 5, component C).
 *
 *   loop:
 *     observe  -> capture page state (Alpha: accessibility tree; Beta: screenshot)
 *     decide   -> ask Claude for the next AgentAction (structured output)
 *     police   -> checkAction() from ./policy
 *     act      -> execute via Playwright
 *     record   -> RunStep + Evidence, emit to the runner
 *   until done / fail / step limit
 *
 * OWNER: Developer 2. This file is a skeleton with the loop shape and the
 * extension points; the TODOs mark where the real work goes.
 */

export interface AgentCallbacks {
  onStep(step: RunStep): void;
  onEvidence(evidence: Evidence): void;
  onLog(message: string): void;
}

export interface BrowserAgentResult {
  outcome: 'done' | 'fail' | 'step_limit' | 'error';
  summary: string;
  finalUrl?: string;
}

export interface BrowserSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
}

export async function openSession(
  config: AgentConfig,
  artifactDir: string,
): Promise<BrowserSession> {
  const browser = await chromium.launch({
    headless: !(config.headed || process.env.PLAYWRIGHT_HEADED === '1'),
  });
  const context = await browser.newContext({ viewport: config.viewport });
  // Trace captures DOM snapshots + screenshots for every action; saved on close.
  await context.tracing.start({ screenshots: true, snapshots: true });
  const page = await context.newPage();
  void artifactDir; // used by closeSession for the trace path
  return { browser, context, page };
}

export async function closeSession(session: BrowserSession, tracePath: string): Promise<void> {
  await session.context.tracing.stop({ path: tracePath });
  await session.browser.close();
}

/**
 * Observation handed to Claude each step. Alpha fills `accessibilityTree`; Beta fills `screenshotBase64`.
 * Both include the URL and a trimmed text excerpt so the model has grounding either way.
 */
export interface Observation {
  url: string;
  title: string;
  accessibilityTree?: string;
  screenshotBase64?: string;
  textExcerpt: string;
}

export async function observe(page: Page, kind: AgentConfig['kind']): Promise<Observation> {
  const url = page.url();
  const title = await page.title();
  const textExcerpt = (await page.locator('body').innerText()).slice(0, 4000);
  if (kind === 'beta_vision') {
    const buf = await page.screenshot({ type: 'png' });
    return { url, title, textExcerpt, screenshotBase64: buf.toString('base64') };
  }
  // TODO(dev2): replace with a compact role/name tree (page.accessibility is deprecated in
  // recent Playwright; use page.locator('body').ariaSnapshot()).
  const accessibilityTree = await page.locator('body').ariaSnapshot();
  return { url, title, textExcerpt, accessibilityTree };
}

/** Ask Claude for the next action. */
export async function decide(
  _mission: Mission,
  _obs: Observation,
  _history: RunStep[],
): Promise<AgentAction> {
  // TODO(dev2): call getClaude().messages.parse with zodOutputFormat(AgentAction).
  // Include: mission.requirements, allowed actions, step budget remaining, last 5 steps,
  // and the observation (image block for Beta). Never pass the raw prompt - only the structured mission.
  throw new Error('decide() not implemented');
}

/** Execute a policy-approved action with Playwright. */
export async function act(page: Page, action: AgentAction): Promise<void> {
  switch (action.type) {
    case 'navigate':
      await page.goto(action.url, { waitUntil: 'domcontentloaded' });
      return;
    case 'click':
      // TODO(dev2): resolve `target` - Alpha: "role:name" or CSS; Beta: "x,y" -> page.mouse.click
      await page.locator(action.target).first().click({ timeout: 5000 });
      return;
    case 'type':
      await page.locator(action.target).first().fill(action.text, { timeout: 5000 });
      return;
    case 'select':
      await page.locator(action.target).first().selectOption(action.value, { timeout: 5000 });
      return;
    case 'scroll':
      await page.mouse.wheel(0, action.direction === 'down' ? 600 : -600);
      return;
    case 'extract':
    case 'done':
    case 'fail':
      return; // no browser effect
  }
}

/**
 * Entry point used by apps/runner. Wire-up order:
 *   openSession -> loop(observe, decide, checkAction, act, record) -> closeSession
 * The runner then calls the verifier with the observed cart (fetch storeUrl + /api/cart with the
 * session's cookies) and the final URL.
 */
export async function runBrowserAgent(
  _mission: Mission,
  _config: AgentConfig,
  _artifactDir: string,
  _cb: AgentCallbacks,
): Promise<BrowserAgentResult> {
  // TODO(dev2): implement the loop described above.
  return { outcome: 'error', summary: 'runBrowserAgent not implemented yet' };
}
