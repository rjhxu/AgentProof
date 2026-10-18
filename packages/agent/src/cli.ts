import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AgentConfig,
  EMPTY_USAGE,
  addUsage,
  newId,
  nowIso,
  type AgentClaim,
  type AgentKind,
  type Evidence,
  type LlmUsage,
  type Mission,
  type Run,
  type RunStatus,
  type RunStep,
  type VerificationResult,
} from '@agentproof/shared';
import { overallStatus, verify } from '@agentproof/verifier';
import { summarizeStep } from './actions';
import {
  browserRunEvidenceForCart,
  fetchCartWithCookies,
  gammaVerification,
  productPathMatches,
  screenshotEvidenceForPage,
  verificationInputFromBrowserRun,
  type BrowserRunResult,
} from './assess';
import { runBrowserAgent, type AgentCallbacks } from './browser-agent';
import { runGamma } from './gamma';
import { getLlm } from './llm';
import type { LlmEffort } from './llm-types';
import { generateMission } from './mission-generator';
import { deterministicNarrative, generateNarrative } from './narrative';
import { AGENT_PROFILES, estimateCostUsd, profileSummary, resolveModel } from './profiles';
import { buildAgentReport, renderAgentReportMarkdown, writeReportFiles } from './report';
import { SCENARIOS, parseScenarioId, scenarioMission, type ScenarioId } from './scenarios';

/**
 * One agent, one scenario, no dashboard:
 *
 *   pnpm cli -- --agent alpha --bug A
 *   (long form: pnpm --filter @agentproof/agent cli -- --agent alpha --bug A)
 *
 * Runs the agent against the store, verifies the cart through the session cookies, writes
 * report.json and report.md under --out/<runId>, and prints a summary. The run's usage total
 * includes the narrator call, as the runner's does, so both report the same cost for a run.
 *
 * Exit codes: 0 when the verifier reached a verdict (a failed mission is a result, not an error);
 * 1 when the agent run ended in an error before the store could be verified (the report is still
 * written, with no checkpoints, as the runner records an errored run without a verification);
 * 2 on bad arguments or an internal error.
 *
 * The only top-level side effect is main(), guarded so importing this module in tests is inert.
 */

export const AGENT_NAMES = ['alpha', 'beta', 'sigma', 'gamma'] as const;
export type AgentName = (typeof AGENT_NAMES)[number];

export const KIND_BY_NAME: Record<AgentName, AgentKind> = {
  alpha: 'alpha_semantic',
  beta: 'beta_vision',
  sigma: 'sigma_hybrid',
  gamma: 'gamma_structured',
};

const EFFORTS: LlmEffort[] = ['low', 'medium', 'high'];
const DEFAULT_STORE_URL = 'http://localhost:5000';

/** Gamma runs no model: the same constants the runner records (apps/runner/src/jobs.ts). */
export const GAMMA_RESOLVED_MODEL = 'none';
export const GAMMA_USAGE: LlmUsage = { ...EMPTY_USAGE, estimatedCostUsd: 0 };

export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliUsageError';
  }
}

export interface CliArgs {
  help: boolean;
  agent: AgentName;
  bug: ScenarioId;
  store: string;
  prompt?: string;
  model?: string;
  effort?: LlmEffort;
  maxSteps?: number;
  headed: boolean;
  out: string;
  json: boolean;
}

export const USAGE = `Usage: pnpm cli -- --agent <alpha|beta|sigma|gamma> [options]
       (long form: pnpm --filter @agentproof/agent cli -- --agent <name> [options])

Runs one agent on one mission against the storefront and writes an agent report.

Options
  --agent <name>       alpha | beta | sigma | gamma (required)
  --bug <id>           A | B | C | D | E | control; scenario from docs/storefront/bugs-and-fixes.md (default A)
  --prompt "<text>"    generate the mission from this text with the mission generator instead of a scenario
  --store <url>        storefront base URL (default STOREFRONT_URL or ${DEFAULT_STORE_URL})
  --model <id>         model override for this run (default: the agent profile, AGENTPROOF_MODEL_* env)
  --effort <level>     low | medium | high (default: the agent profile)
  --max-steps <n>      step cap for this run (AGENTPROOF_MAX_STEPS still applies)
  --headed             run the browser headed
  --out <dir>          artifacts root; the run writes to <dir>/<runId> (default <repo>/data/artifacts/cli)
  --json               print the report JSON instead of the Markdown
  --help               this text

--model and --effort do not apply to gamma, which runs no model.

Exit codes
  0  the verifier reached a verdict (passed or failed); report written
  1  the agent run ended in an error before the store could be verified; report written
  2  bad arguments or an internal error

Set AGENTPROOF_DEBUG=1 to print stack traces on internal errors.`;

