import { createLogger } from "../logger";
import { getDb } from "../store/db";

const log = createLogger("outcome-tracker");

export interface TaskOutcome {
  taskId: string;
  sessionId: string;
  taskHash: string;
  domain: string;
  agentsSpawned: string[];
  revisionCount: number;
  userFeedback?: "good" | "neutral" | "bad";
  timeToCompleteSec?: number;
}

/**
 * Record task outcome when a task completes
 */
export async function recordTaskOutcome(outcome: TaskOutcome): Promise<void> {
  const db = getDb();
  const taskId = outcome.taskId || `${outcome.sessionId}-${Date.now()}`;

  try {
    await db`
      INSERT INTO task_outcomes (
        task_id, session_id, task_hash, domain, agents_spawned,
        revision_count, user_feedback, time_to_complete, created_at
      )
      VALUES (
        ${taskId},
        ${outcome.sessionId},
        ${outcome.taskHash},
        ${outcome.domain},
        ${JSON.stringify(outcome.agentsSpawned)},
        ${outcome.revisionCount},
        ${outcome.userFeedback || null},
        ${outcome.timeToCompleteSec || null},
        NOW()
      )
      ON CONFLICT (task_id) DO UPDATE SET
        agents_spawned = task_outcomes.agents_spawned || ${JSON.stringify(outcome.agentsSpawned)}::text[],
        revision_count = ${outcome.revisionCount},
        user_feedback = ${outcome.userFeedback || null},
        time_to_complete = ${outcome.timeToCompleteSec || null},
        updated_at = NOW()
    `;

    log.debug("Recorded task outcome", {
      sessionId: outcome.sessionId,
      taskHash: outcome.taskHash,
      domain: outcome.domain,
      agents: outcome.agentsSpawned,
      revisions: outcome.revisionCount,
    });

    await processOutcomeAdjustments(outcome);
  } catch (err) {
    log.warn("Failed to record task outcome", { error: String(err) });
  }
}

/**
 * Record a revision attempt (when an agent fails or needs retry)
 */
export async function recordRevision(
  sessionId: string,
  taskHash: string,
  attemptNumber: number,
  agentId: string,
  errorMessage?: string,
): Promise<void> {
  const db = getDb();

  try {
    await db`
      INSERT INTO task_revisions (
        session_id, task_hash, attempt_number, agent_id, error_message, created_at
      )
      VALUES (
        ${sessionId},
        ${taskHash},
        ${attemptNumber},
        ${agentId},
        ${errorMessage || null},
        NOW()
      )
    `;

    log.debug("Recorded revision", {
      sessionId,
      taskHash,
      attempt: attemptNumber,
      agent: agentId,
    });
  } catch (err) {
    log.warn("Failed to record revision", { error: String(err) });
  }
}

/**
 * Process score adjustments based on task outcome
 */
async function processOutcomeAdjustments(outcome: TaskOutcome): Promise<void> {
  const adjustments: Array<{
    agentId: string;
    domain: string;
    adjustmentType: "outcome_bonus" | "revision_penalty" | "timeout_penalty";
    adjustmentValue: number;
    reason: string;
  }> = [];

  if (outcome.revisionCount === 0) {
    for (const agentId of outcome.agentsSpawned) {
      adjustments.push({
        agentId,
        domain: outcome.domain,
        adjustmentType: "outcome_bonus",
        adjustmentValue: 0.05,
        reason: `Task completed successfully in 1 pass (domain: ${outcome.domain})`,
      });
    }
  }

  if (outcome.revisionCount >= 3) {
    for (const agentId of outcome.agentsSpawned) {
      adjustments.push({
        agentId,
        domain: outcome.domain,
        adjustmentType: "revision_penalty",
        adjustmentValue: -0.1,
        reason: `Task required ${outcome.revisionCount} revisions (domain: ${outcome.domain})`,
      });
    }
  }

  if (adjustments.length > 0) {
    await applyScoreAdjustments(
      adjustments,
      outcome.sessionId,
      outcome.taskHash,
    );
  }
}

/**
 * Apply score adjustments via the scoring engine
 */
async function applyScoreAdjustments(
  adjustments: Array<{
    agentId: string;
    domain: string;
    adjustmentType: string;
    adjustmentValue: number;
    reason: string;
  }>,
  sessionId?: string,
  taskHash?: string,
): Promise<void> {
  const { adjustScoresFromOutcomes } = await import("./scoring-engine");

  try {
    await adjustScoresFromOutcomes(
      adjustments.map((adj) => ({
        agentId: adj.agentId,
        domain: adj.domain,
        adjustmentType: adj.adjustmentType as any,
        adjustmentValue: adj.adjustmentValue,
        reason: adj.reason,
        sessionId,
        taskHash,
      })),
    );

    log.info("Applied score adjustments", {
      count: adjustments.length,
      adjustments: adjustments.map((a) => ({
        agent: a.agentId,
        type: a.adjustmentType,
        value: a.adjustmentValue,
      })),
    });
  } catch (err) {
    log.warn("Failed to apply score adjustments", { error: String(err) });
  }
}

/**
 * Get revision count for a specific task
 */
export async function getRevisionCount(
  sessionId: string,
  taskHash: string,
): Promise<number> {
  const db = getDb();

  try {
    const result = await db`
      SELECT COUNT(*) as count
      FROM task_revisions
      WHERE session_id = ${sessionId} AND task_hash = ${taskHash}
    `;

    return parseInt(result[0]?.count ?? "0", 10);
  } catch (err) {
    log.warn("Failed to get revision count", { error: String(err) });
    return 0;
  }
}
