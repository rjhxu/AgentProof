import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  AgentReport,
  MissionReport,
  type LlmUsage,
  type Mission,
  type Run,
} from '@agentproof/shared';
import { alphaFailedRun, hoodieMission } from '@agentproof/shared/fixtures';
import { createMockLlm, type LlmClient, type LlmRequest } from '@agentproof/agent';

// The data dir is read from the environment when config loads, so it is chosen before the
// runner modules are imported. Each vitest file has its own module graph, so this is per file.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentproof-reports-'));
process.env.AGENTPROOF_DATA_DIR = dataDir;
const { config } = await import('./config');
const db = await import('./db');
const reports = await import('./reports');

afterAll(() => {
  db.getDb().close(); // Windows refuses to remove the dir while the SQLite handle is open
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* a leftover temp dir is not a test failure */
  }
});

const NARRATIVE =
  'I found the hoodie but no size control appeared in the accessibility tree, so I added the default size.';

const NARRATOR_USAGE: LlmUsage = {
  calls: 1,
  inputTokens: 900,
  outputTokens: 120,
  reasoningTokens: 0,
  cachedInputTokens: 0,
  imageInputs: 0,
  estimatedCostUsd: 0.0014,
  llmLatencyMs: 800,
};

const ALPHA_USAGE: LlmUsage = {
  calls: 3,
  inputTokens: 6000,
  outputTokens: 300,
  reasoningTokens: 0,
  cachedInputTokens: 0,
  imageInputs: 0,
  estimatedCostUsd: 0.0083,
  llmLatencyMs: 4200,
};

function narrator() {
  // A text reply and a JSON reply so the mock fits either narrator contract.
  return createMockLlm([
    { text: NARRATIVE, json: { narrative: NARRATIVE }, usage: NARRATOR_USAGE },
  ]);
}

function missionWithId(id: string): Mission {
  return { ...structuredClone(hoodieMission), id };
}

function alphaRun(id: string, missionId: string): Run {
  return { ...structuredClone(alphaFailedRun), id, missionId, usage: ALPHA_USAGE };
}

/** A synthetic Sigma pass on the same mission: clicked the chip by coordinate, cart holds M. */
function sigmaPassedRun(id: string, missionId: string): Run {
  const cart = {
    items: [
      {
        productId: 'HOODIE-001',
        variantId: 'HOODIE-001-M',
        name: 'Black Hoodie',
        attributes: { color: 'black', size: 'M' },
        unitPrice: 49,
        quantity: 1,
      },
    ],
    subtotal: 49,
    currency: 'USD',
    source: 'api' as const,
  };
  const evidenceId = `ev_${id}_cart`;
  return {
    id,
    missionId,
    agent: { kind: 'sigma_hybrid', viewport: { width: 1280, height: 800 }, headed: false },
    status: 'passed',
    label: 'original',
    createdAt: '2026-10-17T20:05:00.000Z',
    startedAt: '2026-10-17T20:05:01.000Z',
    finishedAt: '2026-10-17T20:06:30.000Z',
    steps: [
      {
        index: 0,
        at: '2026-10-17T20:05:02.000Z',
        url: 'http://localhost:5000/products/black-hoodie',
        action: { type: 'click', target: '412,388', reason: 'The M chip is visible on screen' },
        outcome: 'ok',
        durationMs: 900,
      },
    ],
    evidence: [
      {
        id: evidenceId,
        runId: id,
        kind: 'cart_state',
        capturedAt: '2026-10-17T20:06:29.000Z',
        data: cart,
      },
    ],
    verification: {
      verifiedAt: '2026-10-17T20:06:30.000Z',
      observedCart: cart,
      checkpoints: [
        'product_discovered',
        'correct_color_identified',
        'correct_size_identified',
        'added_to_cart',
        'cart_matches_variant',
        'cart_quantity_correct',
        'price_within_budget',
        'checkout_review_reached',
      ].map((cp) => ({ id: cp as never, status: 'passed' as const, evidenceIds: [evidenceId] })),
    },
    claim: {
      outcome: 'done',
      summary: 'Added the medium black hoodie and reached checkout review',
      finalUrl: 'http://localhost:5000/checkout',
    },
    resolvedModel: 'grok-4.7',
    usage: {
      calls: 6,
      inputTokens: 42000,
      outputTokens: 900,
      reasoningTokens: 3000,
      cachedInputTokens: 0,
      imageInputs: 6,
      estimatedCostUsd: 0.0894,
      llmLatencyMs: 24000,
    },
  };
}

