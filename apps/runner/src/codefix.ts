import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import {
  AGENT_LABELS,
  CodeFixOptions,
  EMPTY_USAGE,
  addUsage,
  newId,
  nowIso,
  type Checkpoint,
  type CodeFix,
  type CodeFixAttempt,
  type CodeFixCheck,
  type CodeFixProposal,
  type CodeFixRequest,
  type CodeFixStage,
  type Mission,
  type RepositoryConnection,
  type Run,
  type RunStatus,
  type ValidationReport,
} from '@agentproof/shared';
import {
  DEFAULT_SELECTION_BUDGET,
  GitHubClient,
  agentproofBranchName,
  applyEdits,
  buildEvidenceBundle,
  checkContentPolicy,
  clampPullRequestBody,
  combinedDiff,
  compareUrl,
  deriveSearchTerms,
  diffStats,
  gitApply,
  gitApplyCheck,
  installDependencies,
  isSourceCandidate,
  newUntrustedNonce,
  parseRepoFullName,
  proposeFix,
  pullRequestTitle,
  rankFiles,
  renderCodeFixMarkdown,
  renderEvidenceBundle,
  reviewFix,
  runScopeChecks,
  sanitizeEvidenceText,
  scanUntrustedText,
  scopePolicyFor,
  scrubbedEnv,
  selectForModel,
  typecheck,
  type ModelSourceSelection,
  type SourceFile,
} from '@agentproof/codefix';
import { compareRuns } from '@agentproof/verifier';
import { config } from './config';
import * as db from './db';
import { publishCodeFix, subscribe } from './events';
import { resolveGitHubCredential, githubAppState } from './github-app';
import { enqueue } from './jobs';
import { agentSummaryFor, readMissionReport, readRunReport } from './reports';
import { commitAndPush, createWorktree, readSnapshotFile, removeWorktree } from './repositories';

/**
 * The code-fix agent's orchestrator (docs/CODEFIX.md).
 *
 *   collect -> localize -> propose -> validate -> review -> rematch (opt-in) -> deliver
 *
 * Every stage writes into one CodeFix document (saved after each change, so GET /codefix/:id
 * always shows the current state) and publishes a CodeFixEvent for the SSE stream. Code writes
 * every status and every check; the model's text lives only in attempts[].proposal and review.
 * The request token never enters the document: it stays in this module's memory for the
 * duration of the fix and reaches git and GitHub only for the push and the pull request.
 */

const MAX_CANDIDATE_FILES = 60;
const MAX_FILE_CHARS = 200_000;
const STORE_BOOT_TIMEOUT_MS = 45_000;
const REMATCH_TIMEOUT_MS = 10 * 60_000;
const TERMINAL: ReadonlySet<RunStatus> = new Set(['passed', 'failed', 'error', 'cancelled']);

export class CodeFixError extends Error {
  constructor(
    message: string,
    public readonly statusCode = 400,
  ) {
    super(message);
    this.name = 'CodeFixError';
  }
}

/** Runs with a fix in progress; one fix at a time per run. */
const inProgress = new Set<string>();

export function firstFailedCheckpoint(run: Run): Checkpoint | undefined {
  const first = run.verification?.firstFailure;
  if (first && first.status === 'failed') return first;
  return run.verification?.checkpoints.find((c) => c.status === 'failed');
}

