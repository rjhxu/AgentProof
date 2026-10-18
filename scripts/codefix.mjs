// Drive the code-fix agent for one failed run through the runner and print the record.
//
//   node scripts/codefix.mjs --run run_abc                                   # diff mode
//   node scripts/codefix.mjs --run run_abc --repo https://github.com/o/r --store-root apps/storefront
//   node scripts/codefix.mjs --run run_abc --mode pull_request --token-env GITHUB_TOKEN
//
// Needs the runner (pnpm dev:runner, :4000). If --repo is given and the run has no repository
// connected yet, connects it first (POST /runs/:id/repository). Then POST /runs/:id/codefix, polls
// GET /codefix/:id until it is no longer running, and prints the timeline, the validation table,
// the headline and where the artifacts are. The token, when any, is read from the environment
// variable named by --token-env and sent once in the request body; it is never printed.
//
//   --run         the failed run id (required)
//   --repo        GitHub URL to connect when the run has none
//   --store-root  directory of the store inside the repository ('' for a store-only repo)
//   --mode        diff | branch | pull_request          (default diff)
//   --token-env   name of the env var holding a fine-grained token (needed for branch/pull_request, or a private repo)
//   --no-typecheck, --no-review, --rematch, --attempts N
//   --runner      runner base URL                        (default http://127.0.0.1:4000)

const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? dflt : argv[i + 1];
};
const flag = (name) => argv.includes(`--${name}`);

const runId = opt('run');
if (!runId) {
  console.error(
    'usage: node scripts/codefix.mjs --run <runId> [--repo <url>] [--store-root <dir>] [--mode diff|branch|pull_request] [--token-env NAME]',
  );
  process.exit(2);
}
const BASE = opt('runner', process.env.RUNNER_URL ?? 'http://127.0.0.1:4000');
const tokenEnv = opt('token-env');
const token = tokenEnv ? process.env[tokenEnv] : undefined;
if (tokenEnv && !token) {
  console.error(`--token-env ${tokenEnv} is set but the variable is empty`);
  process.exit(2);
}

async function json(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Origin: 'http://localhost:3000',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : undefined;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { run } = await json('GET', `/runs/${runId}`);
console.log(
  `run ${run.id}: ${run.agent.kind} ${run.status}; first failure ${run.verification?.firstFailure?.id ?? 'none'}`,
);

let { repository } = await json('GET', `/runs/${runId}/repository`);
const repoUrl = opt('repo');
if (!repository && repoUrl) {
  console.log(`connecting ${repoUrl} ...`);
  ({ repository } = await json('POST', `/runs/${runId}/repository`, {
    url: repoUrl,
    consent: true,
    ...(token ? { token } : {}),
  }));
}
if (!repository) {
  console.error('no repository connected to this run; pass --repo <GitHub URL>');
  process.exit(1);
}
console.log(
  `repository ${repository.fullName} @ ${repository.commitSha.slice(0, 7)} (${repository.fileCount} files)`,
);

const body = {
  mode: opt('mode', 'diff'),
  consent: true,
  storeRoot: opt('store-root', ''),
  typecheck: !flag('no-typecheck'),
  review: !flag('no-review'),
  rematch: flag('rematch'),
  ...(opt('attempts') ? { maxAttempts: Number(opt('attempts')) } : {}),
  ...(token ? { token } : {}),
};
let { codefix } = await json('POST', `/runs/${runId}/codefix`, body);
console.log(`codefix ${codefix.id} started (mode ${codefix.mode})`);

let printed = 0;
const t0 = Date.now();
while (codefix.status === 'running') {
  await sleep(1500);
  ({ codefix } = await json('GET', `/codefix/${codefix.id}`));
  for (const entry of codefix.timeline.slice(printed)) {
    console.log(`  [${entry.stage}] ${entry.message}`);
  }
  printed = codefix.timeline.length;
  if (Date.now() - t0 > 20 * 60_000) {
    console.error('gave up after 20 minutes');
    process.exit(1);
  }
}
for (const entry of codefix.timeline.slice(printed))
  console.log(`  [${entry.stage}] ${entry.message}`);

console.log('');
console.log(`status ${codefix.status}${codefix.error ? `: ${codefix.error}` : ''}`);
const final =
  codefix.finalAttempt === undefined
    ? codefix.attempts.at(-1)
    : codefix.attempts[codefix.finalAttempt];
if (final?.proposal) {
  const d = final.proposal.diagnosis;
  console.log(
    `diagnosis (${final.model}, hypothesis): ${d.title} [${d.category}, ${d.confidence}]`,
  );
  console.log(`  ${d.inferredCause}`);
}
if (final?.validation) {
  console.log('validation (code):');
  for (const c of final.validation.checks)
    console.log(
      `  ${c.id.padEnd(22)} ${c.status.padEnd(8)} ${c.detail.split('\n')[0].slice(0, 110)}`,
    );
}
if (codefix.review) {
  console.log(
    `review (${codefix.review.model}, advisory): ${codefix.review.verdict}; human-visible change: ${codefix.review.humanVisibleChange}`,
  );
  for (const n of codefix.review.notes) console.log(`  - ${n}`);
}
if (codefix.delivery.status !== 'not_requested') {
  const d = codefix.delivery;
  console.log(
    `delivery: ${d.status}${d.branch ? ` branch ${d.branch}` : ''}${d.pullRequestUrl ? ` ${d.pullRequestUrl} (${d.draft ? 'draft' : 'NOT draft'})` : ''}${d.compareUrl ? ` ${d.compareUrl}` : ''}${d.error ? ` error: ${d.error}` : ''}`,
  );
}
if (codefix.rematch) {
  const r = codefix.rematch;
  console.log(
    `rematch: run ${r.runId} ${r.status}${r.comparison ? `; improved ${r.comparison.improved}, regressed ${r.comparison.regressed}` : ''}${r.error ? ` error: ${r.error}` : ''}`,
  );
}
const u = codefix.usage;
console.log(
  `cost: ${u.calls} calls, ${u.inputTokens} in / ${u.outputTokens} out, ${u.estimatedCostUsd === undefined ? 'unknown' : `$${u.estimatedCostUsd.toFixed(4)}`}`,
);
for (const a of codefix.artifacts) console.log(`artifact: data/artifacts/${a}`);
if (final?.diff) {
  console.log('');
  console.log(final.diff);
}
process.exit(codefix.status === 'succeeded' ? 0 : 1);
