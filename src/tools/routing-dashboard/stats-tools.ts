import type { ToolDefinition, ToolCategory } from "../types";
import { getDb } from "../../store/db";
import { getMcpHealth, getToolPerformance, getCostBreakdown } from "./queries";
import { formatMcpHealth } from "./formatters";

export function createRoutingStatsTool(): ToolDefinition {
  return {
    name: "get_routing_stats",
    description:
      "Get routing statistics: task breakdown by domain, complexity, urgency, and top keywords.",
    categories: ["analytics", "routing"] as readonly ToolCategory[],
    inputSchema: {
      type: "object",
      properties: {
        hours_back: {
          type: "number",
          description: "Hours of data to include (default 24, max 720)",
        },
        domain: {
          type: "string",
          description: "Filter to specific domain",
        },
      },
    },
    async execute(input): Promise<{ output: string; isError: boolean }> {
      const hoursBack = Math.min((input.hours_back as number) || 24, 720);
      const domain = (input.domain as string) || null;

      try {
        const db = getDb();
        const stats = await db`
          SELECT
            domain,
            COUNT(*) as count,
            AVG(complexity_score) as avg_complexity,
            AVG(CASE WHEN urgency = 'high' THEN 1 WHEN urgency = 'medium' THEN 0.5 ELSE 0 END) as avg_urgency
          FROM task_classification
          WHERE created_at >= NOW() - (${hoursBack} * INTERVAL '1 hour')
          ${domain ? db`AND domain = ${domain}` : db``}
          GROUP BY domain
          ORDER BY count DESC
        `;

        if (!stats || stats.length === 0) {
          return {
            output: `No task classification data found for the last ${hoursBack} hours.`,
            isError: false,
          };
        }

        const totalTasks = stats.reduce(
          (sum: number, r: any) => sum + Number(r.count),
          0,
        );
        const lines = [`*Task Classification (last ${hoursBack}h)*`, ""];

        stats.forEach((row: any, i: number) => {
          const pct = ((Number(row.count) / totalTasks) * 100).toFixed(0);
          const complexity = Number(row.avg_complexity || 0).toFixed(1);
          const urgency = Number(row.avg_urgency || 0);
          const urgencyLabel =
            urgency > 0.7 ? "🔴 high" : urgency > 0.3 ? "🟡 medium" : "🟢 low";

          lines.push(`${i + 1}. *${row.domain}*: ${row.count} tasks (${pct}%)`);
          lines.push(`   Complexity: ${complexity}/5, Urgency: ${urgencyLabel}`);
        });

        lines.push("");
        lines.push(`*Total:* ${totalTasks} tasks classified`);

        return { output: lines.join("\n"), isError: false };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { output: `Error: ${msg}`, isError: true };
      }
    },
  };
}

export function createMcpHealthTool(): ToolDefinition {
  return {
    name: "get_mcp_health",
    description:
      "Get MCP server health metrics: latency, reliability, and call volume.",
    categories: ["analytics", "mcp"] as readonly ToolCategory[],
    inputSchema: {
      type: "object",
      properties: {
        hours_back: {
          type: "number",
          description: "Hours of data (default 24)",
        },
      },
    },
    async execute(input): Promise<{ output: string; isError: boolean }> {
      const hoursBack = Math.min((input.hours_back as number) || 24, 168);

      try {
        const db = getDb();
        const health = await getMcpHealth(db, hoursBack);
        const lines = [`*MCP Server Health (last ${hoursBack}h)*`, ""];

        health.forEach((m, i) => {
          const status =
            m.reliability > 0.95 ? "✅" : m.reliability > 0.8 ? "⚠️" : "❌";
          lines.push(`${i + 1}. ${status} ${m.server}`);
          lines.push(
            `   Calls: ${m.totalCalls}, Reliability: ${(m.reliability * 100).toFixed(0)}%, ` +
              `P95: ${m.p95Latency.toFixed(0)}ms`,
          );
        });

        if (health.length === 0) {
          lines.push("_No MCP performance data available_");
        }

        return { output: lines.join("\n"), isError: false };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { output: `Error: ${msg}`, isError: true };
      }
    },
  };
}