function normalizeStoreRoot(raw: string | undefined): string {
  const trimmed = (raw ?? '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '');
  if (trimmed.split('/').some((segment) => segment === '..' || segment === '.')) {
    throw new CodeFixError('storeRoot must be a relative path inside the repository.');
  }
  return trimmed;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function firstLine(text: string, max = 160): string {
  const line = text.split('\n')[0] ?? '';
  return line.length <= max ? line : `${line.slice(0, max - 3)}...`;
}

/**
 * Validate the request against the run, create the document and start the pipeline in the
 * background. Returns the document in its `running` state.
 */
export function startCodeFix(run: Run, request: CodeFixRequest): CodeFix {
  if (run.status !== 'failed' || !firstFailedCheckpoint(run)) {
    throw new CodeFixError('The run has no failed checkpoint to fix.', 409);
  }
  const repository = db.getRepository(run.id);
  if (!repository) {
    throw new CodeFixError('Connect a repository to this run before asking for a fix.', 409);
  }
  if (inProgress.has(run.id)) {
    throw new CodeFixError('A fix is already running for this run.', 409);
  }
  if (request.mode !== 'diff' && !request.token && !githubAppState().config) {
    throw new CodeFixError(
      `Mode "${request.mode}" needs the GitHub App (register it at /github/app/setup) or a fine-grained token with Contents write access${
        request.mode === 'pull_request' ? ' and Pull requests write access' : ''
      }.`,
    );
  }
  const options = CodeFixOptions.parse({
    typecheck: request.typecheck,
    review: request.review,
    rematch: request.rematch,
    maxAttempts: request.maxAttempts,
    storeRoot: normalizeStoreRoot(request.storeRoot),
  });
  const fix: CodeFix = {
    id: newId('fix'),
    runId: run.id,
    missionId: run.missionId,
    repositoryId: repository.id,
    createdAt: nowIso(),
    status: 'running',
    stage: 'collect',
    mode: request.mode,
    options,
    localization: [],
    attempts: [],
    delivery: { mode: request.mode, status: request.mode === 'diff' ? 'not_requested' : 'pending' },
    usage: EMPTY_USAGE,
    timeline: [],
    artifacts: [],
  };
  db.saveCodeFix(fix);
  inProgress.add(run.id);
  void runCodeFix(fix.id, { token: request.token })
    .catch((err) => console.error(`[codefix] ${fix.id} crashed`, err))
    .finally(() => inProgress.delete(run.id));
  return fix;
}

interface Secrets {
  token?: string;
}

/** Everything the pipeline mutates, in one place, so the stage helpers stay small. */
class FixState {
  fix: CodeFix;
  constructor(fix: CodeFix) {
    this.fix = fix;
  }
  save(): void {
    db.saveCodeFix(this.fix);
  }
  patch(update: Partial<CodeFix>): void {
    this.fix = { ...this.fix, ...update };
    this.save();
  }
  stage(stage: CodeFixStage): void {
    this.patch({ stage });
    publishCodeFix({
      type: 'stage',
      codefixId: this.fix.id,
      stage,
      status: this.fix.status,
      at: nowIso(),
    });
  }
  log(message: string): void {
    const at = nowIso();
    this.patch({ timeline: [...this.fix.timeline, { at, stage: this.fix.stage, message }] });
    publishCodeFix({ type: 'log', codefixId: this.fix.id, message, at });
  }
  addUsage(usage: CodeFix['usage']): void {
    this.patch({ usage: addUsage(this.fix.usage, usage) });
  }
  updateAttempt(index: number, update: Partial<CodeFixAttempt>): void {
    const attempts = this.fix.attempts.map((a, i) => (i === index ? { ...a, ...update } : a));
    this.patch({ attempts });
  }
  finalDiff(): { attempt: CodeFixAttempt; diff: string; proposal: CodeFixProposal } | undefined {
    const index = this.fix.finalAttempt;
    if (index === undefined) return undefined;
    const attempt = this.fix.attempts[index];
    if (!attempt?.diff || !attempt.proposal) return undefined;
    return { attempt, diff: attempt.diff, proposal: attempt.proposal };
  }
}

function artifactsDir(fixId: string): { abs: string; rel: string } {
  const rel = path.posix.join('codefix', fixId);
  return { abs: path.join(config.artifactsDir, 'codefix', fixId), rel };
}

/** codefix.json, codefix.md and patch.diff under data/artifacts/codefix/<id>/. Never throws. */
function writeArtifacts(state: FixState): void {
  try {
    const { abs, rel } = artifactsDir(state.fix.id);
    fs.mkdirSync(abs, { recursive: true });
    const artifacts = [`${rel}/codefix.json`, `${rel}/codefix.md`];
    const final = state.finalDiff();
    if (final) artifacts.push(`${rel}/patch.diff`);
    state.patch({ artifacts });
    fs.writeFileSync(path.join(abs, 'codefix.json'), JSON.stringify(state.fix, null, 2));
    fs.writeFileSync(path.join(abs, 'codefix.md'), renderCodeFixMarkdown(state.fix));
    if (final) fs.writeFileSync(path.join(abs, 'patch.diff'), final.diff);
  } catch (err) {
    console.error(`[codefix] ${state.fix.id}: could not write artifacts`, err);
  }
}

function finish(state: FixState, status: 'succeeded' | 'failed', error?: string): void {
  // A branch or pull-request fix that dies before deliver would otherwise leave its delivery
  // pending for good, and the dashboard with a spinner.
  const { delivery } = state.fix;
  const undelivered =
    status === 'failed' && delivery.status === 'pending'
      ? {
          delivery: {
            ...delivery,
            status: 'failed' as const,
            error: error ?? 'not delivered: the fix did not complete',
          },
        }
      : {};
  state.patch({
    status,
    stage: 'done',
    finishedAt: nowIso(),
    ...(error ? { error } : {}),
    ...undelivered,
  });
  writeArtifacts(state);
  // Clear before the done event, so a client that reacts to `done` can start the next fix.
  inProgress.delete(state.fix.runId);
  publishCodeFix({ type: 'done', codefixId: state.fix.id, status, at: nowIso() });
}

// ---- stages ------------------------------------------------------------------------------------

interface Collected {
  run: Run;
  mission: Mission;
  repository: RepositoryConnection;
  checkpoint: Checkpoint;
  evidenceText: string;
  bundle: ReturnType<typeof buildEvidenceBundle>;
  /** Per-fix nonce for the untrusted fences in every prompt of this fix */
  nonce: string;
}

function collect(state: FixState): Collected {
  const run = db.getRun(state.fix.runId);
  if (!run) throw new CodeFixError('run not found', 404);
  const mission = db.getMission(run.missionId);
  if (!mission) throw new CodeFixError('mission not found', 404);
  const repository = db.getRepository(run.id);
  if (!repository) throw new CodeFixError('The repository was disconnected.', 409);
  const checkpoint = firstFailedCheckpoint(run);
  if (!checkpoint) throw new CodeFixError('The run has no failed checkpoint to fix.', 409);

  const agentReport = readRunReport(run);
  const missionReport = readMissionReport(run.missionId);
  const bundle = buildEvidenceBundle({ mission, run, checkpoint, agentReport, missionReport });
  // Page-derived text: strip control and invisible characters, then scan for instruction-like
  // content. Flags are recorded, not acted on: the model still sees the text, fenced as data.
  const rawEvidence = renderEvidenceBundle(bundle);
  const evidenceScan = scanUntrustedText(rawEvidence);
  const evidenceText = sanitizeEvidenceText(rawEvidence);
  state.patch({
    input: {
      agentKind: run.agent.kind,
      checkpointId: checkpoint.id,
      observed: bundle.observed,
      requirements: mission.requirements,
      ...(bundle.attributionCategory ? { attributionCategory: bundle.attributionCategory } : {}),
      ...(bundle.attributionReason ? { attributionReason: bundle.attributionReason } : {}),
      evidenceText,
      evidenceChars: evidenceText.length,
      evidenceFlags: evidenceScan.flags,
      repositoryUrl: repository.url,
      commitSha: repository.commitSha,
      storeRoot: state.fix.options.storeRoot,
    },
  });
  state.log(
    `evidence: ${checkpoint.id} on ${run.agent.kind}, ${evidenceText.length} chars` +
      (agentReport ? ', agent report' : ', no agent report') +
      (missionReport ? ', mission report' : ', no mission report') +
      (bundle.attributionCategory ? `, attribution ${bundle.attributionCategory}` : '') +
      (evidenceScan.flags.length ? `; flagged: ${evidenceScan.reasons.join('; ')}` : ''),
  );
  return { run, mission, repository, checkpoint, evidenceText, bundle, nonce: newUntrustedNonce() };
}

interface Localized {
  files: Map<string, string>;
  ranked: ReturnType<typeof rankFiles>;
  selection: ModelSourceSelection;
}

async function localize(state: FixState, c: Collected): Promise<Localized> {
  const storeRoot = state.fix.options.storeRoot;
  const candidates = c.repository.files.filter((p) => isSourceCandidate(p, storeRoot));
  const where = storeRoot ? `${storeRoot}/src` : 'src';
  if (candidates.length === 0) {
    throw new CodeFixError(
      `No source files under ${where} in the snapshot (${c.repository.fileCount} files listed${
        c.repository.truncated ? ', list truncated' : ''
      }). Check storeRoot.`,
      422,
    );
  }
  const files = new Map<string, string>();
  const sources: SourceFile[] = [];
  const flagsByPath = new Map<string, { flags: string[]; excludedReason?: string }>();
  let excluded = 0;
  for (const p of candidates.slice(0, MAX_CANDIDATE_FILES)) {
    const text = await readSnapshotFile(c.repository.id, p);
    if (text === undefined) continue;
    // Repository content is untrusted: binary, oversized, invisible-character or credential-
    // bearing files are never shown in full (so they can never be edited either); files that
    // merely read like instructions are shown, fenced as data, and flagged in the record.
    const scan = scanUntrustedText(text, { maxChars: MAX_FILE_CHARS });
    if (scan.excluded) {
      excluded += 1;
      flagsByPath.set(p, { flags: scan.flags, excludedReason: scan.reasons.join('; ') });
      sources.push({ path: p, text: '' });
      continue;
    }
    if (scan.flags.length) flagsByPath.set(p, { flags: scan.flags });
    files.set(p, text);
    sources.push({ path: p, text });
  }
  const terms = deriveSearchTerms(c.bundle);
  const ranked = rankFiles(sources, terms, {
    checkpointId: c.checkpoint.id,
    ...(c.bundle.attributionCategory ? { category: c.bundle.attributionCategory } : {}),
  }).map((entry) => {
    const extra = flagsByPath.get(entry.path);
    return extra
      ? {
          ...entry,
          flags: extra.flags,
          ...(extra.excludedReason ? { excludedReason: extra.excludedReason } : {}),
        }
      : entry;
  });
  const selection = annotateExcluded(
    selectForModel(ranked, files, DEFAULT_SELECTION_BUDGET),
    flagsByPath,
  );
  state.patch({ localization: selection.ranked });
  const shown = selection.included.map((f) => f.path);
  const flagged = [...flagsByPath.entries()]
    .filter(([, v]) => !v.excludedReason)
    .map(([p, v]) => `${p} (${v.flags.join(', ')})`);
  state.log(
    `localized ${sources.length} source files under ${where} with ${terms.length} terms; showing in full: ${shown.join(', ') || '(none)'}` +
      (excluded ? `; excluded ${excluded} file(s) from the model` : '') +
      (flagged.length ? `; flagged as data to watch: ${flagged.join('; ')}` : ''),
  );
  return { files, ranked: selection.ranked, selection };
}

/** Excluded files appear in the outline list with the reason instead of their exports. */
function annotateExcluded(
  selection: ModelSourceSelection,
  flagsByPath: Map<string, { flags: string[]; excludedReason?: string }>,
): ModelSourceSelection {
  return {
    ...selection,
    outlined: selection.outlined.map((entry) => {
      const reason = flagsByPath.get(entry.path)?.excludedReason;
      return reason ? { ...entry, outline: `(excluded by AgentProof: ${reason})` } : entry;
    }),
  };
}

/** Validation of one attempt's diff. Keeps the worktree only when every check passed. */
async function validateAttempt(
  state: FixState,
  c: Collected,
  diff: string,
  footprint: { files: string[]; added: number; removed: number },
): Promise<{ validation: ValidationReport; worktree?: string; patched: boolean }> {
  const policy = scopePolicyFor(state.fix.options.storeRoot);
  const checks: CodeFixCheck[] = runScopeChecks(footprint, policy);
  const failed = () => checks.some((check) => check.status === 'failed');
  if (failed()) return { validation: { checks, passed: false }, patched: false };
  // What the added lines contain: no network, dynamic code, secrets, obfuscation, new package
  // imports or CSS that hides controls from humans; no removed payment guards.
  checks.push(checkContentPolicy(diff));
  if (failed()) return { validation: { checks, passed: false }, patched: false };

  const worktree = await createWorktree(c.repository.id);
  let patched = false;
  try {
    checks.push(await gitApplyCheck(worktree, diff));
    if (state.fix.options.typecheck) {
      if (failed()) {
        checks.push({
          id: 'typecheck',
          status: 'skipped',
          detail: 'not run: the diff did not apply',
        });
      } else {
        await gitApply(worktree, diff);
        patched = true;
        checks.push(
          await typecheck(path.join(worktree, state.fix.options.storeRoot), { install: true }),
        );
      }
    }
  } catch (err) {
    checks.push({
      id: 'applies_cleanly',
      status: 'failed',
      detail: `validation aborted: ${firstLine(errorMessage(err), 300)}`,
    });
  }
  const validation = { checks, passed: !failed() };
  if (!validation.passed) {
    await removeWorktree(c.repository.id);
    return { validation, patched: false };
  }
  return { validation, worktree, patched };
}

interface ProposeOutcome {
  worktree?: string;
  patched: boolean;
  footprint?: { files: string[]; added: number; removed: number };
}

async function proposeAndValidate(
  state: FixState,
  c: Collected,
  l: Localized,
): Promise<ProposeOutcome> {
  const storeRoot = state.fix.options.storeRoot;
  let selection = l.selection;
  let feedback: string | undefined;
  let previous: CodeFixProposal | undefined;
  let maxAttempts = state.fix.options.maxAttempts;
  let extraRoundGranted = false;

  for (let i = 0; i < maxAttempts; i++) {
    state.stage('propose');
    const attempt: CodeFixAttempt = {
      index: i,
      model: '',
      startedAt: nowIso(),
      files: [],
      editErrors: [],
      usage: EMPTY_USAGE,
    };
    state.patch({ attempts: [...state.fix.attempts, attempt] });

    let proposal: CodeFixProposal;
    try {
      const result = await proposeFix({
        nonce: c.nonce,
        evidenceText: c.evidenceText,
        included: selection.included,
        outlined: selection.outlined,
        storeRoot,
        ...(feedback ? { feedback } : {}),
        ...(previous ? { previous } : {}),
      });
      state.addUsage(result.usage);
      state.updateAttempt(i, {
        model: result.model,
        proposal: result.value,
        usage: result.usage,
        promptSha256: result.promptSha256,
        promptChars: result.promptChars,
      });
      proposal = result.value;
    } catch (err) {
      const message = errorMessage(err);
      state.updateAttempt(i, { error: message, finishedAt: nowIso() });
      state.log(`attempt ${i + 1}: model call failed: ${firstLine(message)}`);
      continue;
    }
    previous = proposal;
    const d = proposal.diagnosis;
    state.log(
      `attempt ${i + 1}: "${d.title}" (${d.category}, ${d.confidence}), ${proposal.edits.length} edits`,
    );

    // The model may ask once for files it only saw as outlines.
    if (proposal.edits.length === 0 && d.needsFiles.length > 0) {
      const wanted = d.needsFiles.filter((p) => l.files.has(p));
      if (!extraRoundGranted && wanted.length > 0) {
        extraRoundGranted = true;
        maxAttempts += 1;
        selection = annotateExcluded(
          selectForModel(l.ranked, l.files, DEFAULT_SELECTION_BUDGET, [
            ...wanted,
            ...selection.included.map((f) => f.path),
          ]),
          new Map(
            l.ranked
              .filter((f) => f.excludedReason)
              .map((f) => [f.path, { flags: f.flags, excludedReason: f.excludedReason }]),
          ),
        );
        state.patch({ localization: selection.ranked });
        state.updateAttempt(i, { finishedAt: nowIso() });
        state.log(`attempt ${i + 1}: model asked for ${wanted.join(', ')}; now shown in full`);
        feedback = `You asked for ${wanted.join(', ')}. Those files are now shown in full above. Propose the edits.`;
        continue;
      }
      state.updateAttempt(i, {
        error: `asked for files that are not available: ${d.needsFiles.join(', ')}`,
        finishedAt: nowIso(),
      });
      feedback = `needsFiles must name paths from the outline list; not available: ${d.needsFiles.join(', ')}. Work with the files shown.`;
      continue;
    }
    if (proposal.edits.length === 0) {
      state.updateAttempt(i, {
        error: `no edits proposed: ${d.title} (${d.category})`,
        finishedAt: nowIso(),
      });
      state.log(`attempt ${i + 1}: the model proposed no change (${d.category}); stopping`);
      break;
    }

    const shown = new Map(selection.included.map((f) => [f.path, f.text] as const));
    const applied = applyEdits(shown, proposal.edits);
    if (!applied.ok) {
      state.updateAttempt(i, { editErrors: applied.errors, finishedAt: nowIso() });
      state.log(`attempt ${i + 1}: edits did not apply: ${firstLine(applied.errors[0] ?? '')}`);
      feedback = `The edits could not be applied to the files shown:\n- ${applied.errors.join('\n- ')}`;
      continue;
    }
    const changes = applied.touched.map((p) => ({
      path: p,
      before: shown.get(p) ?? '',
      after: applied.updated.get(p) ?? '',
    }));
    const diff = combinedDiff(changes);
    const stats = diffStats(diff);
    state.updateAttempt(i, { diff, files: stats.files });

    state.stage('validate');
    const { validation, worktree, patched } = await validateAttempt(state, c, diff, stats);
    state.updateAttempt(i, { validation, finishedAt: nowIso() });
    state.log(
      `attempt ${i + 1}: validation ${validation.passed ? 'passed' : 'failed'}: ${validation.checks
        .map((check) => `${check.id}=${check.status}`)
        .join(', ')}`,
    );
    if (validation.passed) {
      state.patch({ finalAttempt: i });
      return { worktree, patched, footprint: stats };
    }
    feedback = `Code validation of your diff failed:\n${validation.checks
      .filter((check) => check.status === 'failed')
      .map((check) => `- ${check.id}: ${check.detail}`)
      .join('\n')}`;
  }
  return { patched: false };
}

async function review(state: FixState, c: Collected): Promise<void> {
  const final = state.finalDiff();
  if (!final) return;
  state.stage('review');
  try {
    const result = await reviewFix({
      nonce: c.nonce,
      evidenceText: c.evidenceText,
      diff: final.diff,
      proposal: final.proposal,
      validationLines: (final.attempt.validation?.checks ?? []).map(
        (check) => `${check.id}: ${check.status} (${firstLine(check.detail, 120)})`,
      ),
    });
    state.addUsage(result.usage);
    state.patch({ review: { ...result.value, model: result.model, usage: result.usage } });
    state.log(
      `review (${result.model}): ${result.value.verdict}; human-visible change: ${result.value.humanVisibleChange ? 'yes' : 'no'}`,
    );
  } catch (err) {
    state.log(`review skipped: ${firstLine(errorMessage(err))}`);
  }
}

// ---- rematch: a real rerun against the patched store -----------------------------------------

/** The JavaScript entry behind the `tsx` bin of an installed tsx package, or undefined. */
function tsxEntry(packageDir: string): string | undefined {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8')) as {
      bin?: string | Record<string, string>;
    };
    const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.tsx;
    if (!bin) return undefined;
    const entry = path.join(packageDir, bin);
    return fs.existsSync(entry) ? entry : undefined;
  } catch {
    return undefined;
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => (port ? resolve(port) : reject(new Error('no free port'))));
    });
  });
}

