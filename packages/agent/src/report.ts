import { readFileSync, readdirSync, statSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  AGENT_LABELS,
  CHECKPOINT_LABELS,
  CHECKPOINT_ORDER,
  EMPTY_USAGE,
  FAILURE_CATEGORY_LABELS,
  addUsage,
  isMutatingAction,
  newId,
  nowIso,
  type AgentAction,
  type AgentKind,
  type AgentProfileSummary,
  type AgentReport,
  type Attribution,
  type Checkpoint,
  type CheckpointId,
  type Evidence,
  type EvidenceKind,
  type FailurePoint,
  type LlmUsage,
  type Mission,
  type MissionReport,
  type MissionReportRun,
  type PatternStatus,
  type ReportStep,
  type Run,
  type RunStep,
} from '@agentproof/shared';
import {
  attributeMission,
  latestRunsByKind,
  patternFor,
  recommendationsFrom,
} from '@agentproof/verifier';

/**
 * Report builder and Markdown renderer.
 *
 * Reports are the hand-off from the agents to the dashboard and to the (future) code-fix agent.
 * Everything in here is deterministic: the only model-written text is `narrative`, which is
 * carried through verbatim and labelled as the agent's own account, never as a verdict.
 *
 *   buildAgentReport     one run  -> AgentReport   (senses, step log, divergence, verdict, cost)
 *   buildMissionReport   all runs -> MissionReport (side by side, matrix, attribution, thesis)
 *   render*Markdown      JSON     -> Markdown for humans and LLMs
 *   writeReportFiles     JSON + Markdown to disk
 *
 * File layout: every path in the JSON is relative to the artifacts root (AGENTPROOF_DATA_DIR/
 * artifacts) and uses forward slashes. A run's report lives in its own artifact directory,
 * `<artifactsRoot>/<run.id>/report.{json,md}`, so Markdown link hrefs are made relative to that
 * directory (see ReportMarkdownOptions.linkBase) while link text keeps the artifacts-relative path.
 */

/** Display order for agents: the cheapest first, then the stronger browser agents, then the data path. */
export const REPORT_AGENT_ORDER: AgentKind[] = [
  'alpha_semantic',
  'beta_vision',
  'sigma_hybrid',
  'gamma_structured',
];

/** Browser agents whose model spend the thesis compares. Gamma has no model and no LLM cost. */
const BROWSER_AGENTS: AgentKind[] = ['alpha_semantic', 'beta_vision', 'sigma_hybrid'];

/** FailurePoint.perceived is capped at this many characters (see the shared schema). */
export const PERCEIVED_MAX_CHARS = 2000;
const TRUNCATION_MARK = '\n[truncated]';
const STEP_DETAIL_MAX_CHARS = 100;
const STEP_ACTION_MAX_CHARS = 120;
const RECOVERED_DETAIL_MAX_CHARS = 200;
const COST_NOTE = 'estimated from a static price table; not provider-reported';
/** What writeReportFiles writes with the default base name; never listed as artifacts of the run it describes. */
const REPORT_FILE_NAMES = ['report.json', 'report.md'];

export interface ReportMarkdownOptions {
  /**
   * Directory the Markdown file will be written to, relative to the artifacts root, in posix form
   * (e.g. "run_abc" for `<artifactsRoot>/run_abc/report.md`). Link hrefs are made relative to it so
   * they resolve when the file is opened in place; link text stays artifacts-relative, like the
   * JSON. Agent reports default to the run id (the convention behind MissionReportRun.reportPath);
   * mission reports default to the artifacts root (""). Pass the same directory you give
   * writeReportFiles.
   */
  linkBase?: string;
}

// ---------------------------------------------------------------------------------------------
// Agent report
// ---------------------------------------------------------------------------------------------

export interface BuildAgentReportInput {
  mission: Mission;
  run: Run;
  profile: AgentProfileSummary;
  /** The agent's own account of the run (model-written). Carried verbatim, labelled as such. */
  narrative: string;
  /** Absolute directory that `evidence.path` is relative to (AGENTPROOF_DATA_DIR/artifacts). */
  artifactsRoot: string;
}

export function buildAgentReport(input: BuildAgentReportInput): AgentReport {
  const { mission, run, profile, narrative, artifactsRoot } = input;
  const evidenceById = new Map(run.evidence.map((e) => [e.id, e] as const));

  const steps: ReportStep[] = run.steps.map((step) => ({
    ...step,
    screenshotPath: artifactPath(screenshotEvidenceFor(step, evidenceById)?.path),
    snapshotPath: artifactPath(snapshotEvidenceFor(step, run, evidenceById)?.path),
  }));

  const checkpoints = run.verification?.checkpoints ?? [];
  const failure = findFailureStep(run);
  const failurePoint = failure
    ? toFailurePoint(failure, run, profile, evidenceById, artifactsRoot)
    : undefined;

  const evidenceIds = new Set<string>();
  for (const cp of checkpoints) for (const id of cp.evidenceIds) evidenceIds.add(id);
  if (failure) {
    const { step } = failure;
    if (step.screenshotEvidenceId) evidenceIds.add(step.screenshotEvidenceId);
    if (step.snapshotEvidenceId) evidenceIds.add(step.snapshotEvidenceId);
    for (const e of run.evidence) if (e.stepIndex === step.index) evidenceIds.add(e.id);
  }

  return {
    id: newId('rep'),
    runId: run.id,
    missionId: mission.id,
    generatedAt: nowIso(),
    storeUrl: mission.storeUrl,
    mission,
    agent: profile,
    status: run.status,
    claim: run.claim,
    checkpoints,
    firstFailure: run.verification?.firstFailure,
    observedCart: run.verification?.observedCart,
    steps,
    failurePoint,
    narrative,
    usage: runUsage(run) ?? EMPTY_USAGE,
    durationMs: runDurationMs(run),
    evidenceIds: [...evidenceIds],
    artifacts: listRunArtifacts(artifactsRoot, run.id),
  };
}

