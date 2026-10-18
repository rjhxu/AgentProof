import type {
  AgentKind,
  AgentReport,
  Checkpoint,
  CheckpointId,
  FailureCategory,
  FailurePoint,
  Mission,
  MissionReport,
  MissionRequirements,
  ObservedCart,
  Run,
} from '@agentproof/shared';
import { CHECKPOINT_LABELS } from '@agentproof/shared';
import { summarizeStep } from '@agentproof/agent';

export const EVIDENCE_MAX_CHARS = 9000;
export const MAX_STEP_LINES = 30;
export const JSON_BLOCK_MAX_CHARS = 1500;

export interface EvidenceBundleInput {
  mission: Mission;
  run: Run;
  checkpoint: Checkpoint;
  agentReport?: AgentReport;
  missionReport?: MissionReport;
}

export interface EvidenceBundle {
  agentKind: AgentKind;
  checkpointId: CheckpointId;
  checkpointLabel: string;
  observed: string;
  attributionCategory?: FailureCategory;
  attributionReason?: string;
  attributionPattern?: Record<string, string>;
  requirements: MissionRequirements;
  successMilestone: string;
  storeUrl: string;
  stepLines: string[];
  stepsTotal: number;
  failurePoint?: FailurePoint;
  observedCart?: ObservedCart;
  catalogRecord?: unknown;
  cartApi?: unknown;
  claim?: string;
  visitedUrls: string[];
}

export function buildEvidenceBundle(input: EvidenceBundleInput): EvidenceBundle {
  const { mission, run, checkpoint, agentReport, missionReport } = input;

  // Get checkpoint label
  const checkpointLabel = CHECKPOINT_LABELS[checkpoint.id];

  // Get observed detail or fallback
  const observed = checkpoint.detail ?? `Checkpoint ${checkpoint.id} failed`;

  // Extract attribution if available
  let attributionCategory: FailureCategory | undefined;
  let attributionReason: string | undefined;
  let attributionPattern: Record<string, string> | undefined;

  if (missionReport) {
    const attribution = missionReport.attributions.find((a) => a.checkpointId === checkpoint.id);
    if (attribution) {
      attributionCategory = attribution.category;
      attributionReason = attribution.reason;
      attributionPattern = attribution.pattern;
    }
  }

  // Build step lines using summarizeStep
  const allStepLines = run.steps.map((step) => summarizeStep(step));
  const stepsTotal = run.steps.length;

  // Find failure step index
  let failureStepIndex: number | undefined;
  if (agentReport?.failurePoint) {
    failureStepIndex = agentReport.failurePoint.stepIndex;
  } else {
    // Find first non-ok step
    for (let i = 0; i < run.steps.length; i++) {
      if (run.steps[i]?.outcome !== 'ok') {
        failureStepIndex = i;
        break;
      }
    }
  }

  // Window steps around failure
  let stepLines: string[];
  if (failureStepIndex !== undefined && allStepLines.length > MAX_STEP_LINES) {
    const center = failureStepIndex;
    const halfWindow = Math.floor(MAX_STEP_LINES / 2);
    const start = Math.max(0, center - halfWindow);
    const end = Math.min(allStepLines.length, start + MAX_STEP_LINES);
    stepLines = allStepLines.slice(start, end);
  } else {
    stepLines = allStepLines.slice(0, MAX_STEP_LINES);
  }

  // Extract visitedUrls as unique pathnames
  const urlSet = new Set<string>();
  for (const step of run.steps) {
    if (step.url) {
      try {
        const url = new URL(step.url);
        const pathname = url.pathname;
        urlSet.add(pathname);
      } catch {
        // Skip invalid URLs
      }
    }
  }
  const visitedUrls = Array.from(urlSet).slice(0, 10);

  // Extract failurePoint
  const failurePoint = agentReport?.failurePoint;

  // Extract observedCart
  const observedCart = run.verification?.observedCart ?? agentReport?.observedCart;

  // Extract catalog record (first evidence with kind 'catalog_record')
  let catalogRecord: unknown;
  for (const evidence of run.evidence) {
    if (evidence.kind === 'catalog_record' && evidence.data) {
      catalogRecord = evidence.data;
      break;
    }
  }

  // Extract cartApi (first evidence with kind 'network' or 'cart_state')
  let cartApi: unknown;
  for (const evidence of run.evidence) {
    if (evidence.kind === 'network' && evidence.data) {
      cartApi = evidence.data;
      break;
    }
  }
  if (!cartApi) {
    for (const evidence of run.evidence) {
      if (
        evidence.kind === 'cart_state' &&
        evidence.data &&
        run.agent.kind === 'gamma_structured'
      ) {
        cartApi = evidence.data;
        break;
      }
    }
  }

  // Extract claim summary
  const claim = run.claim?.summary;

  return {
    agentKind: run.agent.kind,
    checkpointId: checkpoint.id,
    checkpointLabel,
    observed,
    attributionCategory,
    attributionReason,
    attributionPattern,
    requirements: mission.requirements,
    successMilestone: mission.successMilestone,
    storeUrl: mission.storeUrl,
    stepLines,
    stepsTotal,
    failurePoint,
    observedCart,
    catalogRecord,
    cartApi,
    claim,
    visitedUrls,
  };
}