async function waitForHealth(
  storeUrl: string,
  child: ChildProcess,
  stderr: () => string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `the patched store exited with code ${child.exitCode} before serving: ${firstLine(stderr(), 300)}`,
      );
    }
    try {
      const res = await fetch(new URL('/health', storeUrl), { signal: AbortSignal.timeout(1000) });
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`the patched store did not answer /health within ${timeoutMs} ms`);
}

function waitForTerminal(runId: string, timeoutMs: number): Promise<Run> {
  return new Promise((resolve, reject) => {
    const done = (run: Run) => {
      clearTimeout(timer);
      unsubscribe();
      resolve(run);
    };
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`the rematch run did not finish within ${timeoutMs} ms`));
    }, timeoutMs);
    const unsubscribe = subscribe(runId, (event) => {
      if (event.type === 'status' && TERMINAL.has(event.status)) {
        const run = db.getRun(runId);
        if (run) done(run);
      }
    });
    const current = db.getRun(runId);
    if (current && TERMINAL.has(current.status)) done(current);
  });
}

function stopChild(child: ChildProcess | undefined): void {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  const force = setTimeout(() => {
    if (child.exitCode === null) child.kill('SIGKILL');
  }, 2000);
  force.unref();
}

async function rematch(
  state: FixState,
  c: Collected,
  worktree: string,
  ensurePatched: () => Promise<void>,
): Promise<boolean> {
  const final = state.finalDiff();
  if (!final) return false;
  state.stage('rematch');
  let child: ChildProcess | undefined;
  let stderrTail = '';
  try {
    await ensurePatched();
    const storeDir = path.join(worktree, state.fix.options.storeRoot);
    const install = await installDependencies(storeDir);
    if (install.status === 'failed')
      throw new Error(`dependency install failed: ${install.detail}`);
    // tsx's own entry point under this node, so the spawn is the same on every platform: Windows
    // refuses to spawn a .cmd shim without a shell (EINVAL), and no shell is wanted here.
    const tsxCli = tsxEntry(path.join(storeDir, 'node_modules', 'tsx'));
    if (!tsxCli) {
      throw new Error('tsx is not installed in the repository, so the patched store cannot boot');
    }
    const entry = ['src/server.ts', 'src/index.ts', 'server.ts', 'index.ts'].find((e) =>
      fs.existsSync(path.join(storeDir, e)),
    );
    if (!entry) throw new Error('no src/server.ts (or index.ts) to boot in the store root');
    const port = await freePort();
    const storeUrl = `http://127.0.0.1:${port}`;
    // Repository code runs here and only here, by explicit request, in a child process with a
    // scrubbed environment (no API keys, no git or npm overrides), on a loopback port.
    child = spawn(process.execPath, [tsxCli, entry], {
      cwd: storeDir,
      env: scrubbedEnv({ STOREFRONT_PORT: String(port), PORT: String(port), LOG_LEVEL: 'warn' }),
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-2000);
    });
    await waitForHealth(storeUrl, child, () => stderrTail, STORE_BOOT_TIMEOUT_MS);
    state.log(`patched store serving at ${storeUrl}`);

    const run: Run = {
      id: newId('run'),
      missionId: c.mission.id,
      agent: c.run.agent,
      agentSummary: agentSummaryFor(c.run.agent),
      status: 'queued',
      label: 'rematch',
      parentRunId: c.run.id,
      createdAt: nowIso(),
      steps: [],
      evidence: [],
    };
    db.saveRun(run);
    state.patch({ rematch: { runId: run.id, status: 'queued', storeUrl } });
    enqueue(run.id, { ...c.mission, storeUrl });
    const name = AGENT_LABELS[c.run.agent.kind].name;
    state.log(`rematch run ${run.id} started (${name})`);
    const finished = await waitForTerminal(run.id, REMATCH_TIMEOUT_MS);
    const comparison = compareRuns(c.run, finished);
    const passed = finished.status === 'passed' && comparison.regressed === 0;
    const check: CodeFixCheck = {
      id: 'rematch',
      status: passed ? 'passed' : 'failed',
      detail: `${name} ${finished.status} on the patched store: ${comparison.improved} improved, ${comparison.regressed} regressed, ${comparison.unchanged} unchanged`,
    };
    appendCheck(state, check);
    state.patch({ rematch: { runId: run.id, status: finished.status, storeUrl, comparison } });
    state.log(`rematch: ${check.detail}`);
    return passed;
  } catch (err) {
    const message = errorMessage(err);
    appendCheck(state, { id: 'rematch', status: 'skipped', detail: firstLine(message, 300) });
    state.patch({
      rematch: {
        ...(state.fix.rematch ?? { runId: '', status: 'error', storeUrl: '' }),
        error: message,
      },
    });
    state.log(`rematch could not run: ${firstLine(message)}`);
    return false;
  } finally {
    stopChild(child);
  }
}

