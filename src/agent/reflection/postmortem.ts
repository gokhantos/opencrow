import { createLogger } from "../../logger";
import { getDb } from "../../store/db";
import { generateErrorSignature } from "../failure/signatures";

const log = createLogger("reflection-postmortem");

export interface ReflectionResult {
  id: string;
  sessionId: string;
  taskHash: string;
  agentId: string;
  outcomeStatus: "success" | "partial" | "failure";
  whatWentWell: string;
  whatWentWrong: string;
  rootCauseAnalysis: string;
  lessonsLearned: string[];
  improvementActions: Array<{
    action: string;
    priority: "low" | "medium" | "high";
    estimatedImpact: number;
  }>;
  similarPastFailures: string[];
}

export interface ReflectionConfig {
  minRevisionsForReflection: number;
  includeSuccessReflections: boolean;
  maxReflectionsPerDay: number;
}

const DEFAULT_CONFIG: ReflectionConfig = {
  minRevisionsForReflection: 2,
  includeSuccessReflections: false,
  maxReflectionsPerDay: 10,
};

/**
 * Generate post-mortem reflection after task completion
 */
export async function generatePostMortem(
  sessionId: string,
  agentId: string,
  taskHash: string,
  outcome: {
    status: "success" | "partial" | "failure";
    result: string;
    errorMessage?: string;
    revisions: number;
    durationSec: number;
  },
  config: ReflectionConfig = DEFAULT_CONFIG,
): Promise<ReflectionResult | null> {
  // Check if reflection should be generated
  if (outcome.status === "success" && !config.includeSuccessReflections) {
    log.debug("Skipping reflection for successful task", { sessionId });
    return null;
  }

  // Check revision threshold for failures
  if (
    outcome.status === "failure" &&
    outcome.revisions < config.minRevisionsForReflection
  ) {
    log.debug("Skipping reflection - below revision threshold", {
      sessionId,
      revisions: outcome.revisions,
      minRequired: config.minRevisionsForReflection,
    });
    return null;
  }

  // Check daily limit
  const dailyCount = await getTodaysReflectionCount(agentId);
  if (dailyCount >= config.maxReflectionsPerDay) {
    log.debug("Skipping reflection - daily limit reached", {
      agentId,
      dailyCount,
      limit: config.maxReflectionsPerDay,
    });
    return null;
  }

  try {
    // Generate reflection content
    const reflection = await buildReflection(
      sessionId,
      agentId,
      taskHash,
      outcome,
    );

    // Find similar past failures
    if (outcome.errorMessage) {
      const signature = generateErrorSignature(outcome.errorMessage);
      const similarFailures = await findSimilarPastFailures(
        signature.normalized,
        "general",
      );
      reflection.similarPastFailures = similarFailures.map((f) => f.sessionId);
    }

    // Store reflection
    await storeReflection(reflection);

    log.info("Generated post-mortem reflection", {
      sessionId,
      agentId,
      outcomeStatus: outcome.status,
      lessonsCount: reflection.lessonsLearned.length,
      actionsCount: reflection.improvementActions.length,
    });

    return reflection;
  } catch (err) {
    log.warn("Failed to generate post-mortem", {
      error: String(err),
      sessionId,
    });
    return null;
  }
}

/**
 * Build reflection content
 */
async function buildReflection(
  sessionId: string,
  agentId: string,
  taskHash: string,
  outcome: {
    status: "success" | "partial" | "failure";
    result: string;
    errorMessage?: string;
    revisions: number;
    durationSec: number;
  },
): Promise<ReflectionResult> {
  const db = getDb();

  // Get task details from database
  const taskInfo = await db`
    SELECT domain, keywords_json
    FROM task_classification
    WHERE task_hash = ${taskHash}
    ORDER BY created_at DESC
    LIMIT 1
  `;

  const domain = taskInfo?.[0]?.domain || "general";
  const keywords = JSON.parse(taskInfo?.[0]?.keywords_json || "[]");

  // Get tool audit log for this session
  const toolLog = await db`
    SELECT tool_name, tool_input, tool_response, is_error
    FROM tool_audit_log
    WHERE session_id = ${sessionId}
    ORDER BY created_at
  `;

  // Analyze what went well
  const whatWentWell = analyzeWhatWentWell(toolLog, outcome);

  // Analyze what went wrong
  const whatWentWrong = analyzeWhatWentWrong(toolLog, outcome);

  // Root cause analysis
  const rootCauseAnalysis = performRootCauseAnalysis(outcome, whatWentWrong);

  // Extract lessons learned
  const lessonsLearned = extractLessonsLearned(outcome, rootCauseAnalysis);

  // Generate improvement actions
  const improvementActions = generateImprovementActions(
    whatWentWrong,
    rootCauseAnalysis,
    outcome.revisions,
  );

  // Generate ID
  const reflectionId = `reflection_${sessionId}_${Date.now()}`;

  return {
    id: reflectionId,
    sessionId,
    taskHash,
    agentId,
    outcomeStatus: outcome.status,
    whatWentWell,
    whatWentWrong,
    rootCauseAnalysis,
    lessonsLearned,
    improvementActions,
    similarPastFailures: [],
  };
}

