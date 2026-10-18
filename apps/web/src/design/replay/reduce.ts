import type {
  AgentProfileSummary,
  Checkpoint,
  RunEvent,
  RunStatus,
  RunStep,
} from '@agentproof/shared';

import { stageOf, type Stage } from '../format';

/** What a lane knows before any event: which run and which agent. */
export type LaneSeed = { runId: string; agent: AgentProfileSummary };

/**
 * One agent's lane in the Scan step, folded from run events. The same reducer serves the
 * sandbox replay and, later, the live event stream, so the screen does not change at wiring.
 */
export type LaneState = {
  runId: string;
  agent: AgentProfileSummary;
  status: RunStatus;
  steps: RunStep[];
  latestScreenshotPath?: string;
  checkpoints: Checkpoint[];
  /** Summed from each step's recorded usage as it arrives. */
  costUsd: number;
  /** Where on the purchase path the agent is, from the page of its latest step. */
  stage: Stage;
  reportPath?: string;
};

export function initialLanes(seeds: LaneSeed[]): LaneState[] {
  return seeds.map((seed) => ({
    runId: seed.runId,
    agent: seed.agent,
    status: 'queued',
    steps: [],
    checkpoints: [],
    costUsd: 0,
    stage: 'find',
  }));
}

export function isTerminal(status: RunStatus): boolean {
  return status === 'passed' || status === 'failed' || status === 'error' || status === 'cancelled';
}

export function reduceLane(lane: LaneState, event: RunEvent): LaneState {
  if (event.runId !== lane.runId) return lane;
  switch (event.type) {
    case 'status': {
      // An agent with no browser steps (Gamma) moves to the cart when it starts verifying.
      const stage =
        lane.steps.length === 0 && (event.status === 'verifying' || isTerminal(event.status))
          ? 'cart'
          : lane.stage;
      return { ...lane, status: event.status, stage };
    }
    case 'step': {
      const step = event.step;
      return {
        ...lane,
        steps: [...lane.steps, step],
        costUsd: lane.costUsd + (step.usage?.estimatedCostUsd ?? 0),
        stage: stageOf(step.url),
      };
    }
    case 'evidence':
      return event.evidence.kind === 'screenshot' && event.evidence.path
        ? { ...lane, latestScreenshotPath: event.evidence.path }
        : lane;
    case 'checkpoint': {
      const others = lane.checkpoints.filter((c) => c.id !== event.checkpoint.id);
      return { ...lane, checkpoints: [...others, event.checkpoint] };
    }
    case 'report':
      return { ...lane, reportPath: event.reportPath };
    case 'log':
      return lane;
  }
}

export function reduceLanes(lanes: LaneState[], event: RunEvent): LaneState[] {
  return lanes.map((lane) => (lane.runId === event.runId ? reduceLane(lane, event) : lane));
}