/** Wall clock of the run: finishedAt - startedAt when both are present, else the sum of step durations. */
export function runDurationMs(run: Run): number {
  if (run.startedAt && run.finishedAt) {
    const ms = Date.parse(run.finishedAt) - Date.parse(run.startedAt);
    if (Number.isFinite(ms) && ms >= 0) return Math.round(ms);
  }
  return run.steps.reduce((sum, s) => sum + (s.durationMs ?? 0), 0);
}

/** run.usage when the runner summed it, else the sum of per-step usage, else undefined. */
export function runUsage(run: Run): LlmUsage | undefined {
  if (run.usage) return run.usage;
  const perStep = run.steps.flatMap((s) => (s.usage ? [s.usage] : []));
  if (perStep.length === 0) return undefined;
  return perStep.reduce((acc, u) => addUsage(acc, u), EMPTY_USAGE);
}

/** One line for an action, e.g. `select "M" in combobox:Size`. */
function describeAction(action: AgentAction | undefined): string {
  if (!action) return '(no action)';
  switch (action.type) {
    case 'navigate':
      return `navigate to ${action.url}`;
    case 'click':
      return `click ${action.target}`;
    case 'type':
      return `type "${action.text}" into ${action.target}`;
    case 'select':
      return `select "${action.value}" in ${action.target}`;
    case 'scroll':
      return `scroll ${action.direction}`;
    case 'extract':
      return `extract ${action.what}`;
    case 'done':
      return `done: ${action.summary}`;
    case 'fail':
      return `fail: ${action.reason}`;
  }
}

function actionReason(action: AgentAction | undefined): string | undefined {
  if (!action || action.type === 'done' || action.type === 'fail') return undefined;
  return action.reason;
}

function attemptedText(step: RunStep): string {
  const summary = describeAction(step.action);
  const reason = actionReason(step.action);
  return reason ? `${summary}; reason: ${reason}` : summary;
}

/** The evidence an id points at, but only when it is of an expected kind. */
function evidenceOfKind(
  id: string | undefined,
  kinds: EvidenceKind[],
  byId: Map<string, Evidence>,
): Evidence | undefined {
  const evidence = id ? byId.get(id) : undefined;
  return evidence && kinds.includes(evidence.kind) ? evidence : undefined;
}

function screenshotEvidenceFor(step: RunStep, byId: Map<string, Evidence>): Evidence | undefined {
  return evidenceOfKind(step.screenshotEvidenceId, ['screenshot'], byId);
}

/**
 * The accessibility snapshot captured at a step: only `dom_snapshot` evidence, so a trace or an
 * image linked by mistake is never read as text. Prefers the explicit link; tolerates a snapshot
 * that was recorded at the step index without being linked (or linked under the screenshot field,
 * as the demo fixture does).
 */
function snapshotEvidenceFor(
  step: RunStep,
  run: Run,
  byId: Map<string, Evidence>,
): Evidence | undefined {
  return (
    evidenceOfKind(step.snapshotEvidenceId, ['dom_snapshot'], byId) ??
    evidenceOfKind(step.screenshotEvidenceId, ['dom_snapshot'], byId) ??
    run.evidence.find((e) => e.kind === 'dom_snapshot' && e.stepIndex === step.index)
  );
}

interface FailureStep {
  step: RunStep;
  outcome: string;
  rule: 'action_failed' | 'verifier_failed' | 'run_error';
}

function describeOutcome(outcome: RunStep['outcome']): string {
  switch (outcome) {
    case 'rejected_by_policy':
      return 'rejected by policy';
    case 'invalid_action':
      return 'invalid action';
    case 'error':
      return 'action error (no detail recorded)';
    case 'ok':
      return 'ok';
  }
}

/**
 * Where the run diverged from the mission.
 *   rule 0: a run that passed every checkpoint did not diverge. An action that failed to execute
 *           and was recovered from is listed in the step log, not reported as a divergence.
 *   rule 1: the first step whose action did not execute (error, policy rejection, invalid action)
 *   rule 2: otherwise, when the verifier failed a checkpoint, the last mutating step (click/type/
 *           select) before the agent claimed `done`: the moment the wrong state was committed
 *   rule 3: otherwise, for a run that ended in a runner error, the step it stopped at, carrying
 *           run.errorMessage (which has no field of its own in the report schema)
 *   rule 4: otherwise none
 */
