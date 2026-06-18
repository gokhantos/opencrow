import type { ToolDefinition, ToolCategory } from "./types";
import { createLogger } from "../logger";
import { getDb } from "../store/db";

const log = createLogger("tool:process-manage");

const CORE_URL = "http://127.0.0.1:48081";
const RESTART_COOLDOWN_MS = 60_000; // 60s cooldown per target

/**
 * Global cross-target rate limit. The per-target cooldown alone let an agent
 * sweep every process (one stop per target). This caps how many distinct
 * mutating actions any single agent process can issue within the window, so a
 * compromised agent cannot stop the whole platform in a burst.
 */
const GLOBAL_ACTION_WINDOW_MS = 60_000;
const GLOBAL_ACTION_MAX = 3;

/** Tracks last restart/stop/start timestamp per target to prevent rapid-fire calls */
const lastActionAt = new Map<string, number>();

/** Timestamps of recent mutating actions for the global rate limit. */
let recentActionTimes: number[] = [];

/**
 * Test-only seam: clears the per-target cooldown and global rate-limit state so
 * tests do not pollute each other (both are module-level by design). Not used in
 * production code paths.
 */
export function __resetProcessManageState(): void {
  lastActionAt.clear();
  recentActionTimes = [];
}

/**
 * Header carrying the caller's own process identity to the control plane. The
 * bearer token authorizes ANY caller, so the server cannot infer who is calling
 * from auth alone — the tool advertises its identity and the server enforces
 * self-only on top of it.
 */
const CALLER_PROCESS_HEADER = "X-OpenCrow-Caller-Process";

/**
 * Builds the auth headers for internal control-plane calls. The internal API is
 * fail-closed (see src/internal/server.ts): without a bearer token, mutating
 * routes (process start/stop/restart) are rejected. The token is provisioned in
 * setup and inherited by every child process via the parent env.
 */
function internalAuthHeaders(
  base: Record<string, string> = {},
): Record<string, string> {
  const internalToken = process.env.OPENCROW_INTERNAL_TOKEN;
  return internalToken
    ? { ...base, Authorization: `Bearer ${internalToken}` }
    : base;
}

/**
 * Derives the current process name from env vars.
 * Agent processes have OPENCROW_AGENT_ID, scraper processes have OPENCROW_SCRAPER_ID, etc.
 */
function getOwnProcessName(): string {
  if (process.env.OPENCROW_AGENT_ID)
    return `agent:${process.env.OPENCROW_AGENT_ID}`;
  if (process.env.OPENCROW_SCRAPER_ID)
    return `scraper:${process.env.OPENCROW_SCRAPER_ID}`;
  return "web";
}

interface OrchestratorProcess {
  readonly name: string;
  readonly status: string;
  readonly syncStatus: string;
  readonly pid: number | null;
  readonly restartCount: number;
  readonly uptimeSeconds: number | null;
}