/**
 * Analyze what went well
 */
function analyzeWhatWentWell(toolLog: any[], outcome: any): string {
  const successfulTools = toolLog.filter((t) => !t.is_error);
  const toolNames = [...new Set(successfulTools.map((t) => t.tool_name))];

  if (outcome.status === "success") {
    return `Task completed successfully. Tools used effectively: ${toolNames.slice(0, 5).join(", ")}.`;
  }

  if (successfulTools.length > 0) {
    return `Successfully executed ${successfulTools.length} tool operations before encountering issues.`;
  }

  return "Task was attempted but did not reach successful completion.";
}

/**
 * Analyze what went wrong
 */
function analyzeWhatWentWrong(toolLog: any[], outcome: any): string {
  if (!outcome.errorMessage) {
    if (outcome.status === "partial") {
      return "Task was partially completed - some requirements may not have been met.";
    }
    return "No specific error message available.";
  }

  const failedTools = toolLog.filter((t) => t.is_error);
  const lastError = failedTools[failedTools.length - 1];

  if (lastError) {
    return `${lastError.tool_name} failed: ${outcome.errorMessage.slice(0, 200)}`;
  }

  return outcome.errorMessage.slice(0, 200);
}

/**
 * Perform root cause analysis
 */
function performRootCauseAnalysis(outcome: any, whatWentWrong: string): string {
  const errorSignature = generateErrorSignature(whatWentWrong);

  // Categorize the error
  const category = errorSignature.category;
  const params = errorSignature.extractedParams;

  let analysis = `Error category: ${category}.`;

  if (params.path) {
    analysis += ` Involved path: ${params.path}.`;
  }
  if (params.httpStatus) {
    analysis += ` HTTP status: ${params.httpStatus}.`;
  }

  // Add category-specific analysis
  switch (category) {
    case "network":
      analysis +=
        " Root cause appears to be network connectivity or service availability.";
      break;
    case "permission":
      analysis +=
        " Root cause appears to be insufficient permissions or access rights.";
      break;
    case "filesystem":
      analysis +=
        " Root cause appears to be file system state (missing files, disk space, etc.).";
      break;
    case "api":
      analysis +=
        " Root cause appears to be API-related (authentication, rate limiting, or server error).";
      break;
    case "database":
      analysis +=
        " Root cause appears to be database-related (query error, connection issue, or deadlock).";
      break;
    case "runtime":
      analysis +=
        " Root cause appears to be a runtime error (type error, undefined variable, etc.).";
      break;
    case "timeout":
      analysis +=
        " Root cause appears to be timeout - operation took too long to complete.";
      break;
    default:
      analysis += " Root cause requires further investigation.";
  }

  if (outcome.revisions > 0) {
    analysis += ` Task required ${outcome.revisions} revision attempts before final outcome.`;
  }

  return analysis;
}

/**
 * Extract lessons learned
 */