function findFailureStep(run: Run): FailureStep | undefined {
  if (run.status === 'passed') return undefined;

  const errorMessage = run.errorMessage?.trim();
  const runError =
    run.status === 'error'
      ? `run ended with a runner error: ${errorMessage || '(no message recorded)'}`
      : undefined;
  const withRunError = (outcome: string) => {
    if (!runError) return outcome;
    return errorMessage && outcome.includes(errorMessage) ? outcome : `${outcome}; ${runError}`;
  };

  const errored = run.steps.find((s) => s.outcome !== 'ok');
  if (errored) {
    return {
      step: errored,
      outcome: withRunError(errored.outcomeDetail ?? describeOutcome(errored.outcome)),
      rule: 'action_failed',
    };
  }

  const first = run.verification?.firstFailure;
  if (first) {
    const doneIndex = run.steps.findIndex((s) => s.action?.type === 'done');
    const before = doneIndex === -1 ? run.steps : run.steps.slice(0, doneIndex);
    const reversed = [...before].reverse();
    const step =
      reversed.find((s) => s.action !== undefined && isMutatingAction(s.action)) ??
      reversed.find((s) => s.action !== undefined && s.action.type !== 'fail') ??
      run.steps[run.steps.length - 1];
    if (step) {
      return {
        step,
        outcome: withRunError(first.detail ?? `${CHECKPOINT_LABELS[first.id]} failed`),
        rule: 'verifier_failed',
      };
    }
  }

  if (runError) {
    const last = run.steps[run.steps.length - 1];
    return {
      step: last ?? { index: 0, at: run.finishedAt ?? run.startedAt ?? run.createdAt, outcome: 'ok' },
      outcome: runError,
      rule: 'run_error',
    };
  }
  return undefined;
}

function isScreenshotOnly(profile: AgentProfileSummary): boolean {
  if (profile.kind === 'beta_vision') return true;
  const textual = /accessib|aria|tree|text|dom|html|catalog|api/i;
  const visual = /screenshot|pixel|image|vision/i;
  return (
    !profile.perceives.some((p) => textual.test(p)) && profile.perceives.some((p) => visual.test(p))
  );
}

function excerpt(text: string): string {
  if (text.length <= PERCEIVED_MAX_CHARS) return text;
  return text.slice(0, PERCEIVED_MAX_CHARS - TRUNCATION_MARK.length) + TRUNCATION_MARK;
}

function inlineExcerpt(evidence: Evidence): string {
  const data = evidence.data;
  const label = evidence.label ? `${evidence.label}:\n` : '';
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const record = data as Record<string, unknown>;
    if (typeof record.excerpt === 'string') return excerpt(label + record.excerpt);
    if (typeof record.aria === 'string') return excerpt(label + record.aria);
    if (typeof record.text === 'string') return excerpt(label + record.text);
  }
  if (typeof data === 'string') return excerpt(label + data);
  try {
    return excerpt(label + JSON.stringify(data, null, 2));
  } catch {
    return excerpt(label + String(data));
  }
}

/** What the agent could perceive at the failure step. Never throws; a missing file becomes a note. */
function perceivedAt(
  step: RunStep,
  run: Run,
  profile: AgentProfileSummary,
  byId: Map<string, Evidence>,
  artifactsRoot: string,
  screenshotPath: string | undefined,
): { perceived: string; snapshotPath?: string } {
  const snapshot = snapshotEvidenceFor(step, run, byId);
  const snapshotPath = artifactPath(snapshot?.path);
  let note: string | undefined;
  if (snapshotPath) {
    try {
      const text = readFileSync(path.join(artifactsRoot, snapshotPath), 'utf8');
      return { perceived: excerpt(text), snapshotPath };
    } catch {
      note = `snapshot file not readable: ${snapshotPath}`;
    }
  }
  if (snapshot && snapshot.data !== undefined) {
    return { perceived: inlineExcerpt(snapshot), snapshotPath };
  }
  if (isScreenshotOnly(profile)) {
    const where = screenshotPath ? `: ${screenshotPath}` : '; none captured at this step';
    return { perceived: `screenshot only (see screenshotPath${where})`, snapshotPath };
  }
  const parts = [note ?? 'no accessibility snapshot captured at this step'];
  if (screenshotPath) parts.push(`screenshot at ${screenshotPath}`);
  return { perceived: parts.join('; '), snapshotPath };
}

function toFailurePoint(
  failure: FailureStep,
  run: Run,
  profile: AgentProfileSummary,
  byId: Map<string, Evidence>,
  artifactsRoot: string,
): FailurePoint {
  const { step } = failure;
  const screenshotPath = artifactPath(screenshotEvidenceFor(step, byId)?.path);
  const { perceived, snapshotPath } = perceivedAt(
    step,
    run,
    profile,
    byId,
    artifactsRoot,
    screenshotPath,
  );
  const attempted =
    failure.rule === 'run_error' && run.steps.length === 0
      ? '(no steps recorded)'
      : attemptedText(step);
  return {
    stepIndex: step.index,
    url: step.url,
    attempted,
    outcome: failure.outcome,
    perceived,
    screenshotPath,
    snapshotPath,
  };
}

/**
 * Files under `<artifactsRoot>/<runId>` as artifact-relative posix paths, e.g. "run_x/trace.zip".
 * Files named like a report (`report.json` / `report.md` by default) are skipped so a regenerated
 * report never lists a stale copy of itself.
 */
