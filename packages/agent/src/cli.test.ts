import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AgentConfig,
  AgentReport,
  EMPTY_USAGE,
  Run,
  type Evidence,
  type LlmUsage,
  type ObservedCart,
  type RunStep,
} from '@agentproof/shared';
import { alphaFailedRun, hoodieMission } from '@agentproof/shared/fixtures';
import { verify } from '@agentproof/verifier';
import { fetchCartWithCookies, verificationInputFromBrowserRun } from './assess';
import { runBrowserAgent, type BrowserAgentResult } from './browser-agent';
import {
  CliUsageError,
  GAMMA_RESOLVED_MODEL,
  GAMMA_USAGE,
  KIND_BY_NAME,
  USAGE,
  buildRunFromResult,
  defaultOutDir,
  main,
  parseCliArgs,
} from './cli';
import { runGamma } from './gamma';
import { createMockLlm, setLlmForTests } from './llm';

// The CLI's accounting and exit codes are under test, not the loop, the store or the catalog:
// those three entry points are replaced, everything else (assessment, verifier, report) is real.
vi.mock('./browser-agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./browser-agent')>();
  return { ...actual, runBrowserAgent: vi.fn() };
});
vi.mock('./assess', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./assess')>();
  return { ...actual, fetchCartWithCookies: vi.fn() };
});
vi.mock('./gamma', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./gamma')>();
  return { ...actual, runGamma: vi.fn() };
});

const ENV_NO_STORE: NodeJS.ProcessEnv = {};

describe('parseCliArgs', () => {
  it('applies the defaults when only --agent is given', () => {
    const args = parseCliArgs(['--agent', 'alpha'], ENV_NO_STORE);
    expect(args).toEqual({
      help: false,
      agent: 'alpha',
      bug: 'A',
      store: 'http://localhost:5000',
      headed: false,
      out: defaultOutDir(),
      json: false,
    });
    expect(args.out.split(path.sep).slice(-3)).toEqual(['data', 'artifacts', 'cli']);
    expect(KIND_BY_NAME[args.agent]).toBe('alpha_semantic');
  });

  it('reads every flag, in either --flag value or --flag=value form', () => {
    const args = parseCliArgs(
      [
        '--agent=Gamma',
        '--bug',
        'c',
        '--store',
        'http://localhost:5050',
        '--prompt',
        'Buy the tote and reach checkout',
        '--model',
        'grok-test',
        '--effort=HIGH',
        '--max-steps',
        '7',
        '--headed',
        '--out',
        'tmp/artifacts',
        '--json',
      ],
      ENV_NO_STORE,
    );
    expect(args).toEqual({
      help: false,
      agent: 'gamma',
      bug: 'C',
      store: 'http://localhost:5050',
      prompt: 'Buy the tote and reach checkout',
      model: 'grok-test',
      effort: 'high',
      maxSteps: 7,
      headed: true,
      out: path.resolve(process.cwd(), 'tmp/artifacts'),
      json: true,
    });
  });

  it('takes the store URL from STOREFRONT_URL when --store is absent', () => {
    expect(
      parseCliArgs(['--agent', 'beta'], { STOREFRONT_URL: 'http://localhost:5050' }).store,
    ).toBe('http://localhost:5050');
    expect(
      parseCliArgs(['--agent', 'beta', '--store', 'http://127.0.0.1:5000'], {
        STOREFRONT_URL: 'http://localhost:5050',
      }).store,
    ).toBe('http://127.0.0.1:5000');
  });

  it('accepts --help without --agent', () => {
    expect(parseCliArgs(['--help'], ENV_NO_STORE).help).toBe(true);
    expect(parseCliArgs(['-h'], ENV_NO_STORE).help).toBe(true);
    expect(USAGE).toContain('--agent');
  });

  it('documents the real scripts: pnpm cli, never the removed "run" script', () => {
    expect(USAGE).toContain('pnpm cli -- --agent');
    expect(USAGE).toContain('pnpm --filter @agentproof/agent cli --');
    expect(USAGE).not.toContain('@agentproof/agent run');
    expect(USAGE).toContain('Exit codes');
  });

  it('rejects bad input with a CliUsageError that names the flag', () => {
    const bad: Array<[string[], RegExp]> = [
      [[], /--agent is required/],
      [['--agent', 'delta'], /--agent must be one of alpha, beta, sigma, gamma/],
      [['--agent', 'alpha', '--bug', 'F'], /--bug must be A, B, C, D, E or control/],
      [['--agent', 'alpha', '--effort', 'max'], /--effort must be low, medium or high/],
      [['--agent', 'alpha', '--max-steps', '0'], /--max-steps must be a positive integer/],
      [['--agent', 'alpha', '--max-steps', '2.5'], /--max-steps must be a positive integer/],
      [
        ['--agent', 'alpha', '--store', 'localhost:5000'],
        /--store must be an absolute http\(s\) URL/,
      ],
      [['--agent', 'alpha', '--store', 'not a url'], /--store must be an absolute http\(s\) URL/],
      [['--agent', 'alpha', '--prompt', '  '], /--prompt must not be empty/],
      [['--agent', 'alpha', '--model'], /--model needs a value/],
      [['--agent', 'alpha', '--out', '--json'], /--out needs a value/],
      [['--agent', 'alpha', '--verbose'], /Unknown argument "--verbose"/],
      [['--agent'], /--agent needs a value/],
    ];
    for (const [argv, message] of bad) {
      expect(() => parseCliArgs(argv, ENV_NO_STORE)).toThrow(CliUsageError);
      expect(() => parseCliArgs(argv, ENV_NO_STORE)).toThrow(message);
    }
  });
});

