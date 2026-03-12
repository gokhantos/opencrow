import type { ToolDefinition, ToolCategory } from "../types";
import { getDb } from "../../store/db";
import {
  getAgentScoresByDomain,
  getMcpHealth,
  getToolPerformance,
  getRoutingStats,
  getCostBreakdown,
} from "./queries";
import {
  formatAgentScores,
  formatMcpHealth,
  formatToolPerformance,
  formatRoutingStats,
  formatCostBreakdown,
} from "./formatters";

export function createRoutingDashboardTool(): ToolDefinition {
  return {
    name: "get_routing_dashboard",
    description:
      "Get a comprehensive dashboard of intelligent routing performance. Shows agent scores by domain, MCP server health, tool performance, and routing statistics.",
    categories: ["analytics", "routing"] as readonly ToolCategory[],
    inputSchema: {
      type: "object",
      properties: {
        hours_back: {
          type: "number",
          description: "Hours of data to include (default 24, max 168)",
        },
        domain: {
          type: "string",
          description:
            "Filter to specific domain (coding, research, analysis, etc.)",
        },
      },
    },
    async execute(input): Promise<{ output: string; isError: boolean }> {
      const hoursBack = Math.min((input.hours_back as number) || 24, 168);
      const domain = (input.domain as string) || null;

      try {
        const db = getDb();

        const agentScores = await getAgentScoresByDomain(db, domain);
        const mcpHealth = await getMcpHealth(db, hoursBack);
        const toolPerf = await getToolPerformance(db, hoursBack);
        const routingStats = await getRoutingStats(db, hoursBack);
        const costBreakdown = await getCostBreakdown(db, hoursBack);

        const sections: string[] = [
          formatAgentScores(agentScores),
          formatMcpHealth(mcpHealth),
          formatToolPerformance(toolPerf),
          formatRoutingStats(routingStats),
          formatCostBreakdown(costBreakdown),
        ];

        return { output: sections.join("\n\n"), isError: false };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { output: `Error generating dashboard: ${msg}`, isError: true };
      }
    },
  };
}
