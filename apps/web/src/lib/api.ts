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
} from '@agentproof/shared';

/**
 * Typed client for the runner API. Contract: packages/shared/src/api.ts.
 * OWNER: Zach.
 */
const BASE = process.env.NEXT_PUBLIC_RUNNER_URL ?? 'http://localhost:4000';

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    cache: 'no-store',
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

export const api = {
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

  /** Subscribe to live run events. Returns an unsubscribe function. Browser only. */
  subscribe(runId: string, onEvent: (e: RunEvent) => void): () => void {
    const es = new EventSource(`${BASE}/runs/${runId}/events`);
    es.onmessage = (msg) => onEvent(JSON.parse(msg.data) as RunEvent);
    es.onerror = () => es.close();
    return () => es.close();
  },
};
