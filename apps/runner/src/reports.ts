import fs from 'node:fs';
import path from 'node:path';
import {
  AGENT_PROFILES,
  buildAgentReport,
  buildMissionReport,
  generateNarrative,
  profileSummary,
  renderAgentReportMarkdown,
  renderMissionReportMarkdown,
  runUsage,
  writeReportFiles,
  type LlmClient,
} from '@agentproof/agent';
import {
  AgentReport,
  EMPTY_USAGE,
  MissionReport,
  addUsage,
  type LlmUsage,
  type Mission,
  type Run,
} from '@agentproof/shared';
import { config } from './config';
import * as db from './db';

/**
 * Report glue for the runner (W5, Zach; additive to Vihan's runner). No business logic of its
 * own: the builders and renderers live in @agentproof/agent (report.ts, narrative.ts). This file
 * decides where the files go and reads them back for the HTTP routes.
 *
 * Layout, all under config.artifactsDir (served by GET /artifacts/*), posix paths in the JSON:
 *   <runId>/report.json, <runId>/report.md               one per finished run (AgentReport)
 *   missions/<missionId>/report.json, .../report.md      one per mission (MissionReport)
 * Run.reportPath stores the artifacts-relative JSON path ("<runId>/report.json").
 */

export interface GenerateRunReportOptions {
  /** Narrator client to inject (tests pass createMockLlm); generateNarrative defaults to getLlm(). */
  narrativeLlm?: LlmClient;
}

export interface RunReportResult {
  report: AgentReport;
  jsonPath: string;
  mdPath: string;
  /** Artifacts-relative JSON path, e.g. "run_abc/report.json": what Run.reportPath stores. */
  relativeJsonPath: string;
  /** Usage of the narrator call, for the caller to add to Run.usage. */
  narrativeUsage: LlmUsage;
}

export interface MissionReportResult {
  report: MissionReport;
  jsonPath: string;
  mdPath: string;
  /** Artifacts-relative JSON path, e.g. "missions/mis_abc/report.json". */
  relativeJsonPath: string;
}

export function runReportRelativePath(runId: string): string {
  return `${runId}/report.json`;
}

export function missionReportRelativePath(missionId: string): string {
  return `missions/${missionId}/report.json`;
}

/**
 * Provider label for a report header, mirroring the auto-detection in @agentproof/agent llm.ts.
 * Reads only whether a key is present, never its value.
 */
export function detectProvider(env: NodeJS.ProcessEnv = process.env): string {
  const forced = env.AGENTPROOF_LLM_PROVIDER?.trim().toLowerCase();
  if (forced) return forced;
  if (env.XAI_API_KEY?.trim() || env.GROK_API_KEY?.trim()) return 'xai';
  if (env.ANTHROPIC_API_KEY?.trim()) return 'anthropic';
  return 'xai';
}

function isFinished(run: Run): boolean {
  return run.status === 'passed' || run.status === 'failed';
}

function oneLine(text: string, max = 300): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 3)}...`;
}

/**
 * The narrator's prose. generateNarrative never throws by contract (it falls back to a
 * deterministic summary); the guard here keeps a report shipping even if that ever changes.
 */
async function narrativeFor(
  run: Run,
  mission: Mission,
  perceives: string[],
  llm: LlmClient | undefined,
): Promise<{ narrative: string; usage: LlmUsage }> {
  try {
    return await generateNarrative({
      kind: run.agent.kind,
      mission,
      steps: run.steps,
      claim: run.claim,
      checkpoints: run.verification?.checkpoints ?? [],
      perceives,
      ...(llm ? { llm } : {}),
    });
  } catch (err) {
    // The verdict and step log are code-written; only the prose is lost, so the report still ships.
    const reason = err instanceof Error ? err.message : String(err);
    return {
      narrative: `Narrative unavailable (${oneLine(reason)}). The checkpoints and step log are the verifier's record of this run.`,
      usage: EMPTY_USAGE,
    };
  }
}

/**
 * Build, render and write the AgentReport for a finished run. The run's usage total includes the
 * narrator call, so the agent report, Run.usage (the caller adds `narrativeUsage`) and the mission
 * report's cost comparison all show the same number.
 */
