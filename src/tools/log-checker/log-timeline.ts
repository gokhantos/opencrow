import type { ToolDefinition, ToolCategory } from "../types";
import { getDb } from "../../store/db";
import { getString, getNumber, getEnum } from "../input-helpers";
import { createLogger } from "../../logger";
import type { TimelineRow } from "./helpers";

const log = createLogger("tool:log-checker");

export function createLogTimelineTool(): ToolDefinition {
  return {
    name: "log_timeline",
    description:
      "Time-series view of log volume. Shows logs per time bucket with optional level filtering. Use for identifying traffic spikes, quiet periods, or correlating with incidents.",
    categories: ["analytics", "system"] as readonly ToolCategory[],
    inputSchema: {
      type: "object",
      properties: {
        hours_back: {
          type: "number",
          description: "How many hours to look back (default: 24, max: 168)",
        },
        bucket: {
          type: "string",
          enum: ["minute", "5min", "15min", "hour"],
          description: "Time bucket size (default: hour)",
        },
        level: {
          type: "string",
          enum: ["debug", "info", "warn", "error"],
          description: "Filter by log level (optional)",
        },
        process_name: {
          type: "string",
          description: "Filter by process name (optional)",
        },
      },
      required: [],
    },
    async execute(input): Promise<{ output: string; isError: boolean }> {
      const hoursBack = getNumber(input, "hours_back", {
        defaultVal: 24,
        min: 1,
        max: 168,
      });
      const bucket =
        getEnum(input, "bucket", ["minute", "5min", "15min", "hour"] as const) ||
        "hour";
      const level = getEnum(input, "level", [
        "debug",
        "info",
        "warn",
        "error",
      ] as const);
      const processName = getString(input, "process_name", { allowEmpty: true });

      try {
        const db = getDb();
        const since = Math.floor(Date.now() / 1000) - hoursBack * 3600;

        const bucketFormats: Record<string, string> = {
          minute: "to_char(to_timestamp(created_at), 'YYYY-MM-DD HH24:MI')",
          "5min":
            "to_char(to_timestamp(created_at - (EXTRACT(EPOCH FROM to_timestamp(created_at))::int % 300)), 'YYYY-MM-DD HH24:MI')",
          "15min":
            "to_char(to_timestamp(created_at - (EXTRACT(EPOCH FROM to_timestamp(created_at))::int % 900)), 'YYYY-MM-DD HH24:MI')",
          hour: "to_char(to_timestamp(created_at), 'YYYY-MM-DD HH24:00')",
        };

        const timeExpr = bucketFormats[bucket];

        let query = `
          SELECT
            ${timeExpr} AS time_bucket,
            COUNT(*)::bigint AS count,
            COUNT(*) FILTER (WHERE level = 'error')::bigint AS error_count,
            COUNT(*) FILTER (WHERE level = 'warn')::bigint AS warn_count
          FROM process_logs
          WHERE created_at >= $1
        `;
        const params: unknown[] = [since];

        if (level) {
          query += " AND level = $2";
          params.push(level);
        }
        if (processName) {
          query += ` AND process_name = $${params.length + 1}`;
          params.push(processName);
        }

        query += `
          GROUP BY ${timeExpr}
          ORDER BY time_bucket ASC
        `;

        const rows = (await db.unsafe(query, params)) as TimelineRow[];

        if (rows.length === 0) {
          return {
            output: `No logs found in the last ${hoursBack}h.`,
            isError: false,
          };
        }

        const counts = rows.map((r) => Number(r.count));
        const avgCount = counts.reduce((a, b) => a + b, 0) / counts.length;
        const maxCount = Math.max(...counts);
        const spikeThreshold = avgCount * 2;

        const lines: string[] = [
          `Log Timeline (${bucket} buckets, last ${hoursBack}h)`,
          level ? `Level: ${level}` : "",
          processName ? `Process: ${processName}` : "",
          "",
          `Avg: ${avgCount.toFixed(1)} logs/bucket | Max: ${maxCount} | Spike threshold: ${spikeThreshold.toFixed(0)}`,
          "",
        ];

        let spikeCount = 0;
        rows.forEach((r) => {
          const count = Number(r.count);
          const isSpike = count >= spikeThreshold;
          const marker = isSpike ? " !" : "  ";
          const details = level ? "" : ` | E:${r.error_count} W:${r.warn_count}`;
          lines.push(`${marker} ${r.time_bucket}: ${count}${details}`);
          if (isSpike) spikeCount++;
        });

        if (spikeCount > 0) {
          lines.push("", `! = spike detected (${spikeCount} buckets above threshold)`);
        }

        return { output: lines.join("\n"), isError: false };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        log.error("Log timeline failed", error);
        return { output: `Error getting timeline: ${msg}`, isError: true };
      }
    },
  };
}