/** <repo>/data/artifacts/cli, from this file's location (packages/agent/src). */
export function defaultOutDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '../../../data/artifacts/cli');
}

/** Hand-rolled parser for process.argv.slice(2). Throws CliUsageError on bad input. */
export function parseCliArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): CliArgs {
  const args: CliArgs = {
    help: false,
    agent: 'alpha',
    bug: 'A',
    store: env.STOREFRONT_URL?.trim() || DEFAULT_STORE_URL,
    headed: false,
    out: defaultOutDir(),
    json: false,
  };
  let agentGiven = false;

  const takeValue = (flag: string, i: number): string => {
    const value = argv[i + 1];
    if (value === undefined || (value.startsWith('--') && value.length > 2)) {
      throw new CliUsageError(`${flag} needs a value`);
    }
    return value;
  };

  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i]!;
    if (raw === '--help' || raw === '-h') {
      args.help = true;
      continue;
    }
    // Accept --flag=value as well as --flag value.
    const eq = raw.indexOf('=');
    const flag = raw.startsWith('--') && eq > 0 ? raw.slice(0, eq) : raw;
    const inlineValue = raw.startsWith('--') && eq > 0 ? raw.slice(eq + 1) : undefined;
    const value = (): string => {
      if (inlineValue !== undefined) return inlineValue;
      const v = takeValue(flag, i);
      i += 1;
      return v;
    };

    switch (flag) {
      case '--agent': {
        const name = value().toLowerCase();
        if (!(AGENT_NAMES as readonly string[]).includes(name)) {
          throw new CliUsageError(
            `--agent must be one of ${AGENT_NAMES.join(', ')}, got "${name}"`,
          );
        }
        args.agent = name as AgentName;
        agentGiven = true;
        break;
      }
      case '--bug': {
        const v = value();
        const id = parseScenarioId(v);
        if (!id) throw new CliUsageError(`--bug must be A, B, C, D, E or control, got "${v}"`);
        args.bug = id;
        break;
      }
      case '--store': {
        const v = value();
        let protocol: string | undefined;
        try {
          protocol = new URL(v).protocol;
        } catch {
          protocol = undefined;
        }
        if (protocol !== 'http:' && protocol !== 'https:') {
          throw new CliUsageError(`--store must be an absolute http(s) URL, got "${v}"`);
        }
        args.store = v;
        break;
      }
      case '--prompt': {
        const v = value().trim();
        if (!v) throw new CliUsageError('--prompt must not be empty');
        args.prompt = v;
        break;
      }
      case '--model': {
        const v = value().trim();
        if (!v) throw new CliUsageError('--model must not be empty');
        args.model = v;
        break;
      }
      case '--effort': {
        const v = value().toLowerCase();
        if (!(EFFORTS as string[]).includes(v)) {
          throw new CliUsageError(`--effort must be low, medium or high, got "${v}"`);
        }
        args.effort = v as LlmEffort;
        break;
      }
      case '--max-steps': {
        const v = value();
        const n = Number(v);
        if (!Number.isInteger(n) || n <= 0) {
          throw new CliUsageError(`--max-steps must be a positive integer, got "${v}"`);
        }
        args.maxSteps = n;
        break;
      }
      case '--headed':
        args.headed = true;
        break;
      case '--json':
        args.json = true;
        break;
      case '--out':
        args.out = path.resolve(process.cwd(), value());
        break;
      default:
        throw new CliUsageError(`Unknown argument "${raw}". Try --help.`);
    }
  }

  if (!args.help && !agentGiven) {
    throw new CliUsageError('--agent is required (alpha, beta, sigma or gamma). Try --help.');
  }
  return args;
}

