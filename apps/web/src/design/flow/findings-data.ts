import { CHECKPOINT_LABELS, CHECKPOINT_ORDER } from '@agentproof/shared';
import type {
  AgentKind,
  AgentReport,
  Attribution,
  CheckpointId,
  CheckpointStatus,
  Issue,
  MissionReport,
  ObservedCart,
} from '@agentproof/shared';

import {
  BENCHMARK_KIND,
  CHECKPOINT_WHERE,
  costLine,
  formatUsd,
  isCoordinateTarget,
  plainDetail,
  relativeCostLabel,
  STAGE_LABELS,
  stageOf,
} from '../format';
import { STAGE_ORDER } from './stage';

/*
 * The problems the Findings step walks through, shaped from the mission report, the run
 * reports and the composed issues. Every line is code-written: checkpoint details from the
 * verifier, the report's attribution sentences, cost table and recommendations. Nothing the
 * model wrote (inferred cause, narrative, claim, step reasons) is carried over.
 */

/** One shopper's result on the problem's checkpoint, for the chip row. */
export type ShopperResult = {
  kind: AgentKind;
  name: string;
  status: CheckpointStatus;
  /** The verifier's detail for this shopper on the row, or a fixed phrase for its status. */
  line: string;
  /** "$0.0025", "$0". */
  cost: string;
  /** "22× Alpha" for a shopper dearer than the cheapest; absent otherwise. */
  multiple?: string;
  /** The shopper this problem belongs to. */
  failing: boolean;
  benchmark: boolean;
  /** Another problem's index, when the report attributes this shopper's failure on the row to it. */
  attributedTo?: number;
};

export type ProblemData = {
  issue: Issue;
  attribution?: Attribution;
  /** The matrix row the chips read from: the attribution's checkpoint, else the issue's. */
  rowId: CheckpointId;
  rowLabel: string;
  checkpointLabel: string;
  /** Where it broke: a purchase-path stage for a browsing shopper, the feed or cart API for Gamma. */
  where: string;
  /** The viewport at the failing step, when the shopper had one. */
  screenshotUrl?: string;
  /** The failing step, 1-based, for the caption. */
  failingStep?: number;
  /** What the shopper perceived at the failing step (an accessibility-tree excerpt). */
  excerpt?: string;
  /** The failing step's role:name target, to highlight its line in the excerpt. */
  target?: string;
  /** The cart the verifier read back, shown when there is no viewport. */
  observedCart?: ObservedCart;
  /** In stage order, without the shoppers the row does not cover. */
  shoppers: ShopperResult[];
  /** The report's cost sentence for the failing shopper. */
  cost: string;
  recommendation?: string;
};

/** Words the report's deterministic recommendations use for each failure category. */
const CATEGORY_WORDS: Partial<Record<Issue['category'], string[]>> = {
  semantic_interface_problem: ['accessible name', 'role'],
  product_data_inconsistency: ['catalog', 'cart api'],
  cart_checkout_defect: ['cart', 'checkout'],
};

/** What a chip says when the run recorded no detail for the row. */
const STATUS_PHRASE: Record<CheckpointStatus, string> = {
  passed: 'passed this check',
  failed: 'failed this check',
  not_verified: 'could not be verified here',
  not_tested: 'never reached this check',
  unsupported: 'could not run this check',
  blocked: 'could not run this check',
};

function rank(kind: AgentKind | undefined): number {
  const i = kind ? STAGE_ORDER.indexOf(kind) : -1;
  return i < 0 ? STAGE_ORDER.length : i;
}

/**
 * Problems in the order they broke the purchase path (checkpoint order), the cheapest shopper
 * first on a tie, then as given. Findings and Fixes both use this order.
 */
export function orderProblems<T extends { issue: Issue }>(problems: T[], runs: AgentReport[]): T[] {
  const kindOf = (issue: Issue) => runs.find((r) => r.runId === issue.runId)?.agent.kind;
  return problems
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const byCheckpoint =
        CHECKPOINT_ORDER.indexOf(a.item.issue.checkpointId) -
        CHECKPOINT_ORDER.indexOf(b.item.issue.checkpointId);
      if (byCheckpoint !== 0) return byCheckpoint;
      return rank(kindOf(a.item.issue)) - rank(kindOf(b.item.issue)) || a.index - b.index;
    })
    .map((x) => x.item);
}