async function listProcesses(): Promise<readonly OrchestratorProcess[]> {
  const res = await fetch(`${CORE_URL}/internal/orchestrator/state`, {
    headers: internalAuthHeaders(),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`Core API returned ${res.status}`);
  const body = (await res.json()) as { data: OrchestratorProcess[] | null };
  return body.data ?? [];
}

async function processAction(
  name: string,
  action: "restart" | "stop" | "start",
): Promise<{ ok?: boolean; error?: string }> {
  const res = await fetch(
    `${CORE_URL}/internal/processes/${encodeURIComponent(name)}/${action}`,
    {
      method: "POST",
      headers: internalAuthHeaders({
        "Content-Type": "application/json",
        [CALLER_PROCESS_HEADER]: getOwnProcessName(),
      }),
      signal: AbortSignal.timeout(5000),
    },
  );
  if (res.status === 403) {
    return { error: "self-only: cannot act on another process" };
  }
  return (await res.json()) as { ok?: boolean; error?: string };
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

export function createSelfRestartTool(): ToolDefinition {
  return {
    name: "process_manage",
    description: [
      "Manage OpenCrow processes via the core orchestrator.",
      "Actions: restart (default), stop, start, list.",
      "Each subsystem runs as its own process: web, cron, market, agent:*, scraper:*.",
      "With no target, restarts the calling process (this agent).",
      "Use 'list' to see all processes and their status before acting.",
    ].join(" "),
    categories: ["system"] as readonly ToolCategory[],
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["restart", "stop", "start", "list"],
          description:
            "Action to perform. 'list' shows all processes. Default: restart.",
        },
        target: {
          type: "string",
          description:
            "Process name to act on (e.g. 'web', 'cron', 'agent:default', 'scraper:hackernews'). Defaults to the calling process.",
        },
        reason: {
          type: "string",
          description: "Why the action is needed",
        },
      },
      required: ["reason"],
    },
    async execute(input: Record<string, unknown>) {
      const action = String(input.action ?? "restart") as
        | "restart"
        | "stop"
        | "start"
        | "list";
      const reason = String(input.reason ?? "");

      // --- List ---
      if (action === "list") {
        try {
          const procs = await listProcesses();
          if (procs.length === 0) {
            return {
              output: "No orchestrated processes found.",
              isError: false,
            };
          }

          const lines = procs.map((p) => {
            const uptime = p.uptimeSeconds
              ? formatUptime(p.uptimeSeconds)
              : "—";
            const restarts =
              p.restartCount > 0 ? ` (${p.restartCount} restarts)` : "";
            return `${p.name}: ${p.syncStatus} | pid ${p.pid ?? "—"} | up ${uptime}${restarts}`;
          });

          return {
            output: `${procs.length} processes:\n${lines.join("\n")}`,
            isError: false,
          };
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          return { output: `Failed to list processes: ${msg}`, isError: true };
        }
      }

      // --- Restart / Stop / Start ---
      const ownName = getOwnProcessName();
      const target = String(input.target ?? ownName);

      // SELF-ONLY: an agent may only act on the process it owns. Acting on web,
      // cron, other scrapers, or other agents is rejected here (defense in depth
      // — the control plane enforces this server-side too, since the shared
      // bearer token authorizes any caller).
      if (target !== ownName) {
        log.warn("process_manage rejected non-self target", {
          action,
          target,
          owner: ownName,
        });
        return {
          output: `Permission denied: '${ownName}' may only ${action} itself, not '${target}'. Cross-process control requires an operator.`,
          isError: true,
        };
      }

      // Validate target is a known process. FAIL CLOSED: if we cannot confirm
      // the target is known, refuse rather than proceeding blindly.
      try {
        const procs = await listProcesses();
        const knownNames = procs.map((p) => p.name);
        if (!knownNames.includes(target)) {
          return {
            output: `Error: unknown process "${target}". Known processes: ${knownNames.join(", ")}`,
            isError: true,
          };
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        log.warn("process_manage failing closed — could not verify target", {
          action,
          target,
          error: msg,
        });
        return {
          output: `Error: could not verify process list (${msg}). Refusing to ${action} '${target}' without confirmation.`,
          isError: true,
        };
      }

      // Global cross-target rate limit: cap mutating actions per window so a
      // burst cannot churn the platform even within the per-target cooldown.
      const now = Date.now();
      recentActionTimes = recentActionTimes.filter(
        (t) => now - t < GLOBAL_ACTION_WINDOW_MS,
      );
      if (recentActionTimes.length >= GLOBAL_ACTION_MAX) {
        log.warn("process_manage throttled by global rate limit", {
          action,
          target,
          recent: recentActionTimes.length,
        });
        return {
          output: `Rate limited: too many process actions (${recentActionTimes.length}/${GLOBAL_ACTION_MAX} in the last ${GLOBAL_ACTION_WINDOW_MS / 1000}s). Wait before issuing another.`,
          isError: true,
        };
      }

      // Cooldown: refuse if same target was acted on within RESTART_COOLDOWN_MS
      const key = `${action}:${target}`;
      const last = lastActionAt.get(key);
      if (last && Date.now() - last < RESTART_COOLDOWN_MS) {
        const remainingSec = Math.ceil(
          (RESTART_COOLDOWN_MS - (Date.now() - last)) / 1000,
        );
        log.warn("Action throttled by cooldown", {
          action,
          target,
          remainingSec,
        });
        return {
          output: `${action} for '${target}' was already triggered ${Math.floor((Date.now() - last) / 1000)}s ago. Cooldown: ${remainingSec}s remaining. The process is already handling the previous ${action}.`,
          isError: false,
        };
      }

      log.info("Process action requested", { action, target, reason });

      // When restarting our own process, clear all SDK sessions for this agent
      // to prevent resume-into-restart loops
      const ownProcess = getOwnProcessName();
      if (
        action === "restart" &&
        target === ownProcess &&
        target.startsWith("agent:")
      ) {
        const agentId = target.replace("agent:", "");
        try {
          const db = getDb();
          await db`DELETE FROM sdk_sessions WHERE agent_id = ${agentId}`;
          log.info("Cleared SDK sessions before self-restart", { agentId });
        } catch (err) {
          log.warn("Failed to clear SDK sessions before self-restart", {
            error: String(err),
          });
        }
      }

      try {
        const result = await processAction(target, action);

        if (result.ok) {
          lastActionAt.set(key, Date.now());
          recentActionTimes.push(Date.now());
          return {
            output: `${action} triggered for '${target}'. Other processes are unaffected.`,
            isError: false,
          };
        }

        return {
          output: `${action} failed for '${target}': ${result.error ?? "unknown error"}`,
          isError: true,
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        log.error("Process action failed", { action, target, error: msg });
        return {
          output: `Failed to ${action} '${target}': ${msg}`,
          isError: true,
        };
      }
    },
  };
}