describe('generateRunReport', () => {
  const mission = missionWithId('mis_reports_run');
  const run = alphaRun('run_reports_alpha', mission.id);

  it('writes report.json and report.md, threads the injected narrator through, sums its usage', async () => {
    db.saveMission(mission);
    db.saveRun(run);
    const runDir = path.join(config.artifactsDir, run.id);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'step-000.png'), 'png');

    const llm = narrator();
    const result = await reports.generateRunReport(run, mission, { narrativeLlm: llm });

    expect(result.relativeJsonPath).toBe(`${run.id}/report.json`);
    expect(result.jsonPath).toBe(path.join(runDir, 'report.json'));
    expect(fs.existsSync(result.mdPath)).toBe(true);
    const onDisk = AgentReport.safeParse(JSON.parse(fs.readFileSync(result.jsonPath, 'utf8')));
    expect(onDisk.success).toBe(true);

    const { report } = result;
    expect(report.runId).toBe(run.id);
    expect(report.missionId).toBe(mission.id);
    expect(report.status).toBe('failed');
    expect(report.agent.kind).toBe('alpha_semantic');
    expect(report.agent.model).toBe(run.agent.model);
    expect(report.agent.effort).toBe('low');
    expect(report.checkpoints).toHaveLength(8);
    expect(report.firstFailure?.id).toBe('correct_size_identified');
    expect(report.artifacts).toContain(`${run.id}/step-000.png`);
    expect(report.artifacts).not.toContain(`${run.id}/report.json`);
    expect(report.narrative).toBe(NARRATIVE);

    // The narrator ran on the injected client (no network), and its usage is in the run total.
    expect(llm.requests.length).toBeGreaterThan(0);
    expect(result.narrativeUsage.calls).toBe(llm.requests.length);
    expect(report.usage.calls).toBe(ALPHA_USAGE.calls + result.narrativeUsage.calls);
    expect(report.usage.inputTokens).toBe(
      ALPHA_USAGE.inputTokens + result.narrativeUsage.inputTokens,
    );

    const markdown = fs.readFileSync(result.mdPath, 'utf8');
    expect(markdown).toContain('Agent Alpha');
    expect(markdown).toContain('Black Hoodie');
  });

  it('readRunReport reads the validated report through Run.reportPath and nothing else', async () => {
    expect(reports.readRunReport(run)).toBeUndefined();
    expect(reports.readRunReportMarkdown(run)).toBeUndefined();

    const withPath = { ...run, reportPath: `${run.id}/report.json` };
    const report = reports.readRunReport(withPath);
    expect(report?.runId).toBe(run.id);
    expect(reports.readRunReportMarkdown(withPath)).toContain('Agent Alpha');

    expect(
      reports.readRunReport({ ...run, reportPath: 'run_missing/report.json' }),
    ).toBeUndefined();
    fs.writeFileSync(path.join(config.artifactsDir, run.id, 'broken.json'), '{"not": "a report"}');
    expect(reports.readRunReport({ ...run, reportPath: `${run.id}/broken.json` })).toBeUndefined();
  });

  it('never resolves a report path outside the artifacts dir', () => {
    expect(reports.resolveArtifactPath('run_x/report.json')).toBe(
      path.join(config.artifactsDir, 'run_x', 'report.json'),
    );
    expect(reports.resolveArtifactPath('../agentproof.db')).toBeUndefined();
    expect(reports.resolveArtifactPath('run_x/../../agentproof.db')).toBeUndefined();
    expect(reports.resolveArtifactPath('')).toBeUndefined();
    expect(reports.readRunReport({ ...run, reportPath: '../agentproof.db' })).toBeUndefined();
  });

  it('still writes a report when the narrator cannot run', async () => {
    const failing = createMockLlm([
      () => {
        throw new Error('narrator unavailable');
      },
    ]);
    const quiet = alphaRun('run_reports_quiet', mission.id);
    db.saveRun(quiet);
    const result = await reports.generateRunReport(quiet, mission, { narrativeLlm: failing });
    expect(AgentReport.safeParse(result.report).success).toBe(true);
    expect(result.report.narrative).toMatch(/^Narrative unavailable/);
    expect(result.narrativeUsage.calls).toBe(0);
    expect(result.report.usage.calls).toBe(ALPHA_USAGE.calls);
  });
});

