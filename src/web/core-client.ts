import { createLogger } from "../logger";

const log = createLogger("core-client");

export interface CoreClient {
  /** POST /internal/chat — execute a chat turn */
  chat(body: { message: string; chatId?: string; agentId?: string }): Promise<{
    text: string;
    usage?: { inputTokens?: number; outputTokens?: number };
  }>;

  /** POST /internal/chat/stream — SSE streaming chat */
  chatStream(body: {
    message: string;
    chatId?: string;
    agentId?: string;
  }): Promise<Response>;

  /** GET /internal/status — live channel/cron/market status */
  getStatus(): Promise<{
    channels: Record<string, { status: string; type: string }>;
    cron: {
      running: boolean;
      jobCount: number;
      nextDueAt: number | null;
    } | null;
    market: unknown | null;
  }>;

  /** POST /internal/channels/:id/:action */
  channelAction(
    channelId: string,
    action: string,
    body?: unknown,
  ): Promise<{ data?: unknown; error?: string }>;

  /** GET /internal/channels — list all channels */
  listChannels(): Promise<{ data: unknown[] }>;

  /** POST /internal/scraper/:name/:action */
  scraperAction(
    name: string,
    action: string,
    body?: unknown,
  ): Promise<{ data?: unknown; error?: string }>;

  /** GET /internal/market/status */
  marketStatus(): Promise<{ data?: unknown; error?: string }>;

  /** POST /internal/cron/jobs/:id/run */
  cronRunNow(jobId: string): Promise<{ ok?: boolean; error?: string }>;

  /** GET /internal/cron/status */
  cronStatus(): Promise<{
    data?: { running: boolean; jobCount: number; nextDueAt: number | null };
    error?: string;
  }>;

  /** GET /internal/processes — list all processes with health */
  listProcesses(): Promise<{
    data: ReadonlyArray<{
      name: string;
      pid: number;
      status: "alive" | "stale" | "dead";
      startedAt: number;
      lastHeartbeat: number;
      uptimeSeconds: number;
      metadata: Record<string, unknown>;
    }>;
  }>;

  /** POST /internal/processes/:name/restart — send restart command */
  restartProcess(
    name: string,
  ): Promise<{ ok?: boolean; commandId?: string; error?: string }>;

  /** POST /internal/processes/:name/stop — send stop command */
  stopProcess(
    name: string,
  ): Promise<{ ok?: boolean; commandId?: string; error?: string }>;

  /** POST /internal/processes/:name/start — resume a stopped process */
  startProcess(name: string): Promise<{ ok?: boolean; error?: string }>;

  /** GET /internal/orchestrator/state — get orchestrator process views */
  getOrchestratorState(): Promise<{
    data: ReadonlyArray<{
      name: string;
      desired: boolean;
      status: "running" | "starting" | "backoff" | "crash-loop" | "stopped";
      syncStatus:
        | "synced"
        | "starting"
        | "restarting"
        | "crash-loop"
        | "stopped";
      pid: number | null;
      restartCount: number;
      uptimeSeconds: number | null;
      backoffMs: number;
      nextRetryAt: number | null;
    }> | null;
  }>;

  /** GET /internal/health — quick health check */
  isHealthy(): Promise<boolean>;
}

export function createCoreClient(baseUrl: string): CoreClient {
  async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
    const url = `${baseUrl}${path}`;
    const internalToken = process.env.OPENCROW_INTERNAL_TOKEN;
    const res = await fetch(url, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(internalToken ? { Authorization: `Bearer ${internalToken}` } : {}),
        ...init?.headers,
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Core API ${res.status}: ${body}`);
    }
    return res.json() as Promise<T>;
  }

  return {
    async chat(body) {
      return fetchJson("/internal/chat", {
        method: "POST",
        body: JSON.stringify(body),
      });
    },

    async chatStream(body) {
      const url = `${baseUrl}/internal/chat/stream`;
      const internalToken = process.env.OPENCROW_INTERNAL_TOKEN;
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(internalToken ? { Authorization: `Bearer ${internalToken}` } : {}),
        },
        body: JSON.stringify(body),
      });
      return res;
    },

    async getStatus() {
      return fetchJson("/internal/status");
    },

    async channelAction(channelId, action, body) {
      return fetchJson(`/internal/channels/${channelId}/${action}`, {
        method: "POST",
        body: body ? JSON.stringify(body) : "{}",
      });
    },

    async listChannels() {
      return fetchJson("/internal/channels");
    },

    async scraperAction(name, action, body) {
      return fetchJson(`/internal/scraper/${name}/${action}`, {
        method: "POST",
        body: body ? JSON.stringify(body) : "{}",
      });
    },

    async marketStatus() {
      return fetchJson("/internal/market/status");
    },

    async cronRunNow(jobId) {
      return fetchJson(`/internal/cron/jobs/${jobId}/run`, {
        method: "POST",
      });
    },

    async cronStatus() {
      return fetchJson("/internal/cron/status");
    },

    async listProcesses() {
      return fetchJson("/internal/processes");
    },

    async restartProcess(name) {
      return fetchJson(`/internal/processes/${name}/restart`, {
        method: "POST",
      });
    },

    async stopProcess(name) {
      return fetchJson(`/internal/processes/${name}/stop`, {
        method: "POST",
      });
    },

    async startProcess(name) {
      return fetchJson(`/internal/processes/${name}/start`, {
        method: "POST",
      });
    },

    async getOrchestratorState() {
      return fetchJson("/internal/orchestrator/state");
    },

    async isHealthy() {
      try {
        const res = await fetch(`${baseUrl}/internal/health`, {
          signal: AbortSignal.timeout(3000),
        });
        return res.ok;
      } catch {
        log.warn("Core health check failed");
        return false;
      }
    },
  };
}
