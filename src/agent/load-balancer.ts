import { createLogger } from "../logger";
import { getDb } from "../store/db";
import { windowToHours } from "./utils/interval";

const log = createLogger("load-balancer");

/**
 * Agent capacity status
 */
export interface AgentCapacity {
  agentId: string;
  currentLoad: number;
  maxCapacity: number;
  availableCapacity: number;
  avgTaskDurationSec: number;
  isAvailable: boolean;
  lastUpdated: Date;
}

/**
 * Task queue entry
 */
export interface QueuedTask {
  taskId: string;
  sessionId: string;
  domain: string;
  priority: number;
  enqueuedAt: Date;
  preferredAgents?: string[];
}

/**
 * Load balancing configuration
 */
export interface LoadBalancerConfig {
  // Maximum concurrent tasks per agent
  maxConcurrentTasks: number;
  // Task timeout in seconds
  taskTimeoutSec: number;
  // Priority weights
  domainWeights: Record<string, number>;
}

const DEFAULT_CONFIG: LoadBalancerConfig = {
  maxConcurrentTasks: 3,
  taskTimeoutSec: 300, // 5 minutes
  domainWeights: {
    api: 1.5,
    bug: 2.0,
    deploy: 1.8,
    general: 1.0,
  },
};

/**
 * Get current capacity for all agents
 */
export async function getAllAgentCapacity(
  config: LoadBalancerConfig = DEFAULT_CONFIG,
): Promise<AgentCapacity[]> {
  const db = getDb();

  try {
    // Get active task counts per agent
    const activeTasks = await db`
      SELECT
        subagent_id,
        COUNT(*) as active_count,
        AVG(EXTRACT(EPOCH FROM (NOW() - created_at))) as avg_duration
      FROM subagent_audit_log
      WHERE status = 'running' OR (status IS NULL AND completed_at IS NULL)
      GROUP BY subagent_id
    `;

    // Build capacity map
    const capacityMap = new Map<string, AgentCapacity>();

    // Process active tasks
    for (const row of activeTasks || []) {
      const agentId = row.subagent_id;
      const currentLoad = Number(row.active_count);

      capacityMap.set(agentId, {
        agentId,
        currentLoad,
        maxCapacity: config.maxConcurrentTasks,
        availableCapacity: Math.max(0, config.maxConcurrentTasks - currentLoad),
        avgTaskDurationSec: Number(row.avg_duration) || 60,
        isAvailable: currentLoad < config.maxConcurrentTasks,
        lastUpdated: new Date(),
      });
    }

    return Array.from(capacityMap.values());
  } catch (err) {
    log.warn("Failed to get agent capacity", { error: String(err) });
    return [];
  }
}

/**
 * Get capacity for a specific agent
 */
export async function getAgentCapacity(
  agentId: string,
  config: LoadBalancerConfig = DEFAULT_CONFIG,
): Promise<AgentCapacity | null> {
  const capacities = await getAllAgentCapacity(config);
  return capacities.find((c) => c.agentId === agentId) || null;
}

/**
 * Select best agent based on capacity and domain fit
 */
export async function selectAgentByCapacity(
  domain: string,
  preferredAgents?: string[],
  config: LoadBalancerConfig = DEFAULT_CONFIG,
): Promise<{
  agentId: string;
  reason: string;
  estimatedWaitSec: number;
} | null> {
  const capacities = await getAllAgentCapacity(config);

  // Filter available agents
  const availableAgents = capacities.filter((c) => c.isAvailable);

  if (availableAgents.length === 0) {
    // All agents at capacity - return null
    return null;
  }

  // Prefer agents with domain expertise
  let candidates = availableAgents;

  if (preferredAgents && preferredAgents.length > 0) {
    const preferredAvailable = availableAgents.filter((a) =>
      preferredAgents.includes(a.agentId),
    );
    if (preferredAvailable.length > 0) {
      candidates = preferredAvailable;
    }
  }

  // Select agent with highest available capacity
  const bestAgent = candidates.sort(
    (a, b) => b.availableCapacity - a.availableCapacity,
  )[0];

  if (!bestAgent) return null;

  return {
    agentId: bestAgent.agentId,
    reason: `Highest available capacity: ${bestAgent.availableCapacity}/${bestAgent.maxCapacity} (load: ${bestAgent.currentLoad})`,
    estimatedWaitSec: 0, // Available immediately
  };
}

/**
 * Update agent load in real-time
 */
export async function updateAgentLoad(
  agentId: string,
  delta: number,
): Promise<void> {
  const db = getDb();

  try {
    // Update or insert agent capacity record
    await db`
      INSERT INTO agent_capacity (agent_id, current_load, last_updated)
      VALUES (${agentId}, ${Math.max(0, delta)}, NOW())
      ON CONFLICT (agent_id) DO UPDATE SET
        current_load = GREATEST(0, agent_capacity.current_load + ${delta}),
        last_updated = NOW()
    `;

    log.debug("Updated agent load", { agentId, delta });
  } catch (err) {
    log.warn("Failed to update agent load", {
      agentId,
      delta,
      error: String(err),
    });
  }
}

/**
 * Sample current workload for scoring engine
 */
export async function sampleWorkload(window: string = "1h"): Promise<{
  totalTasks: number;
  agentUtilization: Array<{ agentId: string; utilization: number }>;
}> {
  const db = getDb();

  try {
    const hours = windowToHours(window);

    // Total tasks in window
    const totalResult = await db`
      SELECT COUNT(*) as count
      FROM subagent_audit_log
      WHERE created_at >= NOW() - (${hours} * INTERVAL '1 hour')
    `;
    const totalTasks = Number(totalResult?.[0]?.count || 0);

    // Agent utilization
    const utilizationResult = await db`
      SELECT
        agent_id,
        AVG(current_load::float / NULLIF(max_capacity, 0)) as utilization
      FROM agent_capacity
      WHERE last_updated >= NOW() - (${hours} * INTERVAL '1 hour')
      GROUP BY agent_id
    `;

    const agentUtilization = (utilizationResult || []).map(
      (row: { agent_id: string; utilization: unknown }) => ({
        agentId: row.agent_id,
        utilization: Number(row.utilization) || 0,
      }),
    );

    return {
      totalTasks,
      agentUtilization,
    };
  } catch (err) {
    log.warn("Failed to sample workload", { error: String(err) });
    return {
      totalTasks: 0,
      agentUtilization: [],
    };
  }
}
