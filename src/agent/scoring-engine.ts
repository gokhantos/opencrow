import { SQL } from "bun";
import { createLogger } from "../logger";
import { getDb } from "../store/db";
import { windowToHours } from "./utils/interval";

const log = createLogger("scoring-engine");

/**
 * Performance score configuration
 */
export interface ScoreConfig {
  // Weights for agent scoring
  successRateWeight: number;
  latencyWeight: number;
  costWeight: number;
  // Minimum tasks required for a score
  minTasks: number;
  // Time windows to compute scores for
  windows: string[];
}

const DEFAULT_CONFIG: ScoreConfig = {
  successRateWeight: 0.4,
  latencyWeight: 0.3,
  costWeight: 0.3,
  minTasks: 3,
  windows: ["1h", "24h", "7d"],
};

/**
 * Compute agent performance scores from subagent_audit_log
 */
export async function computeAgentScores(
  config: ScoreConfig = DEFAULT_CONFIG,
): Promise<void> {
  const db = getDb();

  for (const window of config.windows) {
    try {
      // Get all agents with their performance metrics for this window
      const agentMetrics = await getAgentMetrics(window);

      for (const metric of agentMetrics) {
        // Skip if not enough data
        if (metric.totalTasks < config.minTasks) {
          log.debug("Skipping agent - not enough tasks", {
            agentId: metric.agentId,
            window,
            totalTasks: metric.totalTasks,
          });
          continue;
        }

        // Compute normalized scores (0-1)
        const successScore = metric.successRate;
        const latencyScore = computeLatencyScore(metric.avgDurationSec);
        const costScore = computeCostScore(metric.avgCostUsd);

        // Weighted composite score
        const compositeScore =
          successScore * config.successRateWeight +
          latencyScore * config.latencyWeight +
          costScore * config.costWeight;

        // Upsert score
        await db`INSERT INTO agent_scores (agent_id, domain, time_window, success_rate, avg_duration_sec, avg_cost_usd, total_tasks, score, computed_at)
                 VALUES (${metric.agentId}, ${metric.domain}, ${window}, ${metric.successRate}, ${metric.avgDurationSec}, ${metric.avgCostUsd}, ${metric.totalTasks}, ${compositeScore}, NOW())
                 ON CONFLICT (agent_id, domain, time_window) DO UPDATE SET
                   success_rate = ${metric.successRate},
                   avg_duration_sec = ${metric.avgDurationSec},
                   avg_cost_usd = ${metric.avgCostUsd},
                   total_tasks = ${metric.totalTasks},
                   score = ${compositeScore},
                   computed_at = NOW()`;
      }

      log.info("Computed agent scores", { window, count: agentMetrics.length });
    } catch (err) {
      log.error("Failed to compute agent scores", {
        window,
        error: String(err),
      });
    }
  }
}

/**
 * Compute tool performance scores from tool_audit_log
 */
export async function computeToolScores(
  config: ScoreConfig = DEFAULT_CONFIG,
): Promise<void> {
  const db = getDb();

  for (const window of config.windows) {
    try {
      const toolMetrics = await getToolMetrics(window);

      for (const metric of toolMetrics) {
        // Skip if not enough data
        if (metric.totalCalls < config.minTasks) {
          continue;
        }

        // Tool score: 1 - error_rate (higher is better)
        const errorScore = 1 - metric.errorRate;

        await db`INSERT INTO tool_scores (tool_name, time_window, total_calls, error_rate, avg_latency_ms, score, computed_at)
                 VALUES (${metric.toolName}, ${window}, ${metric.totalCalls}, ${metric.errorRate}, ${metric.avgLatencyMs}, ${errorScore}, NOW())
                 ON CONFLICT (tool_name, time_window) DO UPDATE SET
                   total_calls = ${metric.totalCalls},
                   error_rate = ${metric.errorRate},
                   avg_latency_ms = ${metric.avgLatencyMs},
                   score = ${errorScore},
                   computed_at = NOW()`;
      }

      log.info("Computed tool scores", { window, count: toolMetrics.length });
    } catch (err) {
      log.error("Failed to compute tool scores", {
        window,
        error: String(err),
      });
    }
  }
}