export interface BuildRunArgs {
  runId: string;
  mission: Mission;
  config: AgentConfig;
  steps: RunStep[];
  evidence: Evidence[];
  /** Absent when the run ended in an error before anything was verified; the status is then "error" */
  verification?: VerificationResult | undefined;
  /** The agent's own stopping claim; outcome "error" makes the run status "error" */
  claim?: AgentClaim;
  resolvedModel: string;
  usage: LlmUsage;
  createdAt: string;
  startedAt: string;
  finishedAt: string;
  /** Relative to the artifacts root, e.g. "run_abc/report.json" */
  reportPath?: string;
}

/**
 * A shared `Run` from what a CLI run produced. Status is the verifier's, or "error" when the agent
 * crashed or nothing was verified (an infra failure is never a store verdict).
 */
export function buildRunFromResult(args: BuildRunArgs): Run {
  const { verification } = args;
  const status: RunStatus =
    args.claim?.outcome === 'error' || !verification ? 'error' : overallStatus(verification);
  const errorMessage =
    status !== 'error'
      ? undefined
      : args.claim?.outcome === 'error'
        ? args.claim.summary
        : 'The run was not verified';
  return {
    id: args.runId,
    missionId: args.mission.id,
    agent: args.config,
    status,
    label: 'original',
    createdAt: args.createdAt,
    startedAt: args.startedAt,
    finishedAt: args.finishedAt,
    steps: args.steps,
    evidence: args.evidence,
    ...(verification ? { verification } : {}),
    ...(args.claim ? { claim: args.claim } : {}),
    resolvedModel: args.resolvedModel,
    usage: args.usage,
    ...(args.reportPath ? { reportPath: args.reportPath } : {}),
    ...(errorMessage ? { errorMessage } : {}),
  };
}

function sumStepUsage(steps: RunStep[]): LlmUsage | undefined {
  const perStep = steps.flatMap((s) => (s.usage ? [s.usage] : []));
  if (perStep.length === 0) return undefined;
  return perStep.reduce((acc, u) => addUsage(acc, u), EMPTY_USAGE);
}

/** The configured provider's name without forcing a client to exist (no key: assume xAI defaults). */
function providerName(): string {
  try {
    return getLlm().provider;
  } catch {
    return 'xai';
  }
}

