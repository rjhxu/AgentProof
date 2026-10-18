import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { createMockLlm, setLlmForTests, type MockLlmClient } from '@agentproof/agent';
import {
  CodeFix,
  type CodeFixProposal,
  type CodeFixReviewDraft,
  type RepositoryConnection,
  type Run,
} from '@agentproof/shared';
import { alphaFailedRun, hoodieMission } from '@agentproof/shared/fixtures';

/**
 * The code-fix pipeline end to end with a scripted model and real git: a snapshot of the actual
 * storefront source, `git show` for localization, the proposer's edits turned into a diff by
 * code, `git apply --check` in a real worktree, the advisory review, the artifacts, and the HTTP
 * surface. Nothing touches the network or a model. The push itself needs GitHub (the hardened git
 * wrapper refuses local-path remotes), so branch mode is asserted to fail cleanly and leak nothing.
 */

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentproof-codefix-'));
process.env.AGENTPROOF_DATA_DIR = dataDir;
const { config } = await import('./config');
const db = await import('./db');
const { startCodeFix } = await import('./codefix');
const { subscribeCodeFix } = await import('./events');
const { registerErrorHandler, registerRoutes } = await import('./routes');

const TOKEN = 'ghp_testsecret_0123456789';
const SECRET_DOC = 'ANSWER KEY SECRET: the size chips are the bug';
const SEARCH = `legacySizeChips(product) + remainingOptions(product, ['size']) + quantityInput(),`;
const REPLACE = `optionGroup(product, 'size') + remainingOptions(product, ['size']) + quantityInput(),`;

const proposal: CodeFixProposal = {
  diagnosis: {
    title: 'Size picker has no form control',
    category: 'semantic_interface_problem',
    inferredCause:
      'The classic template renders size chips as <div> elements, so the accessibility tree has no size control.',
    confidence: 'high',
    needsFiles: [],
  },
  edits: [
    {
      path: 'apps/storefront/src/views.ts',
      search: SEARCH,
      replace: REPLACE,
      reason: 'Use the existing accessible optionGroup() for the size picker.',
    },
  ],
  summary: 'Render the hoodie size picker with optionGroup(), a labelled radio group.',
};
const review: CodeFixReviewDraft = {
  verdict: 'approve',
  humanVisibleChange: false,
  addressesObservedFailure: true,
  minimal: true,
  notes: ['legacySizeChips() is now unused and could be deleted in a follow-up.'],
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** A repository shaped like this monorepo: the real store source plus a docs file that must never reach the model. */
function makeOrigin(): string {
  const origin = fs.mkdtempSync(path.join(os.tmpdir(), 'agentproof-origin-'));
  const store = path.resolve(import.meta.dirname, '../../storefront');
  fs.cpSync(path.join(store, 'src'), path.join(origin, 'apps/storefront/src'), { recursive: true });
  for (const f of ['package.json', 'tsconfig.json']) {
    fs.copyFileSync(path.join(store, f), path.join(origin, 'apps/storefront', f));
  }
  fs.copyFileSync(
    path.resolve(import.meta.dirname, '../../../tsconfig.base.json'),
    path.join(origin, 'tsconfig.base.json'),
  );
  fs.mkdirSync(path.join(origin, 'docs'));
  fs.writeFileSync(path.join(origin, 'docs/answer-key.md'), `# Answer key\n\n${SECRET_DOC}\n`);
  git(origin, 'init', '-q', '-b', 'main');
  git(origin, 'add', '-A');
  git(origin, 'commit', '-q', '-m', 'store');
  return origin;
}

/** The bare snapshot the repository connection would have created, with its metadata row. */
function connectSnapshot(origin: string, runId: string, id: string): RepositoryConnection {
  const root = path.resolve(config.dataDir, 'repositories');
  fs.mkdirSync(root, { recursive: true });
  const directory = path.join(root, id);
  git(root, 'clone', '-q', '--bare', '--no-tags', origin, directory);
  const commitSha = git(root, '--git-dir', directory, 'rev-parse', 'HEAD').trim();
  const files = git(root, '--git-dir', directory, 'ls-tree', '-r', '--name-only', 'HEAD')
    .split('\n')
    .filter(Boolean);
  const repository: RepositoryConnection = {
    id,
    runId,
    url: 'https://github.com/example/northwind',
    fullName: 'example/northwind',
    defaultBranch: 'main',
    commitSha,
    connectedAt: new Date().toISOString(),
    files,
    fileCount: files.length,
    truncated: false,
  };
  db.saveRepository(repository);
  return repository;
}

function failedRun(id: string): Run {
  const run: Run = { ...alphaFailedRun, id };
  db.saveRun(run);
  return run;
}

function waitForDone(codefixId: string, ms = 60_000): Promise<CodeFix> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`codefix ${codefixId} did not finish within ${ms}ms`));
    }, ms);
    const settle = () => {
      clearTimeout(timer);
      unsubscribe();
      resolve(db.getCodeFix(codefixId)!);
    };
    const unsubscribe = subscribeCodeFix(codefixId, (event) => {
      if (event.type === 'done') settle();
    });
    const now = db.getCodeFix(codefixId);
    if (now && now.status !== 'running') settle();
  });
}