/** Truncate JSON to JSON_BLOCK_MAX_CHARS with [truncated] marker */
function truncateJson(value: unknown): string {
  let json = JSON.stringify(value, null, 2);
  if (json.length > JSON_BLOCK_MAX_CHARS) {
    json = json.slice(0, JSON_BLOCK_MAX_CHARS) + '\n[truncated]';
  }
  return json;
}

interface RenderParts {
  mission: string;
  checkpoint: string;
  attribution: string | null;
  failurePoint: string | null;
  steps: string;
  observedCart: string | null;
  catalogRecord: string | null;
  cartApi: string | null;
  claim: string | null;
  visitedUrls: string;
}

function renderPartsToString(parts: RenderParts): string {
  const sections: string[] = [];

  sections.push('## Mission');
  sections.push(parts.mission);

  sections.push('## Failed checkpoint (observed by code)');
  sections.push(parts.checkpoint);

  if (parts.attribution) {
    sections.push('## Attribution (code, from the cross-agent pattern)');
    sections.push(parts.attribution);
  }

  if (parts.failurePoint) {
    sections.push('## Failure point');
    sections.push(parts.failurePoint);
  }

  sections.push('## Steps');
  sections.push(parts.steps);

  if (parts.observedCart) {
    sections.push('## Cart as observed through the store API');
    sections.push(parts.observedCart);
  }

  if (parts.catalogRecord) {
    sections.push('## Catalog record (Gamma)');
    sections.push(parts.catalogRecord);
  }

  if (parts.cartApi) {
    sections.push('## Cart API response (Gamma)');
    sections.push(parts.cartApi);
  }

  if (parts.claim) {
    sections.push("## Agent's own stopping claim (not a verdict)");
    sections.push(parts.claim);
  }

  sections.push('## Pages visited');
  sections.push(parts.visitedUrls);

  return sections.join('\n\n');
}

export function renderEvidenceBundle(bundle: EvidenceBundle): string {
  // Render all parts first
  let parts: RenderParts = {
    mission: renderMission(bundle),
    checkpoint: renderCheckpoint(bundle),
    attribution: bundle.attributionCategory ? renderAttribution(bundle) : null,
    failurePoint: bundle.failurePoint ? renderFailurePoint(bundle.failurePoint) : null,
    steps: renderSteps(bundle),
    observedCart: bundle.observedCart
      ? `\`\`\`json\n${truncateJson(bundle.observedCart)}\n\`\`\``
      : null,
    catalogRecord: bundle.catalogRecord
      ? `\`\`\`json\n${truncateJson(bundle.catalogRecord)}\n\`\`\``
      : null,
    cartApi: bundle.cartApi ? `\`\`\`json\n${truncateJson(bundle.cartApi)}\n\`\`\`` : null,
    claim: bundle.claim ? bundle.claim : null,
    visitedUrls: renderVisitedUrls(bundle),
  };

  let result = renderPartsToString(parts);

  // If over limit, truncate in order
  if (result.length > EVIDENCE_MAX_CHARS) {
    // Try removing catalog
    if (parts.catalogRecord) {
      parts.catalogRecord = null;
      result = renderPartsToString(parts);
    }

    // Try removing cartApi
    if (result.length > EVIDENCE_MAX_CHARS && parts.cartApi) {
      parts.cartApi = null;
      result = renderPartsToString(parts);
    }

    // Try truncating perceived in failurePoint
    if (
      result.length > EVIDENCE_MAX_CHARS &&
      parts.failurePoint &&
      bundle.failurePoint?.perceived
    ) {
      parts.failurePoint = renderFailurePointTruncated(bundle.failurePoint, 500);
      result = renderPartsToString(parts);
    }

    // Try removing steps from the end
    if (result.length > EVIDENCE_MAX_CHARS && bundle.stepLines.length > 1) {
      const originalSteps = bundle.stepLines.length;
      const reducedSteps = Math.max(
        1,
        Math.floor((originalSteps * EVIDENCE_MAX_CHARS) / result.length) - 2,
      );
      const newStepLines = bundle.stepLines.slice(0, reducedSteps);
      const stepsText = newStepLines.join('\n');
      const stepsSection = `#${bundle.stepsTotal > bundle.stepLines.length ? reducedSteps : reducedSteps} of ${bundle.stepsTotal}\n${stepsText}`;
      parts.steps = stepsSection + '\n[truncated]';
      result = renderPartsToString(parts);
    }
  }

  // Final safety check
  if (result.length > EVIDENCE_MAX_CHARS) {
    result = result.slice(0, EVIDENCE_MAX_CHARS - 15) + '\n[truncated]';
  }

  return result;
}

