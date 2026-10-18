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
 * sandbox replay and the live event stream, so the screen does not change at wiring.
 */
export type LaneState = {
  runId: string;
  agent: AgentProfileSummary;
  status: RunStatus;
  steps: RunStep[];
  latestScreenshotPath?: string;
  /** The accessibility-tree snapshot the agent read before its latest step, when it reads. */
  latestSnapshotPath?: string;
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

/**
 * How far along a run's life a status is: queued, running, verifying, then any verdict. A lane
 * never moves backwards, so a snapshot loaded over a live stream (or the stream repeating what
 * the snapshot already held) cannot undo what the screen shows.
 */
export function statusRank(status: RunStatus): number {
  switch (status) {
    case 'queued':
      return 0;
    case 'running':
      return 1;
    case 'verifying':
      return 2;
    default:
      return 3;
  }
}

export function reduceLane(lane: LaneState, event: RunEvent): LaneState {
  if (event.runId !== lane.runId) return lane;
  switch (event.type) {
    case 'status': {
      // Never backwards; the same rank may repeat (a verdict can replace a verdict).
      if (statusRank(event.status) < statusRank(lane.status)) return lane;
      // The data check (Gamma) opens no page: it moves to the cart when it starts verifying. A
      // browsing agent that stopped before its first step has no cart to move to and stays put.
      const stage =
        lane.agent.kind === 'gamma_structured' &&
        (event.status === 'verifying' || isTerminal(event.status))
          ? 'cart'
          : lane.stage;
      return { ...lane, status: event.status, stage };
    }
    case 'step': {
      const step = event.step;
      // A step already on the lane (the snapshot and the stream both carried it) counts once.
      if (lane.steps.some((s) => s.index === step.index)) return lane;
      return {
        ...lane,
        steps: [...lane.steps, step],
        costUsd: lane.costUsd + (step.usage?.estimatedCostUsd ?? 0),
        stage: stageOf(step.url),
      };
    }
    case 'evidence': {
      const { kind, path, stepIndex } = event.evidence;
      if (!path) return lane;
      // A step's evidence arrives before the step. Once the step is on the lane its frame has
      // been shown, so a repeat (the snapshot and the stream both carried it) must not rewind it.
      if (stepIndex !== undefined && lane.steps.some((s) => s.index === stepIndex)) return lane;
      if (kind === 'screenshot') return { ...lane, latestScreenshotPath: path };
      if (kind === 'dom_snapshot') return { ...lane, latestSnapshotPath: path };
      return lane;
    }
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
