import { z } from 'zod';
import { AgentKind } from './agent';
import { Issue, Repair, RunComparison } from './issue';
import { Mission } from './mission';
import { Run } from './run';

/**
 * HTTP contract between apps/web and apps/runner.
 * Keep this file in sync with apps/runner/src/routes.ts and apps/web/src/lib/api.ts.
 */

// POST /missions  -> parse a prompt into a Mission (no runs started)
export const CreateMissionRequest = z.object({
  storeUrl: z.url(),
  prompt: z.string().min(1),
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

// POST /issues/:id/diagnose  -> run Claude root-cause analysis
export const DiagnoseResponse = z.object({ issue: Issue });

// POST /issues/:id/repair  -> generate a reviewable diff
export const ProposeRepairResponse = z.object({ repair: Repair });

// POST /repairs/:id/apply  -> apply to the owned storefront checkout
export const ApplyRepairResponse = z.object({
  repair: Repair,
  storefrontReady: z.boolean().optional(),
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
