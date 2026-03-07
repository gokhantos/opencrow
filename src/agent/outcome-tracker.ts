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
      feedback: outcome.userFeedback,
    });

    // Trigger score adjustments based on outcome
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
 * Record survey response from user
 */
export async function recordSurveyResponse(
  sessionId: string,
  taskHash: string,
  feedbackType: "good" | "neutral" | "bad",
  feedbackText?: string,
  revisionRequested?: boolean,
): Promise<void> {
  const db = getDb();

  try {
    await db`
      INSERT INTO survey_responses (
        session_id, task_hash, feedback_type, feedback_text,
        revision_requested, response_time_sec, created_at
      )
      VALUES (
        ${sessionId},
        ${taskHash},
        ${feedbackType},
        ${feedbackText || null},
        ${revisionRequested || false},
        NULL,
        NOW()
      )
    `;

    log.debug("Recorded survey response", {
      sessionId,
      taskHash,
      feedback: feedbackType,
      revisionRequested,
    });

    // Trigger score adjustments based on survey
    await processSurveyAdjustments(sessionId, taskHash, feedbackType);
  } catch (err) {
    log.warn("Failed to record survey response", { error: String(err) });
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

  // Bonus for successful completion (no revisions)
  if (outcome.revisionCount === 0) {
    for (const agentId of outcome.agentsSpawned) {
      adjustments.push({
        agentId,
        domain: outcome.domain,
        adjustmentType: "outcome_bonus",
        adjustmentValue: 0.05, // +5% bonus
        reason: `Task completed successfully in 1 pass (domain: ${outcome.domain})`,
      });
    }
  }

  // Penalty for multiple revisions
  if (outcome.revisionCount >= 3) {
    for (const agentId of outcome.agentsSpawned) {
      adjustments.push({
        agentId,
        domain: outcome.domain,
        adjustmentType: "revision_penalty",
        adjustmentValue: -0.1, // -10% penalty
        reason: `Task required ${outcome.revisionCount} revisions (domain: ${outcome.domain})`,
      });
    }
  }

  // Apply adjustments
  if (adjustments.length > 0) {
    await applyScoreAdjustments(
      adjustments,
      outcome.sessionId,
      outcome.taskHash,
    );
  }
}

/**
 * Process score adjustments based on survey feedback
 */
async function processSurveyAdjustments(
  sessionId: string,
  taskHash: string,
  feedbackType: "good" | "neutral" | "bad",
): Promise<void> {
  const db = getDb();

  try {
    // Get the task outcome to find which agents were used
    const result = await db`
      SELECT domain, agents_spawned
      FROM task_outcomes
      WHERE task_hash = ${taskHash}
      ORDER BY created_at DESC
      LIMIT 1
    `;

    if (result.length === 0) {
      log.warn("No task outcome found for survey", { taskHash });
      return;
    }

    const { domain, agents_spawned } = result[0];
    const adjustments: Array<{
      agentId: string;
      domain: string;
      adjustmentType: "survey_bonus" | "survey_penalty";
      adjustmentValue: number;
      reason: string;
    }> = [];

    if (feedbackType === "good") {
      for (const agentId of agents_spawned) {
        adjustments.push({
          agentId,
          domain,
          adjustmentType: "survey_bonus",
          adjustmentValue: 0.1, // +10% bonus
          reason: `User rated task outcome as "good" (domain: ${domain})`,
        });
      }
    } else if (feedbackType === "bad") {
      for (const agentId of agents_spawned) {
        adjustments.push({
          agentId,
          domain,
          adjustmentType: "survey_penalty",
          adjustmentValue: -0.15, // -15% penalty
          reason: `User rated task outcome as "bad" (domain: ${domain})`,
        });
      }
    }
    // Neutral feedback = no adjustment

    if (adjustments.length > 0) {
      await applyScoreAdjustments(adjustments, sessionId, taskHash);
    }
  } catch (err) {
    log.warn("Failed to process survey adjustments", { error: String(err) });
  }
}

/**
 * Apply score adjustments to the agent_scores table
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
  const db = getDb();
  const { adjustScoresFromOutcomes } = await import("./scoring-engine");

  try {
    // Use the scoring engine function to apply adjustments
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

/**
 * Trigger post-task survey (to be integrated with Telegram)
 */
export async function triggerPostTaskSurvey(
  sessionId: string,
  taskHash: string,
  result: string,
): Promise<void> {
  try {
    const db = getDb();

    // Resolve chat ID from session messages
    const chatRow = await db`
      SELECT chat_id FROM messages
      WHERE session_id = ${sessionId}
      ORDER BY timestamp DESC
      LIMIT 1
    `;
    const chatId = chatRow?.[0]?.chat_id;
    if (!chatId) {
      log.info("No chat ID found for survey — storing as pending", { sessionId, taskHash });
    }

    // Resolve agent ID from routing decision
    const routingRow = await db`
      SELECT selected_agent_id FROM routing_decisions
      WHERE session_id = ${sessionId}
      ORDER BY created_at DESC
      LIMIT 1
    `;
    const agentId = routingRow?.[0]?.selected_agent_id || "default";

    // Attempt to get bot for the agent
    let bot: import("grammy").Bot | undefined;
    try {
      const rows = await db`
        SELECT value_json FROM config_overrides
        WHERE namespace = 'agents' AND key = ${agentId}
      `;
      if (rows.length > 0) {
        const config = JSON.parse(rows[0].value_json);
        const token = config?.telegramBotToken;
        if (token) {
          const { Bot: GrammyBot } = await import("grammy");
          bot = new GrammyBot(token);
        }
      }
    } catch (err) {
      log.warn("Failed to resolve bot for survey", { error: String(err), agentId });
    }

    // Delegate to the delivery system
    const { sendPostTaskSurvey } = await import("./survey/delivery");
    await sendPostTaskSurvey(
      sessionId,
      taskHash,
      agentId,
      chatId || "",
      result,
      bot,
    );
  } catch (err) {
    log.warn("Failed to trigger post-task survey", { error: String(err), sessionId });
  }
}