let origin: string;
let llm: MockLlmClient;

beforeAll(() => {
  origin = makeOrigin();
  db.saveMission(hoodieMission);
});

afterAll(() => {
  setLlmForTests(undefined);
  db.getDb().close();
  for (const dir of [dataDir, origin]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* a leftover temp dir is not a test failure */
    }
  }
});

describe('the code-fix pipeline (diff mode)', () => {
  let fix: CodeFix;
  const runId = 'run_codefix00001';
  const repoId = 'repo_0123456789ab';

  beforeAll(async () => {
    const run = failedRun(runId);
    connectSnapshot(origin, runId, repoId);
    llm = createMockLlm([{ json: proposal }, { json: review }]);
    setLlmForTests(llm);
    const started = startCodeFix(run, {
      mode: 'diff',
      consent: true,
      storeRoot: 'apps/storefront',
      typecheck: false,
    });
    expect(started.status).toBe('running');
    expect(started.stage).toBe('collect');
    fix = await waitForDone(started.id);
  });

  it('collects code-written evidence and localizes the store source only', () => {
    expect(fix.input?.checkpointId).toBe('correct_size_identified');
    expect(fix.input?.observed).toContain('size control');
    expect(fix.input?.storeRoot).toBe('apps/storefront');
    expect(fix.input?.evidenceChars).toBe(fix.input?.evidenceText.length);
    const paths = fix.localization.map((f) => f.path);
    expect(paths.length).toBeGreaterThan(3);
    expect(paths.every((p) => p.startsWith('apps/storefront/src/'))).toBe(true);
    expect(fix.localization[0]?.path).toBe('apps/storefront/src/views.ts');
    expect(fix.localization[0]?.included).toBe(true);
    expect(fix.localization[0]?.matchedTerms.length).toBeGreaterThan(0);
  });

  it('shows the model the evidence and the ranked source, never the docs', () => {
    expect(llm.requests).toHaveLength(2);
    const propose = llm.requests[0]!;
    expect(propose.system).toContain('You repair the source code');
    const text = propose.messages[0]!.content.map((b) => (b.type === 'text' ? b.text : '')).join(
      '',
    );
    expect(text).toContain('# EVIDENCE');
    expect(text).toMatch(/<<<BEGIN UNTRUSTED evidence [0-9a-f]{16}>>>/);
    expect(text).toMatch(/<<<END UNTRUSTED apps\/storefront\/src\/views\.ts [0-9a-f]{16}>>>/);
    expect(propose.system).toContain('TRUST BOUNDARY');
    expect(text).toContain('## apps/storefront/src/views.ts');
    expect(text).toContain(SEARCH);
    expect(text).not.toContain(SECRET_DOC);
    expect(text).not.toContain('answer-key');
    expect(propose.jsonSchema?.name).toBe('codefix_proposal');
    const reviewReq = llm.requests[1]!;
    expect(reviewReq.system).toContain('You review a proposed source change');
    expect(reviewReq.jsonSchema?.name).toBe('codefix_review');
  });

  it('turns the edits into a diff that code validated in a real worktree', () => {
    expect(fix.status).toBe('succeeded');
    expect(fix.stage).toBe('done');
    expect(fix.finalAttempt).toBe(0);
    const attempt = fix.attempts[0]!;
    expect(attempt.model).toBeTruthy();
    expect(attempt.files).toEqual(['apps/storefront/src/views.ts']);
    expect(attempt.diff).toContain('--- a/apps/storefront/src/views.ts');
    expect(attempt.diff).toContain(`-        ${SEARCH}`);
    expect(attempt.diff).toContain(`+        ${REPLACE}`);
    const byId = Object.fromEntries(attempt.validation!.checks.map((c) => [c.id, c.status]));
    expect(byId).toEqual({
      paths_in_scope: 'passed',
      no_dependency_changes: 'passed',
      size_within_bounds: 'passed',
      content_policy: 'passed',
      applies_cleanly: 'passed',
    });
    expect(attempt.promptSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(attempt.promptChars).toBeGreaterThan(1000);
    expect(attempt.validation!.passed).toBe(true);
    // The real oracle: the patch applies to the repository the snapshot came from.
    const patch = path.join(config.artifactsDir, 'codefix', fix.id, 'patch.diff');
    expect(() => git(origin, 'apply', '--check', patch)).not.toThrow();
  });

  it('records the review as advisory and the cost of every call', () => {
    expect(fix.review?.verdict).toBe('approve');
    expect(fix.review?.humanVisibleChange).toBe(false);
    expect(fix.review?.model).toBeTruthy();
    expect(fix.usage.calls).toBe(2);
    expect(fix.delivery).toEqual({ mode: 'diff', status: 'not_requested' });
    expect(fix.rematch).toBeUndefined();
    const stages = fix.timeline.map((t) => t.stage);
    for (const stage of ['collect', 'localize', 'propose', 'validate', 'review']) {
      expect(stages).toContain(stage);
    }
  });

  it('writes the artifacts and the worktree is gone', () => {
    const dir = path.join(config.artifactsDir, 'codefix', fix.id);
    expect(fix.artifacts).toEqual([
      `codefix/${fix.id}/codefix.json`,
      `codefix/${fix.id}/codefix.md`,
      `codefix/${fix.id}/patch.diff`,
    ]);
    const json = fs.readFileSync(path.join(dir, 'codefix.json'), 'utf8');
    expect(() => CodeFix.parse(JSON.parse(json))).not.toThrow();
    const md = fs.readFileSync(path.join(dir, 'codefix.md'), 'utf8');
    expect(md).toContain('## What failed (observed by code)');
    expect(md).toContain('## Validation (run by code)');
    expect(md).toContain('A hypothesis, not a verdict');
    expect(fs.existsSync(path.join(config.dataDir, 'repositories', `${repoId}.work`))).toBe(false);
  });

  it('serves the record, the Markdown, the patch and a closed event stream', async () => {
    const app = Fastify();
    await registerRoutes(app);
    registerErrorHandler(app);
    const record = await app.inject({ method: 'GET', url: `/codefix/${fix.id}` });
    expect(record.statusCode).toBe(200);
    expect(CodeFix.parse(record.json().codefix).id).toBe(fix.id);
    const list = await app.inject({ method: 'GET', url: `/runs/${runId}/codefixes` });
    expect(list.json().codefixes).toHaveLength(1);
    const md = await app.inject({ method: 'GET', url: `/codefix/${fix.id}/report.md` });
    expect(md.headers['content-type']).toContain('text/markdown');
    expect(md.body).toContain('## Change');
    const patch = await app.inject({ method: 'GET', url: `/codefix/${fix.id}/patch.diff` });
    expect(patch.body).toContain('+++ b/apps/storefront/src/views.ts');
    const events = await app.inject({ method: 'GET', url: `/codefix/${fix.id}/events` });
    const types = events.body
      .split('\n\n')
      .filter((c) => c.startsWith('data: '))
      .map((c) => (JSON.parse(c.slice(6)) as { type: string }).type);
    expect(types).toEqual(['stage', 'done']);
    const missing = await app.inject({ method: 'GET', url: '/codefix/fix_000000000000' });
    expect(missing.statusCode).toBe(404);
    await app.close();
  });

  it('refuses a fix for a run without a repository and a mode without a token', async () => {
    const app = Fastify();
    await registerRoutes(app);
    registerErrorHandler(app);
    failedRun('run_codefix00002');
    const noRepo = await app.inject({
      method: 'POST',
      url: '/runs/run_codefix00002/codefix',
      payload: { consent: true, mode: 'diff' },
    });
    expect(noRepo.statusCode).toBe(409);
    const noToken = await app.inject({
      method: 'POST',
      url: `/runs/${runId}/codefix`,
      payload: { consent: true, mode: 'pull_request' },
    });
    expect(noToken.statusCode).toBe(400);
    expect(noToken.json().error).toContain('token');
    const badBody = await app.inject({
      method: 'POST',
      url: `/runs/${runId}/codefix`,
      payload: { mode: 'diff' },
    });
    expect(badBody.statusCode).toBe(400);
    await app.close();
  });
});

describe('branch mode', () => {
  it('fails cleanly when the push is refused and never records the token', async () => {
    const runId = 'run_codefix00003';
    const run = failedRun(runId);
    connectSnapshot(origin, runId, 'repo_0123456789ac');
    setLlmForTests(createMockLlm([{ json: proposal }, { json: review }]));
    const started = startCodeFix(run, {
      mode: 'branch',
      consent: true,
      storeRoot: 'apps/storefront',
      typecheck: false,
      review: false,
      token: TOKEN,
    });
    const fix = await waitForDone(started.id);
    // A validated diff exists, but the hardened git wrapper refuses to push to a local-path
    // remote (protocol.file.allow=never), which is what a GitHub-less test can prove.
    expect(fix.finalAttempt).toBe(0);
    expect(fix.attempts[0]?.validation?.passed).toBe(true);
    expect(fix.delivery.mode).toBe('branch');
    expect(fix.delivery.status).toBe('failed');
    expect(fix.status).toBe('failed');
    expect(fix.error).toBeTruthy();
    expect(fix.review).toBeUndefined();
    const everything =
      JSON.stringify(fix) +
      fs.readFileSync(path.join(config.artifactsDir, 'codefix', fix.id, 'codefix.md'), 'utf8');
    expect(everything).not.toContain(TOKEN);
    // Nothing reached the origin.
    expect(git(origin, 'branch', '--list', 'agentproof/*').trim()).toBe('');
  });
});