function formatCost(usage: LlmUsage): string {
  if (usage.calls === 0) return '$0.0000 (no model calls)';
  if (usage.estimatedCostUsd === undefined) return 'unknown (model not in price table)';
  return `$${usage.estimatedCostUsd.toFixed(4)} (estimate)`;
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

interface CliIo {
  out(line: string): void;
  err(line: string): void;
}

/** Runs the agent, writes the report, prints the summary; returns the run's final status. */
async function runCli(args: CliArgs, io: CliIo): Promise<RunStatus> {
  const kind = KIND_BY_NAME[args.agent];
  const isGamma = kind === 'gamma_structured';
  const scenario = args.prompt ? undefined : SCENARIOS[args.bug];

  let mission: Mission = args.prompt
    ? await generateMission(args.store, args.prompt)
    : scenarioMission(args.bug, args.store);
  if (args.maxSteps !== undefined) mission = { ...mission, maxSteps: args.maxSteps };

  if (isGamma && (args.model || args.effort)) {
    io.err('[cli] --model and --effort do not apply to gamma (no model call); ignored');
  }
  const config = AgentConfig.parse({
    kind,
    ...(!isGamma && args.model ? { model: args.model } : {}),
    ...(!isGamma && args.effort ? { effort: args.effort } : {}),
    ...(args.maxSteps !== undefined ? { maxSteps: args.maxSteps } : {}),
    headed: args.headed,
  });

  const runId = newId('run');
  const artifactDir = path.join(args.out, runId);
  await mkdir(artifactDir, { recursive: true });

  io.err(
    `[cli] ${AGENT_PROFILES[kind].name} (${kind}) on ${scenario ? `scenario ${scenario.id}: ${scenario.title}` : 'generated mission'}`,
  );
  io.err(`[cli] mission ${mission.id}: ${mission.rawPrompt}`);
  io.err(`[cli] run ${runId}, artifacts in ${artifactDir}`);

  const createdAt = nowIso();
  const startedAt = createdAt;
  const steps: RunStep[] = [];
  const evidence: Evidence[] = [];
  let verification: VerificationResult | undefined;
  let claim: AgentClaim;
  let resolvedModel: string;
  let provider: string;
  let effort: LlmEffort | undefined = undefined;
  let usage: LlmUsage;

  if (isGamma) {
    const result = await runGamma(mission);
    const assessed = gammaVerification({ mission, result, runId });
    evidence.push(...assessed.evidence);
    verification = assessed.verification;
    claim = {
      // Gamma claims "done" only when it found a variant to add; otherwise it gave up.
      outcome: result.selectedVariant ? 'done' : 'fail',
      summary: result.notes.join(' ') || 'Inspected the catalog feed and the cart API.',
    };
    provider = 'none';
    resolvedModel = GAMMA_RESOLVED_MODEL;
    usage = { ...GAMMA_USAGE };
    for (const note of result.notes) io.err(`[gamma] ${note}`);
  } else {
    const callbacks: AgentCallbacks = {
      onStep: (step) => {
        steps.push(step);
        io.err(`[step] ${summarizeStep(step)}`);
      },
      onEvidence: (item) => {
        evidence.push(item);
      },
      onLog: (message) => io.err(`[agent] ${message}`),
    };
    const result: BrowserRunResult = await runBrowserAgent(mission, config, artifactDir, callbacks);

    claim = {
      outcome: result.outcome,
      summary: result.summary,
      ...(result.finalUrl ? { finalUrl: result.finalUrl } : {}),
    };
    provider = result.provider ?? providerName();
    resolvedModel =
      result.resolvedModel ??
      resolveModel(kind, provider === 'anthropic' ? 'anthropic' : 'xai', args.model);
    effort = result.effort ?? args.effort ?? AGENT_PROFILES[kind].defaultEffort;
    usage = result.usage ?? sumStepUsage(steps) ?? { ...EMPTY_USAGE };

    if (result.outcome === 'error') {
      // As the runner does: an errored run is infra, not a store verdict. Nothing is verified.
      io.err(`[cli] agent run ended in error: ${result.summary}; the store was not verified`);
    } else {
      // The verdict rests on what the store holds, read through the session cookies. No cookie
      // or no readable cart is infra: the cart checkpoints then come back not_verified.
      const cart = await fetchCartWithCookies(mission.storeUrl, result.cookies ?? []);
      const cartEvidenceIds: string[] = [];
      if (cart) {
        const cartEvidence = browserRunEvidenceForCart(runId, cart);
        evidence.push(cartEvidence);
        cartEvidenceIds.push(cartEvidence.id);
        io.err(
          `[cli] cart via session cookies: ${cart.items.length} item(s), subtotal ${cart.currency} ${cart.subtotal}`,
        );
      } else {
        io.err(
          '[cli] no cart could be read for this session (no store cookie, or the store returned no readable cart); cart checkpoints are not verified',
        );
      }
      const product = mission.requirements.product;
      verification = verify(
        verificationInputFromBrowserRun({
          mission,
          result,
          ...(cart ? { cart } : {}),
          cartEvidenceIds,
          productEvidenceIds: screenshotEvidenceForPage(steps, (p) =>
            productPathMatches(p, product),
          ),
          checkoutEvidenceIds: screenshotEvidenceForPage(steps, (p) => p === '/checkout'),
        }),
      );
    }
  }

  if (usage.estimatedCostUsd === undefined) {
    const estimated = estimateCostUsd(resolvedModel, usage);
    if (estimated !== undefined) usage = { ...usage, estimatedCostUsd: estimated };
  }

  const profile = profileSummary(kind, resolvedModel, provider, effort);
  const narrativeBase = {
    kind,
    steps,
    claim,
    checkpoints: verification?.checkpoints ?? [],
    perceives: profile.perceives,
  };
  // An errored run gets the deterministic summary: no paid narrator call for an infra failure.
  const narrative = verification
    ? await generateNarrative({ ...narrativeBase, mission })
    : { narrative: deterministicNarrative(narrativeBase), usage: { ...EMPTY_USAGE } };
  // Same accounting as the runner (apps/runner/src/jobs.ts finishRun): the narrator call is part
  // of the run's usage, so Run.usage, report.usage and the summary lines all show one number.
  usage = addUsage(usage, narrative.usage);

  const finishedAt = nowIso();
  const reportPath = path.posix.join(runId, 'report.json');
  const run = buildRunFromResult({
    runId,
    mission,
    config,
    steps,
    evidence,
    verification,
    claim,
    resolvedModel,
    usage,
    createdAt,
    startedAt,
    finishedAt,
    reportPath,
  });

  const report = buildAgentReport({
    mission,
    run,
    profile,
    narrative: narrative.narrative,
    artifactsRoot: args.out,
  });
  const markdown = renderAgentReportMarkdown(report, { linkBase: runId });
  const written = await writeReportFiles(artifactDir, report, markdown);

  const firstFailure = verification
    ? verification.firstFailure
      ? `${verification.firstFailure.id}${verification.firstFailure.detail ? ` (${verification.firstFailure.detail})` : ''}`
      : 'none'
    : 'not verified (run ended in error)';
  const summary = [
    '',
    `Status:        ${run.status}`,
    `First failure: ${firstFailure}`,
    `Claim:         ${claim.outcome}: ${claim.summary}`,
    `Steps:         ${steps.length} of ${mission.maxSteps}`,
    `Model:         ${provider === 'none' ? 'none (deterministic, no model)' : `${resolvedModel} (${provider}${effort ? `, effort ${effort}` : ''})`}`,
    `Tokens:        ${usage.inputTokens} in / ${usage.outputTokens} out, ${usage.calls} call(s), ${usage.imageInputs} image(s) (agent + narrator)`,
    `Est. cost:     ${formatCost(usage)}`,
    `Narrative:     ${narrative.usage.calls ? `${narrative.usage.inputTokens} in / ${narrative.usage.outputTokens} out, ${narrative.usage.calls} call(s), counted in the totals above` : 'deterministic (no model call)'}`,
    `Report JSON:   ${written.jsonPath}`,
    `Report MD:     ${written.mdPath}`,
    '',
  ];
  const summaryOut = args.json ? io.err : io.out;
  for (const line of summary) summaryOut(line);

  if (args.json) io.out(JSON.stringify(report, null, 2));
  else io.out(markdown);
  return run.status;
}

/**
 * Entry point. Returns the process exit code instead of calling process.exit, for testability:
 * 0 for a verdict (passed or failed), 1 for a run that ended in an error, 2 for a usage or
 * internal error.
 */
export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const io: CliIo = {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  };
  let args: CliArgs;
  try {
    args = parseCliArgs(argv);
  } catch (err) {
    io.err(errorText(err));
    io.err('');
    io.err(USAGE);
    return 2;
  }
  if (args.help) {
    io.out(USAGE);
    return 0;
  }
  try {
    const status = await runCli(args, io);
    return status === 'error' ? 1 : 0;
  } catch (err) {
    io.err(`[cli] internal error: ${errorText(err)}`);
    if (process.env.AGENTPROOF_DEBUG === '1' && err instanceof Error && err.stack)
      io.err(err.stack);
    return 2;
  }
}

/** True when this file is the script Node was started with (tsx src/cli.ts), not an import. */
function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return path.resolve(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      process.stderr.write(`[cli] ${errorText(err)}\n`);
      process.exitCode = 2;
    },
  );
}