describe('buildRunFromResult', () => {
  const config = AgentConfig.parse({ kind: 'alpha_semantic', model: 'grok-test', effort: 'low' });
  const steps: RunStep[] = alphaFailedRun.steps;
  const cartEvidence: Evidence = alphaFailedRun.evidence[2]!;
  const evidence: Evidence[] = [...alphaFailedRun.evidence];
  const verification = verify(
    verificationInputFromBrowserRun({
      mission: hoodieMission,
      result: {
        outcome: 'done',
        summary: 'Reached checkout with the default size',
        finalUrl: 'http://localhost:5000/checkout',
        visitedUrls: [
          'http://localhost:5000/products/black-hoodie',
          'http://localhost:5000/checkout',
        ],
      },
      cart: cartEvidence.data as never,
      cartEvidenceIds: [cartEvidence.id],
    }),
  );
  const base = {
    runId: 'run_cli00000001',
    mission: hoodieMission,
    config,
    steps,
    evidence,
    verification,
    resolvedModel: 'grok-test',
    usage: {
      calls: 3,
      inputTokens: 3000,
      outputTokens: 90,
      reasoningTokens: 0,
      cachedInputTokens: 0,
      imageInputs: 0,
      llmLatencyMs: 1200,
    },
    createdAt: '2026-10-17T20:00:00.000Z',
    startedAt: '2026-10-17T20:00:01.000Z',
    finishedAt: '2026-10-17T20:01:00.000Z',
    reportPath: 'run_cli00000001/report.json',
  };

  it('produces a Run that passes Run.parse with the verifier’s status', () => {
    const run = buildRunFromResult({
      ...base,
      claim: {
        outcome: 'done',
        summary: 'Reached checkout with the default size',
        finalUrl: 'http://localhost:5000/checkout',
      },
    });
    expect(Run.safeParse(run).success).toBe(true);
    expect(run).toMatchObject({
      id: 'run_cli00000001',
      missionId: hoodieMission.id,
      status: 'failed',
      label: 'original',
      agent: config,
      resolvedModel: 'grok-test',
      reportPath: 'run_cli00000001/report.json',
      claim: { outcome: 'done', finalUrl: 'http://localhost:5000/checkout' },
    });
    expect(run.steps).toHaveLength(3);
    expect(run.evidence).toHaveLength(3);
    expect(run.verification?.firstFailure?.id).toBe('correct_size_identified');
    expect(run.usage?.inputTokens).toBe(3000);
    expect(run.errorMessage).toBeUndefined();
  });

  it('is "passed" when nothing failed and "error" when the agent crashed', () => {
    const passedVerification = {
      ...verification,
      checkpoints: verification.checkpoints.map((c) => ({ ...c, status: 'passed' as const })),
      firstFailure: undefined,
    };
    const passed = buildRunFromResult({ ...base, verification: passedVerification });
    expect(Run.safeParse(passed).success).toBe(true);
    expect(passed.status).toBe('passed');
    expect(passed.claim).toBeUndefined();

    const crashed = buildRunFromResult({
      ...base,
      claim: { outcome: 'error', summary: 'browser crashed' },
    });
    expect(Run.safeParse(crashed).success).toBe(true);
    expect(crashed.status).toBe('error');
    expect(crashed.errorMessage).toBe('browser crashed');
  });

  it('is "error" with no verification at all, as the runner records an errored run', () => {
    const unverified = buildRunFromResult({
      ...base,
      verification: undefined,
      claim: { outcome: 'error', summary: 'store unreachable' },
    });
    expect(Run.safeParse(unverified).success).toBe(true);
    expect(unverified.status).toBe('error');
    expect(unverified.verification).toBeUndefined();
    expect(unverified.errorMessage).toBe('store unreachable');
    expect(buildRunFromResult({ ...base, verification: undefined }).status).toBe('error');
  });
});

