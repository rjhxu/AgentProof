/**
 * Drive the real browser loop with a SCRIPTED model (no API calls): the mock LLM returns a fixed
 * sequence of action drafts, everything else (Chromium, policy, Playwright actions, evidence,
 * cookies, cart fetch, verifier) is the real thing. Use it to validate the harness without
 * spending tokens, and as a deterministic fallback for the demo.
 *
 *   pnpm --filter @agentproof/agent exec tsx --env-file-if-exists=../../.env scripts/scripted-run.ts [alpha|sigma] [A|control] [--headed]
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentConfig, newId, type AgentActionDraft, type AgentKind } from '@agentproof/shared';
import { overallStatus, verify } from '@agentproof/verifier';
import {
  browserRunEvidenceForCart,
  fetchCartWithCookies,
  verificationInputFromBrowserRun,
} from '../src/assess';
import { runBrowserAgent } from '../src/browser-agent';
import { createMockLlm } from '../src/llm';
import { scenarioMission, type ScenarioId } from '../src/scenarios';

const [agentArg = 'alpha', bugArg = 'A'] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const headed = process.argv.includes('--headed');
const kind: AgentKind = agentArg === 'sigma' ? 'sigma_hybrid' : 'alpha_semantic';
const bug = bugArg as ScenarioId;
const storeUrl = process.env.STOREFRONT_URL ?? 'http://localhost:5000';

const draft = (
  type: AgentActionDraft['type'],
  fields: Partial<AgentActionDraft> = {},
): AgentActionDraft => ({
  type,
  reason: fields.reason ?? `scripted ${type}`,
  target: null,
  url: null,
  text: null,
  value: null,
  direction: null,
  what: null,
  ...fields,
});

/** What a semantic agent would do on each scenario, following the prompt's two-attempt rule. */
const SCRIPTS: Partial<Record<ScenarioId, AgentActionDraft[]>> = {
  A: [
    draft('click', {
      target: 'link:Black Hoodie',
      reason: 'Open the product that matches the mission',
    }),
    draft('select', { target: 'Size', value: 'M', reason: 'Mission requires size M' }),
    draft('select', { target: 'Size', value: 'M', reason: 'Second attempt at size M' }),
    draft('click', {
      target: 'button:Add to cart',
      reason: 'No size control found; continue with the page default',
    }),
    draft('click', { target: 'link:Proceed to checkout', reason: 'Reach checkout review' }),
    draft('done', { reason: 'Checkout review page reached; size M could not be selected' }),
  ],
  control: [
    draft('click', { target: 'link:Canvas Tote', reason: 'Open the product' }),
    draft('click', { target: 'button:Add to cart', reason: 'Single variant' }),
    draft('click', { target: 'link:Proceed to checkout', reason: 'Reach checkout review' }),
    draft('done', { reason: 'Checkout review page reached' }),
  ],
};

const script = SCRIPTS[bug];
if (!script) {
  console.error(`No script for scenario ${bug}; available: ${Object.keys(SCRIPTS).join(', ')}`);
  process.exit(2);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const artifactsRoot = path.resolve(here, '../../../data/artifacts/scripted');
const runId = newId('run');
const artifactDir = path.join(artifactsRoot, runId);
const mission = scenarioMission(bug, storeUrl);
const config = AgentConfig.parse({ kind, headed });
const llm = createMockLlm(script.map((json) => ({ json })));

console.log(`[scripted] ${kind} on scenario ${bug} at ${storeUrl}; artifacts ${artifactDir}`);
const steps: import('@agentproof/shared').RunStep[] = [];
const evidence: import('@agentproof/shared').Evidence[] = [];
const result = await runBrowserAgent(
  mission,
  config,
  artifactDir,
  {
    onStep: (s) => {
      steps.push(s);
      console.log(
        `  #${s.index} ${s.action ? JSON.stringify(s.action) : '(no action)'} -> ${s.outcome}${s.outcomeDetail ? `: ${s.outcomeDetail}` : ''}`,
      );
    },
    onEvidence: (e) => evidence.push(e),
    onLog: (m) => console.log(`  [log] ${m}`),
  },
  { llm },
);
console.log(
  `[scripted] outcome=${result.outcome} summary="${result.summary}" finalUrl=${result.finalUrl} steps=${result.stepsUsed} cookies=${result.cookies.length} evidence=${evidence.length}`,
);

const cart = await fetchCartWithCookies(storeUrl, result.cookies);
const cartEvidence = cart ? [browserRunEvidenceForCart(runId, cart)] : [];
const input = verificationInputFromBrowserRun({
  mission,
  result,
  cart,
  cartEvidenceIds: cartEvidence.map((e) => e.id),
});
const verification = verify(input);
console.log(
  `[scripted] cart: ${cart ? cart.items.map((i) => `${i.variantId} x${i.quantity}`).join(', ') || '(empty)' : '(not readable)'}`,
);
console.log(`[scripted] verdict: ${overallStatus(verification)}`);
for (const c of verification.checkpoints)
  console.log(`  ${c.status.padEnd(12)} ${c.id}${c.detail ? `  (${c.detail})` : ''}`);
console.log(
  `[scripted] llm requests recorded: ${llm.requests.length}; first user turn blocks: ${llm.requests[0]?.messages[0]?.content.map((b) => b.type).join(',')}`,
);