function appendCheck(state: FixState, check: CodeFixCheck): void {
  const index = state.fix.finalAttempt;
  if (index === undefined) return;
  const attempt = state.fix.attempts[index];
  if (!attempt?.validation) return;
  const checks = [...attempt.validation.checks.filter((c) => c.id !== check.id), check];
  state.updateAttempt(index, {
    validation: { checks, passed: checks.every((c) => c.status !== 'failed') },
  });
}

// ---- deliver: a branch or a draft pull request, never a merge ---------------------------------

async function deliver(
  state: FixState,
  c: Collected,
  secrets: Secrets,
  worktree: string,
  ensurePatched: () => Promise<void>,
  files: string[],
): Promise<void> {
  const final = state.finalDiff();
  if (!final) return;
  state.stage('deliver');
  const mode = state.fix.mode;
  try {
    const credential = await resolveGitHubCredential(c.repository.url, 'deliver', secrets.token);
    if (credential.kind === 'none' || !credential.token) {
      throw new Error(`no credential can push: ${credential.note}`);
    }
    state.log(`delivering with ${credential.note}`);
    const actor = credential.kind;
    const ref = parseRepoFullName(c.repository.url);
    const branch = agentproofBranchName(final.proposal.diagnosis.title, state.fix.id);
    await ensurePatched();
    const title = pullRequestTitle(state.fix);
    // The body is a snapshot taken before the push: render it as the record will read once the
    // pull request exists (every check has passed by now; delivery is what this step completes).
    const snapshot: CodeFix = {
      ...state.fix,
      status: 'succeeded',
      stage: 'done',
      delivery: { ...state.fix.delivery, status: 'delivered', branch, actor },
    };
    const body = clampPullRequestBody(renderCodeFixMarkdown(snapshot, { forPullRequest: true }));
    const { commitSha } = await commitAndPush({
      id: c.repository.id,
      worktree,
      branch,
      files,
      message: `${title}\n\n${final.proposal.summary}\n\nProposed by AgentProof from run ${c.run.id} (${c.checkpoint.id}). Validated by code; never merged by the agent.`,
      token: credential.token,
    });
    state.patch({ delivery: { ...state.fix.delivery, branch, commitSha, actor } });
    state.log(`pushed ${branch} (${commitSha.slice(0, 7)})`);
    if (mode === 'branch') {
      state.patch({
        delivery: {
          ...state.fix.delivery,
          status: 'delivered',
          compareUrl: compareUrl(ref, {
            base: c.repository.defaultBranch,
            head: branch,
            title,
            body,
          }),
          deliveredAt: nowIso(),
        },
      });
      state.log('branch delivered; open the compare URL to create the pull request yourself');
      return;
    }
    const client = new GitHubClient({ token: credential.token });
    const pr = await client.createDraftPullRequest(ref, {
      head: branch,
      base: c.repository.defaultBranch,
      title,
      body,
    });
    state.patch({
      delivery: {
        ...state.fix.delivery,
        status: 'delivered',
        pullRequestUrl: pr.url,
        pullRequestNumber: pr.number,
        draft: pr.draft,
        deliveredAt: nowIso(),
      },
    });
    state.log(
      `draft pull request #${pr.number} opened${pr.draft ? '' : ' (GitHub did not mark it draft: review before merging)'}`,
    );
  } catch (err) {
    const message = errorMessage(err);
    state.patch({ delivery: { ...state.fix.delivery, status: 'failed', error: message } });
    state.log(`delivery failed: ${firstLine(message)}`);
  }
}