function extractLessonsLearned(outcome: any, rootCause: string): string[] {
  const lessons: string[] = [];

  // Add general lessons based on outcome
  if (outcome.status === "failure") {
    lessons.push("Verify prerequisites before starting complex operations.");
  }

  if (outcome.revisions > 0) {
    lessons.push(
      "Multiple attempts indicate the need for better initial analysis.",
    );
  }

  // Add specific lessons based on root cause
  if (rootCause.includes("network")) {
    lessons.push(
      "Implement retry logic with exponential backoff for network operations.",
    );
    lessons.push("Check service health before attempting connections.");
  }

  if (rootCause.includes("permission")) {
    lessons.push("Verify permissions early in the task execution.");
    lessons.push("Use least-privilege principle when requesting access.");
  }

  if (rootCause.includes("timeout")) {
    lessons.push("Break large operations into smaller, manageable chunks.");
    lessons.push("Set appropriate timeouts and implement progress tracking.");
  }

  if (rootCause.includes("API")) {
    lessons.push("Implement rate limiting awareness and backoff strategies.");
    lessons.push("Cache API responses when possible to reduce calls.");
  }

  // Ensure we always have at least one lesson
  if (lessons.length === 0) {
    lessons.push("Review task requirements thoroughly before execution.");
  }

  return lessons.slice(0, 5); // Limit to 5 lessons
}

/**
 * Generate improvement actions
 */
function generateImprovementActions(
  whatWentWrong: string,
  rootCause: string,
  revisions: number,
): Array<{
  action: string;
  priority: "low" | "medium" | "high";
  estimatedImpact: number;
}> {
  const actions: Array<{
    action: string;
    priority: "low" | "medium" | "high";
    estimatedImpact: number;
  }> = [];

  // Priority based on revision count
  const basePriority =
    revisions >= 3 ? "high" : revisions >= 2 ? "medium" : "low";

  // Add actions based on identified issues
  if (whatWentWrong.includes("timeout")) {
    actions.push({
      action: "Implement timeout handling with graceful degradation",
      priority: basePriority,
      estimatedImpact: 0.8,
    });
  }

  if (
    whatWentWrong.includes("permission") ||
    whatWentWrong.includes("access denied")
  ) {
    actions.push({
      action: "Add permission pre-check before operations",
      priority: "high",
      estimatedImpact: 0.9,
    });
  }

  if (whatWentWrong.includes("not found") || whatWentWrong.includes("ENOENT")) {
    actions.push({
      action: "Validate file/resource existence before operations",
      priority: basePriority,
      estimatedImpact: 0.7,
    });
  }

  if (revisions >= 2) {
    actions.push({
      action: "Improve initial task analysis to reduce revision cycles",
      priority: "medium",
      estimatedImpact: 0.6,
    });
  }

  // Add generic action if none specific
  if (actions.length === 0) {
    actions.push({
      action: "Review and document task execution process",
      priority: "low",
      estimatedImpact: 0.4,
    });
  }

  return actions.slice(0, 3); // Limit to 3 actions
}

/**
 * Find similar past failures
 */
export async function findSimilarPastFailures(
  errorSignature: string,
  domain: string,
  limit: number = 5,
): Promise<
  Array<{
    sessionId: string;
    agentId: string;
    errorMessage: string;
    resolution?: string;
  }>
> {
  const db = getDb();

  try {
    // Search in failure records for similar signatures
    const result = await db`
      SELECT
        fr.session_id,
        fr.agent_id,
        fr.error_message,
        fr.error_signature,
        sh.result as resolution
      FROM failure_records fr
      LEFT JOIN session_history sh ON fr.session_id = sh.session_id
      WHERE fr.error_signature LIKE ${`%${errorSignature.slice(0, 50)}%`}
         OR fr.error_message LIKE ${`%${errorSignature.slice(0, 50)}%`}
      ORDER BY fr.created_at DESC
      LIMIT ${limit}
    `;

    return (result || []).map((row: any) => ({
      sessionId: row.session_id,
      agentId: row.agent_id,
      errorMessage: row.error_message,
      resolution: row.resolution,
    }));
  } catch (err) {
    log.warn("Failed to find similar past failures", { error: String(err) });
    return [];
  }
}

/**
 * Store reflection in database
 */
