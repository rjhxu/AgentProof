import { AgentReport, MissionReport } from '@agentproof/shared';

import missionABuggedJson from './mission-a-bugged.json';
import missionAFixedJson from './mission-a-fixed.json';
import missionControlJson from './mission-control.json';
import runAlphaABuggedJson from './run-alpha-a-bugged.json';

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

/** Screenshots from that Alpha run, served from apps/web/public/design. */
export const alphaAScreenshots = {
  step04: '/design/alpha-a-step-04.png',
  step05: '/design/alpha-a-step-05.png',
} as const;

/** The hand-written fixtures the runner and its tests already use. */
export { hoodieMission, alphaFailedRun, alphaIssue, alphaRepair } from '@agentproof/shared/fixtures';