/**
 * Compute MCP server performance scores
 */
export async function computeMcpScores(
  config: ScoreConfig = DEFAULT_CONFIG,
): Promise<void> {
  const db = getDb();

  for (const window of config.windows) {
    try {
      const mcpMetrics = await getMcpMetrics(window);

      for (const metric of mcpMetrics) {
        // Skip if not enough data
        if (metric.totalCalls < 3) {
          continue;
        }

        // MCP score: reliability (1 - error_rate) * 0.6 + latency_score * 0.4
        const reliabilityScore = metric.reliability;
        const latencyScore = computeMcpLatencyScore(metric.p95LatencyMs);
        const compositeScore = reliabilityScore * 0.6 + latencyScore * 0.4;

        await db`INSERT INTO mcp_scores (mcp_server, time_window, total_calls, p95_latency_ms, reliability, avg_cost_usd, score, computed_at)
                 VALUES (${metric.mcpServer}, ${window}, ${metric.totalCalls}, ${metric.p95LatencyMs}, ${metric.reliability}, ${metric.avgCostUsd}, ${compositeScore}, NOW())
                 ON CONFLICT (mcp_server, time_window) DO UPDATE SET
                   total_calls = ${metric.totalCalls},
                   p95_latency_ms = ${metric.p95LatencyMs},
                   reliability = ${metric.reliability},
                   avg_cost_usd = ${metric.avgCostUsd},
                   score = ${compositeScore},
                   computed_at = NOW()`;
      }

      log.info("Computed MCP scores", { window, count: mcpMetrics.length });
    } catch (err) {
      log.error("Failed to compute MCP scores", { window, error: String(err) });
    }
  }
}

/**
 * Get MCP metrics from mcp_performance table
 */
async function getMcpMetrics(window: string): Promise<
  Array<{
    mcpServer: string;
    totalCalls: number;
    p95LatencyMs: number;
    reliability: number;
    avgCostUsd: number;
  }>
> {
  const db = getDb();
  const hours = windowToHours(window);

  const rows = await db<
    Array<{
      mcp_server: string;
      total_calls: number;
      p95_latency_ms: number;
      reliability: number;
      avg_cost_usd: number;
    }>
  >`
    SELECT
      mcp_server,
      COUNT(*) AS total_calls,
      PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY duration_ms) AS p95_latency_ms,
      1 - AVG(is_error::numeric) AS reliability,
      AVG(COALESCE(cost_usd, 0)) AS avg_cost_usd
    FROM mcp_performance
    WHERE created_at >= NOW() - (${hours} * INTERVAL '1 hour')
    GROUP BY mcp_server
    HAVING COUNT(*) >= 1
  `;

  return (rows || []).map((row) => ({
    mcpServer: row.mcp_server,
    totalCalls: Number(row.total_calls),
    p95LatencyMs: Number(row.p95_latency_ms),
    reliability: Number(row.reliability),
    avgCostUsd: Number(row.avg_cost_usd),
  }));
}

/**
 * Normalize MCP latency score (0-1)
 * Lower latency = higher score
 */
function computeMcpLatencyScore(p95LatencyMs: number | null): number {
  if (!p95LatencyMs || p95LatencyMs <= 0) return 1;

  // Sigmoid curve: 500ms is average, 2000ms is poor
  const center = 500;
  const slope = 300;
  const normalized = 1 / (1 + Math.exp((p95LatencyMs - center) / slope));
  return normalized;
}

/**
 * Get agent metrics from subagent_audit_log for a time window
 */
async function getAgentMetrics(window: string): Promise<
  Array<{
    agentId: string;
    domain: string | null;
    successRate: number;
    avgDurationSec: number;
    avgCostUsd: number;
    totalTasks: number;
  }>
