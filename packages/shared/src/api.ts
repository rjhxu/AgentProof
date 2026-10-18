import { z } from 'zod';
import { AgentKind } from './agent';
import { Issue, Repair, RunComparison } from './issue';
import { Mission } from './mission';
import { AgentReport, MissionReport } from './report';
import { Run } from './run';

/**
 * HTTP contract between apps/web and apps/runner.
 * Keep this file in sync with apps/runner/src/routes.ts and apps/web/src/lib/api.ts.
 */

// POST /missions  -> parse a prompt into a Mission (no runs started)
export const CreateMissionRequest = z.object({
  storeUrl: z.url(),
  /**
   * When absent the runner derives the mission from the store's catalog feed
   * (GET /api/catalog.json) with no model call, and answers 422 when the store publishes none.
   */
  prompt: z.string().min(1).optional(),
});
export const CreateMissionResponse = z.object({ mission: Mission });

// POST /missions/:id/runs  -> start one run per requested agent
export const StartRunsRequest = z.object({
  agents: z.array(AgentKind).min(1),
});
export const StartRunsResponse = z.object({ runs: z.array(Run) });

// GET /runs/:id
export const GetRunResponse = z.object({
  run: Run,
  issues: z.array(Issue),
  repairs: z.array(Repair),
});

// GET /runs/:id/events  -> text/event-stream of RunEvent

// POST /runs/:id/rematch  -> re-run same mission + agent config
export const RematchResponse = z.object({ run: Run });

// GET /runs/:id/compare/:otherId
export const CompareResponse = z.object({ comparison: RunComparison });

// POST /runs/:id/diagnose  -> root-cause analysis for the run's first failed checkpoint (one Issue)
export const DiagnoseResponse = z.object({ issue: Issue });

// POST /issues/:id/repair  -> generate a reviewable diff
export const ProposeRepairResponse = z.object({ repair: Repair });

// POST /repairs/:id/apply  -> apply to the owned storefront checkout
export const ApplyRepairResponse = z.object({
  repair: Repair,
  storefrontReady: z.boolean().optional(),
});

// POST /missions/fixture  -> insert one of the storefront's known scenario missions (no LLM call)
export const FixtureMissionRequest = z.object({
  bug: z.enum(['A', 'B', 'C', 'D', 'E', 'control']),
  /** Defaults to the runner's STOREFRONT_URL */
  storeUrl: z.url().optional(),
});
export const FixtureMissionResponse = z.object({ mission: Mission });

// GET /runs/:id/report  -> the agent's report for a finished run (also served as .md)
export const GetRunReportResponse = z.object({ report: AgentReport });

// GET /missions/:id/report  -> cross-agent mission report (also served as .md)
export const GetMissionReportResponse = z.object({ report: MissionReport });

// GET /missions/:id  -> the mission, its runs (original and rematch), and the mission report
// path once one exists
export const GetMissionResponse = z.object({
  mission: Mission,
  runs: z.array(Run),
  /** Artifacts-relative path of the cross-agent report JSON, e.g. "missions/mis_abc/report.json" */
  missionReportPath: z.string().optional(),
});

export const ErrorResponse = z.object({ error: z.string() });

export type CreateMissionRequest = z.infer<typeof CreateMissionRequest>;
export type CreateMissionResponse = z.infer<typeof CreateMissionResponse>;
export type StartRunsRequest = z.infer<typeof StartRunsRequest>;
export type StartRunsResponse = z.infer<typeof StartRunsResponse>;
export type GetRunResponse = z.infer<typeof GetRunResponse>;
export type RematchResponse = z.infer<typeof RematchResponse>;
export type CompareResponse = z.infer<typeof CompareResponse>;
export type DiagnoseResponse = z.infer<typeof DiagnoseResponse>;
export type ProposeRepairResponse = z.infer<typeof ProposeRepairResponse>;
export type ApplyRepairResponse = z.infer<typeof ApplyRepairResponse>;
export type ErrorResponse = z.infer<typeof ErrorResponse>;
export type FixtureMissionRequest = z.infer<typeof FixtureMissionRequest>;
export type FixtureMissionResponse = z.infer<typeof FixtureMissionResponse>;
export type GetRunReportResponse = z.infer<typeof GetRunReportResponse>;
export type GetMissionReportResponse = z.infer<typeof GetMissionReportResponse>;
export type GetMissionResponse = z.infer<typeof GetMissionResponse>;