// ---- the pipeline ------------------------------------------------------------------------------

export async function runCodeFix(fixId: string, secrets: Secrets): Promise<void> {
  const stored = db.getCodeFix(fixId);
  if (!stored) throw new Error(`codefix ${fixId} not found`);
  const state = new FixState(stored);
  let repositoryId: string | undefined;
  try {
    state.stage('collect');
    const c = collect(state);
    repositoryId = c.repository.id;

    state.stage('localize');
    const l = await localize(state, c);

    const outcome = await proposeAndValidate(state, c, l);
    const final = state.finalDiff();
    if (!final || !outcome.footprint) {
      finish(state, 'failed', `no valid diff after ${state.fix.attempts.length} attempt(s)`);
      return;
    }

    if (state.fix.options.review) await review(state, c);

    // A worktree with the diff applied, for the rematch and the push. validateAttempt kept it when
    // every check passed (patched when typecheck ran); otherwise make one now.
    let worktree = outcome.worktree;
    let patched = outcome.patched;
    const ensurePatched = async () => {
      if (!worktree) worktree = await createWorktree(c.repository.id);
      if (!patched) {
        await gitApply(worktree, final.diff);
        patched = true;
      }
    };

    if (state.fix.options.rematch) {
      await ensurePatched();
      const proven = await rematch(state, c, worktree as string, ensurePatched);
      if (!proven) {
        if (state.fix.mode !== 'diff') {
          state.patch({
            delivery: {
              ...state.fix.delivery,
              status: 'failed',
              error: 'not delivered: the rematch did not prove the fix',
            },
          });
        }
        finish(state, 'failed', 'the rematch did not prove the fix');
        return;
      }
    }

    if (state.fix.mode !== 'diff') {
      await ensurePatched();
      await deliver(state, c, secrets, worktree as string, ensurePatched, outcome.footprint.files);
      if (state.fix.delivery.status !== 'delivered') {
        finish(state, 'failed', state.fix.delivery.error ?? 'delivery failed');
        return;
      }
    }
    finish(state, 'succeeded');
  } catch (err) {
    finish(state, 'failed', errorMessage(err));
  } finally {
    if (repositoryId) await removeWorktree(repositoryId).catch(() => undefined);
  }
}
