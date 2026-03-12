import type { ToolDefinition, ToolCategory } from "../types";
import { getDb } from "../../store/db";
import { getString, getNumber } from "../input-helpers";
import { createLogger } from "../../logger";

const log = createLogger("tool:log-checker");

export function createErrorAnalysisTool(): ToolDefinition {
  return {
    name: "error_analysis",
    description:
      "Deep-dive analysis of error logs. Shows error rate trend, groups errors by message pattern, and identifies most error-prone contexts. Use for incident investigation and root cause analysis.",
    categories: ["analytics", "system"] as readonly ToolCategory[],
    inputSchema: {
      type: "object",
      properties: {
        process_name: {
          type: "string",
          description: "Filter by process name (optional)",
        },
        hours_back: {
          type: "number",
          description: "How many hours to look back (default: 24, max: 168)",
        },
        top_n: {
          type: "number",
          description: "Number of top error groups to show (default: 10)",
        },
      },
      required: [],
    },
    async execute(input): Promise<{ output: string; isError: boolean }> {
      const processName = getString(input, "process_name", { allowEmpty: true });
      const hoursBack = getNumber(input, "hours_back", {
        defaultVal: 24,
        min: 1,
        max: 168,
      });
      const topN = getNumber(input, "top_n", { defaultVal: 10, min: 1, max: 50 });

      try {
        const db = getDb();
        const since = Math.floor(Date.now() / 1000) - hoursBack * 3600;

        let statsQuery = `
          SELECT
            COUNT(*) FILTER (WHERE level = 'error') AS error_count,
            COUNT(*) FILTER (WHERE level = 'warn') AS warn_count,
            COUNT(*) AS total_count
          FROM process_logs
          WHERE created_at >= $1
        `;
        const statsParams: unknown[] = [since];

        if (processName) {
          statsQuery += " AND process_name = $2";
          statsParams.push(processName);
        }

        const statsRows = (await db.unsafe(statsQuery, statsParams)) as {
          error_count: bigint;
          warn_count: bigint;
          total_count: bigint;
        }[];

        const stats = statsRows[0]!;
        const errorCount = Number(stats.error_count);
        const warnCount = Number(stats.warn_count);
        const totalCount = Number(stats.total_count);
        const errorRate = totalCount > 0 ? ((errorCount / totalCount) * 100).toFixed(2) : "0";

        let errorGroupsQuery = `
          SELECT
            LEFT(message, 100) AS message_pattern,
            context,
            COUNT(*)::bigint AS count
          FROM process_logs
          WHERE level = 'error' AND created_at >= $1
        `;
        const errorGroupsParams: unknown[] = [since];

        if (processName) {
          errorGroupsQuery += " AND process_name = $2";
          errorGroupsParams.push(processName);
        }

        errorGroupsQuery += `
          GROUP BY LEFT(message, 100), context
          ORDER BY count DESC
          LIMIT $${errorGroupsParams.length + 1}
        `;
        errorGroupsParams.push(topN);

        const errorGroups = (await db.unsafe(
          errorGroupsQuery,
          errorGroupsParams,
        )) as { message_pattern: string; context: string; count: bigint }[];

        let contextQuery = `
          SELECT
            context,
            COUNT(*) FILTER (WHERE level = 'error')::bigint AS errors,
            COUNT(*)::bigint AS total
          FROM process_logs
          WHERE created_at >= $1
        `;
        const contextParams: unknown[] = [since];

        if (processName) {
          contextQuery += " AND process_name = $2";
          contextParams.push(processName);
        }

        contextQuery += `
          GROUP BY context
          ORDER BY errors DESC
          LIMIT $${contextParams.length + 1}
        `;
        contextParams.push(topN);

        const contextStats = (await db.unsafe(
          contextQuery,
          contextParams,
        )) as { context: string; errors: bigint; total: bigint }[];

        const lines: string[] = [
          `Error Analysis (last ${hoursBack}h)`,
          processName ? `Process: ${processName}` : "",
          "",
          `Summary: ${errorCount} errors, ${warnCount} warnings, ${totalCount} total logs`,
          `Error rate: ${errorRate}%`,
          "",
          `Top ${Math.min(topN, errorGroups.length)} Error Patterns:`,
        ];

        if (errorGroups.length === 0) {
          lines.push("  (no errors found)");
        } else {
          errorGroups.forEach((g, i) => {
            lines.push(`  ${i + 1}. [${g.context}] ${g.message_pattern}... (${g.count}x)`);
          });
        }

        lines.push("", `Top ${Math.min(topN, contextStats.length)} Error-Prone Contexts:`);
        contextStats.slice(0, topN).forEach((c, i) => {
          const ctxErrorRate =
            Number(c.total) > 0
              ? ((Number(c.errors) / Number(c.total)) * 100).toFixed(1)
              : "0";
          lines.push(
            `  ${i + 1}. ${c.context}: ${c.errors} errors / ${c.total} total (${ctxErrorRate}%)`,
          );
        });

        return { output: lines.filter((l) => l !== "").join("\n"), isError: false };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        log.error("Error analysis failed", error);
        return { output: `Error analyzing logs: ${msg}`, isError: true };
      }
    },
  };
}
