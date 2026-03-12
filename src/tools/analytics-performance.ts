import type { ToolDefinition, ToolCategory } from "./types";
import { getDb } from "../store/db";

export function createGetToolUsageTool(): ToolDefinition {
  return {
    name: "get_tool_usage",
    description:
      "Get analytics on tool usage patterns. Shows which tools are used most, error rates, and usage trends. Useful for understanding how you interact with tools.",
    categories: ["analytics"] as readonly ToolCategory[],
    inputSchema: {
      type: "object",
      properties: {
        agent_id: {
          type: "string",
          description: "Filter by agent ID. Omit for all agents.",
        },
        hours_back: {
          type: "number",
          description: "How many hours to look back (default 24, max 168).",
        },
        group_by: {
          type: "string",
          enum: ["tool", "agent", "hour"],
          description: "How to group results. Default: tool.",
        },
      },
      required: [],
    },
    async execute(input): Promise<{ output: string; isError: boolean }> {
      const agentId = input.agent_id as string | undefined;
      const hoursBack = Math.min((input.hours_back as number) || 24, 168);
      const groupBy = (input.group_by as string) || "tool";

      try {
        const db = getDb();
        const since = Math.floor(Date.now() / 1000) - hoursBack * 3600;

        if (groupBy === "tool") {
          const rows = await db`
            SELECT tool_name, COUNT(*) as count,
                   SUM(CASE WHEN is_error THEN 1 ELSE 0 END) as errors
            FROM tool_audit_log
            WHERE created_at >= ${since}
              ${agentId ? db`AND agent_id = ${agentId}` : db``}
            GROUP BY tool_name
            ORDER BY count DESC
            LIMIT 20
          `;

          if (rows.length === 0) {
            return { output: "No tool usage data found for the specified time range.", isError: false };
          }

          const lines = rows.map((r: { tool_name: string; count: bigint; errors: bigint }, i: number) => {
            const errRate = r.count > 0 ? ((Number(r.errors) / Number(r.count)) * 100).toFixed(1) : "0";
            return `${i + 1}. ${r.tool_name}: ${r.count} calls, ${r.errors} errors (${errRate}%)`;
          });

          const totalCalls = rows.reduce((sum: number, r: { count: bigint }) => sum + Number(r.count), 0);
          const totalErrors = rows.reduce((sum: number, r: { errors: bigint }) => sum + Number(r.errors), 0);

          return {
            output: `Tool usage (last ${hoursBack}h) - ${totalCalls} total calls, ${totalErrors} errors:\n\n${lines.join("\n")}`,
            isError: false,
          };
        } else if (groupBy === "agent") {
          const rows = await db`
            SELECT agent_id, COUNT(*) as count,
                   SUM(CASE WHEN is_error THEN 1 ELSE 0 END) as errors
            FROM tool_audit_log
            WHERE created_at >= ${since}
            GROUP BY agent_id
            ORDER BY count DESC
            LIMIT 20
          `;

          if (rows.length === 0) {
            return { output: "No tool usage data found for the specified time range.", isError: false };
          }

          const lines = rows.map((r: { agent_id: string; count: bigint; errors: bigint }, i: number) => {
            const errRate = r.count > 0 ? ((Number(r.errors) / Number(r.count)) * 100).toFixed(1) : "0";
            return `${i + 1}. ${r.agent_id}: ${r.count} calls, ${r.errors} errors (${errRate}%)`;
          });

          return {
            output: `Tool usage by agent (last ${hoursBack}h):\n\n${lines.join("\n")}`,
            isError: false,
          };
        } else {
          // group by hour
          const rows = await db`
            SELECT
              FLOOR(created_at / 3600) as hour_bucket,
              COUNT(*) as count,
              SUM(CASE WHEN is_error THEN 1 ELSE 0 END) as errors
            FROM tool_audit_log
            WHERE created_at >= ${since}
              ${agentId ? db`AND agent_id = ${agentId}` : db``}
            GROUP BY hour_bucket
            ORDER BY hour_bucket DESC
            LIMIT 24
          `;

          if (rows.length === 0) {
            return { output: "No tool usage data found for the specified time range.", isError: false };
          }

          const lines = rows.map((r: { hour_bucket: string; count: bigint; errors: bigint }) => {
            const date = new Date(Number(r.hour_bucket) * 3600 * 1000);
            const hourStr = date.toLocaleString();
            return `${hourStr}: ${r.count} calls, ${r.errors} errors`;
          });

          return {
            output: `Tool usage by hour (last ${hoursBack}h):\n\n${lines.join("\n")}`,
            isError: false,
          };
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { output: `Error fetching tool usage: ${msg}`, isError: true };
      }
    },
  };
}


export function createGetAgentPerformanceTool(): ToolDefinition {
  return {
    name: "get_agent_performance",
    description:
      "Get performance metrics for agent executions. Shows token usage, costs, latency, and tool usage patterns by agent. Useful for optimizing agent efficiency.",
    categories: ["analytics"] as readonly ToolCategory[],
    inputSchema: {
      type: "object",
      properties: {
        agent_id: {
          type: "string",
          description: "Filter by agent ID. Omit for all agents.",
        },
        hours_back: {
          type: "number",
          description: "How many hours to look back (default 24, max 168).",
        },
      },
      required: [],
    },
    async execute(input): Promise<{ output: string; isError: boolean }> {
      const agentId = input.agent_id as string | undefined;
      const hoursBack = Math.min((input.hours_back as number) || 24, 168);

      try {
        const db = getDb();
        const since = Math.floor(Date.now() / 1000) - hoursBack * 3600;

        // Aggregate by agent
        const rows = await db`
          SELECT
            agent_id,
            model,
            provider,
            COUNT(*) as request_count,
            SUM(input_tokens) as total_input,
            SUM(output_tokens) as total_output,
            SUM(cache_read_tokens) as total_cache_read,
            SUM(cost_usd) as total_cost,
            AVG(duration_ms) as avg_duration,
            SUM(tool_use_count) as total_tool_uses
          FROM token_usage
          WHERE created_at >= ${since}
            ${agentId ? db`AND agent_id = ${agentId}` : db``}
          GROUP BY agent_id, model, provider
          ORDER BY total_cost DESC
          LIMIT 15
        `;

        if (rows.length === 0) {
          return { output: "No performance data found for the specified time range.", isError: false };
        }

        const lines = rows.map((r: {
          agent_id: string;
          model: string;
          request_count: bigint;
          total_input: bigint;
          total_output: bigint;
          total_cost: number;
          avg_duration: number;
          total_tool_uses: bigint;
        }, i: number) => {
          const avgDur = r.avg_duration ? Math.round(Number(r.avg_duration)) : 0;
          const cost = Number(r.total_cost).toFixed(3);
          const inputK = (Number(r.total_input) / 1000).toFixed(1);
          const outputK = (Number(r.total_output) / 1000).toFixed(1);
          return `${i + 1}. ${r.agent_id} (${r.model})\n   ${r.request_count} requests, ${inputK}K input, ${outputK}K output, $${cost} cost\n   Avg ${avgDur}ms, ${r.total_tool_uses} tool calls`;
        });

        const totalCost = rows.reduce((sum: number, r: { total_cost: number }) => sum + Number(r.total_cost), 0);
        const totalReqs = rows.reduce((sum: number, r: { request_count: bigint }) => sum + Number(r.request_count), 0);

        return {
          output: `Agent performance (last ${hoursBack}h) - ${totalReqs} requests, $${totalCost.toFixed(3)} total:\n\n${lines.join("\n\n")}`,
          isError: false,
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { output: `Error fetching agent performance: ${msg}`, isError: true };
      }
    },
  };
}

export function createGetSessionStatsTool(): ToolDefinition {
  return {
    name: "get_session_stats",
    description:
      "Get statistics about conversation sessions. Shows session counts, duration patterns, and activity trends. Useful for understanding usage patterns.",
    categories: ["analytics"] as readonly ToolCategory[],
    inputSchema: {
      type: "object",
      properties: {
        channel: {
          type: "string",
          description: "Filter by channel (e.g., 'telegram'). Omit for all channels.",
        },
        days_back: {
          type: "number",
          description: "How many days to look back (default 7, max 30).",
        },
      },
      required: [],
    },
    async execute(input): Promise<{ output: string; isError: boolean }> {
      const channel = input.channel as string | undefined;
      const daysBack = Math.min((input.days_back as number) || 7, 30);

      try {
        const db = getDb();
        const since = Math.floor(Date.now() / 1000) - daysBack * 86400;

        // Get session counts by channel
        const channelRows = await db`
          SELECT channel, COUNT(*) as count
          FROM sessions
          WHERE created_at >= ${since}
            ${channel ? db`AND channel = ${channel}` : db``}
          GROUP BY channel
          ORDER BY count DESC
        `;

        // Get sessions by day
        const dayRows = await db`
          SELECT
            DATE(TO_TIMESTAMP(created_at)) as day,
            COUNT(*) as count
          FROM sessions
          WHERE created_at >= ${since}
            ${channel ? db`AND channel = ${channel}` : db``}
          GROUP BY day
          ORDER BY day DESC
          LIMIT ${daysBack}
        `;

        // Get unique chats
        const chatRows = await db`
          SELECT COUNT(DISTINCT chat_id) as unique_chats
          FROM sessions
          WHERE created_at >= ${since}
            ${channel ? db`AND channel = ${channel}` : db``}
        `;

        const totalSessions = channelRows.reduce((sum: number, r: { count: bigint }) => sum + Number(r.count), 0);
        const uniqueChats = chatRows[0]?.unique_chats || 0;

        const channelStats = channelRows.map((r: any) => `${r.channel}: ${r.count} sessions`).join(", ");
        const dayStats = dayRows.map((r: any) => {
          const date = new Date(r.day).toLocaleDateString();
          return `${date}: ${r.count}`;
        }).join("\n");

        return {
          output: `Session stats (last ${daysBack} days):\n\n` +
            `Total sessions: ${totalSessions}\n` +
            `Unique chats: ${uniqueChats}\n\n` +
            `By channel: ${channelStats || "none"}\n\n` +
            `By day:\n${dayStats || "none"}`,
          isError: false,
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { output: `Error fetching session stats: ${msg}`, isError: true };
      }
    },
  };
}

export function createGetCostSummaryTool(): ToolDefinition {
  return {
    name: "get_cost_summary",
    description:
      "Get aggregate cost analysis from token usage and tool audit logs. Shows total costs by agent, model, and provider. Useful for understanding spending patterns.",
    categories: ["analytics"] as readonly ToolCategory[],
    inputSchema: {
      type: "object",
      properties: {
        hours_back: {
          type: "number",
          description: "How many hours to look back (default 24, max 720).",
        },
      },
      required: [],
    },
    async execute(input): Promise<{ output: string; isError: boolean }> {
      const hoursBack = Math.min((input.hours_back as number) || 24, 720);

      try {
        const db = getDb();
        const since = Math.floor(Date.now() / 1000) - hoursBack * 3600;

        // Get cost by agent
        const byAgent = await db`
          SELECT
            agent_id,
            SUM(cost_usd) as total_cost,
            SUM(input_tokens) as input_tokens,
            SUM(output_tokens) as output_tokens,
            COUNT(*) as request_count
          FROM token_usage
          WHERE created_at >= ${since}
          GROUP BY agent_id
          ORDER BY total_cost DESC
          LIMIT 15
        `;

        // Get cost by model
        const byModel = await db`
          SELECT
            model,
            provider,
            SUM(cost_usd) as total_cost,
            COUNT(*) as request_count
          FROM token_usage
          WHERE created_at >= ${since}
          GROUP BY model, provider
          ORDER BY total_cost DESC
          LIMIT 10
        `;

        // Get total
        const totalResult = await db`
          SELECT SUM(cost_usd) as total
          FROM token_usage
          WHERE created_at >= ${since}
        `;

        const totalCost = Number(totalResult[0]?.total || 0);
        const lines: string[] = [];

        lines.push(`Total cost (last ${hoursBack}h): $${totalCost.toFixed(4)}`);

        if (byAgent.length > 0) {
          lines.push("\nBy agent:");
          for (const r of byAgent) {
            const cost = Number(r.total_cost).toFixed(4);
            const inputK = (Number(r.input_tokens) / 1000).toFixed(1);
            const outputK = (Number(r.output_tokens) / 1000).toFixed(1);
            lines.push(`  ${r.agent_id}: $${cost} (${r.request_count} reqs, ${inputK}K in / ${outputK}K out)`);
          }
        }

        if (byModel.length > 0) {
          lines.push("\nBy model:");
          for (const r of byModel) {
            const cost = Number(r.total_cost).toFixed(4);
            lines.push(`  ${r.model} (${r.provider}): $${cost}, ${r.request_count} requests`);
          }
        }

        return { output: lines.join("\n"), isError: false };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { output: `Error fetching cost summary: ${msg}`, isError: true };
      }
    },
  };
}