> {
  const db = getDb();
  const hours = windowToHours(window);

  const rows = await db<
    Array<{
      agent_id: string;
      domain: string | null;
      success_rate: number;
      avg_duration_sec: number;
      avg_cost_usd: number;
      total_tasks: number;
    }>
  >`
    WITH subagent_data AS (
      SELECT
        sa.subagent_id AS agent_id,
        tc.domain,
        CASE WHEN sa.status = 'completed' THEN 1 ELSE 0 END AS is_success,
        EXTRACT(EPOCH FROM (sa.completed_at - sa.created_at)) AS duration_sec,
        COALESCE(tu.cost_usd, 0) AS cost_usd
      FROM subagent_audit_log sa
      LEFT JOIN task_classification tc ON tc.session_id = sa.session_id
      LEFT JOIN LATERAL (
        SELECT SUM(cost_usd) AS cost_usd
        FROM token_usage tu2
        WHERE tu2.agent_id = sa.subagent_id
          AND tu2.created_at > sa.created_at - INTERVAL '1 minute'
          AND tu2.created_at < sa.completed_at + INTERVAL '1 minute'
      ) tu ON true
      WHERE sa.created_at >= NOW() - (${hours} * INTERVAL '1 hour')
        AND sa.completed_at IS NOT NULL
    )
    SELECT
      agent_id,
      domain,
      COUNT(*) AS total_tasks,
      AVG(is_success::numeric) AS success_rate,
      AVG(duration_sec) AS avg_duration_sec,
      AVG(cost_usd) AS avg_cost_usd
    FROM subagent_data
    GROUP BY agent_id, domain
    HAVING COUNT(*) >= 1
  `;

  return (rows || []).map((row) => ({
    agentId: row.agent_id,
    domain: row.domain,
    successRate: Number(row.success_rate),
    avgDurationSec: Number(row.avg_duration_sec),
    avgCostUsd: Number(row.avg_cost_usd),
    totalTasks: Number(row.total_tasks),
  }));
}

/**
 * Get tool metrics from tool_audit_log for a time window
 */
async function getToolMetrics(window: string): Promise<
  Array<{
    toolName: string;
    totalCalls: number;
    errorRate: number;
    avgLatencyMs: number;
  }>
> {
  const db = getDb();
  const hours = windowToHours(window);

  const rows = await db<
    Array<{
      tool_name: string;
      total_calls: number;
      error_rate: number;
      avg_latency_ms: number;
    }>
  >`
    SELECT
      tool_name,
      COUNT(*) AS total_calls,
      AVG(is_error::numeric) AS error_rate,
      0 AS avg_latency_ms
    FROM tool_audit_log
    WHERE created_at >= NOW() - (${hours} * INTERVAL '1 hour')
    GROUP BY tool_name
    HAVING COUNT(*) >= 1
  `;

  return (rows || []).map((row) => ({
    toolName: row.tool_name,
    totalCalls: Number(row.total_calls),
    errorRate: Number(row.error_rate),
    avgLatencyMs: Number(row.avg_latency_ms),
  }));
}

/**
 * Normalize latency score (0-1)
 * Lower latency = higher score
 * Uses sigmoid-like curve centered at 30 seconds
 */
function computeLatencyScore(avgDurationSec: number | null): number {
  if (!avgDurationSec || avgDurationSec <= 0) return 1;

  // Sigmoid: 1 / (1 + e^(-(x - center) / slope))
  // Inverted: lower duration = higher score
  const center = 30; // 30 seconds is "average"
  const slope = 15;
  const normalized = 1 / (1 + Math.exp((avgDurationSec - center) / slope));
  return normalized;
}

/**
 * Normalize cost score (0-1)
 * Lower cost = higher score
 * Uses logarithmic scale
 */
function computeCostScore(avgCostUsd: number | null): number {
  if (!avgCostUsd || avgCostUsd <= 0) return 1;

  // Log scale: higher cost = lower score
  // $0.01 = 1.0, $0.10 = 0.5, $1.00 = 0.25, $10+ = ~0
  const maxCost = 10;
  const normalized =
    1 -
    Math.min(
      1,
      Math.log10(avgCostUsd * 100 + 1) / Math.log10(maxCost * 100 + 1),
    );
  return normalized;
}

/**
 * Adjust agent scores based on task outcomes
 */
