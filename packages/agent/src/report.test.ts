import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AGENT_LABELS,
  AgentReport,
  CHECKPOINT_ORDER,
  EMPTY_USAGE,
  MissionReport,
  type AgentKind,
  type AgentProfileSummary,
  type Checkpoint,
  type LlmUsage,
  type Run,
} from '@agentproof/shared';
import { alphaFailedRun, hoodieMission } from '@agentproof/shared/fixtures';
import {
  buildAgentReport,
  buildMissionReport,
  listRunArtifacts,
  renderAgentReportMarkdown,
  renderMissionReportMarkdown,
  writeReportFiles,
} from './report';

const ARIA_EXCERPT = [
  '- heading "Black Hoodie" [level=1]',
  '- paragraph: $49.00',
  '- text: Size',
  '- text: S',
  '- text: M',
  '- text: L',
  '- combobox "Quantity"',
  '- button "Add to cart"',
].join('\n');

const SNAPSHOT_PATH = 'run_demo0000alpha/step-001.aria.txt';
/** A snapshot with runs of blank lines: the fenced block must carry it verbatim. */
const SPACED_SNAPSHOT_PATH = 'run_demo0000alpha/step-001.spaced.txt';
const SPACED_SNAPSHOT = '- heading "Black Hoodie"\n\n\n\n- button "Add to cart"\n';

const alphaProfile: AgentProfileSummary = {
  kind: 'alpha_semantic',
  name: AGENT_LABELS.alpha_semantic.name,
  strategy: AGENT_LABELS.alpha_semantic.strategy,
  perceives: ['accessibility tree (role + name)', 'page text excerpt', 'URL and title'],
  targetGrammars: ['role:name'],
  model: 'test-model-small',
  provider: 'mock',
  effort: 'low',
};

const betaProfile: AgentProfileSummary = {
  kind: 'beta_vision',
  name: AGENT_LABELS.beta_vision.name,
  strategy: AGENT_LABELS.beta_vision.strategy,
  perceives: ['viewport screenshot', 'URL and title'],
  targetGrammars: ['x,y'],
  model: 'test-model-vision',
  provider: 'mock',
};

const NARRATIVE =
  'I found the hoodie but could not find a size control in the accessibility tree, so I added the default size.';

/** The fixture run with a file-backed aria snapshot linked to the errored step. */
function alphaRunWithSnapshot(snapshotPath = SNAPSHOT_PATH): Run {
  const run = structuredClone(alphaFailedRun);
  run.evidence.push({
    id: 'ev_demo0000snap',
    runId: run.id,
    kind: 'dom_snapshot',
    stepIndex: 1,
    capturedAt: '2026-10-17T20:00:15.500Z',
    label: 'Accessibility tree of main',
    path: snapshotPath,
  });
  run.steps[1]!.snapshotEvidenceId = 'ev_demo0000snap';
  return run;
}

/** The fixture run with every step ok and every checkpoint passed. */
function alphaPassedRun(): Run {
  const run = structuredClone(alphaFailedRun);
  run.status = 'passed';
  run.steps = run.steps.map((s) => ({ ...s, outcome: 'ok' as const, outcomeDetail: undefined }));
  run.verification = {
    ...run.verification!,
    checkpoints: run.verification!.checkpoints.map((c) => ({ ...c, status: 'passed' as const })),
    firstFailure: undefined,
  };
  run.claim = { outcome: 'done', summary: 'Reached checkout' };
  return run;
}

function build(run: Run, profile = alphaProfile, narrative = ''): AgentReport {
  return buildAgentReport({ mission: hoodieMission, run, profile, narrative, artifactsRoot });
}

let artifactsRoot: string;

