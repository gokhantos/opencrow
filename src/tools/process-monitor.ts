import type { ToolDefinition, ToolCategory } from "./types";
import { getDb } from "../store/db";
import { getNumber, getString, getEnum } from "./input-helpers";

// ============================================================================
// Process Monitoring Tools
// ============================================================================

interface ProcessLogRow {
  id: bigint;
  process_name: string;
  level: string;
  context: string;
  message: string;
  data_json: string | null;
  created_at: number;
}

interface ProcessRegistryRow {
  name: string;
  pid: number;
  started_at: number;
  last_heartbeat: number;
  metadata_json: string;
}

export function createProcessMonitorTools(): ToolDefinition[] {
  return [
    createGetProcessLogsTool(),
    createGetProcessHealthTool(),
  ];
}

function createGetProcessLogsTool(): ToolDefinition {
  return {
    name: "get_process_logs",
    description:
      "Query system process logs. Shows recent log entries with filtering by process, level, and time range. Useful for debugging and monitoring system health.",
    inputSchema: {
      type: "object",
      properties: {
        process_name: {
          type: "string",
          description: "Filter by process name (e.g., 'web', 'agent').",
        },
        level: {
          type: "string",
          enum: ["debug", "info", "warn", "error"],
          description: "Filter by log level.",
        },
        context: {
          type: "string",
          description: "Filter by context (e.g., 'tool:cron', 'agent:claude').",
        },
        limit: {
          type: "number",
          description: "Max entries to return (default 50, max 200).",
        },
        hours_back: {
          type: "number",
          description: "How many hours to look back (default 24, max 168).",
        },
      },
      required: [],
    },
    categories: ["analytics", "system"] as readonly ToolCategory[],
    async execute(input): Promise<{ output: string; isError: boolean }> {
      const processName = getString(input, "process_name", { allowEmpty: true });
      const level = getEnum(input, "level", ["debug", "info", "warn", "error"] as const);
      const context = getString(input, "context", { allowEmpty: true });
      const limit = getNumber(input, "limit", { defaultVal: 50, min: 1, max: 200 });
      const hoursBack = getNumber(input, "hours_back", { defaultVal: 24, min: 1, max: 168 });

      try {
        const db = getDb();
        const since = Math.floor(Date.now() / 1000) - hoursBack * 3600;

        let rows: readonly ProcessLogRow[];

        if (processName && level) {
          rows = await db`
            SELECT * FROM process_logs
            WHERE created_at >= ${since}
              AND process_name = ${processName}
              AND level = ${level}
            ORDER BY created_at DESC
            LIMIT ${limit}
          `;
        } else if (processName) {
          rows = await db`
            SELECT * FROM process_logs
            WHERE created_at >= ${since}
              AND process_name = ${processName}
            ORDER BY created_at DESC
            LIMIT ${limit}
          `;
        } else if (level) {
          rows = await db`
            SELECT * FROM process_logs
            WHERE created_at >= ${since}
              AND level = ${level}
            ORDER BY created_at DESC
            LIMIT ${limit}
          `;
        } else {
          rows = await db`
            SELECT * FROM process_logs
            WHERE created_at >= ${since}
            ORDER BY created_at DESC
            LIMIT ${limit}
          `;
        }

        // Filter by context in memory if provided (simple contains)
        const filteredRows = context
          ? rows.filter((r) => r.context.toLowerCase().includes(context.toLowerCase()))
          : rows;

        if (filteredRows.length === 0) {
          return {
            output: `No process logs found for the specified filters (last ${hoursBack}h).`,
            isError: false,
          };
        }

        // Calculate error rate
        const errorCount = filteredRows.filter((r) => r.level === "error").length;
        const warnCount = filteredRows.filter((r) => r.level === "warn").length;

        const lines = filteredRows.slice(0, 30).map((r) => {
          const ts = new Date(r.created_at * 1000).toLocaleString();
          const data = r.data_json ? ` | ${r.data_json.slice(0, 100)}` : "";
          return `[${r.level.toUpperCase()}] ${ts} ${r.process_name}/${r.context}: ${r.message.slice(0, 150)}${data}`;
        });

        const summary = `Found ${filteredRows.length} logs (${errorCount} errors, ${warnCount} warnings) in last ${hoursBack}h:\n\n`;
        return { output: summary + lines.join("\n"), isError: false };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { output: `Error fetching process logs: ${msg}`, isError: true };
      }
    },
  };
}

function createGetProcessHealthTool(): ToolDefinition {
  return {
    name: "get_process_health",
    description:
      "Get aggregate health statistics from the process registry. Shows running processes, uptime, heartbeat freshness, and overall system health.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
    categories: ["analytics", "system"] as readonly ToolCategory[],
    async execute(): Promise<{ output: string; isError: boolean }> {
      try {
        const db = getDb();
        const rows = await db`
          SELECT * FROM process_registry
          ORDER BY name
        ` as ProcessRegistryRow[];

        if (rows.length === 0) {
          return { output: "No processes registered.", isError: false };
        }

        const now = Math.floor(Date.now() / 1000);
        const lines: string[] = [];

        let healthyCount = 0;
        let staleCount = 0;

        for (const proc of rows) {
          const uptime = now - proc.started_at;
          const secondsSinceHeartbeat = now - proc.last_heartbeat;
          const heartbeatFresh = secondsSinceHeartbeat < 60;
          const uptimeHours = (uptime / 3600).toFixed(1);

          const status = heartbeatFresh ? "✓ healthy" : "✗ stale";
          if (heartbeatFresh) healthyCount++;
          else staleCount++;

          const pid = proc.pid;

          lines.push(
            `${proc.name}: PID ${pid}, uptime ${uptimeHours}h, heartbeat ${secondsSinceHeartbeat}s ago [${status}]`,
          );
        }

        const healthSummary = `\n--- Health Summary ---\nTotal: ${rows.length} | Healthy: ${healthyCount} | Stale: ${staleCount}`;
        return {
          output: "Process Health:\n\n" + lines.join("\n") + healthSummary,
          isError: false,
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { output: `Error fetching process health: ${msg}`, isError: true };
      }
    },
  };
}