export function createToolPerformanceTool(): ToolDefinition {
  return {
    name: "get_tool_performance",
    description:
      "Get tool performance metrics: call volume, error rates, and reliability.",
    categories: ["analytics", "tools"] as readonly ToolCategory[],
    inputSchema: {
      type: "object",
      properties: {
        hours_back: {
          type: "number",
          description: "Hours of data (default 24)",
        },
      },
    },
    async execute(input): Promise<{ output: string; isError: boolean }> {
      const hoursBack = Math.min((input.hours_back as number) || 24, 168);

      try {
        const db = getDb();
        const perf = await getToolPerformance(db, hoursBack);
        const lines = [`*Tool Performance (last ${hoursBack}h)*`, ""];

        const byErrorRate = [...perf].sort((a, b) => b.errorRate - a.errorRate);

        lines.push("*Tools by error rate:*");
        byErrorRate.slice(0, 10).forEach((t, i) => {
          const status =
            t.errorRate < 0.05 ? "✅" : t.errorRate < 0.2 ? "⚠️" : "❌";
          lines.push(
            `${i + 1}. ${status} ${t.toolName}: ${(t.errorRate * 100).toFixed(1)}% errors (${t.errorCount}/${t.totalCalls})`,
          );
        });

        if (perf.length === 0) {
          lines.push("_No tool performance data available_");
        }

        return { output: lines.join("\n"), isError: false };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { output: `Error: ${msg}`, isError: true };
      }
    },
  };
}

export function createCostBreakdownTool(): ToolDefinition {
  return {
    name: "get_cost_breakdown",
    description:
      "Get cost breakdown by agent: tokens, cost, and per-task averages.",
    categories: ["analytics", "cost"] as readonly ToolCategory[],
    inputSchema: {
      type: "object",
      properties: {
        hours_back: {
          type: "number",
          description: "Hours of data (default 24)",
        },
      },
    },
    async execute(input): Promise<{ output: string; isError: boolean }> {
      const hoursBack = Math.min((input.hours_back as number) || 24, 168);

      try {
        const db = getDb();
        const costs = await getCostBreakdown(db, hoursBack);
        const lines = [`*Cost Breakdown (last ${hoursBack}h)*`, ""];

        let totalCost = 0;
        costs.forEach((c, i) => {
          totalCost += c.totalCost;
          lines.push(
            `${i + 1}. ${c.agentId}: $${c.totalCost.toFixed(2)} | ` +
              `${c.taskCount} tasks | $${c.avgCostPerTask.toFixed(3)}/task`,
          );
        });

        lines.push("");
        lines.push(`*Total:* $${totalCost.toFixed(2)}`);

        if (costs.length === 0) {
          lines.push("_No cost data available_");
        }

        return { output: lines.join("\n"), isError: false };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { output: `Error: ${msg}`, isError: true };
      }
    },
  };
}

export function createPrewarmStatsTool(): ToolDefinition {
  return {
    name: "get_prewarm_stats",
    description:
      "Get pre-warming cache statistics: domain hit rates and context usage.",
    categories: ["analytics", "prewarm"] as readonly ToolCategory[],
    inputSchema: {
      type: "object",
      properties: {},
    },
    async execute(_input): Promise<{ output: string; isError: boolean }> {
      try {
        const db = getDb();
        const rows = await db`
          SELECT domain, hit_rate, last_used, LENGTH(context_data::text) as context_size
          FROM prewarm_cache
          ORDER BY hit_rate DESC
        `;

        const lines = ["*PRE-WARM CACHE STATS*", ""];

        if (!rows || rows.length === 0) {
          lines.push("_No pre-warm data yet_");
        } else {
          rows.forEach((row: any, i: number) => {
            lines.push(
              `${i + 1}. ${row.domain}: hit_rate=${(Number(row.hit_rate || 0) * 100).toFixed(0)}%, ` +
                `context_size=${Number(row.context_size || 0)} bytes`,
            );
          });
        }

        return { output: lines.join("\n"), isError: false };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { output: `Error: ${msg}`, isError: true };
      }
    },
  };
}
