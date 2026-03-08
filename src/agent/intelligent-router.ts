import { createLogger } from "../logger";
import { getTopAgents } from "./scoring-engine";
import { getDb } from "../store/db";
import type { TaskDomain } from "./task-classifier";
import { selectAgentByCapacity, getAgentCapacity } from "./load-balancer";
import { getAntiRecommendations } from "./failure-analyzer";

const log = createLogger("intelligent-router");

/**
 * Routing decision result
 */
export interface RoutingDecision {
  selectedAgentId: string;
  alternativeAgents: string[];
  decisionReason: string;
  confidence: "high" | "medium" | "low";
}

/**
 * Router configuration
 */
export interface RouterConfig {
  // Minimum score difference to prefer one agent over another
  minScoreDifference: number;
  // Enable A/B testing for close scores
  abTestingEnabled: boolean;
  // A/B test percentage (0-100)
  abTestPercentage: number;
  // Fallback agent if no scores available
  fallbackAgent: string;
  // Domain to agent mapping (overrides scoring)
  domainOverrides: Record<string, string>;
}

const DEFAULT_CONFIG: RouterConfig = {
  minScoreDifference: 0.1,
  abTestingEnabled: true,
  abTestPercentage: 10,
  fallbackAgent: "general-purpose",
  domainOverrides: {},
};

/**
 * Route a task to the best agent based on domain and performance scores
 */
export async function routeTask(
  domain: TaskDomain,
  task: string,
  sessionId?: string,
  config: RouterConfig = DEFAULT_CONFIG,
): Promise<RoutingDecision> {
  // Check for domain override first
  if (config.domainOverrides[domain]) {
    log.info("Using domain override for routing", {
      domain,
      overriddenAgent: config.domainOverrides[domain],
    });
    return {
      selectedAgentId: config.domainOverrides[domain],
      alternativeAgents: [],
      decisionReason: `Domain override: ${domain} → ${config.domainOverrides[domain]}`,
      confidence: "high",
    };
  }

  // Check anti-recommendations first
  const antiRecs = await getAntiRecommendations(undefined, domain);
  const blockedAgents = new Set(antiRecs.map((r) => r.agentId));

  // Get top agents for this domain
  const topAgents = await getTopAgents(domain, "24h", 5);

  // Filter out blocked agents
  const availableAgents = topAgents.filter(
    (a) => !blockedAgents.has(a.agentId),
  );

  if (availableAgents.length === 0) {
    // All top agents are blocked - use fallback
    log.warn("All top agents blocked by anti-recommendations, using fallback", {
      domain,
      blockedCount: blockedAgents.size,
    });
    return {
      selectedAgentId: config.fallbackAgent,
      alternativeAgents: [],
      decisionReason: `All top performers blocked by failure patterns, using fallback`,
      confidence: "low",
    };
  }

  // Phase 3: Check capacity for available agents
  const capacityResult = await selectAgentByCapacity(
    domain,
    availableAgents.map((a) => a.agentId),
  );

  if (topAgents.length === 0) {
    // No scores available - use fallback or capacity-based selection
    if (capacityResult) {
      log.info("No agent scores, using capacity-based selection", {
        domain,
        selectedAgent: capacityResult.agentId,
        reason: capacityResult.reason,
      });
      return {
        selectedAgentId: capacityResult.agentId,
        alternativeAgents: [],
        decisionReason: `Capacity-based selection: ${capacityResult.reason}`,
        confidence: "medium",
      };
    }

    log.info("No agent scores available, using fallback", {
      domain,
      fallbackAgent: config.fallbackAgent,
    });
    return {
      selectedAgentId: config.fallbackAgent,
      alternativeAgents: [],
      decisionReason: `No performance data for domain "${domain}", using fallback agent`,
      confidence: "low",
    };
  }

  // Check if top agent is significantly better
  const topAgent = availableAgents[0];
  const secondAgent = availableAgents[1];

  // Phase 3: Capacity-aware routing
  // If capacity-based selection differs from score-based, consider both
  if (
    capacityResult &&
    topAgent &&
    capacityResult.agentId !== topAgent.agentId
  ) {
    // Top agent by score may be at capacity
    const topAgentCapacity = await getAgentCapacity(topAgent.agentId);

    if (topAgentCapacity && !topAgentCapacity.isAvailable) {
      // Top agent is at capacity, use capacity-based selection
      log.info("Top agent at capacity, using available agent", {
        domain,
        topAgent: topAgent.agentId,
        selectedAgent: capacityResult.agentId,
        reason: capacityResult.reason,
      });
      return {
        selectedAgentId: capacityResult.agentId,
        alternativeAgents: availableAgents.slice(0, 3).map((a) => a.agentId),
        decisionReason: `Capacity-aware: ${topAgent.agentId} at max load, ${capacityResult.agentId} available (${capacityResult.reason})`,
        confidence: "medium",
      };
    }
  }

  // A/B testing: randomly use second-best agent if scores are close
  if (
    config.abTestingEnabled &&
    secondAgent &&
    topAgent &&
    Math.random() * 100 < config.abTestPercentage
  ) {
    const scoreDiff = Math.abs(topAgent.score - secondAgent.score);
    if (scoreDiff < config.minScoreDifference) {
      log.info("A/B testing: selecting alternative agent", {
        domain,
        selectedAgent: secondAgent.agentId,
        topAgent: topAgent.agentId,
        scoreDiff,
      });
      return {
        selectedAgentId: secondAgent.agentId,
        alternativeAgents: availableAgents.slice(1, 3).map((a) => a.agentId),
        decisionReason: `A/B testing: ${secondAgent.agentId} (score: ${secondAgent.score.toFixed(2)}) vs ${topAgent.agentId} (score: ${topAgent.score.toFixed(2)})`,
        confidence: "medium",
      };
    }
  }

  // Check if top agent is clearly better
  if (
    topAgent &&
    (!secondAgent ||
      topAgent.score - secondAgent.score >= config.minScoreDifference)
  ) {
    log.info("Routing to top performer", {
      domain,
      agent: topAgent.agentId,
      score: topAgent.score,
      successRate: topAgent.successRate,
    });
    return {
      selectedAgentId: topAgent.agentId,
      alternativeAgents: availableAgents.slice(1, 3).map((a) => a.agentId),
      decisionReason: `Top performer for "${domain}": ${topAgent.agentId} (score: ${topAgent.score.toFixed(2)}, success: ${(topAgent.successRate * 100).toFixed(0)}%, avg duration: ${topAgent.avgDurationSec.toFixed(0)}s)`,
      confidence: topAgent.totalTasks >= 10 ? "high" : "medium",
    };
  }

  // Scores are close - pick top but note low confidence
  // Note: topAgent is guaranteed to be defined here because we checked availableAgents.length > 0
  if (topAgent) {
    log.info("Routing to top agent (close competition)", {
      domain,
      agent: topAgent.agentId,
      scoreDiff: secondAgent
        ? (topAgent.score - secondAgent.score).toFixed(2)
        : "N/A",
    });
    return {
      selectedAgentId: topAgent.agentId,
      alternativeAgents: availableAgents.slice(1, 3).map((a) => a.agentId),
      decisionReason: `Close competition: ${topAgent.agentId} (score: ${topAgent.score.toFixed(2)}) slightly ahead of ${secondAgent?.agentId || "N/A"} (score: ${secondAgent?.score?.toFixed(2) || "N/A"})`,
      confidence: "low",
    };
  }

  // Fallback - should not reach here
  return {
    selectedAgentId: config.fallbackAgent,
    alternativeAgents: [],
    decisionReason: "Fallback routing due to unavailable agents",
    confidence: "low",
  };
}