export function listRunArtifacts(
  artifactsRoot: string,
  runId: string,
  options: { exclude?: string[] } = {},
): string[] {
  const exclude = new Set(options.exclude ?? REPORT_FILE_NAMES);
  const dir = path.join(artifactsRoot, runId);
  try {
    if (!statSync(dir).isDirectory()) return [];
  } catch {
    return [];
  }
  const out: string[] = [];
  const walk = (abs: string, rel: string) => {
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(abs, entry.name), relPath);
      else if (entry.isFile() && !exclude.has(entry.name)) out.push(`${runId}/${relPath}`);
    }
  };
  walk(dir, '');
  return out.sort();
}

// ---------------------------------------------------------------------------------------------
// Markdown helpers
// ---------------------------------------------------------------------------------------------

/** Artifact paths are posix in the JSON and in links, whatever the runner recorded. */
function posixPath(p: string): string {
  return p.replace(/\\/g, '/');
}

function artifactPath(p: string | undefined): string | undefined {
  return p === undefined ? undefined : posixPath(p);
}

function hostOf(storeUrl: string): string {
  try {
    return new URL(storeUrl).host || storeUrl;
  } catch {
    return storeUrl;
  }
}

/** Whitespace collapsed to single spaces (Playwright errors are multi-line), optionally capped. */
function oneLine(text: string, max?: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return max === undefined ? flat : truncate(flat, max);
}

/** A table cell: single line, pipes escaped so the cell cannot break the table. */
function cell(value: unknown): string {
  const text = value === undefined || value === null ? '' : String(value);
  return oneLine(text).replace(/\|/g, '\\|');
}

function table(headers: string[], rows: string[][]): string {
  const line = (cells: string[]) => `| ${cells.join(' | ')} |`;
  return [line(headers), line(headers.map(() => '---')), ...rows.map(line)].join('\n');
}