export async function adjustScoresFromOutcomes(
  adjustments: Array<{
    agentId: string;
    domain?: string | null;
    adjustmentType:
      | "outcome_bonus"
      | "revision_penalty"
      | "timeout_penalty";
    adjustmentValue: number;
    reason: string;
    sessionId?: string | null;
    taskHash?: string | null;
  }>,
): Promise<void> {
  const db = getDb();

  for (const adj of adjustments) {
    try {
      // Record adjustment in audit table
      await db`
        INSERT INTO agent_score_adjustments
        (agent_id, domain, adjustment_type, adjustment_value, reason, session_id, task_hash, created_at)
        VALUES (
          ${adj.agentId},
          ${adj.domain ?? null},
          ${adj.adjustmentType},
          ${adj.adjustmentValue},
          ${adj.reason},
          ${adj.sessionId ?? null},
          ${adj.taskHash ?? null},
          NOW()
        )
      `;

      // Apply adjustment to all time windows (not just 1h)
      await db`
        UPDATE agent_scores
        SET score = LEAST(1.0, GREATEST(0.0, score + ${adj.adjustmentValue})),
            computed_at = NOW()
        WHERE agent_id = ${adj.agentId}
          AND domain IS ${adj.domain === null ? null : adj.domain}
      `;

      log.info("Adjusted agent score", {
        agentId: adj.agentId,
        type: adj.adjustmentType,
        value: adj.adjustmentValue,
        reason: adj.reason,
      });
    } catch (err) {
      log.warn("Failed to adjust agent score", {
        agentId: adj.agentId,
        error: String(err),
      });
    }
  }
}

/**
 * Get top agents by domain and window
 */
export async function getTopAgents(
  domain: string | null,
  window: string = "24h",
  limit: number = 5,
): Promise<
  Array<{
    agentId: string;
    score: number;
    successRate: number;
    avgDurationSec: number;
    avgCostUsd: number;
    totalTasks: number;
  }>
> {
  const db = getDb();

  try {
    const rows = await db<
      Array<{
        agent_id: string;
        score: number;
        success_rate: number;
        avg_duration_sec: number;
        avg_cost_usd: number;
        total_tasks: number;
      }>
    >`
      SELECT agent_id, score, success_rate, avg_duration_sec, avg_cost_usd, total_tasks
      FROM agent_scores
      WHERE domain IS ${domain === null ? null : domain}
        AND time_window = ${window}
      ORDER BY score DESC NULLS LAST
      LIMIT ${limit}
    `;

    return (rows || []).map((row) => ({
      agentId: row.agent_id,
      score: Number(row.score),
      successRate: Number(row.success_rate),
      avgDurationSec: Number(row.avg_duration_sec),
      avgCostUsd: Number(row.avg_cost_usd),
      totalTasks: Number(row.total_tasks),
    }));
  } catch (err) {
    log.warn("Failed to get top agents", { error: String(err) });
    return [];
  }
}

/**
 * Get agent score for a specific agent/domain/window
 */
export async function getAgentScore(
  agentId: string,
  domain: string | null = null,
  window: string = "24h",
): Promise<{
  score: number;
  successRate: number;
  avgDurationSec: number;
  avgCostUsd: number;
  totalTasks: number;
} | null> {
  const db = getDb();

  try {
    const row = await db<
      Array<{
        score: number;
        success_rate: number;
        avg_duration_sec: number;
        avg_cost_usd: number;
        total_tasks: number;
      }>
    >`
      SELECT score, success_rate, avg_duration_sec, avg_cost_usd, total_tasks
      FROM agent_scores
      WHERE agent_id = ${agentId}
        AND domain IS ${domain === null ? null : domain}
        AND time_window = ${window}
      LIMIT 1
    `;

    if (!row || row.length === 0) return null;

    const firstRow = row[0];
    if (!firstRow) return null;

    return {
      score: Number(firstRow.score),
      successRate: Number(firstRow.success_rate),
      avgDurationSec: Number(firstRow.avg_duration_sec),
      avgCostUsd: Number(firstRow.avg_cost_usd),
      totalTasks: Number(firstRow.total_tasks),
    };
  } catch (err) {
    log.warn("Failed to get agent score", { error: String(err) });
    return null;
  }
}
