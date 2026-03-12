import type { ToolDefinition, ToolCategory } from "../types";
import { getDb } from "../../store/db";
import { getNumber, isToolError, requireString } from "../input-helpers";
import { createLogger } from "../../logger";

const log = createLogger("tool:log-checker");

export function createComparePeriodsTool(): ToolDefinition {
  return {
    name: "compare_periods",
    description:
      "Compare log metrics between two time periods. Shows volume change, error rate change, and flags anomalies. Use for measuring impact of deployments or investigating changes in behavior.",
    categories: ["analytics", "system"] as readonly ToolCategory[],
    inputSchema: {
      type: "object",
      properties: {
        metric: {
          type: "string",
          enum: ["volume", "errors", "levels"],
          description:
            "Metric to compare (volume=total logs, errors=error count, levels=breakdown by level)",
        },
        current_hours_back: {
          type: "number",
          description: "Current period: how many hours back (default: 24)",
        },
        previous_hours_back: {
          type: "number",
          description:
            "Previous period: how many hours back from current period start (default: 24)",
        },
      },
      required: ["metric"],
    },
    async execute(input): Promise<{ output: string; isError: boolean }> {
      const metric = requireString(input, "metric");
      if (isToolError(metric)) return metric;

      const currentHoursBack = getNumber(input, "current_hours_back", {
        defaultVal: 24,
        min: 1,
        max: 168,
      });
      const previousHoursBack = getNumber(input, "previous_hours_back", {
        defaultVal: currentHoursBack,
        min: 1,
        max: 168,
      });

      try {
        const db = getDb();
        const now = Math.floor(Date.now() / 1000);
        const currentSince = now - currentHoursBack * 3600;
        const previousSince = currentSince - previousHoursBack * 3600;

        if (metric === "volume") {
          return await compareVolume(db, currentSince, previousSince, currentHoursBack, previousHoursBack);
        }

        if (metric === "errors") {
          return await compareErrors(db, currentSince, previousSince, currentHoursBack, previousHoursBack);
        }

        if (metric === "levels") {
          return await compareLevels(db, currentSince, previousSince, currentHoursBack, previousHoursBack);
        }

        return {
          output: `Invalid metric: ${metric}. Must be: volume, errors, or levels.`,
          isError: true,
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        log.error("Compare periods failed", error);
        return { output: `Error comparing periods: ${msg}`, isError: true };
      }
    },
  };
}

async function compareVolume(
  db: ReturnType<typeof getDb>,
  currentSince: number,
  previousSince: number,
  currentHoursBack: number,
  previousHoursBack: number,
): Promise<{ output: string; isError: boolean }> {
  const rows = (await db.unsafe(
    `SELECT
      COUNT(*) FILTER (WHERE created_at >= $1) AS current,
      COUNT(*) FILTER (WHERE created_at >= $2 AND created_at < $1) AS previous
    FROM process_logs
    WHERE created_at >= $2`,
    [currentSince, previousSince],
  )) as { current: bigint; previous: bigint }[];

  const current = Number(rows[0]!.current);
  const previous = Number(rows[0]!.previous);
  const change = current - previous;
  const pctChange = previous > 0 ? ((change / previous) * 100).toFixed(1) : "N/A";
  const anomaly = Math.abs(parseFloat(pctChange as string)) > 50 ? " (ANOMALY)" : "";

  return {
    output: `Volume Comparison:
  Current period (${currentHoursBack}h): ${current} logs
  Previous period (${previousHoursBack}h): ${previous} logs
  Change: ${change > 0 ? "+" : ""}${change} (${pctChange}%)${anomaly}`,
    isError: false,
  };
}

async function compareErrors(
  db: ReturnType<typeof getDb>,
  currentSince: number,
  previousSince: number,
  currentHoursBack: number,
  previousHoursBack: number,
): Promise<{ output: string; isError: boolean }> {
  const rows = (await db.unsafe(
    `SELECT
      COUNT(*) FILTER (WHERE level = 'error' AND created_at >= $1) AS current_errors,
      COUNT(*) FILTER (WHERE level = 'error' AND created_at >= $2 AND created_at < $1) AS previous_errors,
      COUNT(*) FILTER (WHERE created_at >= $1) AS current_total,
      COUNT(*) FILTER (WHERE created_at >= $2 AND created_at < $1) AS previous_total
    FROM process_logs
    WHERE created_at >= $2`,
    [currentSince, previousSince],
  )) as {
    current_errors: bigint;
    previous_errors: bigint;
    current_total: bigint;
    previous_total: bigint;
  }[];

  const currentErrors = Number(rows[0]!.current_errors);
  const previousErrors = Number(rows[0]!.previous_errors);
  const currentTotal = Number(rows[0]!.current_total);
  const previousTotal = Number(rows[0]!.previous_total);

  const errorChange = currentErrors - previousErrors;
  const errorPctChange =
    previousErrors > 0
      ? ((errorChange / previousErrors) * 100).toFixed(1)
      : "N/A";
  const currentErrorRate =
    currentTotal > 0 ? ((currentErrors / currentTotal) * 100).toFixed(2) : "0";
  const previousErrorRate =
    previousTotal > 0
      ? ((previousErrors / previousTotal) * 100).toFixed(2)
      : "0";
  const anomaly =
    Math.abs(parseFloat(errorPctChange as string)) > 50 ? " (ANOMALY)" : "";

  return {
    output: `Error Comparison:
  Current period: ${currentErrors} errors (${currentErrorRate}% of ${currentTotal} total)
  Previous period: ${previousErrors} errors (${previousErrorRate}% of ${previousTotal} total)
  Change: ${errorChange > 0 ? "+" : ""}${errorChange} (${errorPctChange}%)${anomaly}`,
    isError: false,
  };
}

async function compareLevels(
  db: ReturnType<typeof getDb>,
  currentSince: number,
  previousSince: number,
  currentHoursBack: number,
  previousHoursBack: number,
): Promise<{ output: string; isError: boolean }> {
  const rows = (await db.unsafe(
    `SELECT
      level,
      COUNT(*) FILTER (WHERE created_at >= $1) AS current,
      COUNT(*) FILTER (WHERE created_at >= $2 AND created_at < $1) AS previous
    FROM process_logs
    WHERE created_at >= $2
    GROUP BY level`,
    [currentSince, previousSince],
  )) as { level: string; current: bigint; previous: bigint }[];

  const lines: string[] = [
    `Level Breakdown Comparison:`,
    ``,
    `Level       | Current (${currentHoursBack}h) | Previous (${previousHoursBack}h) | Change`,
    `------------|${"-".repeat(19 + currentHoursBack.toString().length)}|${"-".repeat(20 + previousHoursBack.toString().length)}|--------`,
  ];

  const levelOrder = ["debug", "info", "warn", "error"];
  const sortedRows = [...rows].sort(
    (a, b) => levelOrder.indexOf(a.level) - levelOrder.indexOf(b.level),
  );

  for (const row of sortedRows) {
    const current = Number(row.current);
    const previous = Number(row.previous);
    const change = current - previous;
    const changeStr = change > 0 ? `+${change}` : `${change}`;
    lines.push(
      `${row.level.padEnd(11)} | ${String(current).padEnd(18)} | ${String(previous).padEnd(19)} | ${changeStr}`,
    );
  }

  return { output: lines.join("\n"), isError: false };
}