beforeAll(() => {
  artifactsRoot = mkdtempSync(path.join(os.tmpdir(), 'agentproof-report-'));
  const runDir = path.join(artifactsRoot, alphaFailedRun.id);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(path.join(runDir, 'step-000.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  writeFileSync(path.join(runDir, 'step-001.aria.txt'), ARIA_EXCERPT, 'utf8');
  writeFileSync(path.join(runDir, 'step-001.spaced.txt'), SPACED_SNAPSHOT, 'utf8');
  writeFileSync(path.join(runDir, 'trace.zip'), Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  // A previously generated report must not be listed as an artifact of the run it describes.
  writeFileSync(path.join(runDir, 'report.json'), '{}\n', 'utf8');
  writeFileSync(path.join(runDir, 'report.md'), '# stale\n', 'utf8');
});

afterAll(() => {
  rmSync(artifactsRoot, { recursive: true, force: true });
});

describe('buildAgentReport', () => {
  it('pinpoints the errored select, reads the aria snapshot, resolves paths and validates', () => {
    const run = alphaRunWithSnapshot();
    const report = build(run, alphaProfile, NARRATIVE);

    expect(report.runId).toBe(run.id);
    expect(report.status).toBe('failed');
    expect(report.agent).toEqual(alphaProfile);
    expect(report.narrative).toBe(NARRATIVE);

    const fp = report.failurePoint!;
    expect(fp.stepIndex).toBe(1);
    expect(fp.url).toBe('http://localhost:5000/products/black-hoodie');
    expect(fp.attempted).toContain('combobox:Size');
    expect(fp.attempted).toContain('Mission requires size M');
    expect(fp.outcome).toBe(run.steps[1]!.outcomeDetail);
    expect(fp.perceived).toContain('- text: M');
    expect(fp.perceived).toContain('- button "Add to cart"');
    expect(fp.perceived.length).toBeLessThanOrEqual(2000);
    expect(fp.snapshotPath).toBe(SNAPSHOT_PATH);

    expect(report.steps[0]!.screenshotPath).toBe('run_demo0000alpha/step-000.png');
    expect(report.steps[1]!.snapshotPath).toBe(SNAPSHOT_PATH);
    expect(report.artifacts).toEqual([
      'run_demo0000alpha/step-000.png',
      'run_demo0000alpha/step-001.aria.txt',
      'run_demo0000alpha/step-001.spaced.txt',
      'run_demo0000alpha/trace.zip',
    ]);

    expect(report.durationMs).toBe(66_000);
    expect(report.usage).toEqual(EMPTY_USAGE);
    expect(report.checkpoints).toHaveLength(8);
    expect(report.firstFailure?.id).toBe('correct_size_identified');
    expect(report.observedCart?.source).toBe('api');
    expect(report.evidenceIds).toEqual(
      expect.arrayContaining([
        'ev_demo00000001',
        'ev_demo00000002',
        'ev_demo00000003',
        'ev_demo0000snap',
      ]),
    );

    expect(() => AgentReport.parse(report)).not.toThrow();
    expect(() => AgentReport.parse(JSON.parse(JSON.stringify(report)))).not.toThrow();
  });

  it('skips stale report files when listing artifacts unless told otherwise', () => {
    expect(listRunArtifacts(artifactsRoot, alphaFailedRun.id)).not.toContain(
      'run_demo0000alpha/report.md',
    );
    expect(listRunArtifacts(artifactsRoot, alphaFailedRun.id, { exclude: [] })).toEqual(
      expect.arrayContaining(['run_demo0000alpha/report.json', 'run_demo0000alpha/report.md']),
    );
    expect(listRunArtifacts(artifactsRoot, 'run_missing')).toEqual([]);
  });

  it('falls back to inline snapshot data and an empty artifact list without throwing', () => {
    const report = buildAgentReport({
      mission: hoodieMission,
      run: alphaFailedRun,
      profile: alphaProfile,
      narrative: '',
      artifactsRoot: path.join(artifactsRoot, 'does-not-exist'),
    });
    expect(report.failurePoint?.stepIndex).toBe(1);
    expect(report.failurePoint?.perceived).toContain('<div class="chip">M</div>');
    expect(report.failurePoint?.snapshotPath).toBeUndefined();
    expect(report.artifacts).toEqual([]);
  });

  it('notes a missing snapshot file instead of throwing', () => {
    const report = build(alphaRunWithSnapshot('run_demo0000alpha/missing.txt'));
    expect(report.failurePoint?.perceived).toContain('not readable');
    expect(report.failurePoint?.perceived).toContain('run_demo0000alpha/missing.txt');
  });

  it('never reads binary evidence linked as a snapshot as if it were text', () => {
    const run = structuredClone(alphaFailedRun);
    // A runner mistake: the step-000 screenshot linked under snapshotEvidenceId.
    run.steps[1]!.snapshotEvidenceId = 'ev_demo00000001';
    const report = build(run);
    expect(report.failurePoint?.perceived).not.toContain('PNG');
    expect(report.failurePoint?.perceived).toContain('<div class="chip">M</div>');
    expect(report.steps[1]!.snapshotPath).toBeUndefined();
    expect(report.steps[1]!.screenshotPath).toBeUndefined();
  });

  it('normalizes Windows path separators in evidence paths', () => {
    const run = alphaRunWithSnapshot('run_demo0000alpha\\step-001.aria.txt');
    run.evidence[0]!.path = 'run_demo0000alpha\\step-000.png';
    const report = build(run);
    expect(report.steps[0]!.screenshotPath).toBe('run_demo0000alpha/step-000.png');
    expect(report.steps[1]!.snapshotPath).toBe(SNAPSHOT_PATH);
    expect(report.failurePoint?.snapshotPath).toBe(SNAPSHOT_PATH);
    expect(report.failurePoint?.perceived).toContain('- text: M');
    expect(renderAgentReportMarkdown(report)).toContain(
      '[run_demo0000alpha/step-000.png](step-000.png)',
    );
  });

  it('says "screenshot only" for a vision agent with no snapshot', () => {
    const run = structuredClone(alphaFailedRun);
    run.agent.kind = 'beta_vision';
    run.evidence = run.evidence.filter((e) => e.kind !== 'dom_snapshot');
    run.evidence.push({
      id: 'ev_demo00000002',
      runId: run.id,
      kind: 'screenshot',
      stepIndex: 1,
      capturedAt: '2026-10-17T20:00:15.000Z',
      path: 'run_demo0000alpha/step-001.png',
    });
    const report = build(run, betaProfile);
    expect(report.failurePoint?.perceived).toContain('screenshot only (see screenshotPath');
    expect(report.failurePoint?.screenshotPath).toBe('run_demo0000alpha/step-001.png');
  });

  it('uses the last mutating step before "done" when only the verifier failed', () => {
    const run = structuredClone(alphaFailedRun);
    run.steps = [
      { ...run.steps[0]!, outcome: 'ok', outcomeDetail: undefined },
      {
        index: 1,
        at: '2026-10-17T20:00:10.000Z',
        url: 'http://localhost:5000/products/black-hoodie',
        action: { type: 'click', target: 'button:Add to cart', reason: 'Add the hoodie' },
        outcome: 'ok',
      },
      {
        index: 2,
        at: '2026-10-17T20:00:12.000Z',
        url: 'http://localhost:5000/cart',
        action: { type: 'extract', what: 'cart contents', reason: 'Confirm the cart' },
        outcome: 'ok',
      },
      {
        index: 3,
        at: '2026-10-17T20:00:14.000Z',
        url: 'http://localhost:5000/checkout',
        action: { type: 'done', summary: 'Reached checkout' },
        outcome: 'ok',
      },
    ];
    const report = build(run);
    expect(report.failurePoint?.stepIndex).toBe(1);
    expect(report.failurePoint?.attempted).toContain('click button:Add to cart');
    expect(report.failurePoint?.outcome).toBe(run.verification!.firstFailure!.detail);
  });

  it('has no failure point for a clean pass and sums step durations without timestamps', () => {
    const run = alphaPassedRun();
    run.startedAt = undefined;
    run.finishedAt = undefined;
    run.steps[1]!.usage = { ...EMPTY_USAGE, calls: 1, inputTokens: 1200, outputTokens: 40 };
    run.steps[2]!.usage = { ...EMPTY_USAGE, calls: 1, inputTokens: 1300, outputTokens: 50 };
    const report = build(run);
    expect(report.failurePoint).toBeUndefined();
    expect(report.durationMs).toBe(820 + 5100 + 640);
    expect(report.usage).toMatchObject({ calls: 2, inputTokens: 2500, outputTokens: 90 });
    expect(renderAgentReportMarkdown(report)).toContain(
      'No divergence: every action executed and the verifier found no failed checkpoint.',
    );
  });

  it('does not call a recovered invalid action a divergence when the run passed', () => {
    const run = alphaPassedRun();
    run.steps[1]!.outcome = 'invalid_action';
    run.steps[1]!.outcomeDetail = 'click target "text:M" is not x,y';
    const report = build(run, betaProfile);
    expect(report.failurePoint).toBeUndefined();
    expect(() => AgentReport.parse(report)).not.toThrow();

    const md = renderAgentReportMarkdown(report);
    expect(md).toContain('- **Status:** passed (verifier verdict)');
    expect(md).toContain('No divergence: the verifier found no failed checkpoint.');
    expect(md).toContain('1 action did not execute and the agent recovered');
    expect(md).toContain(
      '- Step 1: select "M" in combobox:Size -> invalid_action: click target "text:M" is not x,y',
    );
    expect(md).not.toContain('- **Attempted:**');
    expect(md).not.toContain('### What the agent perceived at that step');
  });

  it('carries run.errorMessage into the failure point of an errored run', () => {
    const message = 'Browser crashed: Target page, context or browser has been closed';

    // No step failed: the run stopped after its last step.
    const crashed = alphaPassedRun();
    crashed.status = 'error';
    crashed.errorMessage = message;
    crashed.verification = undefined;
    const report = build(crashed);
    expect(report.failurePoint).toMatchObject({
      stepIndex: 2,
      attempted: 'click button:Add to cart; reason: Proceed with default size',
      outcome: `run ended with a runner error: ${message}`,
    });
    expect(() => AgentReport.parse(report)).not.toThrow();
    const md = renderAgentReportMarkdown(report);
    expect(md).toContain('- **Status:** error (runner or infrastructure error, not a verdict)');
    expect(md).toContain('The run ended with a runner or infrastructure error.');
    expect(md).toContain(`- **Outcome:** run ended with a runner error: ${message}`);

    // A step failed first: it stays the failure point and the run error is appended.
    const stepThenCrash = structuredClone(alphaFailedRun);
    stepThenCrash.status = 'error';
    stepThenCrash.errorMessage = message;
    const fp = build(stepThenCrash).failurePoint!;
    expect(fp.stepIndex).toBe(1);
    expect(fp.outcome).toBe(
      `${alphaFailedRun.steps[1]!.outcomeDetail}; run ended with a runner error: ${message}`,
    );

    // Nothing recorded at all: still a valid failure point that carries the message.
    const empty = structuredClone(alphaFailedRun);
    empty.status = 'error';
    empty.errorMessage = message;
    empty.steps = [];
    empty.evidence = [];
    empty.verification = undefined;
    const emptyReport = build(empty);
    expect(emptyReport.failurePoint).toMatchObject({
      stepIndex: 0,
      attempted: '(no steps recorded)',
      outcome: `run ended with a runner error: ${message}`,
    });
    expect(() => AgentReport.parse(emptyReport)).not.toThrow();
    expect(renderAgentReportMarkdown(emptyReport)).toContain(
      '- **Step:** index 0 (no steps recorded)',
    );
  });
});

describe('renderAgentReportMarkdown', () => {
  it('renders every section in order with the verdict table, the divergence, and escaped pipes', () => {
    const run = alphaRunWithSnapshot();
    run.steps[2]!.action = {
      type: 'click',
      target: 'button:Add to cart',
      reason: 'Proceed | default size',
    };
    run.verification!.checkpoints[4]!.detail = 'Cart contained size S | mission required size M.';
    const report = build(run, alphaProfile, NARRATIVE);
    const md = renderAgentReportMarkdown(report);

    const headings = [
      '# Agent Alpha report: black hoodie on localhost:5000',
      '## What this agent can perceive',
      '## Mission',
      '## Result',
      '## Observed cart',
      '## Where it diverged',
      '### What the agent perceived at that step',
      '## Step log',
      '## Agent narrative',
      '## Artifacts',
    ];
    const positions = headings.map((h) => md.indexOf(h));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);

    expect(md).toContain('- **Status:** failed (verifier verdict)');
    expect(md).toContain('- **Model:** test-model-small, mock, effort low');
    expect(md).toContain('- **Steps used:** 3 of 25');
    expect(md).toContain('- **Estimated cost:** $0.00 (no model calls recorded)');
    expect(md).toContain('- accessibility tree (role + name)');
    expect(md).toContain('Targets controls by: `role:name`');
    expect(md).toContain('"product": "black hoodie"');

    expect(md).toContain('| Product discovered | passed |');
    expect(md).toContain('| **Correct size identified** | **failed** |');
    expect(md).toContain(
      '| Cart matches requested variant | failed | Cart contained size S \\| mission required size M. |',
    );
    expect(md).toContain('First failure: **Correct size identified**');

    expect(md).toContain('| Black Hoodie | HOODIE-001-S | color=black, size=S | 49.00 | 1 |');

    expect(md).toContain('- **Step:** index 1 (step 2 of 3)');
    expect(md).toContain(
      '- **Attempted:** select "M" in combobox:Size; reason: Mission requires size M',
    );
    expect(md).toContain('```text\n' + ARIA_EXCERPT + '\n```');
    // Links: text is the artifacts-relative path (as in the JSON); the href resolves from the
    // run directory, where <run.id>/report.md is written.
    expect(md).toContain(`- Snapshot: [${SNAPSHOT_PATH}](step-001.aria.txt)`);
    expect(md).toContain('[run_demo0000alpha/step-000.png](step-000.png)');
    expect(md).not.toContain('Proceed | default size');
    expect(md).toContain("agent's own account");
    expect(md).toContain('not a verdict');
    expect(md).toContain(NARRATIVE);
    expect(md).toContain('- [run_demo0000alpha/trace.zip](trace.zip)');
    expect(md).not.toContain('report.md](');
    expect(md).not.toMatch(/\n{3,}/);
  });

  it('makes link hrefs relative to the directory the report is written to', () => {
    const report = build(alphaRunWithSnapshot());
    const atRoot = renderAgentReportMarkdown(report, { linkBase: '' });
    expect(atRoot).toContain('[run_demo0000alpha/step-000.png](run_demo0000alpha/step-000.png)');
    expect(atRoot).toContain(`- Snapshot: [${SNAPSHOT_PATH}](${SNAPSHOT_PATH})`);

    const nested = renderAgentReportMarkdown(report, { linkBase: 'reports\\run_demo0000alpha/' });
    expect(nested).toContain(
      '[run_demo0000alpha/step-000.png](../../run_demo0000alpha/step-000.png)',
    );

    const inPlace = renderAgentReportMarkdown(report, { linkBase: report.runId });
    expect(inPlace).toBe(renderAgentReportMarkdown(report));
  });

  it('flattens multi-line Playwright errors in the divergence bullets but not in the JSON', () => {
    const run = structuredClone(alphaFailedRun);
    const playwrightError =
      "locator.selectOption: Timeout 5000ms exceeded.\nCall log:\n  - waiting for getByRole('combobox', { name: 'Size' })\n";
    run.steps[1]!.outcomeDetail = playwrightError;
    const report = build(run);
    expect(report.failurePoint?.outcome).toBe(playwrightError);
    const md = renderAgentReportMarkdown(report);
    expect(md).toContain(
      "- **Outcome:** locator.selectOption: Timeout 5000ms exceeded. Call log: - waiting for getByRole('combobox', { name: 'Size' })\n",
    );
    expect(md).not.toContain('\nCall log:');
    expect(md).toContain("| 1 | select \"M\" in combobox:Size | error | locator.selectOption:");
  });

  it('keeps the perceived block and the narrative verbatim', () => {
    const run = alphaRunWithSnapshot(SPACED_SNAPSHOT_PATH);
    const narrative = 'First paragraph.\n\n\n\nSecond paragraph after three blank lines.';
    const report = build(run, alphaProfile, narrative);
    expect(report.failurePoint?.perceived).toBe(SPACED_SNAPSHOT);
    const md = renderAgentReportMarkdown(report);
    expect(md).toContain('```text\n' + SPACED_SNAPSHOT + '\n```');
    expect(md).toContain(narrative);
  });

  it('distinguishes "no model calls" from "no price for this model"', () => {
    const run = structuredClone(alphaFailedRun);
    run.usage = { ...EMPTY_USAGE, calls: 2, inputTokens: 100, outputTokens: 10 };
    expect(renderAgentReportMarkdown(build(run))).toContain(
      '- **Estimated cost:** not available (no price for this model)',
    );
    run.usage = { ...run.usage, estimatedCostUsd: 0.012 };
    expect(renderAgentReportMarkdown(build(run))).toContain(
      '- **Estimated cost:** $0.012 (estimated from a static price table; not provider-reported)',
    );
    run.usage = undefined;
    expect(renderAgentReportMarkdown(build(run))).toContain(
      '- **Estimated cost:** $0.00 (no model calls recorded)',
    );
  });
});

// ---------------------------------------------------------------------------------------------
// Mission report
// ---------------------------------------------------------------------------------------------

function cp(id: Checkpoint['id'], status: Checkpoint['status'], detail?: string): Checkpoint {
  return { id, status, detail, evidenceIds: [] };
}

function derivedRun(
  kind: AgentKind,
  id: string,
  createdAt: string,
  checkpoints: Checkpoint[],
  usage?: LlmUsage,
): Run {
  const run = structuredClone(alphaFailedRun);
  const firstFailure = checkpoints.find((c) => c.status === 'failed');
  run.id = id;
  run.agent = { ...run.agent, kind };
  run.status = firstFailure ? 'failed' : 'passed';
  run.createdAt = createdAt;
  run.usage = usage;
  run.steps = run.steps.map((s) => ({ ...s, outcome: 'ok' as const, outcomeDetail: undefined }));
  run.verification = { ...run.verification!, checkpoints, firstFailure };
  run.claim = { outcome: firstFailure ? 'fail' : 'done', summary: 'derived fixture' };
  return run;
}

const allPassed = alphaFailedRun.verification!.checkpoints.map((c) => cp(c.id, 'passed'));

const alphaUsage: LlmUsage = {
  ...EMPTY_USAGE,
  calls: 3,
  inputTokens: 9000,
  outputTokens: 300,
  estimatedCostUsd: 0.012,
};

const sigmaUsage: LlmUsage = {
  ...EMPTY_USAGE,
  calls: 6,
  inputTokens: 42_000,
  outputTokens: 900,
  imageInputs: 6,
  estimatedCostUsd: 0.05,
};

const alphaRun: Run = { ...structuredClone(alphaFailedRun), usage: alphaUsage };

const sigmaRun = derivedRun(
  'sigma_hybrid',
  'run_demo0000sigma',
  '2026-10-17T20:05:00.000Z',
  allPassed,
  sigmaUsage,
);

const gammaRun: Run = {
  ...derivedRun('gamma_structured', 'run_demo0000gamma', '2026-10-17T20:06:00.000Z', [
    cp('product_discovered', 'passed'),
    cp('added_to_cart', 'passed'),
    cp(
      'cart_matches_variant',
      'failed',
      'Catalog advertised HOODIE-001-M; cart returned HOODIE-001-S.',
    ),
    cp('catalog_variant_resolves', 'failed', 'Variant id HOODIE-001-M resolved to size S.'),
    cp('catalog_price_matches_page', 'passed'),
  ]),
  steps: [],
  evidence: [],
};
gammaRun.agent = { ...gammaRun.agent, model: undefined };

describe('buildMissionReport', () => {
  const report = buildMissionReport({
    mission: hoodieMission,
    runs: [alphaRun, sigmaRun, gammaRun],
  });

  it('orders runs alpha, sigma, gamma and fills the checkpoint matrix with not_run gaps', () => {
    expect(report.runs.map((r) => r.agentKind)).toEqual([
      'alpha_semantic',
      'sigma_hybrid',
      'gamma_structured',
    ]);
    expect(report.runs.map((r) => r.status)).toEqual(['failed', 'passed', 'failed']);
    expect(report.runs[2]!.model).toBe('none (no LLM)');
    expect(report.runs[2]!.stepsUsed).toBe(0);

    expect(Object.keys(report.matrix).sort()).toEqual([...CHECKPOINT_ORDER].sort());
    expect(report.matrix.correct_size_identified).toEqual({
      alpha_semantic: 'failed',
      beta_vision: 'not_run',
      sigma_hybrid: 'passed',
      gamma_structured: 'not_run',
    });
    expect(report.matrix.cart_matches_variant.gamma_structured).toBe('failed');
    expect(report.matrix.cart_matches_variant.alpha_semantic).toBe('failed');
    expect(report.matrix.catalog_variant_resolves.gamma_structured).toBe('failed');
    expect(report.matrix.catalog_variant_resolves.sigma_hybrid).toBe('not_run');
  });

  it('attributes Alpha to the semantic interface and Gamma to product data', () => {
    const categories = [...new Set(report.attributions.map((a) => a.category))].sort();
    expect(categories).toEqual(['product_data_inconsistency', 'semantic_interface_problem']);
    const semantic = report.attributions.filter((a) => a.category === 'semantic_interface_problem');
    expect(semantic.map((a) => a.checkpointId)).toEqual([
      'correct_size_identified',
      'cart_matches_variant',
    ]);
    expect(semantic.every((a) => a.failingAgents.join() === 'alpha_semantic')).toBe(true);
    const data = report.attributions.filter((a) => a.category === 'product_data_inconsistency');
    expect(data).toHaveLength(1);
    expect(data[0]).toMatchObject({
      checkpointId: 'cart_matches_variant',
      failingAgents: ['gamma_structured'],
    });
    expect(report.recommendations).toHaveLength(2);
    expect(report.recommendations[0]).toContain('Expose the controls behind');
  });

  it('writes a deterministic headline and relative costs with the cheapest agent at 1', () => {
    expect(report.headline).toContain('1 of 3 agents completed the mission.');
    expect(report.headline).toContain('Agent Alpha failed at "Correct size identified".');
    expect(report.headline).toContain('Agent Gamma failed at "Cart matches requested variant".');
    expect(report.headline).toContain(
      'The cheapest agent that completed it was Agent Sigma at $0.05 (estimated); Agent Alpha would have cost ~$0.012.',
    );
    expect(report.costComparison.map((c) => c.agentKind)).toEqual([
      'alpha_semantic',
      'sigma_hybrid',
    ]);
    expect(report.costComparison[0]!.relativeCost).toBe(1);
    expect(report.costComparison[1]!.relativeCost).toBeCloseTo(4.17, 2);
    expect(report.costComparison[1]!.imageInputs).toBe(6);
  });

  it('keeps the LLM cost ratio and the headline intact when a free agent records zero cost', () => {
    const freeGamma: Run = { ...gammaRun, usage: { ...EMPTY_USAGE, estimatedCostUsd: 0 } };
    const withFree = buildMissionReport({
      mission: hoodieMission,
      runs: [alphaRun, sigmaRun, freeGamma],
    });
    const relative = Object.fromEntries(
      withFree.costComparison.map((c) => [c.agentKind, c.relativeCost]),
    );
    expect(relative.alpha_semantic).toBe(1);
    expect(relative.sigma_hybrid).toBeCloseTo(4.17, 2);
    expect(relative.gamma_structured).toBe(0);
    expect(withFree.headline).toContain(
      'The cheapest agent that completed it was Agent Sigma at $0.05 (estimated); Agent Alpha would have cost ~$0.012.',
    );
    expect(withFree.headline).not.toContain('Agent Gamma would');
    expect(() => MissionReport.parse(withFree)).not.toThrow();

    const md = renderMissionReportMarkdown(withFree);
    expect(md).toContain('| Agent Alpha | claude-opus-5-5 | failed at "Correct size identified" |');
    expect(md).toContain('| $0.012 | 1.0x |');
    expect(md).toContain('| $0.05 | 4.2x |');
    expect(md).toContain('| 0 | 0 / 0 | 0 | $0.00 | 0.0x |');
    expect(md).toContain("Agent Sigma could, at $0.05 (estimated), 4.2x Agent Alpha's spend of $0.012");
    expect(md).not.toContain('Agent Gamma could');
  });

  it('validates against the shared schema', () => {
    expect(() => MissionReport.parse(report)).not.toThrow();
    expect(() => MissionReport.parse(JSON.parse(JSON.stringify(report)))).not.toThrow();
  });

  it('links per-agent reports and renders the matrix, attributions, recommendations and thesis', () => {
    const alphaReport = build(alphaRun, alphaProfile, NARRATIVE);
    const linked = buildMissionReport({
      mission: hoodieMission,
      runs: [alphaRun, sigmaRun, gammaRun],
      agentReports: [alphaReport],
    });
    expect(linked.runs[0]!.reportPath).toBe('run_demo0000alpha/report.md');

    const md = renderMissionReportMarkdown(linked);
    const headings = [
      '# Mission report: black hoodie on localhost:5000',
      '## Agents',
      '## Checkpoint matrix',
      '## Attribution',
      '## What the store must change',
      '## Cost and the thesis',
      '## Per-agent reports',
    ];
    const positions = headings.map((h) => md.indexOf(h));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);

    expect(md).toContain('1 of 3 agents completed the mission.');
    expect(md).toContain(
      '| Agent Alpha | claude-opus-5-5 | failed at "Correct size identified" | 3 | 9,000 / 300 | 0 | $0.012 | 1.0x |',
    );
    expect(md).toContain(
      '| Agent Sigma | claude-opus-5-5 | passed | 3 | 42,000 / 900 | 6 | $0.05 | 4.2x |',
    );
    expect(md).toContain(
      '| Agent Gamma | none (no LLM) | failed at "Cart matches requested variant" | 0 | - | - | - | - |',
    );

    expect(md).toContain('| Checkpoint | Agent Alpha | Agent Sigma | Agent Gamma |');
    expect(md).toContain('| Correct size identified | FAIL | pass | - |');
    expect(md).toContain('| Cart matches requested variant | FAIL | pass | FAIL |');
    expect(md).toContain(
      '| Catalog variant ID resolves to the advertised variant | - | - | FAIL |',
    );
    expect(md).not.toContain('| Catalog price matches product page | - | - | - |');

    expect(md).toContain(
      '- **Semantic interface problem**: Agent Sigma passed and Agent Alpha failed on "Correct size identified"',
    );
    expect(md).toContain('(failing: Agent Alpha)');
    expect(md).toContain('- **Product data inconsistency**:');
    expect(md).toContain('1. Expose the controls behind');
    expect(md).toContain('2. Make the structured catalog and the cart API agree');

    expect(md).toContain('Agent Alpha did not complete it');
    expect(md).toContain(
      "Agent Sigma could, at $0.05 (estimated), 4.2x Agent Alpha's spend of $0.012",
    );
    expect(md).toContain(
      '- Agent Alpha: [run_demo0000alpha/report.md](run_demo0000alpha/report.md)',
    );
    expect(md).not.toMatch(/\n{3,}/);

    // Written one level down, the links climb back to the artifacts root.
    const nested = renderMissionReportMarkdown(linked, { linkBase: 'missions/mis_demo00000001' });
    expect(nested).toContain(
      '- Agent Alpha: [run_demo0000alpha/report.md](../../run_demo0000alpha/report.md)',
    );
  });

  it("prefers the runner's recorded report path and normalizes its separators", () => {
    const recorded: Run = { ...alphaRun, reportPath: 'run_demo0000alpha\\report.json' };
    const built = buildMissionReport({ mission: hoodieMission, runs: [recorded, sigmaRun] });
    expect(built.runs[0]!.reportPath).toBe('run_demo0000alpha/report.json');
    expect(built.runs[1]!.reportPath).toBeUndefined();
    expect(renderMissionReportMarkdown(built)).toContain(
      '- Agent Alpha: [run_demo0000alpha/report.json](run_demo0000alpha/report.json)',
    );
  });

  it('states the cost ratio in the thesis when Alpha passes alongside a costlier agent', () => {
    const alphaPassed = derivedRun(
      'alpha_semantic',
      'run_demo0000alph2',
      '2026-10-17T20:10:00.000Z',
      allPassed,
      alphaUsage,
    );
    const after = buildMissionReport({
      mission: hoodieMission,
      runs: [alphaPassed, sigmaRun, gammaRun],
    });
    expect(after.headline).toBe(
      '2 of 3 agents completed the mission. Agent Gamma failed at "Cart matches requested variant".',
    );
    const md = renderMissionReportMarkdown(after);
    expect(md).toContain(
      'Agent Alpha completed it at $0.012 (estimated), so this mission meets the bar: no stronger, costlier agent was needed.',
    );
    expect(md).toContain(
      "Agent Sigma reached the same result at $0.05 (estimated), 4.2x Agent Alpha's spend.",
    );
  });

  it('handles an empty run list and a single run without attribution', () => {
    const empty = buildMissionReport({ mission: hoodieMission, runs: [] });
    expect(empty.headline).toBe('No finished runs for this mission yet.');
    expect(empty.attributions).toEqual([]);
    expect(() => MissionReport.parse(empty)).not.toThrow();
    expect(renderMissionReportMarkdown(empty)).toContain('No checkpoints were verified.');

    const single = buildMissionReport({ mission: hoodieMission, runs: [alphaFailedRun] });
    expect(single.headline).toBe(
      '0 of 1 agent completed the mission. Agent Alpha failed at "Correct size identified".',
    );
    expect(renderMissionReportMarkdown(single)).toContain('Attribution needs at least two agents');
  });
});

describe('writeReportFiles', () => {
  it('writes JSON and Markdown side by side and returns absolute paths', async () => {
    const dir = path.join(artifactsRoot, 'run_demo0000alpha', 'nested');
    const { jsonPath, mdPath } = await writeReportFiles(dir, { ok: true }, '# Report');
    expect(path.isAbsolute(jsonPath)).toBe(true);
    expect(jsonPath.endsWith('report.json')).toBe(true);
    expect(mdPath.endsWith('report.md')).toBe(true);
    expect(JSON.parse(readFileSync(jsonPath, 'utf8'))).toEqual({ ok: true });
    expect(readFileSync(mdPath, 'utf8')).toBe('# Report\n');
    expect(existsSync(dir)).toBe(true);
  });
});
