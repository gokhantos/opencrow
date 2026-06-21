import { apiFetch } from "../../api";
import type {
  FusedScore,
  PopulationEntry,
  RoundLedger,
} from "./types";
import type { GraphView } from "../../../../sige/knowledge/graph-query";

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

interface ActionsResponse {
  readonly success: boolean;
  readonly data: {
    readonly sessionId: string;
    readonly rounds: readonly RoundLedger[];
  };
}

/**
 * Fetch agent action ledger for a session.
 * Pass `round` to scope to a single round (e.g. 1-4 for expert-game rounds,
 * or the taste_filter pseudo-round). Omit for all rounds.
 */
export async function fetchSessionActions(
  sessionId: string,
  round?: number,
  signal?: AbortSignal,
): Promise<{ readonly sessionId: string; readonly rounds: readonly RoundLedger[] }> {
  const qs = round != null ? `?round=${round}` : "";
  const res = await apiFetch<ActionsResponse>(
    `/api/sige/sessions/${sessionId}/actions${qs}`,
    signal ? { signal } : undefined,
  );
  return res.data;
}
