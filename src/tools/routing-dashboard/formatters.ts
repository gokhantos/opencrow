import type {
  AgentScoreRow,
  McpHealthRow,
  ToolPerformanceRow,
  RoutingStats,
  CostRow,
} from "./queries";

// ============================================================================
// Formatting Functions
// ============================================================================

export function formatAgentScores(scores: AgentScoreRow[]): string {
  const lines = ["*AGENT PERFORMANCE BY DOMAIN*", ""];

  const byDomain = new Map<string | null, AgentScoreRow[]>();
  for (const s of scores) {
    const existing = byDomain.get(s.domain) || [];
    byDomain.set(s.domain, [...existing, s]);
  }

  let shown = 0;
  for (const [domain, agents] of byDomain.entries()) {
    if (shown >= 3) break;
    lines.push(`*${domain || "general"}*:`);
    agents.slice(0, 3).forEach((a, i) => {
      lines.push(
        `  ${i + 1}. ${a.agentId}: score=${(a.score * 100).toFixed(0)}%, ` +
          `success=${(a.successRate * 100).toFixed(0)}%, ` +
          `avg=${a.avgDuration.toFixed(0)}s`,
      );
    });
    shown++;
  }

  if (scores.length === 0) {
    lines.push("_No agent performance data yet_");
  }

  return lines.join("\n");
}

export function formatMcpHealth(mcp: McpHealthRow[]): string {
  const lines = ["*MCP SERVER HEALTH*", ""];

  mcp.slice(0, 5).forEach((m, i) => {
    const status =
      m.reliability > 0.95 ? "✅" : m.reliability > 0.8 ? "⚠️" : "❌";
    lines.push(
      `${i + 1}. ${status} ${m.server}: ` +
        `reliability=${(m.reliability * 100).toFixed(0)}%, ` +
        `p95=${m.p95Latency.toFixed(0)}ms, ` +
        `calls=${m.totalCalls}`,
    );
  });

  if (mcp.length === 0) {
    lines.push("_No MCP performance data yet_");
  }

  return lines.join("\n");
}

export function formatToolPerformance(tools: ToolPerformanceRow[]): string {
  const lines = ["*TOOL PERFORMANCE*", ""];

  tools.slice(0, 5).forEach((t, i) => {
    const status = t.errorRate < 0.05 ? "✅" : t.errorRate < 0.2 ? "⚠️" : "❌";
    lines.push(
      `${i + 1}. ${status} ${t.toolName}: ` +
        `${t.totalCalls} calls, ` +
        `errors=${t.errorCount} (${(t.errorRate * 100).toFixed(1)}%)`,
    );
  });

  const worstTools = tools.filter((t) => t.errorRate > 0.1).slice(0, 3);
  if (worstTools.length > 0) {
    lines.push("");
    lines.push("*High error tools:*");
    worstTools.forEach((t, i) => {
      lines.push(
        `  ${i + 1}. ${t.toolName}: ${(t.errorRate * 100).toFixed(1)}% errors`,
      );
    });
  }

  if (tools.length === 0) {
    lines.push("_No tool performance data yet_");
  }

  return lines.join("\n");
}

export function formatRoutingStats(stats: RoutingStats): string {
  const lines = ["*ROUTING STATISTICS*", ""];

  lines.push(`Total routed: ${stats.totalDecisions}`);
  lines.push(`Success rate: ${(stats.successRate * 100).toFixed(0)}%`);
  lines.push("");

  lines.push("*Top agents:*");
  stats.topAgents.slice(0, 3).forEach((a, i) => {
    lines.push(
      `  ${i + 1}. ${a.agentId}: ${a.count} tasks, ${(a.successRate * 100).toFixed(0)}% success`,
    );
  });

  lines.push("");
  lines.push("*Domains:*");
  stats.domainBreakdown.slice(0, 5).forEach((d, i) => {
    lines.push(`  ${i + 1}. ${d.domain}: ${d.count}`);
  });

  return lines.join("\n");
}

export function formatCostBreakdown(costs: CostRow[]): string {
  const lines = ["*COST BREAKDOWN*", ""];

  costs.slice(0, 5).forEach((c, i) => {
    lines.push(
      `${i + 1}. ${c.agentId}: $${c.totalCost.toFixed(2)} total, ` +
        `$${c.avgCostPerTask.toFixed(3)}/task, ` +
        `${c.totalTokens.toLocaleString()} tokens`,
    );
  });

  if (costs.length === 0) {
    lines.push("_No cost data yet_");
  }

  return lines.join("\n");
}