describe('withNarratorBudget', () => {
  const request: LlmRequest = { model: 'narrator', system: 'sys', messages: [], timeoutMs: 60_000 };

  it('caps the per-request timeout and gives up at the deadline; the report keeps the deterministic summary', async () => {
    const seen: LlmRequest[] = [];
    const hanging: LlmClient = {
      provider: 'mock',
      complete: (req) => {
        seen.push(req);
        return new Promise(() => undefined); // a provider that never answers
      },
    };
    const client = reports.withNarratorBudget(hanging, { timeoutMs: 1_000, budgetMs: 25 });
    await expect(client.complete(request)).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(seen[0]?.timeoutMs).toBe(1_000);

    const mission = missionWithId('mis_reports_budget');
    db.saveMission(mission);
    const run = alphaRun('run_reports_budget', mission.id);
    db.saveRun(run);
    const result = await reports.generateRunReport(run, mission, { narrativeLlm: client });
    expect(result.report.narrative).toMatch(/^Narrative unavailable \(timed out\)/);
    expect(result.report.narrative).toContain('Agent Alpha');
    expect(result.narrativeUsage.calls).toBe(0);
  });

  it('passes a prompt answer through with the default timeout applied', async () => {
    const quick = narrator();
    const client = reports.withNarratorBudget(quick);
    const response = await client.complete(request);
    expect(response.text).toBe(NARRATIVE);
    expect(client.provider).toBe('mock');
    expect(quick.requests[0]?.timeoutMs).toBe(reports.NARRATOR_TIMEOUT_MS);
  });
});

describe('currentMissionReport', () => {
  it('serves the stored report until a run finishes after it, and rebuilds on refresh', async () => {
    expect(await reports.currentMissionReport('mis_nope')).toBeUndefined();
    const mission = missionWithId('mis_reports_current');
    db.saveMission(mission);
    expect(await reports.currentMissionReport(mission.id)).toBeUndefined();

    const alpha = alphaRun('run_reports_cur_alpha', mission.id);
    const alphaReport = await reports.generateRunReport(alpha, mission, {
      narrativeLlm: narrator(),
    });
    db.saveRun({ ...alpha, reportPath: alphaReport.relativeJsonPath });

    const first = await reports.currentMissionReport(mission.id); // no file yet: builds it
    expect(first?.report.runs.map((r) => r.agentKind)).toEqual(['alpha_semantic']);
    const second = await reports.currentMissionReport(mission.id); // a read, not a rewrite
    expect(second?.report.id).toBe(first!.report.id);
    expect(second?.jsonPath).toBe(first!.jsonPath);
    expect(second?.mdPath).toBe(first!.mdPath);
    expect(second?.relativeJsonPath).toBe(`missions/${mission.id}/report.json`);
    expect(reports.readMissionReport(mission.id)?.id).toBe(first!.report.id);

    // A run that finished after the report was generated makes it stale.
    const sigma: Run = {
      ...sigmaPassedRun('run_reports_cur_sigma', mission.id),
      finishedAt: new Date(Date.parse(first!.report.generatedAt) + 1).toISOString(),
    };
    const sigmaReport = await reports.generateRunReport(sigma, mission, {
      narrativeLlm: narrator(),
    });
    db.saveRun({ ...sigma, reportPath: sigmaReport.relativeJsonPath });
    const third = await reports.currentMissionReport(mission.id);
    expect(third?.report.id).not.toBe(first!.report.id);
    expect(third?.report.runs.map((r) => r.agentKind).sort()).toEqual([
      'alpha_semantic',
      'sigma_hybrid',
    ]);
    expect((await reports.currentMissionReport(mission.id))?.report.id).toBe(third!.report.id);

    const refreshed = await reports.currentMissionReport(mission.id, { refresh: true });
    expect(refreshed?.report.id).not.toBe(third!.report.id);
    expect(reports.readMissionReport(mission.id)?.id).toBe(refreshed!.report.id);
  });
});

