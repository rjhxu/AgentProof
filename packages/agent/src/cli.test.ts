import { afterEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { AgentConfig, Run, type Evidence, type RunStep } from '@agentproof/shared';
import { alphaFailedRun, hoodieMission } from '@agentproof/shared/fixtures';
import { verify } from '@agentproof/verifier';
import { verificationInputFromBrowserRun } from './assess';
import {
  CliUsageError,
  KIND_BY_NAME,
  USAGE,
  buildRunFromResult,
  defaultOutDir,
  main,
  parseCliArgs,
} from './cli';

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
});

describe('main', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prints the usage and exits 0 for --help, 2 for a bad argument, without running anything', async () => {
    const out: string[] = [];
    const err: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      out.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      err.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);

    expect(await main(['--help'])).toBe(0);
    expect(out.join('')).toContain('Usage:');

    expect(await main(['--agent', 'delta'])).toBe(2);
    expect(err.join('')).toContain('--agent must be one of');
    expect(err.join('')).toContain('Usage:');
  });
});