describe('main', () => {
  let out: string[];
  let err: string[];
  let outDir: string;

  const LOOP_USAGE: LlmUsage = {
    calls: 3,
    inputTokens: 3000,
    outputTokens: 90,
    reasoningTokens: 0,
    cachedInputTokens: 0,
    imageInputs: 0,
    llmLatencyMs: 1200,
  };
  const NARRATOR_USAGE = { calls: 1, inputTokens: 700, outputTokens: 60 };
  const NARRATIVE = 'The agent found no size control and continued with the default.';
  const cartS: ObservedCart = { ...(alphaFailedRun.evidence[2]!.data as ObservedCart) };

  /** The loop replaced: the fixture's steps and screenshots through the callbacks, then a result. */
  function fakeLoop(over: Partial<BrowserAgentResult> = {}): void {
    vi.mocked(runBrowserAgent).mockImplementation(async (_mission, _config, artifactDir, cb) => {
      const runId = path.basename(artifactDir);
      for (const e of alphaFailedRun.evidence) {
        if (e.kind !== 'cart_state') cb.onEvidence({ ...e, runId });
      }
      for (const s of alphaFailedRun.steps) cb.onStep(s);
      cb.onLog('model: grok-test (mock, effort low)');
      return {
        outcome: 'done',
        summary: 'Reached checkout with the default size',
        finalUrl: 'http://localhost:5000/checkout',
        visitedUrls: [
          'http://localhost:5000/',
          'http://localhost:5000/products/black-hoodie',
          'http://localhost:5000/cart',
          'http://localhost:5000/checkout',
        ],
        cookies: [{ name: 'nw_session', value: 'abc', domain: 'localhost', path: '/' }],
        usage: LOOP_USAGE,
        resolvedModel: 'grok-test',
        provider: 'mock',
        effort: 'low',
        stepsUsed: 3,
        durationMs: 66_000,
        ...over,
      };
    });
  }

  function readReport(): AgentReport {
    const runDirs = fs.readdirSync(outDir);
    expect(runDirs).toHaveLength(1);
    const dir = path.join(outDir, runDirs[0]!);
    expect(fs.existsSync(path.join(dir, 'report.md'))).toBe(true);
    const parsed = AgentReport.safeParse(
      JSON.parse(fs.readFileSync(path.join(dir, 'report.json'), 'utf8')),
    );
    expect(parsed.success).toBe(true);
    return parsed.data!;
  }

  beforeEach(() => {
    out = [];
    err = [];
    outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentproof-cli-'));
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      out.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      err.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
    vi.mocked(runBrowserAgent).mockReset();
    vi.mocked(fetchCartWithCookies).mockReset();
    vi.mocked(runGamma).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setLlmForTests(undefined);
    fs.rmSync(outDir, { recursive: true, force: true });
  });

  it('prints the usage and exits 0 for --help, 2 for a bad argument, without running anything', async () => {
    expect(await main(['--help'])).toBe(0);
    expect(out.join('')).toContain('Usage: pnpm cli --');

    expect(await main(['--agent', 'delta'])).toBe(2);
    expect(err.join('')).toContain('--agent must be one of');
    expect(err.join('')).toContain('Usage:');
    expect(runBrowserAgent).not.toHaveBeenCalled();
  });

  it('sums the narrator call into Run.usage and the report, as the runner does', async () => {
    const narrator = createMockLlm([{ text: NARRATIVE, usage: NARRATOR_USAGE }]);
    setLlmForTests(narrator);
    fakeLoop();
    vi.mocked(fetchCartWithCookies).mockResolvedValue(cartS);

    expect(await main(['--agent', 'alpha', '--bug', 'A', '--out', outDir])).toBe(0);

    expect(narrator.requests).toHaveLength(1);
    const report = readReport();
    expect(report.status).toBe('failed');
    expect(report.firstFailure?.id).toBe('correct_size_identified');
    expect(report.narrative).toBe(NARRATIVE);
    expect(report.usage.calls).toBe(LOOP_USAGE.calls + NARRATOR_USAGE.calls);
    expect(report.usage.inputTokens).toBe(LOOP_USAGE.inputTokens + NARRATOR_USAGE.inputTokens);
    expect(report.usage.outputTokens).toBe(LOOP_USAGE.outputTokens + NARRATOR_USAGE.outputTokens);
    expect(report.agent.model).toBe('grok-test');

    // Evidence for product_discovered is the screenshot of the first step on the product page,
    // not the catalog landing page; nothing links to /checkout since no step was observed there.
    const byId = Object.fromEntries(report.checkpoints.map((c) => [c.id, c]));
    expect(byId.product_discovered?.status).toBe('passed');
    expect(byId.product_discovered?.evidenceIds).toEqual([
      alphaFailedRun.steps[1]!.screenshotEvidenceId,
    ]);
    expect(byId.checkout_review_reached?.evidenceIds).toEqual([]);

    const stdout = out.join('');
    expect(stdout).toContain('Status:        failed');
    expect(stdout).toContain('Tokens:        3700 in / 150 out, 4 call(s)');
    expect(stdout).toContain('Narrative:     700 in / 60 out, 1 call(s)');
  });

  it('does not verify or narrate an errored run, reports status error, and exits 1', async () => {
    const narrator = createMockLlm([{ text: NARRATIVE, usage: NARRATOR_USAGE }]);
    setLlmForTests(narrator);
    fakeLoop({
      outcome: 'error',
      summary: 'model call failed: spending limit',
      finalUrl: 'http://localhost:5000/',
      visitedUrls: ['http://localhost:5000/'],
      cookies: [],
    });

    expect(await main(['--agent', 'alpha', '--out', outDir, '--json'])).toBe(1);

    expect(fetchCartWithCookies).not.toHaveBeenCalled();
    expect(narrator.requests).toHaveLength(0);
    const report = readReport();
    expect(report.status).toBe('error');
    expect(report.checkpoints).toEqual([]);
    expect(report.firstFailure).toBeUndefined();
    expect(report.claim).toMatchObject({
      outcome: 'error',
      summary: 'model call failed: spending limit',
    });
    expect(report.narrative).toContain('It stopped with error: model call failed: spending limit.');
    expect(report.usage.calls).toBe(LOOP_USAGE.calls);

    const stderr = err.join('');
    expect(stderr).toContain('the store was not verified');
    expect(stderr).toContain('First failure: not verified (run ended in error)');
    // --json: stdout is the report itself, the summary went to stderr.
    expect(JSON.parse(out.join('')).status).toBe('error');
  });

  it('records gamma like the runner: model "none", a zero cost line, the claim from the result', async () => {
    setLlmForTests(createMockLlm([{ text: 'never called' }]));
    vi.mocked(runGamma).mockResolvedValue({
      checkpoints: [
        {
          id: 'product_discovered',
          status: 'failed',
          detail: 'No in-stock catalog variant satisfies the mission and budget.',
          evidenceIds: [],
        },
      ],
      notes: ['No cart mutation attempted.'],
    });

    expect(
      await main(['--agent', 'gamma', '--bug', 'B', '--model', 'grok-test', '--out', outDir]),
    ).toBe(0);

    expect(runBrowserAgent).not.toHaveBeenCalled();
    expect(fetchCartWithCookies).not.toHaveBeenCalled();
    const report = readReport();
    expect(report.status).toBe('failed');
    expect(report.firstFailure?.id).toBe('product_discovered');
    expect(report.agent.model).toBe(GAMMA_RESOLVED_MODEL);
    expect(report.agent.model).toBe('none');
    expect(report.mission.requirements.product).toBe('black hoodie');
    expect(report.usage).toEqual(GAMMA_USAGE);
    expect(report.usage).toEqual({ ...EMPTY_USAGE, estimatedCostUsd: 0 });
    expect(report.claim).toMatchObject({ outcome: 'fail', summary: 'No cart mutation attempted.' });
    expect(err.join('')).toContain('--model and --effort do not apply to gamma');
    expect(out.join('')).toContain('Model:         none (deterministic, no model)');
  });
});
