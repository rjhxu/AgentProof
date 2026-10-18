import type {
  CompareResponse,
  CreateMissionRequest,
  CreateMissionResponse,
  DiagnoseResponse,
  GetRunResponse,
  RematchResponse,
  RunEvent,
  StartRunsRequest,
  StartRunsResponse,
  ProposeRepairResponse,
  ApplyRepairResponse,
  ConnectRepositoryRequest,
  RepositoryResponse,
  FixtureMissionRequest,
  FixtureMissionResponse,
  GetRunReportResponse,
  GetMissionReportResponse,
  Mission,
  Run,
} from '@agentproof/shared';

/**
 * Typed client for the runner API. Contract: packages/shared/src/api.ts.
 * OWNER: Zach.
 */
const BASE = process.env.NEXT_PUBLIC_RUNNER_URL ?? 'http://localhost:4000';

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers ?? {}),
    },
    cache: 'no-store',
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

/** GET /missions/:id (no shared schema yet): the mission, its runs, and the mission report path once one exists. */
export interface GetMissionResponse {
  mission: Mission;
  runs: Run[];
  /** Artifacts-relative path of the cross-agent report JSON, e.g. "missions/mis_abc/report.json" */
  missionReportPath?: string;
}

export const api = {
  getRepository: (runId: string) => call<RepositoryResponse>(`/runs/${runId}/repository`),
  connectRepository: (runId: string, body: ConnectRepositoryRequest) =>
    call<RepositoryResponse>(`/runs/${runId}/repository`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  disconnectRepository: (runId: string) =>
    call<RepositoryResponse>(`/runs/${runId}/repository`, { method: 'DELETE' }),
  demoMission: () => call<CreateMissionResponse>('/demo/hoodie', { method: 'POST' }),
  proposeRepair: (issueId: string) =>
    call<ProposeRepairResponse>(`/issues/${issueId}/repair`, { method: 'POST' }),
  applyRepair: (repairId: string) =>
    call<ApplyRepairResponse>(`/repairs/${repairId}/apply`, { method: 'POST' }),
  createMission: (body: CreateMissionRequest) =>
    call<CreateMissionResponse>('/missions', { method: 'POST', body: JSON.stringify(body) }),
  startRuns: (missionId: string, body: StartRunsRequest) =>
    call<StartRunsResponse>(`/missions/${missionId}/runs`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  getRun: (runId: string) => call<GetRunResponse>(`/runs/${runId}`),
  rematch: (runId: string) => call<RematchResponse>(`/runs/${runId}/rematch`, { method: 'POST' }),
  compare: (runId: string, otherId: string) =>
    call<CompareResponse>(`/runs/${runId}/compare/${otherId}`),
  diagnose: (runId: string) =>
    call<DiagnoseResponse>(`/runs/${runId}/diagnose`, { method: 'POST' }),

  // ---- scenarios, reports and artifacts (W5, Zach) ---------------------------------------------
  /** Insert one of the storefront's known scenario missions (A-E, control); no model call. */
  fixtureMission: (body: FixtureMissionRequest) =>
    call<FixtureMissionResponse>('/missions/fixture', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  getMission: (missionId: string) => call<GetMissionResponse>(`/missions/${missionId}`),
  /** 404 ("report not ready") until the run has a verdict and jobs.ts has written its report. */
  getRunReport: (runId: string) => call<GetRunReportResponse>(`/runs/${runId}/report`),
  /** Rebuilt on every call from the mission's finished runs; 404 until one has finished. */
  getMissionReport: (missionId: string) =>
    call<GetMissionReportResponse>(`/missions/${missionId}/report`),
  /** text/markdown rendering of the same run report, for "open as Markdown" links. */
  runReportMarkdownUrl: (runId: string) => `${BASE}/runs/${runId}/report.md`,
  missionReportMarkdownUrl: (missionId: string) => `${BASE}/missions/${missionId}/report.md`,
  /** URL of an artifact (screenshot, aria snapshot, trace, report) by its artifacts-relative path. */
  artifactUrl: (relativePath: string) =>
    `${BASE}/artifacts/${relativePath
      .replace(/\\/g, '/')
      .replace(/^\/+/, '')
      .split('/')
      .map(encodeURIComponent)
      .join('/')}`,

  /** Subscribe to live run events. Returns an unsubscribe function. Browser only. */
  subscribe(runId: string, onEvent: (e: RunEvent) => void): () => void {
    const es = new EventSource(`${BASE}/runs/${runId}/events`);
    es.onmessage = (msg) => onEvent(JSON.parse(msg.data) as RunEvent);
    es.onerror = () => es.close();
    return () => es.close();
  },
};