function renderMission(bundle: EvidenceBundle): string {
  const lines: string[] = [];
  lines.push(`Product: ${bundle.requirements.product}`);

  // Attributes
  const attrs = bundle.requirements.attributes;
  if (Object.keys(attrs).length > 0) {
    for (const [key, value] of Object.entries(attrs)) {
      lines.push(`  ${key}=${value}`);
    }
  }

  lines.push(`Quantity: ${bundle.requirements.quantity}`);

  if (bundle.requirements.maxUnitPrice !== undefined) {
    lines.push(`Max unit price: ${bundle.requirements.maxUnitPrice.toFixed(2)}`);
  }
  if (bundle.requirements.maxTotalPrice !== undefined) {
    lines.push(`Max total price: ${bundle.requirements.maxTotalPrice.toFixed(2)}`);
  }

  lines.push(`Success milestone: ${bundle.successMilestone}`);
  lines.push(`Store URL: ${bundle.storeUrl}`);

  return lines.join('\n');
}

function renderCheckpoint(bundle: EvidenceBundle): string {
  return `${bundle.checkpointId} (${bundle.checkpointLabel}): ${bundle.observed}`;
}

function renderAttribution(bundle: EvidenceBundle): string {
  const lines: string[] = [];
  if (bundle.attributionReason) {
    lines.push(bundle.attributionReason);
  }
  if (bundle.attributionPattern) {
    lines.push('');
    lines.push('Agent results:');
    for (const [kind, status] of Object.entries(bundle.attributionPattern)) {
      lines.push(`  ${kind}: ${status}`);
    }
  }
  return lines.join('\n');
}

function renderFailurePoint(failurePoint: FailurePoint): string {
  const lines: string[] = [];
  lines.push(`Step: ${failurePoint.stepIndex}`);
  if (failurePoint.url) {
    lines.push(`URL: ${failurePoint.url}`);
  }
  lines.push(`Attempted: ${failurePoint.attempted}`);
  lines.push(`Outcome: ${failurePoint.outcome}`);
  if (failurePoint.perceived) {
    lines.push('');
    lines.push('Perceived:');
    lines.push('```text');
    lines.push(failurePoint.perceived);
    lines.push('```');
  }
  return lines.join('\n');
}

function renderFailurePointTruncated(
  failurePoint: FailurePoint,
  maxPerceivedChars: number,
): string {
  const lines: string[] = [];
  lines.push(`Step: ${failurePoint.stepIndex}`);
  if (failurePoint.url) {
    lines.push(`URL: ${failurePoint.url}`);
  }
  lines.push(`Attempted: ${failurePoint.attempted}`);
  lines.push(`Outcome: ${failurePoint.outcome}`);
  if (failurePoint.perceived) {
    lines.push('');
    lines.push('Perceived:');
    lines.push('```text');
    if (failurePoint.perceived.length > maxPerceivedChars) {
      lines.push(failurePoint.perceived.slice(0, maxPerceivedChars));
      lines.push('[truncated]');
    } else {
      lines.push(failurePoint.perceived);
    }
    lines.push('```');
  }
  return lines.join('\n');
}

function renderSteps(bundle: EvidenceBundle): string {
  if (bundle.stepLines.length === 0) {
    return '(no steps)';
  }

  const stepsShown = bundle.stepLines.length;
  const header = `(${stepsShown} of ${bundle.stepsTotal})`;
  return `${header}\n${bundle.stepLines.join('\n')}`;
}

function renderVisitedUrls(bundle: EvidenceBundle): string {
  if (bundle.visitedUrls.length === 0) {
    return '(none)';
  }
  return bundle.visitedUrls.map((url) => `- ${url}`).join('\n');
}
