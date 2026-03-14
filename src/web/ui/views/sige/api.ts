import { apiFetch } from "../../api";
import type {
  SigeSession,
  SigeSessionDetail,
  FusedScore,
  PopulationEntry,
} from "./types";

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
