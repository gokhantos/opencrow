import type { ToolDefinition, ToolCategory } from "../types";
import { getDb } from "../../store/db";
import {
  getString,
  getNumber,
  isToolError,
  requireString,
} from "../input-helpers";
import { createLogger } from "../../logger";
import type { AggregateRow } from "./helpers";

const log = createLogger("tool:log-checker");

export function createAggregateLogsTool(): ToolDefinition {
  return {
    name: "aggregate_logs",
    description:
      "Get aggregate statistics from logs. Group by level, process, context, or hour to understand distribution and identify hotspots.",
    categories: ["analytics", "system"] as readonly ToolCategory[],
    inputSchema: {
      type: "object",
      properties: {
        group_by: {
          type: "string",
          enum: ["level", "process", "context", "hour"],
          description: "Dimension to group by",
        },
        process_name: {
          type: "string",
          description: "Filter by process name (optional)",
        },
        hours_back: {
          type: "number",
          description: "How many hours to look back (default: 24, max: 168)",
        },
      },
      required: ["group_by"],
    },
    async execute(input): Promise<{ output: string; isError: boolean }> {
      const groupBy = requireString(input, "group_by");
      if (isToolError(groupBy)) return groupBy;

      const processName = getString(input, "process_name", { allowEmpty: true });
      const hoursBack = getNumber(input, "hours_back", {
        defaultVal: 24,
        min: 1,
        max: 168,
      });

      try {
        const db = getDb();
        const since = Math.floor(Date.now() / 1000) - hoursBack * 3600;

        const groupConfigs: Record<string, { expr: string; label: string }> = {
          level: { expr: "level", label: "Level" },
          process: { expr: "process_name", label: "Process" },
          context: { expr: "context", label: "Context" },
          hour: {
            expr: "to_char(to_timestamp(created_at), 'YYYY-MM-DD HH24:00')",
            label: "Hour",
          },
        };

        const config = groupConfigs[groupBy];
        if (!config) {
          return {
            output: `Invalid group_by: ${groupBy}. Must be: level, process, context, or hour.`,
            isError: true,
          };
        }

        let rows: AggregateRow[];

        if (processName) {
          rows = (await db.unsafe(
            `SELECT ${config.expr} AS bucket, COUNT(*)::bigint AS count
             FROM process_logs
             WHERE created_at >= $1 AND process_name = $2
             GROUP BY ${config.expr}
             ORDER BY count DESC`,
            [since, processName],
          )) as AggregateRow[];
        } else {
          rows = (await db.unsafe(
            `SELECT ${config.expr} AS bucket, COUNT(*)::bigint AS count
             FROM process_logs
             WHERE created_at >= $1
             GROUP BY ${config.expr}
             ORDER BY count DESC`,
            [since],
          )) as AggregateRow[];
        }

        if (rows.length === 0) {
          return {
            output: `No logs found in the last ${hoursBack}h.`,
            isError: false,
          };
        }

        const total = rows.reduce((sum, r) => sum + Number(r.count), 0);
        const lines = rows.map((r) => {
          const pct = ((Number(r.count) / total) * 100).toFixed(1);
          return `${r.bucket}: ${r.count} (${pct}%)`;
        });

        const summary = `Logs grouped by ${config.label} (last ${hoursBack}h, total: ${total}):\n\n`;
        return { output: summary + lines.join("\n"), isError: false };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        log.error("Aggregate logs failed", error);
        return { output: `Error aggregating logs: ${msg}`, isError: true };
      }
    },
  };
}
