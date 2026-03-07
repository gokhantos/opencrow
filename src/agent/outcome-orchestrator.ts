import { createLogger } from "../logger";
import { getDb } from "../store/db";

const log = createLogger("phase4-orchestrator");

/**
 * Handle failure (trigger clustering, reflection, learning)
 */
export async function handleFailure(
  sessionId: string,
  agentId: string,
  taskHash: string,
  errorMessage: string,
): Promise<void> {
  try {
    log.info("Handling failure", {
      sessionId,
      agentId,
      taskHash,
      errorMessage: errorMessage.slice(0, 100),
    });

    // Get chatId for survey delivery
    const chatId = await getChatIdForSession(sessionId);

    // Send failure survey
    const { sendFailureSurvey } = await import("./survey/delivery");
    const bot = getBotInstance();

    if (bot && chatId) {
      await sendFailureSurvey(
        sessionId,
        taskHash,
        agentId,
        chatId,
        errorMessage,
        bot,
      );
    }

    // Record failure for pattern analysis
    const { recordFailure } = await import("./failure-analyzer");

    await recordFailure(sessionId, agentId, "general", errorMessage, "error");

    // Check if clustering should be triggered (every 10 failures)
    const { getFailureStats } = await import("./failure-analyzer");
    const stats = await getFailureStats({ agentId });

    if (stats.totalFailures % 10 === 0) {
      const { runFailureClustering } = await import("./failure/clustering");
      const clusters = await runFailureClustering();

      log.info("Failure clustering triggered", {
        clustersFound: clusters.length,
        totalFailures: stats.totalFailures,
      });

      // Create anti-recommendations for severe clusters
      for (const cluster of clusters) {
        if (cluster.severity === "high" || cluster.severity === "critical") {
          await createAntiRecommendationsForCluster(cluster);
        }
      }
    }

    // Generate reflection if revisions >= 2
    const { getRevisionCount } = await import("./outcome-tracker");
    const revisionCount = await getRevisionCount(sessionId, taskHash);

    if (revisionCount >= 2) {
      const { generatePostMortem } = await import("./reflection/postmortem");

      await generatePostMortem(sessionId, agentId, taskHash, {
        status: "failure",
        result: errorMessage,
        errorMessage,
        revisions: revisionCount,
        durationSec: 0,
      });
    }

    // Record learning event
    await recordLearningEvent({
      eventType: "pattern_discovered",
      sessionId,
      taskHash,
      agentId,
      domain: "general",
      eventData: {
        errorMessage: errorMessage.slice(0, 200),
        revisionCount,
      },
    });

    log.debug("Failure handling complete", { sessionId });
  } catch (err) {
    log.warn("Failed to handle failure", { error: String(err), sessionId });
  }
}

/**
 * Get chat ID for a session
 */
async function getChatIdForSession(sessionId: string): Promise<string | null> {
  const db = getDb();

  try {
    const result = await db`
      SELECT chat_id FROM messages
      WHERE session_id = ${sessionId}
      ORDER BY timestamp DESC
      LIMIT 1
    `;

    return result?.[0]?.chat_id || null;
  } catch (err) {
    log.warn("Failed to get chat ID for session", { error: String(err) });
    return null;
  }
}

/**
 * Get bot instance (placeholder - will be injected from handler)
 */
function getBotInstance(): any {
  // This will be implemented by setting a bot instance via setBotInstance()
  return (global as any).telegramBot || null;
}

/**
 * Create anti-recommendations for a failure cluster
 */
async function createAntiRecommendationsForCluster(
  cluster: any,
): Promise<void> {
  const db = getDb();
  const { createAntiRecommendation } = await import("./failure-analyzer");

  for (const agentId of cluster.affected_agents || []) {
    await createAntiRecommendation(
      agentId,
      cluster.domain,
      `Recurring failure pattern: ${cluster.cluster_name} (${cluster.occurrence_count} occurrences)`,
      cluster.occurrence_count,
      24, // valid for 24 hours
    );
  }
}

/**
 * Record a learning event
 */
async function recordLearningEvent(event: {
  eventType: string;
  sessionId?: string;
  taskHash?: string;
  agentId?: string;
  domain?: string;
  eventData: unknown;
}): Promise<void> {
  const db = getDb();

  try {
    await db`
      INSERT INTO learning_events (
        event_type, session_id, task_hash, agent_id, domain, event_data_json, created_at
      ) VALUES (
        ${event.eventType}, ${event.sessionId || null}, ${event.taskHash || null},
        ${event.agentId || null}, ${event.domain || null},
        ${JSON.stringify(event.eventData)}::jsonb, NOW()
      )
    `;
  } catch (err) {
    log.warn("Failed to record learning event", { error: String(err) });
  }
}

export async function refreshOutcomeCaches(): Promise<number> {
  const db = getDb();

  try {
    // Get distinct domains from recent outcomes
    const domains = await db`
      SELECT DISTINCT domain FROM task_outcomes
      WHERE created_at >= NOW() - INTERVAL '7 days'
        AND domain IS NOT NULL
    `;

    let updatedCount = 0;

    for (const row of domains || []) {
      const domain = row.domain;

      // Update cache for this domain
      await db`
        INSERT INTO outcome_routing_cache (
          domain, successful_agents_json, failed_agents_json,
          total_tasks, success_rate, last_updated, expires_at
        )
        SELECT
          ${domain} as domain,
          COALESCE(
            (SELECT json_agg(json_build_object('agentId', agent_id, 'successRate', success_rate))
             FROM (
               SELECT rd.selected_agent_id as agent_id,
                 COUNT(*) FILTER (WHERE rd.outcome_status = 'completed')::float /
                 NULLIF(COUNT(*), 0) as success_rate
               FROM routing_decisions rd
               JOIN task_outcomes to ON rd.task_hash = to.task_hash
               WHERE to.domain = ${domain}
                 AND rd.created_at >= NOW() - INTERVAL '7 days'
               GROUP BY rd.selected_agent_id
               HAVING COUNT(*) >= 1
             )
            ), '[]'::json
          ) as successful_agents_json,
          '[]' as failed_agents_json,
          COUNT(*) as total_tasks,
          COUNT(*) FILTER (WHERE outcome_status = 'completed')::float /
            NULLIF(COUNT(*), 0) as success_rate,
          NOW() as last_updated,
          NOW() + INTERVAL '24 hours' as expires_at
        FROM routing_decisions rd
        JOIN task_outcomes to ON rd.task_hash = to.task_hash
        WHERE to.domain = ${domain}
        ON CONFLICT (domain) DO UPDATE SET
          successful_agents_json = EXCLUDED.successful_agents_json,
          failed_agents_json = EXCLUDED.failed_agents_json,
          total_tasks = EXCLUDED.total_tasks,
          success_rate = EXCLUDED.success_rate,
          last_updated = EXCLUDED.last_updated,
          expires_at = NOW() + INTERVAL '24 hours'
      `;

      updatedCount++;
    }

    return updatedCount;
  } catch (err) {
    log.warn("Failed to refresh outcome caches", { error: String(err) });
    return 0;
  }
}