describe('regenerateMissionReport', () => {
  it('is undefined for an unknown mission or one without a finished run', async () => {
    expect(await reports.regenerateMissionReport('mis_nope')).toBeUndefined();
    const mission = missionWithId('mis_reports_queued');
    db.saveMission(mission);
    db.saveRun({
      ...alphaRun('run_reports_queued', mission.id),
      status: 'queued',
      verification: undefined,
      finishedAt: undefined,
    });
    expect(await reports.regenerateMissionReport(mission.id)).toBeUndefined();
    expect(reports.missionReportExists(mission.id)).toBe(false);
    expect(reports.readMissionReport(mission.id)).toBeUndefined();
  });

  it('attributes the Alpha failure to the store when Sigma passes, with the cost comparison', async () => {
    const mission = missionWithId('mis_reports_mission');
    db.saveMission(mission);
    const alpha = alphaRun('run_reports_m_alpha', mission.id);
    const sigma = sigmaPassedRun('run_reports_m_sigma', mission.id);
    for (const run of [alpha, sigma]) {
      const { relativeJsonPath } = await reports.generateRunReport(run, mission, {
        narrativeLlm: narrator(),
      });
      db.saveRun({ ...run, reportPath: relativeJsonPath });
    }

    const result = await reports.regenerateMissionReport(mission.id);
    expect(result).toBeDefined();
    expect(result!.relativeJsonPath).toBe(`missions/${mission.id}/report.json`);
    expect(result!.jsonPath).toBe(path.join(config.missionReportsDir, mission.id, 'report.json'));
    expect(
      MissionReport.safeParse(JSON.parse(fs.readFileSync(result!.jsonPath, 'utf8'))).success,
    ).toBe(true);

    const { report } = result!;
    expect(report.missionId).toBe(mission.id);
    expect(report.runs.map((r) => r.agentKind).sort()).toEqual(['alpha_semantic', 'sigma_hybrid']);
    expect(report.runs.find((r) => r.agentKind === 'alpha_semantic')?.reportPath).toBe(
      `${alpha.id}/report.json`,
    );
    expect(report.matrix.correct_size_identified).toMatchObject({
      alpha_semantic: 'failed',
      sigma_hybrid: 'passed',
      beta_vision: 'not_run',
      gamma_structured: 'not_run',
    });
    expect(report.attributions).toContainEqual(
      expect.objectContaining({
        checkpointId: 'correct_size_identified',
        category: 'semantic_interface_problem',
        reference: 'sigma_hybrid',
        failingAgents: ['alpha_semantic'],
      }),
    );
    expect(report.recommendations.length).toBeGreaterThan(0);
    const cost = Object.fromEntries(report.costComparison.map((c) => [c.agentKind, c]));
    expect(cost.alpha_semantic?.relativeCost).toBe(1);
    expect(cost.sigma_hybrid?.relativeCost).toBeGreaterThan(1);

    expect(reports.missionReportExists(mission.id)).toBe(true);
    expect(reports.readMissionReport(mission.id)?.id).toBe(report.id);
    const markdown = reports.readMissionReportMarkdown(mission.id);
    expect(markdown).toContain('Mission report');
    expect(markdown).toContain('Agent Sigma');
  });
});

describe('rematch runs and the mission report', () => {
  it('builds the report from the original runs only; a finished rematch does not make it stale', async () => {
    const mission = missionWithId('mis_reports_rematch');
    db.saveMission(mission);
    const alpha = alphaRun('run_reports_r_alpha', mission.id);
    const sigma = sigmaPassedRun('run_reports_r_sigma', mission.id);
    for (const run of [alpha, sigma]) {
      const { relativeJsonPath } = await reports.generateRunReport(run, mission, {
        narrativeLlm: narrator(),
      });
      db.saveRun({ ...run, reportPath: relativeJsonPath });
    }
    const before = await reports.currentMissionReport(mission.id);
    expect(before?.report.runs.find((r) => r.agentKind === 'alpha_semantic')).toMatchObject({
      runId: alpha.id,
      status: 'failed',
    });

    // The code-fix agent reran Alpha against a patched store: a rematch, saved as its own run,
    // finishing after the report was written. It describes the repaired store, not this scan.
    const rematch: Run = {
      ...alphaRun('run_reports_r_rematch', mission.id),
      status: 'passed',
      label: 'rematch',
      parentRunId: alpha.id,
      finishedAt: '2026-10-19T00:00:00.000Z',
    };
    db.saveRun(rematch);

    const unchanged = await reports.currentMissionReport(mission.id);
    expect(unchanged?.report.id).toBe(before?.report.id);
    const refreshed = await reports.regenerateMissionReport(mission.id);
    expect(refreshed?.report.runs.map((r) => r.runId).sort()).toEqual([alpha.id, sigma.id].sort());
    expect(refreshed?.report.runs.find((r) => r.agentKind === 'alpha_semantic')?.status).toBe(
      'failed',
    );
  });
});