export function buildProblems(
  report: MissionReport,
  runs: AgentReport[],
  problems: Array<{ issue: Issue }>,
  frames: Record<string, string>,
  observedCarts: Record<string, ObservedCart>,
): ProblemData[] {
  const names = Object.fromEntries(report.runs.map((r) => [r.agentKind, r.agentName])) as Partial<
    Record<AgentKind, string>
  >;
  // Resolve every problem's shopper, row and category first so a chip can point at another problem.
  const heads = orderProblems(problems, runs).map(({ issue }) => {
    const run = runs.find((r) => r.runId === issue.runId);
    const kind = run?.agent.kind;
    const attribution =
      report.attributions.find(
        (a) => a.checkpointId === issue.checkpointId && a.category === issue.category,
      ) ??
      report.attributions.find(
        (a) => a.category === issue.category && (kind ? a.failingAgents.includes(kind) : true),
      );
    const rowId = attribution?.checkpointId ?? issue.checkpointId;
    return { issue, run, kind, attribution, rowId };
  });

  return heads.map(({ issue, run, kind, attribution, rowId }) => {
    const failingStep =
      run?.failurePoint && run.steps.find((s) => s.index === run.failurePoint?.stepIndex);
    const screenshotPath = run?.failurePoint?.screenshotPath ?? failingStep?.screenshotPath;
    const screenshotUrl = screenshotPath ? frames[screenshotPath] : undefined;
    const browses = kind !== undefined && kind !== 'gamma_structured';
    const where = browses
      ? STAGE_LABELS[stageOf(run?.failurePoint?.url ?? failingStep?.url)]
      : CHECKPOINT_WHERE[issue.checkpointId];
    const action = failingStep?.action;
    const rawTarget = action && 'target' in action ? action.target : undefined;
    const target = rawTarget && !isCoordinateTarget(rawTarget) ? rawTarget : undefined;
    const row = report.matrix[rowId];

    const shoppers: ShopperResult[] = [];
    for (const agentKind of STAGE_ORDER) {
      const status = row?.[agentKind];
      const missionRun = report.runs.find((r) => r.agentKind === agentKind);
      if (!status || status === 'not_run' || !missionRun) continue;
      const theirRun = runs.find((r) => r.agent.kind === agentKind);
      const failing = agentKind === kind;
      const detailOf = (id: CheckpointId) =>
        plainDetail(theirRun?.checkpoints.find((c) => c.id === id)?.detail);
      const line =
        (failing ? detailOf(issue.checkpointId) : undefined) ??
        detailOf(rowId) ??
        STATUS_PHRASE[status];
      const costRow = report.costComparison.find((r) => r.agentKind === agentKind);
      const theirAttribution = report.attributions.find(
        (a) => a.checkpointId === rowId && a.failingAgents.includes(agentKind),
      );
      const attributedTo =
        !failing && status === 'failed' && theirAttribution
          ? heads.findIndex(
              (h) => h.kind === agentKind && h.issue.category === theirAttribution.category,
            )
          : -1;
      const shopper: ShopperResult = {
        kind: agentKind,
        name: missionRun.agentName,
        status,
        line,
        cost: formatUsd(costRow?.estimatedCostUsd),
        failing,
        benchmark: agentKind === BENCHMARK_KIND,
      };
      const multiple = relativeCostLabel(report.costComparison, agentKind, names);
      if (multiple) shopper.multiple = multiple;
      if (attributedTo >= 0 && theirAttribution?.category !== issue.category) {
        shopper.attributedTo = attributedTo;
      }
      shoppers.push(shopper);
    }

    const labels = [CHECKPOINT_LABELS[issue.checkpointId], CHECKPOINT_LABELS[rowId]];
    // Two recommendations can name the same checkpoint; the category's own words break the tie.
    const keywords = CATEGORY_WORDS[issue.category] ?? [];
    const candidates = report.recommendations.filter((r) => labels.some((l) => r.includes(l)));
    const recommendation =
      candidates.find((r) => keywords.some((w) => r.toLowerCase().includes(w))) ?? candidates[0];

    const card: ProblemData = {
      issue,
      rowId,
      rowLabel: CHECKPOINT_LABELS[rowId],
      checkpointLabel: CHECKPOINT_LABELS[issue.checkpointId],
      where,
      shoppers,
      cost: kind ? costLine(report.costComparison, kind, names) : '',
    };
    if (attribution) card.attribution = attribution;
    if (screenshotUrl) card.screenshotUrl = screenshotUrl;
    if (run?.failurePoint) card.failingStep = run.failurePoint.stepIndex + 1;
    if (run?.failurePoint?.perceived) card.excerpt = run.failurePoint.perceived;
    if (target) card.target = target;
    if (!screenshotUrl && observedCarts[issue.runId])
      card.observedCart = observedCarts[issue.runId];
    if (recommendation) card.recommendation = recommendation;
    return card;
  });
}
