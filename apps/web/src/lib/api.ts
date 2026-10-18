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
  GetMissionResponse,
  CodeFixEvent,
  CodeFixRequest,
  CodeFixResponse,
  ListCodeFixesResponse,
  GitHubAppStatusResponse,
} from '@agentproof/shared';

/**
 * Typed client for the runner API. Contract: packages/shared/src/api.ts.
 * OWNER: Zach.
 */
/** Base URL of the runner API. Exported so a page can build its own event-stream URLs from it. */
export const RUNNER_URL = process.env.NEXT_PUBLIC_RUNNER_URL ?? 'http://localhost:4000';
const BASE = RUNNER_URL;

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
  /**
   * text/event-stream of RunEvent for one run. The live page manages its own EventSource from
   * this URL so it can reconnect; `subscribe` below is the fire-and-forget form.
   */
  runEventsUrl: (runId: string) => `${BASE}/runs/${runId}/events`,
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
  /** The mission, its runs (original and rematch), and the mission report path once one exists. */
  getMission: (missionId: string) => call<GetMissionResponse>(`/missions/${missionId}`),
  /**
   * 404 ("report not ready") while the run is in progress. jobs.ts saves the terminal status and
   * reportPath together, so a run that polls as passed/failed/error has its report unless
   * writing it failed (then the run carries the verdict and the log says why).
   */
  getRunReport: (runId: string) => call<GetRunReportResponse>(`/runs/${runId}/report`),
  /**
   * The report written when the mission's last run finished (same id as the report.json
   * artifact); 404 until one has finished. `refresh` forces a rebuild from the mission's runs.
   */
  getMissionReport: (missionId: string, opts: { refresh?: boolean } = {}) =>
    call<GetMissionReportResponse>(
      `/missions/${missionId}/report${opts.refresh ? '?refresh=1' : ''}`,
    ),
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

  // ---- the code-fix agent (docs/CODEFIX.md) --------------------------------------------------
  /**
   * Start a fix for a failed run with a connected repository. The token in the body, when any,
   * is used once and never stored. 202 with the record in its `running` state; poll getCodeFix
   * or subscribeCodeFix for progress.
   */
  startCodeFix: (runId: string, body: CodeFixRequest) =>
    call<CodeFixResponse>(`/runs/${runId}/codefix`, { method: 'POST', body: JSON.stringify(body) }),
  getCodeFix: (codefixId: string) => call<CodeFixResponse>(`/codefix/${codefixId}`),
  listCodeFixes: (runId: string) => call<ListCodeFixesResponse>(`/runs/${runId}/codefixes`),
  /** text/markdown rendering of the record (the same text a pull request body gets). */
  codeFixMarkdownUrl: (codefixId: string) => `${BASE}/codefix/${codefixId}/report.md`,
  codeFixPatchUrl: (codefixId: string) => `${BASE}/codefix/${codefixId}/patch.diff`,
  /**
   * text/event-stream of CodeFixEvent for one fix. The live page manages its own EventSource
   * from this URL so it can reconnect; `subscribeCodeFix` below is the fire-and-forget form.
   */
  codeFixEventsUrl: (codefixId: string) => `${BASE}/codefix/${codefixId}/events`,
  /** Whether the runner has a GitHub App identity, and where to install it; never the key. */
  getGitHubApp: () => call<GitHubAppStatusResponse>('/github/app'),
  /** The one-button registration page (opens in a new tab; GitHub returns to the runner). */
  gitHubAppSetupUrl: () => `${BASE}/github/app/setup`,
  /** Live stage/log/done events for a fix; closes after `done`. Browser only. */
  subscribeCodeFix(codefixId: string, onEvent: (e: CodeFixEvent) => void): () => void {
    const es = new EventSource(`${BASE}/codefix/${codefixId}/events`);
    es.onmessage = (msg) => onEvent(JSON.parse(msg.data) as CodeFixEvent);
    es.onerror = () => es.close();
    return () => es.close();
  },

  /**
   * Subscribe to live run events. Returns an unsubscribe function. Browser only. The runner ends
   * the stream after the terminal status (at once for a run that has already finished), which
   * EventSource reports through onerror, so the source is closed rather than left reconnecting.
   */
  subscribe(runId: string, onEvent: (e: RunEvent) => void): () => void {
    const es = new EventSource(`${BASE}/runs/${runId}/events`);
    es.onmessage = (msg) => onEvent(JSON.parse(msg.data) as RunEvent);
    es.onerror = () => es.close();
    return () => es.close();
  },
};