/** Fenced block whose fence is longer than any backtick run inside, so content cannot close it. */
function fence(text: string, lang = ''): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const f = '`'.repeat(longest + 1);
  return `${f}${lang}\n${text}\n${f}`;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 3))}...`;
}

function isAbsoluteOrUrl(p: string): boolean {
  return /^(\/|[a-zA-Z]:\/|[a-z][a-z0-9+.-]*:\/\/)/.test(p);
}

/** Href for an artifacts-relative `target` from a file inside `linkBase` (an artifacts-relative dir). */
function hrefFrom(linkBase: string, target: string): string {
  const base = posixPath(linkBase)
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.')
    .join('/');
  if (!base || isAbsoluteOrUrl(target)) return target;
  return path.posix.relative(`/${base}`, `/${target}`) || '.';
}

/** Link text is the artifacts-relative path (as in the JSON); the href resolves from `linkBase`. */
function link(relPath: string, linkBase: string): string {
  const target = posixPath(relPath);
  const href = hrefFrom(linkBase, target).replace(
    /[ ()]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `[${target}](${href})`;
}

function fmtUsd(n: number): string {
  if (n >= 1) return `$${n.toFixed(2)}`;
  let s = n.toFixed(4);
  while (s.length > 4 && s.endsWith('0')) s = s.slice(0, -1);
  return `$${s}`;
}

function fmtDuration(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function fmtInt(n: number): string {
  return n.toLocaleString('en-US');
}

function fmtCost(usage: LlmUsage | undefined): string {
  if (!usage) return 'not available (no usage recorded)';
  if (usage.estimatedCostUsd !== undefined) return `${fmtUsd(usage.estimatedCostUsd)} (${COST_NOTE})`;
  if (usage.calls === 0) return '$0.00 (no model calls recorded)';
  return 'not available (no price for this model)';
}

function checkpointRank(id: CheckpointId): number {
  return CHECKPOINT_ORDER.indexOf(id);
}

function sortedCheckpoints(checkpoints: Checkpoint[]): Checkpoint[] {
  return [...checkpoints].sort((a, b) => checkpointRank(a.id) - checkpointRank(b.id));
}

function statusLine(status: Run['status']): string {
  switch (status) {
    case 'passed':
    case 'failed':
      return `${status} (verifier verdict)`;
    case 'error':
      return 'error (runner or infrastructure error, not a verdict)';
    default:
      return status;
  }
}

/** Section builder: each call is one paragraph-level block followed by exactly one blank line. */
function markdownDocument(): { push: (...lines: string[]) => void; render: () => string } {
  const out: string[] = [];
  return {
    push: (...lines) => {
      if (lines.length) out.push(...lines, '');
    },
    render: () => out.join('\n').trimEnd() + '\n',
  };
}

// ---------------------------------------------------------------------------------------------
// Agent report Markdown
// ---------------------------------------------------------------------------------------------

export function renderAgentReportMarkdown(
  report: AgentReport,
  options: ReportMarkdownOptions = {},
): string {
  const { agent, mission, usage } = report;
  const linkBase = options.linkBase ?? report.runId;
  const href = (p: string) => link(p, linkBase);
  const { push, render } = markdownDocument();

  push(`# ${agent.name} report: ${mission.requirements.product} on ${hostOf(report.storeUrl)}`);

  const modelBits = [agent.model, agent.provider];
  if (agent.effort) modelBits.push(`effort ${agent.effort}`);
  const claim = report.claim
    ? oneLine(`${report.claim.outcome}: ${report.claim.summary}`)
    : 'none recorded';
  push(
    `- **Status:** ${statusLine(report.status)}`,
    `- **Agent:** ${agent.name} (${agent.kind}), ${agent.strategy}`,
    `- **Model:** ${modelBits.join(', ')}`,
    `- **Steps used:** ${report.steps.length} of ${mission.maxSteps}`,
    `- **Duration:** ${fmtDuration(report.durationMs)}`,
    `- **LLM calls:** ${usage.calls}`,
    `- **Tokens in/out:** ${fmtInt(usage.inputTokens)} / ${fmtInt(usage.outputTokens)} (cached ${fmtInt(usage.cachedInputTokens)}, reasoning ${fmtInt(usage.reasoningTokens)})`,
    `- **Image inputs:** ${usage.imageInputs}`,
    `- **Estimated cost:** ${fmtCost(usage)}`,
    `- **Agent claim:** ${claim}`,
    `- **Run:** ${report.runId} (mission ${report.missionId}, generated ${report.generatedAt})`,
  );

  push('## What this agent can perceive');
  push(
    ...(agent.perceives.length ? agent.perceives.map((p) => `- ${p}`) : ['- (nothing recorded)']),
    agent.targetGrammars.length
      ? `- Targets controls by: ${agent.targetGrammars.map((g) => `\`${g}\``).join(', ')}`
      : '- Targets controls by: none (no browser; structured data only)',
  );

  push('## Mission');
  push(
    `- **Store:** ${report.storeUrl}`,
    `- **Success milestone:** ${mission.successMilestone}`,
    `- **Allowed actions:** ${mission.allowedActions.join(', ')} (max ${mission.maxSteps} steps, payment never authorized)`,
    `- **Request:** ${oneLine(mission.rawPrompt)}`,
  );
  push(fence(JSON.stringify(mission.requirements, null, 2), 'json'));

  push('## Result');
  if (report.checkpoints.length === 0) {
    push(`No verification result (run status: ${report.status}).`);
  } else {
    if (report.firstFailure) {
      push(
        `First failure: **${CHECKPOINT_LABELS[report.firstFailure.id]}**${report.firstFailure.detail ? `: ${oneLine(report.firstFailure.detail)}` : ''}`,
      );
    }
    const rows = sortedCheckpoints(report.checkpoints).map((cp) => {
      const isFirst = report.firstFailure?.id === cp.id;
      const label = cell(CHECKPOINT_LABELS[cp.id]);
      const status = cell(cp.status);
      return [
        isFirst ? `**${label}**` : label,
        isFirst ? `**${status}**` : status,
        cell(cp.detail ?? ''),
      ];
    });
    push(table(['Checkpoint', 'Status', 'Detail'], rows));
  }

  if (report.observedCart) {
    const cart = report.observedCart;
    push('## Observed cart');
    push(
      table(
        ['Product', 'Variant', 'Attributes', 'Unit price', 'Qty'],
        cart.items.map((item) => [
          cell(item.name),
          cell(item.variantId ?? '-'),
          cell(
            Object.entries(item.attributes)
              .map(([k, v]) => `${k}=${v}`)
              .join(', ') || '-',
          ),
          cell(item.unitPrice.toFixed(2)),
          cell(item.quantity),
        ]),
      ),
    );
    push(`Subtotal: ${cart.subtotal.toFixed(2)} ${cart.currency} (observed via ${cart.source})`);
  }

  push('## Where it diverged');
  const fp = report.failurePoint;
  if (fp) {
    if (report.status === 'error') {
      push(
        'The run ended with a runner or infrastructure error. This is where it stopped; it is not a verdict on the store.',
      );
    }
    const total = report.steps.length;
    const position = total
      ? `index ${fp.stepIndex} (step ${fp.stepIndex + 1} of ${total})`
      : `index ${fp.stepIndex} (no steps recorded)`;
    const lines = [
      `- **Step:** ${position}`,
      `- **URL:** ${fp.url ?? 'unknown'}`,
      `- **Attempted:** ${oneLine(fp.attempted)}`,
      `- **Outcome:** ${oneLine(fp.outcome)}`,
    ];
    if (report.firstFailure) {
      lines.push(`- **First failed checkpoint:** ${CHECKPOINT_LABELS[report.firstFailure.id]}`);
    }
    push(...lines);
    push('### What the agent perceived at that step');
    push(fence(fp.perceived, 'text'));
    const links: string[] = [];
    if (fp.screenshotPath) links.push(`- Screenshot: ${href(fp.screenshotPath)}`);
    if (fp.snapshotPath) links.push(`- Snapshot: ${href(fp.snapshotPath)}`);
    push(...links);
  } else if (report.status === 'passed') {
    const recovered = report.steps.filter((s) => s.outcome !== 'ok');
    if (recovered.length === 0) {
      push('No divergence: every action executed and the verifier found no failed checkpoint.');
    } else {
      const n = recovered.length;
      push(
        `No divergence: the verifier found no failed checkpoint. ${n} ${n === 1 ? 'action' : 'actions'} did not execute and the agent recovered, so ${n === 1 ? 'it is' : 'they are'} not counted as a divergence:`,
      );
      push(
        ...recovered.map(
          (s) =>
            `- Step ${s.index}: ${oneLine(describeAction(s.action), STEP_ACTION_MAX_CHARS)} -> ${s.outcome}${s.outcomeDetail ? `: ${oneLine(s.outcomeDetail, RECOVERED_DETAIL_MAX_CHARS)}` : ''}`,
        ),
      );
    }
  } else if (report.status === 'failed') {
    push(
      'The verifier found a failed checkpoint, but no step could be identified as the divergence (no recorded steps).',
    );
  } else {
    push(`Not available for a run with status ${report.status}.`);
  }

  push('## Step log');
  if (report.steps.length === 0) {
    push('No steps recorded.');
  } else {
    push(
      table(
        ['#', 'Action', 'Outcome', 'Detail', 'Screenshot'],
        report.steps.map((step) => [
          cell(step.index),
          cell(truncate(describeAction(step.action), STEP_ACTION_MAX_CHARS)),
          cell(step.outcome),
          cell(truncate(oneLine(step.outcomeDetail ?? ''), STEP_DETAIL_MAX_CHARS)),
          step.screenshotPath ? cell(href(step.screenshotPath)) : '-',
        ]),
      ),
    );
  }

  push('## Agent narrative');
  push(
    "_This is the agent's own account of the run, written by the model from its step log after the run finished. It is not a verdict: the Result table above is the verifier's verdict._",
  );
  push(report.narrative.trim() || '(no narrative)');

  push('## Artifacts');
  push(...(report.artifacts.length ? report.artifacts.map((a) => `- ${href(a)}`) : ['(none)']));

  return render();
}

// ---------------------------------------------------------------------------------------------
// Mission report
// ---------------------------------------------------------------------------------------------

export interface BuildMissionReportInput {
  mission: Mission;
  runs: Run[];
  /** Per-run reports already built, used for model names and report links. */
  agentReports?: AgentReport[];
}

type CostLine = MissionReport['costComparison'][number];

function modelFor(run: Run, agentReport: AgentReport | undefined): string {
  return (
    run.resolvedModel ??
    run.agent.model ??
    agentReport?.agent.model ??
    (run.agent.kind === 'gamma_structured' ? 'none (no LLM)' : 'unknown')
  );
}

export function buildMissionReport(input: BuildMissionReportInput): MissionReport {
  const { mission, agentReports = [] } = input;
  const byKind = latestRunsByKind(input.runs);
  const ordered = REPORT_AGENT_ORDER.flatMap((kind) => {
    const run = byKind[kind];
    return run ? [run] : [];
  });

  const runs: MissionReportRun[] = ordered.map((run) => {
    const agentReport = agentReports.find((r) => r.runId === run.id);
    // The runner's record wins; otherwise the writeReportFiles convention <run.id>/report.md.
    const reportPath = run.reportPath
      ? posixPath(run.reportPath)
      : agentReport
        ? `${run.id}/report.md`
        : undefined;
    return {
      runId: run.id,
      agentKind: run.agent.kind,
      agentName: AGENT_LABELS[run.agent.kind].name,
      model: modelFor(run, agentReport),
      status: run.status,
      claim: run.claim,
      firstFailure: run.verification?.firstFailure,
      usage: runUsage(run),
      durationMs: runDurationMs(run),
      stepsUsed: run.steps.length,
      reportPath,
    };
  });

  // The shared schema keys the matrix by the CheckpointId enum, which Zod v4 treats as
  // exhaustive, so every checkpoint gets a row; ones no agent tested are all "not_run".
  const matrix = {} as MissionReport['matrix'];
  for (const id of CHECKPOINT_ORDER) matrix[id] = patternFor(id, byKind);

  const attributions = attributeMission(input.runs);
  const costComparison = costComparisonFor(runs);

  return {
    id: newId('rep'),
    missionId: mission.id,
    generatedAt: nowIso(),
    mission,
    storeUrl: mission.storeUrl,
    runs,
    matrix,
    attributions,
    costComparison,
    headline: headlineFor(runs, costComparison),
    recommendations: recommendationsFrom(attributions),
  };
}

/**
 * relativeCost: 1.0 is the cheapest agent that spent anything on a model. A zero-cost line (Gamma,
 * which has no model) gets 0 and never serves as the base, so the ratio the thesis depends on
 * (Sigma vs Alpha) survives a free agent in the same mission.
 */
function costComparisonFor(runs: MissionReportRun[]): CostLine[] {
  const lines: CostLine[] = runs.flatMap((r) =>
    r.usage
      ? [
          {
            agentKind: r.agentKind,
            model: r.model,
            status: r.status,
            inputTokens: r.usage.inputTokens,
            outputTokens: r.usage.outputTokens,
            imageInputs: r.usage.imageInputs,
            estimatedCostUsd: r.usage.estimatedCostUsd,
          },
        ]
      : [],
  );
  const positive = lines.flatMap((l) =>
    l.estimatedCostUsd !== undefined && l.estimatedCostUsd > 0 ? [l.estimatedCostUsd] : [],
  );
  const base = positive.length ? Math.min(...positive) : undefined;
  for (const line of lines) {
    const cost = line.estimatedCostUsd;
    if (cost === undefined) continue;
    if (cost === 0) line.relativeCost = 0;
    else if (base !== undefined) line.relativeCost = Math.round((cost / base) * 100) / 100;
  }
  return lines;
}

/** The estimated model spend of an agent, when it spent anything; free agents are excluded. */
function positiveCostOf(cost: CostLine[], kind: AgentKind): number | undefined {
  const c = cost.find((line) => line.agentKind === kind)?.estimatedCostUsd;
  return c !== undefined && c > 0 ? c : undefined;
}

/** Deterministic headline: completion count, where each failed agent stopped, and the cost gap. */
function headlineFor(runs: MissionReportRun[], cost: CostLine[]): string {
  if (runs.length === 0) return 'No finished runs for this mission yet.';
  const passed = runs.filter((r) => r.status === 'passed');
  const failed = runs.filter((r) => r.status === 'failed');
  const parts = [
    `${passed.length} of ${runs.length} ${runs.length === 1 ? 'agent' : 'agents'} completed the mission.`,
  ];
  for (const r of failed) {
    parts.push(
      r.firstFailure
        ? `${r.agentName} failed at "${CHECKPOINT_LABELS[r.firstFailure.id]}".`
        : `${r.agentName} failed.`,
    );
  }
  const withCost = (list: MissionReportRun[]) =>
    list
      .flatMap((r) => {
        const c = positiveCostOf(cost, r.agentKind);
        return c === undefined ? [] : [{ r, c }];
      })
      .sort((a, b) => a.c - b.c);
  const cheapestPass = withCost(passed)[0];
  if (cheapestPass) {
    const cheaperFailures = withCost(failed).filter((x) => x.c < cheapestPass.c);
    if (cheaperFailures.length) {
      const would = cheaperFailures
        .map((x, i) =>
          i === 0
            ? `${x.r.agentName} would have cost ~${fmtUsd(x.c)}`
            : `${x.r.agentName} ~${fmtUsd(x.c)}`,
        )
        .join(' and ');
      parts.push(
        `The cheapest agent that completed it was ${cheapestPass.r.agentName} at ${fmtUsd(cheapestPass.c)} (estimated); ${would}.`,
      );
    }
  }
  return parts.join(' ');
}

// ---------------------------------------------------------------------------------------------
// Mission report Markdown
// ---------------------------------------------------------------------------------------------

function matrixCell(status: PatternStatus): string {
  switch (status) {
    case 'passed':
      return 'pass';
    case 'failed':
      return 'FAIL';
    case 'not_run':
      return '-';
    default:
      return status;
  }
}

function attributionLine(a: Attribution): string {
  const failing = a.failingAgents.map((k) => AGENT_LABELS[k].name).join(', ');
  return `- **${FAILURE_CATEGORY_LABELS[a.category]}**: ${oneLine(a.reason)} (failing: ${failing || 'none'})`;
}

function thesisParagraph(report: MissionReport): string {
  const alphaName = AGENT_LABELS.alpha_semantic.name;
  const costOf = (kind: AgentKind) => positiveCostOf(report.costComparison, kind);
  const passed = report.runs.filter((r) => r.status === 'passed');
  const alpha = report.runs.find((r) => r.agentKind === 'alpha_semantic');
  const alphaCost = costOf('alpha_semantic');
  const ratioTo = (c: number) =>
    alphaCost === undefined ? '' : `, ${(c / alphaCost).toFixed(1)}x ${alphaName}'s spend`;
  // Stronger browser agents that completed the mission, cheapest first. Gamma is the data path,
  // has no model, and says nothing about whether a shopper's browser agent can navigate the store.
  const strongerPasses = passed
    .filter((r) => r.agentKind !== 'alpha_semantic' && BROWSER_AGENTS.includes(r.agentKind))
    .flatMap((r) => {
      const c = costOf(r.agentKind);
      return c === undefined ? [] : [{ r, c }];
    })
    .sort((a, b) => a.c - b.c);

  const sentences = [
    `Thesis: the store should be navigable by the cheapest agent, ${alphaName} (accessibility tree only, text model).`,
  ];
  sentences.push(
    passed.length
      ? `Completed the mission: ${passed.map((r) => r.agentName).join(', ')}.`
      : 'No agent completed the mission.',
  );
  if (!alpha) {
    sentences.push(`${alphaName} did not run on this mission, so the thesis was not tested.`);
  } else if (alpha.status === 'passed') {
    sentences.push(
      `${alphaName} completed it${alphaCost === undefined ? '' : ` at ${fmtUsd(alphaCost)} (estimated)`}, so this mission meets the bar: no stronger, costlier agent was needed.`,
    );
    if (strongerPasses.length) {
      const same = strongerPasses
        .map(({ r, c }, i) =>
          i === 0
            ? `${r.agentName} reached the same result at ${fmtUsd(c)} (estimated)${ratioTo(c)}`
            : `${r.agentName} at ${fmtUsd(c)}${ratioTo(c)}`,
        )
        .join('; ');
      sentences.push(`${same}.`);
    }
  } else {
    sentences.push(
      `${alphaName} did not complete it, so a shopper using a text-only agent cannot finish this mission on the store as it is.`,
    );
    const best = strongerPasses[0];
    if (best) {
      const ratio =
        alphaCost === undefined ? '' : `${ratioTo(best.c)} of ${fmtUsd(alphaCost)}`;
      sentences.push(
        `${best.r.agentName} could, at ${fmtUsd(best.c)} (estimated)${ratio}: that gap is the price of the store's defects.`,
      );
    } else if (passed.length) {
      sentences.push(
        'Cost comparison not available: no estimated cost was recorded for the browser agents that completed it.',
      );
    }
  }
  if (report.costComparison.length === 0) {
    sentences.push('No model usage was recorded for these runs, so costs are not shown.');
  }
  return sentences.join(' ');
}

