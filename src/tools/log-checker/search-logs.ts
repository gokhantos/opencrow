import type { ToolDefinition, ToolCategory } from "../types";
import { getDb } from "../../store/db";
import {
  getString,
  getNumber,
  getEnum,
  getBoolean,
  isToolError,
  requireString,
} from "../input-helpers";
import { createLogger } from "../../logger";
import { truncate, type LogRow } from "./helpers";

const log = createLogger("tool:log-checker");

export function createSearchLogsTool(): ToolDefinition {
  return {
    name: "search_logs",
    description:
      "Search log messages and data for patterns or keywords. Supports substring match and regex. Use for finding specific errors, tracing requests, or investigating incidents.",
    categories: ["analytics", "system"] as readonly ToolCategory[],
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query (substring or regex pattern)",
        },
        process_name: {
          type: "string",
          description: "Filter by process name (e.g., 'web', 'agent')",
        },
        level: {
          type: "string",
          enum: ["debug", "info", "warn", "error"],
          description: "Filter by log level",
        },
        context: {
          type: "string",
          description: "Filter by context (e.g., 'tool:bash', 'agent:claude')",
        },
        use_regex: {
          type: "boolean",
          description: "Treat query as regex (default: false)",
        },
        hours_back: {
          type: "number",
          description: "How many hours to look back (default: 24, max: 168)",
        },
        limit: {
          type: "number",
          description: "Max results to return (default: 50, max: 200)",
        },
      },
      required: ["query"],
    },
    async execute(input): Promise<{ output: string; isError: boolean }> {
      const query = requireString(input, "query");
      if (isToolError(query)) return query;

      const processName = getString(input, "process_name", { allowEmpty: true });
      const level = getEnum(input, "level", [
        "debug",
        "info",
        "warn",
        "error",
      ] as const);
      const context = getString(input, "context", { allowEmpty: true });
      const useRegex = getBoolean(input, "use_regex", false);
      const hoursBack = getNumber(input, "hours_back", {
        defaultVal: 24,
        min: 1,
        max: 168,
      });
      const limit = getNumber(input, "limit", { defaultVal: 50, min: 1, max: 200 });

      try {
        const db = getDb();
        const since = Math.floor(Date.now() / 1000) - hoursBack * 3600;

        const conditions = ["created_at >= $1"];
        const params: unknown[] = [since];
        let paramIdx = 2;

        if (processName) {
          conditions.push(`process_name = $${paramIdx++}`);
          params.push(processName);
        }
        if (level) {
          conditions.push(`level = $${paramIdx++}`);
          params.push(level);
        }
        if (context) {
          conditions.push(`context = $${paramIdx++}`);
          params.push(context);
        }

        if (useRegex) {
          conditions.push(`message ~ $${paramIdx++}`);
          params.push(query);
        } else {
          conditions.push(`message ILIKE $${paramIdx++}`);
          params.push(`%${query}%`);
        }

        const whereClause = conditions.join(" AND ");

        const rows = (await db.unsafe(
          `SELECT * FROM process_logs WHERE ${whereClause} ORDER BY created_at DESC LIMIT $${paramIdx++}`,
          [...params, limit],
        )) as LogRow[];

        if (rows.length === 0) {
          return {
            output: `No logs found matching "${query}" (last ${hoursBack}h).`,
            isError: false,
          };
        }

        const lines = rows.map((r) => {
          const ts = new Date(r.created_at * 1000).toLocaleString();
          const data = r.data_json ? ` | data: ${truncate(r.data_json, 150)}` : "";
          return `[${r.level.toUpperCase()}] ${ts} ${r.process_name}/${r.context}: ${truncate(r.message, 200)}${data}`;
        });

        const summary = `Found ${rows.length} logs matching "${query}" (last ${hoursBack}h):\n\n`;
        return { output: summary + lines.join("\n"), isError: false };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        log.error("Search logs failed", error);
        return { output: `Error searching logs: ${msg}`, isError: true };
      }
    },
  };
}