export async function storeReflection(
  reflection: ReflectionResult,
): Promise<void> {
  const db = getDb();

  try {
    await db`
      INSERT INTO agent_reflections (
        id, session_id, task_hash, agent_id, reflection_type,
        outcome_status, what_went_well, what_went_wrong, root_cause_analysis,
        lessons_learned_json, improvement_actions_json, similar_past_failures,
        created_at
      ) VALUES (
        ${reflection.id}, ${reflection.sessionId}, ${reflection.taskHash}, ${reflection.agentId},
        ${reflection.outcomeStatus === "success" ? "post_success" : "post_failure"},
        ${reflection.outcomeStatus}, ${reflection.whatWentWell}, ${reflection.whatWentWrong},
        ${reflection.rootCauseAnalysis}, ${JSON.stringify(reflection.lessonsLearned)},
        ${JSON.stringify(reflection.improvementActions)}, ${reflection.similarPastFailures},
        NOW()
      )
    `;

    // Record learning event
    await db`
      INSERT INTO learning_events (
        event_type, session_id, task_hash, agent_id, event_data_json
      ) VALUES (
        'reflection_created', ${reflection.sessionId}, ${reflection.taskHash}, ${reflection.agentId},
        ${JSON.stringify({
          outcomeStatus: reflection.outcomeStatus,
          lessonsCount: reflection.lessonsLearned.length,
          actionsCount: reflection.improvementActions.length,
        })}::jsonb
      )
    `;

    log.debug("Stored reflection", {
      reflectionId: reflection.id,
      sessionId: reflection.sessionId,
    });
  } catch (err) {
    log.warn("Failed to store reflection", { error: String(err) });
  }
}

/**
 * Get reflections for an agent
 */
export async function getAgentReflections(
  agentId: string,
  limit: number = 10,
  outcomeStatus?: string,
): Promise<ReflectionResult[]> {
  const db = getDb();

  try {
    let query = db`
      SELECT * FROM agent_reflections
      WHERE agent_id = ${agentId}
    `;

    if (outcomeStatus) {
      query = db`
        SELECT * FROM agent_reflections
        WHERE agent_id = ${agentId} AND outcome_status = ${outcomeStatus}
      `;
    }

    query = db`${query} ORDER BY created_at DESC LIMIT ${limit}`;

    const result = await query;

    return (result || []).map((row: any) => ({
      id: row.id,
      sessionId: row.session_id,
      taskHash: row.task_hash,
      agentId: row.agent_id,
      outcomeStatus: row.outcome_status as "success" | "partial" | "failure",
      whatWentWell: row.what_went_well,
      whatWentWrong: row.what_went_wrong,
      rootCauseAnalysis: row.root_cause_analysis,
      lessonsLearned: JSON.parse(row.lessons_learned_json || "[]"),
      improvementActions: JSON.parse(row.improvement_actions_json || "[]"),
      similarPastFailures: row.similar_past_failures || [],
    }));
  } catch (err) {
    log.warn("Failed to get agent reflections", { error: String(err) });
    return [];
  }
}

/**
 * Get today's reflection count for an agent
 */
async function getTodaysReflectionCount(agentId: string): Promise<number> {
  const db = getDb();

  try {
    const result = await db`
      SELECT COUNT(*) as count FROM agent_reflections
      WHERE agent_id = ${agentId}
        AND created_at >= DATE_TRUNC('day', NOW())
    `;

    return Number(result?.[0]?.count || 0);
  } catch (err) {
    log.warn("Failed to get reflection count", { error: String(err) });
    return 0;
  }
}

/**
 * Get relevant reflections for an agent to inject into its prompt.
 * Returns recent failure reflections with lessons learned.
 */
export async function getRelevantReflections(
  agentId: string,
  limit: number = 3,
): Promise<ReflectionResult[]> {
  const db = getDb();

  try {
    const rows = await db`
      SELECT * FROM agent_reflections
      WHERE agent_id = ${agentId}
        AND outcome_status IN ('failure', 'partial')
        AND created_at >= NOW() - INTERVAL '7 days'
      ORDER BY created_at DESC
      LIMIT ${limit}
    `;

    return (rows || []).map((row: any) => ({
      id: row.id,
      sessionId: row.session_id,
      taskHash: row.task_hash,
      agentId: row.agent_id,
      outcomeStatus: row.outcome_status as "success" | "partial" | "failure",
      whatWentWell: row.what_went_well,
      whatWentWrong: row.what_went_wrong,
      rootCauseAnalysis: row.root_cause_analysis,
      lessonsLearned: JSON.parse(row.lessons_learned_json || "[]"),
      improvementActions: JSON.parse(row.improvement_actions_json || "[]"),
      similarPastFailures: row.similar_past_failures || [],
    }));
  } catch (err) {
    log.warn("Failed to get relevant reflections", { error: String(err) });
    return [];
  }
}