export async function generateRunReport(
  run: Run,
  mission: Mission,
  opts: GenerateRunReportOptions = {},
): Promise<RunReportResult> {
  const kind = run.agent.kind;
  const model = run.resolvedModel ?? run.agent.model ?? 'none';
  const provider = model === 'none' ? 'none' : detectProvider();
  const effort = run.agent.effort ?? AGENT_PROFILES[kind].defaultEffort;
  const profile = profileSummary(kind, model, provider, effort);

  const narrative = await narrativeFor(run, mission, profile.perceives, opts.narrativeLlm);
  const usage = addUsage(runUsage(run) ?? EMPTY_USAGE, narrative.usage);
  const report = buildAgentReport({
    mission,
    run: { ...run, usage },
    profile,
    narrative: narrative.narrative,
    artifactsRoot: config.artifactsDir,
  });
  const markdown = renderAgentReportMarkdown(report, { linkBase: run.id });
  const { jsonPath, mdPath } = await writeReportFiles(
    path.join(config.artifactsDir, run.id),
    report,
    markdown,
  );
  return {
    report,
    jsonPath,
    mdPath,
    relativeJsonPath: runReportRelativePath(run.id),
    narrativeUsage: narrative.usage,
  };
}

// Two runs of one mission can finish together; serialize writers per mission so report.json is
// never half of one version and half of another, and the last writer sees every finished run.
const missionReportQueue = new Map<string, Promise<unknown>>();

function withMissionLock<T>(missionId: string, task: () => Promise<T>): Promise<T> {
  const previous = missionReportQueue.get(missionId) ?? Promise.resolve();
  const next = previous.then(task, task);
  missionReportQueue.set(
    missionId,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

/**
 * Rebuild the MissionReport from every run of the mission (deterministic, no model call).
 * Undefined when the mission is unknown or no run has finished yet.
 */
export async function regenerateMissionReport(
  missionId: string,
): Promise<MissionReportResult | undefined> {
  const mission = db.getMission(missionId);
  if (!mission) return undefined;
  return withMissionLock(missionId, async () => {
    const runs = db.listRuns(missionId);
    if (!runs.some(isFinished)) return undefined;
    const agentReports = runs.flatMap((run) => {
      const report = readRunReport(run);
      return report ? [report] : [];
    });
    const report = buildMissionReport({ mission, runs, agentReports });
    const markdown = renderMissionReportMarkdown(report, { linkBase: `missions/${missionId}` });
    const { jsonPath, mdPath } = await writeReportFiles(
      path.join(config.missionReportsDir, missionId),
      report,
      markdown,
    );
    return { report, jsonPath, mdPath, relativeJsonPath: missionReportRelativePath(missionId) };
  });
}

/** Absolute path of an artifacts-relative path, or undefined when it would escape the root. */
export function resolveArtifactPath(relativePath: string): string | undefined {
  const root = path.resolve(config.artifactsDir);
  const abs = path.resolve(root, relativePath);
  const rel = path.relative(root, abs);
  if (rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel))
    return undefined;
  return abs;
}

function readTextIfExists(abs: string | undefined): string | undefined {
  if (!abs) return undefined;
  try {
    return fs.readFileSync(abs, 'utf8');
  } catch {
    return undefined;
  }
}

function parseJson(text: string | undefined): unknown {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** The run's AgentReport from Run.reportPath, validated; undefined when missing or invalid. */
export function readRunReport(run: Run): AgentReport | undefined {
  if (!run.reportPath) return undefined;
  const parsed = AgentReport.safeParse(
    parseJson(readTextIfExists(resolveArtifactPath(run.reportPath))),
  );
  return parsed.success ? parsed.data : undefined;
}

/** The Markdown rendering written next to the run's report.json. */
export function readRunReportMarkdown(run: Run): string | undefined {
  if (!run.reportPath) return undefined;
  return readTextIfExists(resolveArtifactPath(run.reportPath.replace(/\.json$/i, '.md')));
}

export function readMissionReport(missionId: string): MissionReport | undefined {
  const parsed = MissionReport.safeParse(
    parseJson(readTextIfExists(resolveArtifactPath(missionReportRelativePath(missionId)))),
  );
  return parsed.success ? parsed.data : undefined;
}

export function readMissionReportMarkdown(missionId: string): string | undefined {
  return readTextIfExists(
    resolveArtifactPath(missionReportRelativePath(missionId).replace(/\.json$/i, '.md')),
  );
}

export function missionReportExists(missionId: string): boolean {
  const abs = resolveArtifactPath(missionReportRelativePath(missionId));
  return abs !== undefined && fs.existsSync(abs);
}
