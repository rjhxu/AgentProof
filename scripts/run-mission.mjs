// Drive one scenario mission through the runner and print the cross-agent result.
//
//   node scripts/run-mission.mjs --bug A --agents alpha,beta,sigma,gamma
//   node scripts/run-mission.mjs --bug C --agents alpha --store http://localhost:5050
//
// Needs the runner (pnpm dev:runner, :4000) and the store the mission points at. Creates the
// fixture mission (POST /missions/fixture), starts the runs, polls GET /missions/:id until every run
// is terminal, then prints each run's verdict and the mission report's matrix, attribution and
// cost lines. Reports land under data/artifacts/<runId>/ and data/artifacts/missions/<missionId>/.
//
//   --bug      A | B | C | D | E | control            (default A)
//   --agents   comma list of alpha, beta, sigma, gamma  (default alpha)
//   --store    storefront URL for the mission           (default: the runner's STOREFRONT_URL)
//   --runner   runner base URL                          (default http://127.0.0.1:4000)

const KINDS = {
  alpha: 'alpha_semantic',
  beta: 'beta_vision',
  sigma: 'sigma_hybrid',
  gamma: 'gamma_structured',
};
const SHORT = Object.fromEntries(Object.entries(KINDS).map(([k, v]) => [v, k]));
const TERMINAL = new Set(['passed', 'failed', 'error', 'cancelled']);

const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? dflt : argv[i + 1];
};
const bug = opt('bug', 'A');
const agents = opt('agents', 'alpha')
  .split(',')
  .map((a) => KINDS[a.trim()] ?? a.trim());
const store = opt('store', undefined);
const BASE = opt('runner', process.env.RUNNER_URL ?? 'http://127.0.0.1:4000');

async function json(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const usd = (c) => (c === undefined || c === null ? 'n/a' : `$${c.toFixed(4)}`);

const { mission } = await json('POST', '/missions/fixture', {
  bug,
  ...(store ? { storeUrl: store } : {}),
});
console.log(`mission ${mission.id} (bug ${bug}) on ${mission.storeUrl}`);
console.log(mission.rawPrompt);
const started = await json('POST', `/missions/${mission.id}/runs`, { agents });
console.log(`started ${started.runs.map((r) => `${SHORT[r.agent.kind]}=${r.id}`).join(' ')}`);

const seen = new Map();
const t0 = Date.now();
let runs;
for (;;) {
  runs = (await json('GET', `/missions/${mission.id}`)).runs;
  for (const r of runs) {
    if (seen.get(r.id) !== r.status) {
      seen.set(r.id, r.status);
      const extra = TERMINAL.has(r.status)
        ? ` (${r.steps.length} steps, ${usd(r.usage?.estimatedCostUsd)})`
        : '';
      const t = String(Math.round((Date.now() - t0) / 1000)).padStart(4);
      console.log(`${t}s ${SHORT[r.agent.kind].padEnd(5)} ${r.status}${extra}`);
    }
  }
  if (runs.every((r) => TERMINAL.has(r.status))) break;
  if (Date.now() - t0 > 30 * 60 * 1000) {
    console.log('gave up after 30 minutes');
    break;
  }
  await sleep(3000);
}

console.log('');
for (const r of runs) {
  const ff = r.verification?.firstFailure;
  const verdict = ff
    ? `${ff.id}${ff.detail ? ` (${ff.detail})` : ''}`
    : r.status === 'error'
      ? `error: ${r.errorMessage ?? ''}`
      : 'all checkpoints passed';
  console.log(
    `${SHORT[r.agent.kind].padEnd(6)} ${r.status.padEnd(7)} ${String(r.steps.length).padStart(2)} steps  ${usd(r.usage?.estimatedCostUsd).padEnd(8)} ${r.resolvedModel ?? '-'}  ${verdict}`,
  );
  if (r.claim?.summary)
    console.log(`       claim (${r.claim.outcome}): ${r.claim.summary.slice(0, 200)}`);
}

const { report } = await json('GET', `/missions/${mission.id}/report?refresh=1`);
console.log('');
console.log(report.headline);
const kinds = Object.values(KINDS).filter((k) => runs.some((r) => r.agent.kind === k));
console.log(`${'checkpoint'.padEnd(32)}${kinds.map((k) => SHORT[k].padEnd(12)).join('')}`);
for (const [cp, row] of Object.entries(report.matrix)) {
  if (kinds.every((k) => (row[k] ?? 'not_run') === 'not_run')) continue;
  console.log(`${cp.padEnd(32)}${kinds.map((k) => (row[k] ?? 'not_run').padEnd(12)).join('')}`);
}
if (report.attributions.length) {
  console.log('attribution:');
  for (const a of report.attributions) {
    console.log(
      `  ${a.checkpointId}: ${a.category} (failing: ${a.failingAgents.map((k) => SHORT[k]).join(', ')}; reference: ${a.reference ? SHORT[a.reference] : '-'})`,
    );
  }
}
console.log('cost:');
for (const c of report.costComparison) {
  console.log(
    `  ${SHORT[c.agentKind].padEnd(6)} ${c.status.padEnd(7)} ${c.model.padEnd(18)} ${c.inputTokens} in / ${c.outputTokens} out, ${c.imageInputs} img, ${usd(c.estimatedCostUsd)}${c.relativeCost !== undefined ? ` (${c.relativeCost.toFixed(1)}x)` : ''}`,
  );
}
for (const rec of report.recommendations) console.log(`recommendation: ${rec}`);
console.log(`report: data/artifacts/missions/${mission.id}/report.md`);