/**
 * Get routing statistics
 */
export async function getRoutingStats(hoursBack: number = 24): Promise<{
  totalDecisions: number;
  successRate: number;
  topAgents: Array<{ agentId: string; count: number; successRate: number }>;
  domainBreakdown: Array<{ domain: string; count: number; avgScore: number }>;
}> {
  const db = getDb();

  try {
    // Total decisions
    const totalResult = await db<Array<{ count: number }>>`
      SELECT COUNT(*) as count
      FROM routing_decisions
      WHERE created_at >= NOW() - (${hoursBack} * INTERVAL '1 hour')
    `;
    const totalDecisions = totalResult?.[0]?.count || 0;

    // Success rate
    const successResult = await db<
      Array<{ success_count: number; total: number }>
    >`
      SELECT
        COUNT(*) FILTER (WHERE outcome_status = 'completed') as success_count,
        COUNT(*) FILTER (WHERE outcome_status IS NOT NULL) as total
      FROM routing_decisions
      WHERE created_at >= NOW() - (${hoursBack} * INTERVAL '1 hour')
    `;
    const successCount = successResult?.[0]?.success_count || 0;
    const totalWithOutcome = successResult?.[0]?.total || 0;
    const successRate =
      totalWithOutcome > 0 ? successCount / totalWithOutcome : 0;

    // Top agents by selection count
    const topAgentsResult = await db<
      Array<{ agent_id: string; count: number; success_count: number }>
    >`
      SELECT
        selected_agent_id as agent_id,
        COUNT(*) as count,
        COUNT(*) FILTER (WHERE outcome_status = 'completed') as success_count
      FROM routing_decisions
      WHERE created_at >= NOW() - (${hoursBack} * INTERVAL '1 hour')
      GROUP BY selected_agent_id
      ORDER BY count DESC
      LIMIT 10
    `;

    const topAgents = (topAgentsResult || []).map((row) => ({
      agentId: row.agent_id,
      count: Number(row.count),
      successRate:
        Number(row.count) > 0
          ? Number(row.success_count) / Number(row.count)
          : 0,
    }));

    // Domain breakdown (from task_classification joined with routing_decisions)
    const domainResult = await db<
      Array<{ domain: string; count: number; avg_score: number }>
    >`
      SELECT
        tc.domain,
        COUNT(*) as count,
        AVG(COALESCE(rd.outcome_score, 0)) as avg_score
      FROM routing_decisions rd
      JOIN task_classification tc ON rd.task_hash = tc.task_hash
      WHERE rd.created_at >= NOW() - (${hoursBack} * INTERVAL '1 hour')
      GROUP BY tc.domain
      ORDER BY count DESC
    `;

    const domainBreakdown = (domainResult || []).map((row) => ({
      domain: row.domain,
      count: Number(row.count),
      avgScore: Number(row.avg_score),
    }));

    return {
      totalDecisions: Number(totalDecisions),
      successRate,
      topAgents,
      domainBreakdown,
    };
  } catch (err) {
    log.warn("Failed to get routing stats", { error: String(err) });
    return {
      totalDecisions: 0,
      successRate: 0,
      topAgents: [],
      domainBreakdown: [],
    };
  }
}