export function renderMissionReportMarkdown(
  report: MissionReport,
  options: ReportMarkdownOptions = {},
): string {
  const linkBase = options.linkBase ?? '';
  const href = (p: string) => link(p, linkBase);
  const { push, render } = markdownDocument();

  push(`# Mission report: ${report.mission.requirements.product} on ${hostOf(report.storeUrl)}`);
  push(report.headline);
  push(
    `- **Store:** ${report.storeUrl}`,
    `- **Mission:** ${report.missionId} (milestone ${report.mission.successMilestone}, generated ${report.generatedAt})`,
    `- **Requirements:** ${JSON.stringify(report.mission.requirements)}`,
  );

  push('## Agents');
  if (report.runs.length === 0) {
    push('No finished runs.');
  } else {
    const costByKind = new Map(report.costComparison.map((c) => [c.agentKind, c] as const));
    push(
      table(
        [
          'Agent',
          'Model',
          'Status',
          'Steps',
          'Tokens in/out',
          'Images',
          'Est. cost (USD, estimated)',
          'Relative',
        ],
        report.runs.map((r) => {
          const c = costByKind.get(r.agentKind);
          const status =
            r.status === 'failed' && r.firstFailure
              ? `failed at "${CHECKPOINT_LABELS[r.firstFailure.id]}"`
              : r.status;
          return [
            cell(r.agentName),
            cell(r.model),
            cell(status),
            cell(r.stepsUsed),
            r.usage
              ? cell(`${fmtInt(r.usage.inputTokens)} / ${fmtInt(r.usage.outputTokens)}`)
              : '-',
            r.usage ? cell(r.usage.imageInputs) : '-',
            c?.estimatedCostUsd === undefined ? '-' : cell(fmtUsd(c.estimatedCostUsd)),
            c?.relativeCost === undefined ? '-' : cell(`${c.relativeCost.toFixed(1)}x`),
          ];
        }),
      ),
    );
    push(
      'Relative: 1.0x is the cheapest agent that used a model; 0.0x means no model calls (no LLM cost).',
    );
  }

  push('## Checkpoint matrix');
  const agentsRan = REPORT_AGENT_ORDER.filter((k) => report.runs.some((r) => r.agentKind === k));
  const matrixRows = CHECKPOINT_ORDER.filter((id) => {
    const row = report.matrix[id];
    return row !== undefined && agentsRan.some((k) => row[k] !== 'not_run');
  });
  if (agentsRan.length === 0 || matrixRows.length === 0) {
    push('No checkpoints were verified.');
  } else {
    push(
      table(
        ['Checkpoint', ...agentsRan.map((k) => AGENT_LABELS[k].name)],
        matrixRows.map((id) => [
          cell(CHECKPOINT_LABELS[id]),
          ...agentsRan.map((k) => matrixCell(report.matrix[id][k])),
        ]),
      ),
    );
    push('pass = checkpoint passed, FAIL = checkpoint failed, - = this agent did not test it.');
  }

  push('## Attribution');
  if (report.attributions.length) {
    push(...report.attributions.map(attributionLine));
  } else if (report.runs.length < 2) {
    push(
      'Attribution needs at least two agents with a verdict; only one finished run is available.',
    );
  } else if (matrixRows.some((id) => agentsRan.some((k) => report.matrix[id][k] === 'failed'))) {
    push(
      'No attribution possible: fewer than two agents produced a verdict on the failed checkpoints.',
    );
  } else {
    push('Every checkpoint passed for every agent that ran; nothing to attribute.');
  }

  push('## What the store must change');
  push(
    ...(report.recommendations.length
      ? report.recommendations.map((r, i) => `${i + 1}. ${r}`)
      : ['No changes required by the evidence.']),
  );

  push('## Cost and the thesis');
  push(thesisParagraph(report));

  push('## Per-agent reports');
  const links = report.runs.flatMap((r) =>
    r.reportPath ? [`- ${r.agentName}: ${href(r.reportPath)}`] : [],
  );
  push(...(links.length ? links : ['(no per-agent report paths recorded)']));

  return render();
}

// ---------------------------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------------------------

/** Writes `<dir>/<baseName>.json` and `<dir>/<baseName>.md` (creating `dir`), returns absolute paths. */
export async function writeReportFiles(
  dir: string,
  json: object,
  markdown: string,
  baseName = 'report',
): Promise<{ jsonPath: string; mdPath: string }> {
  const abs = path.resolve(dir);
  await mkdir(abs, { recursive: true });
  const jsonPath = path.join(abs, `${baseName}.json`);
  const mdPath = path.join(abs, `${baseName}.md`);
  await Promise.all([
    writeFile(jsonPath, `${JSON.stringify(json, null, 2)}\n`, 'utf8'),
    writeFile(mdPath, markdown.endsWith('\n') ? markdown : `${markdown}\n`, 'utf8'),
  ]);
  return { jsonPath, mdPath };
}
