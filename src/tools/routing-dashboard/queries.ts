import { SQL } from "bun";

// ============================================================================
// Shared data-fetching functions
// ============================================================================

export interface AgentScoreRow {
  readonly agentId: string;
  readonly domain: string | null;
  readonly score: number;
  readonly successRate: number;
  readonly avgDuration: number;
  readonly avgCost: number;
  readonly totalTasks: number;
}

export interface McpHealthRow {
  readonly server: string;
  readonly totalCalls: number;
  readonly p95Latency: number;
  readonly reliability: number;
  readonly avgCost: number;
}

export interface ToolPerformanceRow {
  readonly toolName: string;
  readonly totalCalls: number;
  readonly errorRate: number;
  readonly errorCount: number;
}

export interface RoutingStats {
  readonly totalDecisions: number;
  readonly successRate: number;
  readonly topAgents: ReadonlyArray<{
    readonly agentId: string;
    readonly count: number;
    readonly successRate: number;
  }>;
  readonly domainBreakdown: ReadonlyArray<{
    readonly domain: string;
    readonly count: number;
  }>;
}

export interface CostRow {
  readonly agentId: string;
  readonly totalTokens: number;
  readonly totalCost: number;
  readonly taskCount: number;
  readonly avgCostPerTask: number;
}

export async function getAgentScoresByDomain(
  db: InstanceType<typeof SQL>,
  domain: string | null,
): Promise<AgentScoreRow[]> {
  const rows = await db`
    SELECT DISTINCT ON (agent_id, domain)
      agent_id,
      domain,
      score,
      success_rate,
      avg_duration_sec,
      avg_cost_usd,
      total_tasks,
      time_window
    FROM agent_scores
    WHERE time_window = '24h'
    ${domain ? db`AND domain = ${domain}` : db``}
    ORDER BY agent_id, domain, score DESC
    LIMIT 50
  `;

  return (rows || []).map((row: any) => ({
    agentId: row.agent_id,
    domain: row.domain,
    score: Number(row.score || 0),
    successRate: Number(row.success_rate || 0),
    avgDuration: Number(row.avg_duration_sec || 0),
    avgCost: Number(row.avg_cost_usd || 0),
    totalTasks: Number(row.total_tasks || 0),
  }));
}

export async function getMcpHealth(
  db: InstanceType<typeof SQL>,
  hoursBack: number,
): Promise<McpHealthRow[]> {
  const rows = await db`
    SELECT
      mcp_server,
      COUNT(*) AS total_calls,
      PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY duration_ms) AS p95_latency_ms,
      1 - AVG(is_error::numeric) AS reliability,
      AVG(COALESCE(cost_usd, 0)) AS avg_cost_usd
    FROM mcp_performance
    WHERE created_at >= NOW() - (${hoursBack} * INTERVAL '1 hour')
    GROUP BY mcp_server
    ORDER BY total_calls DESC
    LIMIT 20
  `;

  return (rows || []).map((row: any) => ({
    server: row.mcp_server,
    totalCalls: Number(row.total_calls),
    p95Latency: Number(row.p95_latency_ms || 0),
    reliability: Number(row.reliability || 0),
    avgCost: Number(row.avg_cost_usd || 0),
  }));
}

export async function getToolPerformance(
  db: InstanceType<typeof SQL>,
  hoursBack: number,
): Promise<ToolPerformanceRow[]> {
  const rows = await db`
    SELECT
      tool_name,
      COUNT(*) AS total_calls,
      AVG(is_error::numeric) AS error_rate,
      COUNT(*) FILTER (WHERE is_error = true) AS error_count
    FROM tool_audit_log
    WHERE created_at >= NOW() - (${hoursBack} * INTERVAL '1 hour')
    GROUP BY tool_name
    ORDER BY total_calls DESC
    LIMIT 30
  `;

  return (rows || []).map((row: any) => ({
    toolName: row.tool_name,
    totalCalls: Number(row.total_calls),
    errorRate: Number(row.error_rate || 0),
    errorCount: Number(row.error_count || 0),
  }));
}

export async function getRoutingStats(
  db: InstanceType<typeof SQL>,
  hoursBack: number,
): Promise<RoutingStats> {
  const totalResult = await db`
    SELECT COUNT(*) as count
    FROM routing_decisions
    WHERE created_at >= NOW() - (${hoursBack} * INTERVAL '1 hour')
  `;
  const totalDecisions = Number(totalResult?.[0]?.count || 0);

  const successResult = await db`
    SELECT
      COUNT(*) FILTER (WHERE outcome_status = 'completed') as success_count,
      COUNT(*) FILTER (WHERE outcome_status IS NOT NULL) as total
    FROM routing_decisions
    WHERE created_at >= NOW() - (${hoursBack} * INTERVAL '1 hour')
  `;
  const successCount = Number(successResult?.[0]?.success_count || 0);
  const totalWithOutcome = Number(successResult?.[0]?.total || 0);
  const successRate =
    totalWithOutcome > 0 ? successCount / totalWithOutcome : 0;

  const topAgentsResult = await db`
    SELECT
      selected_agent_id,
      COUNT(*) as count,
      COUNT(*) FILTER (WHERE outcome_status = 'completed') as success_count
    FROM routing_decisions
    WHERE created_at >= NOW() - (${hoursBack} * INTERVAL '1 hour')
    GROUP BY selected_agent_id
    ORDER BY count DESC
    LIMIT 10
  `;

  const topAgents = (topAgentsResult || []).map((row: any) => ({
    agentId: row.selected_agent_id,
    count: Number(row.count),
    successRate:
      Number(row.count) > 0 ? Number(row.success_count) / Number(row.count) : 0,
  }));

  const domainResult = await db`
    SELECT
      tc.domain,
      COUNT(*) as count
    FROM routing_decisions rd
    LEFT JOIN task_classification tc ON rd.task_hash = tc.task_hash
    WHERE rd.created_at >= NOW() - (${hoursBack} * INTERVAL '1 hour')
    GROUP BY tc.domain
    ORDER BY count DESC
  `;

  const domainBreakdown = (domainResult || []).map((row: any) => ({
    domain: row.domain || "unknown",
    count: Number(row.count),
  }));

  return { totalDecisions, successRate, topAgents, domainBreakdown };
}

export async function getCostBreakdown(
  db: InstanceType<typeof SQL>,
  hoursBack: number,
): Promise<CostRow[]> {
  const rows = await db`
    SELECT
      agent_id,
      SUM(input_tokens + output_tokens) as total_tokens,
      SUM(cost_usd) as total_cost,
      COUNT(*) as task_count,
      AVG(cost_usd) as avg_cost_per_task
    FROM cost_tracking
    WHERE created_at >= NOW() - (${hoursBack} * INTERVAL '1 hour')
    GROUP BY agent_id
    ORDER BY total_cost DESC
    LIMIT 20
  `;

  return (rows || []).map((row: any) => ({
    agentId: row.agent_id,
    totalTokens: Number(row.total_tokens || 0),
    totalCost: Number(row.total_cost || 0),
    taskCount: Number(row.task_count || 0),
    avgCostPerTask: Number(row.avg_cost_per_task || 0),
  }));
}
