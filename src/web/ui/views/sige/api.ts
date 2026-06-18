import { apiFetch } from "../../api";
import type {
  SigeSession,
  SigeSessionDetail,
  FusedScore,
  PopulationEntry,
  SessionProgress,
} from "./types";
import type { GraphView } from "../../../../sige/knowledge/graph-query";

interface ListSessionsResponse {
  readonly success: boolean;
  readonly data: {
    readonly sessions: readonly SigeSession[];
  };
}

interface SessionResponse {
  readonly success: boolean;
  readonly data: SigeSessionDetail;
}

interface CreateSessionResponse {
  readonly success: boolean;
  readonly data: {
    readonly id: string;
    readonly status: string;
  };
}

interface IdeasResponse {
  readonly success: boolean;
  readonly data: {
    readonly ideas: readonly FusedScore[];
  };
}

interface ReportResponse {
  readonly success: boolean;
  readonly data: {
    readonly report: string;
  };
}

interface PopulationResponse {
  readonly success: boolean;
  readonly data: {
    readonly population: readonly PopulationEntry[];
  };
}

export interface SigeCreateConfig {
  readonly alpha?: number;
  readonly socialAgentCount?: number;
  readonly model?: string;
}

export async function fetchSessions(): Promise<readonly SigeSession[]> {
  const res = await apiFetch<ListSessionsResponse>("/api/sige/sessions");
  return res.data.sessions;
}

export async function fetchSession(id: string): Promise<SigeSessionDetail> {
  const res = await apiFetch<SessionResponse>(`/api/sige/sessions/${id}`);
  return res.data;
}

export async function createSession(
  seedInput: string,
  config?: SigeCreateConfig,
): Promise<{ readonly id: string; readonly status: string }> {
  const res = await apiFetch<CreateSessionResponse>("/api/sige/sessions", {
    method: "POST",
    body: JSON.stringify({ seedInput, config }),
  });
  return res.data;
}

export async function fetchSessionIdeas(id: string): Promise<readonly FusedScore[]> {
  const res = await apiFetch<IdeasResponse>(`/api/sige/sessions/${id}/ideas?limit=50`);
  return res.data.ideas;
}

export async function fetchSessionReport(id: string): Promise<string> {
  const res = await apiFetch<ReportResponse>(`/api/sige/sessions/${id}/report`);
  return res.data.report;
}

export async function fetchPopulationDynamics(
  id: string,
): Promise<readonly PopulationEntry[]> {
  const res = await apiFetch<PopulationResponse>(
    `/api/sige/sessions/${id}/population`,
  );
  return res.data.population;
}

export async function cancelSession(id: string): Promise<void> {
  await apiFetch(`/api/sige/sessions/${id}`, { method: "DELETE" });
}

interface ProgressResponse {
  readonly success: boolean;
  readonly data: SessionProgress;
}

export async function fetchSessionProgress(
  id: string,
): Promise<SessionProgress> {
  const res = await apiFetch<ProgressResponse>(
    `/api/sige/sessions/${id}/progress`,
  );
  return res.data;
}

interface GraphResponse {
  readonly success: boolean;
  readonly data: GraphView;
}

export async function fetchSessionGraph(
  sessionId: string,
  signal?: AbortSignal,
): Promise<GraphView> {
  const res = await apiFetch<GraphResponse>(
    `/api/sige/sessions/${sessionId}/graph`,
    signal ? { signal } : undefined,
  );
  return res.data;
}
