import {
  AgentReport,
  Issue,
  MissionReport,
  Repair,
  RepositoryConnection,
} from '@agentproof/shared';
import type { AgentKind } from '@agentproof/shared';
import { z } from 'zod';

import issueAlphaABuggedJson from './issue-alpha-a-bugged.json';
import issueGammaABuggedJson from './issue-gamma-a-bugged.json';
import missionABuggedJson from './mission-a-bugged.json';
import missionAFixedJson from './mission-a-fixed.json';
import missionControlJson from './mission-control.json';
import repairAlphaABuggedJson from './repair-alpha-a-bugged.json';
import repairGammaABuggedJson from './repair-gamma-a-bugged.json';
import repositoryAJson from './repository-a.json';
import runAlphaABuggedJson from './run-alpha-a-bugged.json';
import runBetaABuggedJson from './run-beta-a-bugged.json';
import runGammaABuggedJson from './run-gamma-a-bugged.json';
import runSigmaABuggedJson from './run-sigma-a-bugged.json';
import snapshotsABuggedJson from './snapshots-a-bugged.json';

/**
 * Recorded reports for the design sandbox. Each JSON is a report the runner wrote on
 * 2026-10-18 (ids in docs/RESULTS.md), copied from data/artifacts and parsed with the
 * shared Zod schema so a contract change surfaces here, not at wiring time.
 *
 * Sandbox only; see src/design/README.md.
 */

/** Bug A on the bugged store, four agents: Alpha and Gamma fail, Beta and Sigma pass. */
export const missionABugged: MissionReport = MissionReport.parse(missionABuggedJson);

/** Bug A on the store with the reference fix applied: the same Alpha passes. */
export const missionAFixed: MissionReport = MissionReport.parse(missionAFixedJson);

/** The control product: every agent passes. */
export const missionControl: MissionReport = MissionReport.parse(missionControlJson);

/** Alpha's own run report from the bugged Bug A mission: six steps, fails on size. */
export const runAlphaABugged: AgentReport = AgentReport.parse(runAlphaABuggedJson);

/** Beta on the same mission: five steps by screenshot, passes. */
export const runBetaABugged: AgentReport = AgentReport.parse(runBetaABuggedJson);

/** Sigma on the same mission: five steps with every sense, passes, costs twenty times more. */
export const runSigmaABugged: AgentReport = AgentReport.parse(runSigmaABuggedJson);

/** Gamma on the same mission: no browser, reads the catalog and the cart API, fails on variant. */
export const runGammaABugged: AgentReport = AgentReport.parse(runGammaABuggedJson);

/** The four run reports in the order the arena shows them. */
export const runsABugged: AgentReport[] = [
  runAlphaABugged,
  runBetaABugged,
  runSigmaABugged,
  runGammaABugged,
];

/** Screenshots from that Alpha run, served from apps/web/public/design. */
export const alphaAScreenshots = {
  step04: '/design/alpha-a-step-04.png',
  step05: '/design/alpha-a-step-05.png',
} as const;

/** Each browsing agent's last viewport on the bugged Bug A mission. Gamma has none. */
export const arenaScreenshots: Partial<Record<AgentKind, string>> = {
  alpha_semantic: '/design/alpha-a-step-05.png',
  beta_vision: '/design/beta-a-step-04.png',
  sigma_hybrid: '/design/sigma-a-step-04.png',
};

/** Every step frame of the three browsing runs lives under apps/web/public/design. */
const FRAME_PREFIX: Record<string, string> = {
  run_e2f6442a5419: 'alpha-a',
  run_3b3c7a56c6fc: 'beta-a',
  run_fbb8747e6c77: 'sigma-a',
};

/**
 * Maps an artifact path from a report ("run_e2f6442a5419/step-001.png") to the copied
 * frame's URL. The sandbox stand-in for the runner's artifact URL at wiring time.
 */
export function resolveDesignArtifact(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const match = /^(run_[a-f0-9]+)\/step-(\d{3})\.png$/.exec(path);
  if (!match) return undefined;
  const prefix = FRAME_PREFIX[match[1] ?? ''];
  const index = match[2] ?? '';
  return prefix ? `/design/${prefix}-step-${index.slice(1)}.png` : undefined;
}

/**
 * The accessibility-tree snapshots Alpha and Sigma read at each step, keyed by the report's
 * `snapshotPath`, copied verbatim from data/artifacts. Beta has none: it only looks. At wiring
 * the runner serves these as artifacts, like the frames.
 */
export const snapshotsABugged: Record<string, string> = z
  .record(z.string(), z.string())
  .parse(snapshotsABuggedJson);

/**
 * The two problems on the bugged Bug A mission, composed from the recorded reports.
 * `observed` and the evidence ids are verbatim from the recorded checkpoints and failure
 * point. The hypothesis fields (`inferredCause`, `confidence`, `suggestedRepair`) come from
 * the shared `alphaIssue` demo fixture for Alpha and are HAND-WRITTEN for Gamma, which has
 * no recorded diagnosis yet; the UI labels both as hypotheses. The repair diffs are the
 * reference patches under docs/storefront/patches.
 */
export const issueAlphaABugged: Issue = Issue.parse(issueAlphaABuggedJson);
export const issueGammaABugged: Issue = Issue.parse(issueGammaABuggedJson);
export const repairAlphaABugged: Repair = Repair.parse(repairAlphaABuggedJson);
export const repairGammaABugged: Repair = Repair.parse(repairGammaABuggedJson);

export type Problem = { issue: Issue; repair: Repair };

export const problemsABugged: Problem[] = [
  { issue: issueAlphaABugged, repair: repairAlphaABugged },
  { issue: issueGammaABugged, repair: repairGammaABugged },
];

/**
 * HAND-WRITTEN. There is no recorded repository connection; this one mirrors what the
 * runner returns for a connected GitHub repository, with the real storefront file list.
 */
export const repositoryA: RepositoryConnection = RepositoryConnection.parse(repositoryAJson);

/** The hand-written fixtures the runner and its tests already use. */
export {
  hoodieMission,
  alphaFailedRun,
  alphaIssue,
  alphaRepair,
} from '@agentproof/shared/fixtures';
