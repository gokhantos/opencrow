import type { ZodType } from "zod";

const TOKEN_KEY = "opencrow_web_token";

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

export function initTokenFromUrl(): void {
  const params = new URLSearchParams(window.location.search);
  const urlToken = params.get("token");
  if (urlToken) {
    setToken(urlToken);
    const url = new URL(window.location.href);
    url.searchParams.delete("token");
    window.history.replaceState({}, "", url.toString());
  }
}

export interface ApiError {
  status: number;
  message: string;
}

/**
 * Optional extras for {@link apiFetch}. Pass a zod `schema` to validate the
 * decoded JSON response at runtime; when omitted the body is cast to `T` (the
 * legacy behaviour, preserved for the ~86 existing call sites).
 */
export interface ApiFetchExtras<T> {
  readonly schema?: ZodType<T>;
}

export async function apiFetch<T>(
  path: string,
  options: RequestInit = {},
  extras: ApiFetchExtras<T> = {},
): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string>),
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  const res = await fetch(path, { ...options, headers });

  if (res.status === 401) {
    clearToken();
    const err: ApiError = { status: 401, message: "Unauthorized" };
    throw err;
  }

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    const err: ApiError = { status: res.status, message: text };
    throw err;
  }

  const body = (await res.json()) as unknown;

  if (extras.schema) {
    const parsed = extras.schema.safeParse(body);
    if (!parsed.success) {
      const err: ApiError = {
        status: res.status,
        message: `Invalid response from ${path}: ${parsed.error.message}`,
      };
      throw err;
    }
    return parsed.data;
  }

  return body as T;
}

export function setupChannel(
  id: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  return apiFetch(`/api/channels/${id}/setup`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function enableChannel(id: string): Promise<unknown> {
  return apiFetch(`/api/channels/${id}/enable`, { method: "POST" });
}

export function disableChannel(id: string): Promise<unknown> {
  return apiFetch(`/api/channels/${id}/disable`, { method: "POST" });
}

export function restartChannel(id: string): Promise<unknown> {
  return apiFetch(`/api/channels/${id}/restart`, { method: "POST" });
}

export function requestWhatsAppPairingCode(
  phoneNumber: string,
): Promise<{ success: boolean; data?: { code: string }; error?: string }> {
  return apiFetch("/api/channels/whatsapp/pair", {
    method: "POST",
    body: JSON.stringify({ phoneNumber }),
  });
}

export function resumeRun(
  runId: string,
): Promise<{ success: boolean; message?: string; runId?: string; error?: string }> {
  return apiFetch(`/api/pipelines-runs/${runId}/resume`, { method: "POST" });
}

// ── Learning lift (Phase 4 A/B holdout) ──────────────────────────────────

/** Per-run learning lift: arm, idea count, validated counts, injected lessons. */
export interface RunLiftData {
  readonly runId: string;
  readonly arm: "guided" | "blind";
  readonly holdoutRatio: number;
  readonly createdAt: number;
  readonly ideas: number;
  readonly humanValidated: number;
  readonly anyValidated: number;
  readonly injectedLessons: {
    readonly reinforce: number;
    readonly avoid: number;
    readonly graphPath: number;
  };
}

interface ArmRatesData {
  readonly runs: number;
  readonly ideas: number;
  readonly validatedRate: number;
  readonly keptRate: number;
}

/** Per-lesson lift vs the guided baseline. */
export interface LessonLiftData {
  readonly lessonKey: string;
  readonly lessonKind: "reinforce" | "avoid" | "graph_path";
  readonly lessonText: string | null;
  readonly runs: number;
  readonly ideas: number;
  readonly validatedRate: number;
  readonly liftVsBaseline: number;
}

/** Windowed guided-vs-blind lift summary. */
export interface LiftSummaryData {
  readonly sinceSec: number;
  readonly humanOnly: boolean;
  readonly lift: {
    readonly guided: ArmRatesData;
    readonly blind: ArmRatesData;
    readonly validatedLift: number;
    readonly keptLift: number;
  };
  readonly lessons: readonly LessonLiftData[];
}

export function getRunLift(
  runId: string,
): Promise<{ success: boolean; data?: RunLiftData; error?: string }> {
  return apiFetch(`/api/pipelines-runs/${runId}/lift`);
}

export function getLiftSummary(
  window?: number,
  humanOnly = true,
): Promise<{ success: boolean; data?: LiftSummaryData; error?: string }> {
  const params = new URLSearchParams();
  if (window !== undefined) params.set("window", String(window));
  if (!humanOnly) params.set("humanOnly", "false");
  const qs = params.toString();
  return apiFetch(`/api/pipelines/lift-summary${qs ? `?${qs}` : ""}`);
}

export function resumeInterruptedRuns(): Promise<{
  success: boolean;
  resumed?: number;
  error?: string;
}> {
  return apiFetch("/api/pipelines-runs/resume-interrupted", { method: "POST" });
}

let _configHash: string | null = null;

export function getConfigHash(): string | null {
  return _configHash;
}

export function setConfigHash(h: string): void {
  _configHash = h;
}

export function updateAgent(
  id: string,
  updates: Record<string, unknown>,
): Promise<unknown> {
  return apiFetch(`/api/agents/${id}`, {
    method: "PUT",
    body: JSON.stringify({ ...updates, configHash: _configHash }),
  });
}

export function createAgent(data: Record<string, unknown>): Promise<unknown> {
  return apiFetch("/api/agents", {
    method: "POST",
    body: JSON.stringify({ ...data, configHash: _configHash }),
  });
}

export function deleteAgent(id: string): Promise<unknown> {
  const qs = _configHash
    ? `?configHash=${encodeURIComponent(_configHash)}`
    : "";
  return apiFetch(`/api/agents/${id}${qs}`, { method: "DELETE" });
}

export function createSkillApi(data: {
  name: string;
  description: string;
  content: string;
}): Promise<{ success: boolean; data?: { id: string }; error?: string }> {
  return apiFetch("/api/skills", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export function updateSkillApi(
  id: string,
  data: { name: string; description: string; content: string },
): Promise<{ success: boolean; error?: string }> {
  return apiFetch(`/api/skills/${id}`, {
    method: "PUT",
    body: JSON.stringify(data),
  });
}

export function deleteSkillApi(
  id: string,
): Promise<{ success: boolean; error?: string }> {
  return apiFetch(`/api/skills/${id}`, { method: "DELETE" });
}

export function fetchSkillDetail(
  id: string,
): Promise<{
  success: boolean;
  data: {
    id: string;
    name: string;
    description: string;
    content: string;
    body: string;
  };
}> {
  return apiFetch(`/api/skills/${id}`);
}
