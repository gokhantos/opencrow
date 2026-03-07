import { getDb } from "../store/db";
import { createLogger } from "../logger";

const log = createLogger("tool-stats");

interface PendingStat {
  successes: number;
  failures: number;
  lastFailureError: string | null;
}

/** In-memory buffer keyed by "agentId:toolName" */
const buffer = new Map<string, PendingStat>();

const FLUSH_INTERVAL_MS = 30_000;
let flushTimer: ReturnType<typeof setInterval> | null = null;

function bufferKey(agentId: string, toolName: string): string {
  return `${agentId}\0${toolName}`;
}

function parseKey(key: string): { agentId: string; toolName: string } {
  const idx = key.indexOf("\0");
  return { agentId: key.slice(0, idx), toolName: key.slice(idx + 1) };
}

export function recordToolResult(
  agentId: string,
  toolName: string,
  isError: boolean,
  errorText?: string,
): void {
  const key = bufferKey(agentId, toolName);
  const existing = buffer.get(key) ?? {
    successes: 0,
    failures: 0,
    lastFailureError: null,
  };

  const updated = isError
    ? {
        ...existing,
        failures: existing.failures + 1,
        lastFailureError: errorText?.slice(0, 500) ?? null,
      }
    : { ...existing, successes: existing.successes + 1 };

  buffer.set(key, updated);
}

export async function flushToolStats(): Promise<void> {
  if (buffer.size === 0) return;

  const entries = [...buffer.entries()];
  buffer.clear();

  let db: ReturnType<typeof getDb>;
  try {
    db = getDb();
  } catch {
    return; // DB not initialized yet
  }

  const now = Math.floor(Date.now() / 1000);

  try {
    for (const [key, stat] of entries) {
      const { agentId, toolName } = parseKey(key);
      await db`
        INSERT INTO tool_stats (agent_id, tool_name, success_count, failure_count, last_failure_at, last_failure_error, updated_at)
        VALUES (${agentId}, ${toolName}, ${stat.successes}, ${stat.failures},
          ${stat.failures > 0 ? now : null},
          ${stat.lastFailureError},
          ${now})
        ON CONFLICT (agent_id, tool_name) DO UPDATE SET
          success_count = tool_stats.success_count + EXCLUDED.success_count,
          failure_count = tool_stats.failure_count + EXCLUDED.failure_count,
          last_failure_at = COALESCE(EXCLUDED.last_failure_at, tool_stats.last_failure_at),
          last_failure_error = COALESCE(EXCLUDED.last_failure_error, tool_stats.last_failure_error),
          updated_at = EXCLUDED.updated_at
      `;
    }
  } catch (err) {
    log.error("Failed to flush tool stats", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export function startToolStatsFlush(): void {
  if (flushTimer) return;
  flushTimer = setInterval(() => {
    flushToolStats().catch(() => {});
  }, FLUSH_INTERVAL_MS);
}

export function stopToolStatsFlush(): void {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  flushToolStats().catch(() => {});
}

export interface ToolStatRow {
  readonly agentId: string;
  readonly toolName: string;
  readonly successCount: number;
  readonly failureCount: number;
  readonly failureRate: number;
  readonly lastFailureAt: number | null;
  readonly lastFailureError: string | null;
}

export async function getToolStats(
  agentId?: string,
): Promise<readonly ToolStatRow[]> {
  const db = getDb();
  const rows = agentId
    ? await db`
        SELECT * FROM tool_stats WHERE agent_id = ${agentId}
        ORDER BY failure_count DESC, success_count DESC
      `
    : await db`
        SELECT * FROM tool_stats
        ORDER BY failure_count DESC, success_count DESC
      `;

  return (rows as Record<string, unknown>[]).map((r) => {
    const success = (r.success_count as number) ?? 0;
    const failure = (r.failure_count as number) ?? 0;
    const total = success + failure;
    return {
      agentId: r.agent_id as string,
      toolName: r.tool_name as string,
      successCount: success,
      failureCount: failure,
      failureRate: total > 0 ? failure / total : 0,
      lastFailureAt: (r.last_failure_at as number) ?? null,
      lastFailureError: (r.last_failure_error as string) ?? null,
    };
  });
}
