import { SQL } from "bun";
import { getDb } from "../store/db";
import { createLogger } from "../logger";
import type { ProgressEvent } from "./types";
import { classifyTask } from "./task-classifier";

const log = createLogger("hooks");

const MAX_AUDIT_LENGTH = 2000;
const MAX_PROMPT_LENGTH = 4000;

// ─── Hook Failure Tracking ──────────────────────────────────────────────────

const hookFailureCounts = new Map<string, number>();

function recordHookFailure(hookName: string, error: unknown): void {
  const count = (hookFailureCounts.get(hookName) ?? 0) + 1;
  hookFailureCounts.set(hookName, count);
  log.warn(`Hook failure [${hookName}] (count: ${count})`, {
    error: String(error),
  });
}

export function getHookFailureCounts(): ReadonlyMap<string, number> {
  return hookFailureCounts;
}

export interface HooksConfig {
  readonly auditLog?: boolean;
  readonly notifications?: boolean;
  readonly sessionTracking?: boolean;
  readonly subagentTracking?: boolean;
  readonly promptLogging?: boolean;
  readonly dangerousCommandBlocking?: boolean;
}

export interface BuildHooksOptions {
  readonly agentId: string;
  readonly sessionId?: string;
  readonly hooksConfig?: HooksConfig;
  readonly onProgress?: (event: ProgressEvent) => void;
}

// ─── Types matching Agent SDK hook API ─────────────────────────────────────

type HookCallback = (
  input: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

interface HookCallbackMatcher {
  readonly matcher: string;
  readonly hooks: readonly HookCallback[];
}

type HookRecord = Partial<Record<string, HookCallbackMatcher[]>>;

// ─── Helpers ───────────────────────────────────────────────────────────────

function truncateJson(value: unknown, max: number): string {
  try {
    const str = typeof value === "string" ? value : JSON.stringify(value);
    if (!str) return "";
    return str.length > max ? str.slice(0, max) : str;
  } catch {
    return "[unserializable]";
  }
}

function truncateText(value: string, max: number): string {
  if (!value) return "";
  return value.length > max ? value.slice(0, max) : value;
}

// Dangerous command patterns to block
const DANGEROUS_COMMANDS = [
  /\brm\s+(-[rf]+\s+)?\/(?:etc|usr|var|home|root|boot)/, // rm system dirs
  /\bdd\s+if=.*of=/, // dd disk write
  /\bchmod\s+-R\s+777/, // chmod -R 777
  /\bchown\s+-R\s+/, // chown -R (risky)
  /:\(\)\{\s*:\|:\s*&\s*\};:/, // fork bomb
  /\bmkfs/, // filesystem format
  />\s*\/dev\/sd[a-z]/, // raw disk write (e.g., > /dev/sda)
  />\s*:?\s*\/dev\/sd[a-z]/, // raw disk write variant (e.g., >: /dev/sda)
];

function isDangerousCommand(command: string): boolean {
  return DANGEROUS_COMMANDS.some((pattern) => pattern.test(command));
}

export { isDangerousCommand };

// ─── PreToolUse: Dangerous Command Blocking ────────────────────────────────

function createPreToolUseHook(agentId: string): HookCallback {
  return async (input) => {
    try {
      const toolName = String(input.tool_name ?? "");

      // Only check Bash tool for dangerous commands
      if (toolName === "Bash") {
        const toolInput = input.tool_input as
          | Record<string, unknown>
          | undefined;
        const command = String(toolInput?.command ?? "");

        if (isDangerousCommand(command)) {
          log.warn("Blocked dangerous command", { agentId, command });
          return {
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "deny",
              permissionDecisionReason: `Blocked dangerous command: ${command.slice(0, 100)}`,
            },
          };
        }
      }
    } catch (err) {
      log.warn("PreToolUse hook error", { error: String(err) });
    }
    return {};
  };
}

// ─── PostToolUse: Audit Logger ─────────────────────────────────────────────

function createAuditHook(agentId: string): HookCallback {
  return async (input) => {
    try {
      const db = getDb();
      const toolName = String(input.tool_name ?? "");
      const toolInput = truncateJson(input.tool_input, MAX_AUDIT_LENGTH);
      const toolResponse = truncateJson(input.tool_response, MAX_AUDIT_LENGTH);
      const sessionId = input.session_id ? String(input.session_id) : null;

      db`INSERT INTO tool_audit_log (agent_id, session_id, tool_name, tool_input, tool_response, is_error)
         VALUES (${agentId}, ${sessionId}, ${toolName}, ${toolInput}, ${toolResponse}, ${false})`.catch(
        (err: unknown) =>
          log.warn("Audit log insert failed", { error: String(err) }),
      );
    } catch (err) {
      recordHookFailure("audit", err);
    }
    return {};
  };
}

function createAuditFailureHook(agentId: string): HookCallback {
  return async (input) => {
    try {
      const db = getDb();
      const toolName = String(input.tool_name ?? "");
      const toolInput = truncateJson(input.tool_input, MAX_AUDIT_LENGTH);
      const toolResponse = truncateJson(
        input.error ?? input.tool_response,
        MAX_AUDIT_LENGTH,
      );
      const sessionId = input.session_id ? String(input.session_id) : null;

      db`INSERT INTO tool_audit_log (agent_id, session_id, tool_name, tool_input, tool_response, is_error)
         VALUES (${agentId}, ${sessionId}, ${toolName}, ${toolInput}, ${toolResponse}, ${true})`.catch(
        (err: unknown) =>
          log.warn("Audit failure log insert failed", { error: String(err) }),
      );
    } catch (err) {
      recordHookFailure("auditFailure", err);
    }
    return {};
  };
}

// ─── Notification: Forward to Progress ─────────────────────────────────────

function createNotificationForwarder(
  agentId: string,
  onProgress?: (event: ProgressEvent) => void,
): HookCallback {
  return async (input) => {
    if (!onProgress) return {};
    try {
      const message = String(input.message ?? input.title ?? "");
      if (message) {
        onProgress({
          type: "thinking",
          agentId,
          summary: message.slice(0, 100),
        });
      }
    } catch (err) {
      recordHookFailure("notification", err);
    }
    return {};
  };
}

// ─── Stop: Log conversation end ────────────────────────────────────────────

function createStopHook(agentId: string): HookCallback {
  return async (_input) => {
    log.info("Agent conversation stopped via hook", { agentId });
    return {};
  };
}

// ─── SessionStart: Track conversation start ────────────────────────────────

function createSessionStartHook(agentId: string): HookCallback {
  return async (input) => {
    try {
      const db = getDb();
      const sessionId = input.session_id ? String(input.session_id) : null;
      const prompt = truncateText(
        String(input.prompt ?? ""),
        MAX_PROMPT_LENGTH,
      );

      if (sessionId) {
        await db`INSERT INTO session_history (agent_id, session_id, prompt, created_at)
           VALUES (${agentId}, ${sessionId}, ${prompt}, NOW())
           ON CONFLICT (agent_id, session_id) DO UPDATE SET prompt = ${prompt}, updated_at = NOW()`;
      }
      log.info("Session started", { agentId, sessionId });
    } catch (err) {
      recordHookFailure("sessionStart", err);
    }
    return {};
  };
}

// ─── SessionEnd: Track conversation end ────────────────────────────────────

function createSessionEndHook(agentId: string): HookCallback {
  return async (input) => {
    try {
      const db = getDb();
      const sessionId = input.session_id ? String(input.session_id) : null;
      const result = String(input.result ?? "");

      if (sessionId) {
        await db`UPDATE session_history
           SET result = ${result.slice(0, MAX_AUDIT_LENGTH)}, updated_at = NOW()
           WHERE agent_id = ${agentId} AND session_id = ${sessionId}`;

        // Phase 2: Record task outcome and trigger survey (non-critical, fire-and-forget)
        recordSessionOutcome(db, sessionId, agentId, result).catch(
          (err: unknown) =>
            log.warn("Session outcome recording failed", {
              error: String(err),
            }),
        );
      }
      log.info("Session ended", {
        agentId,
        sessionId,
        resultLength: result.length,
      });
    } catch (err) {
      recordHookFailure("sessionEnd", err);
    }
    return {};
  };
}

/**
 * Phase 2 & 4: Record session outcome for learning
 */
async function recordSessionOutcome(
  db: InstanceType<typeof SQL>,
  sessionId: string,
  agentId: string,
  result: string,
): Promise<void> {
  try {
    const { recordTaskOutcome } = await import("./outcome-tracker");

    // Get the routing decision to find task hash and domain
    const routingDecision = await db`
      SELECT task_hash, selected_agent_id, domain
      FROM routing_decisions
      WHERE session_id = ${sessionId}
      ORDER BY created_at DESC
      LIMIT 1
    `;

    if (!routingDecision || routingDecision.length === 0) {
      const taskHash = `session-${sessionId}-${Date.now()}`;
      await recordTaskOutcome({
        taskId: sessionId,
        sessionId,
        taskHash,
        domain: "general",
        agentsSpawned: [agentId],
        revisionCount: 0,
        timeToCompleteSec: undefined,
      });
      return;
    }

    const { task_hash, domain } = routingDecision[0];

    await recordTaskOutcome({
      taskId: sessionId,
      sessionId,
      taskHash: task_hash,
      domain: domain || "general",
      agentsSpawned: [agentId],
      revisionCount: 0,
      timeToCompleteSec: undefined,
    });

    log.debug("Recorded session outcome", {
      sessionId,
      taskHash: task_hash,
      domain,
      agentId,
    });
  } catch (err) {
    log.warn("Failed to record session outcome", { error: String(err) });
  }
}

// ─── SubagentStart: Track subagent spawning ────────────────────────────────

function createSubagentStartHook(agentId: string): HookCallback {
  return async (input) => {
    try {
      const db = getDb();
      const subagentId = String(input.subagent_id ?? input.agent_id ?? "");
      const task = truncateText(String(input.task ?? ""), MAX_AUDIT_LENGTH);
      const sessionId = input.session_id ? String(input.session_id) : null;

      if (subagentId) {
        await db`INSERT INTO subagent_audit_log (parent_agent_id, session_id, subagent_id, task, created_at)
           VALUES (${agentId}, ${sessionId}, ${subagentId}, ${task}, NOW())`;

        // Classify the subagent task asynchronously (non-critical, fire-and-forget)
        classifyTask(task, sessionId || undefined).catch((err: unknown) =>
          log.warn("Subagent task classification failed", {
            error: String(err),
          }),
        );
      }
      log.info("Subagent started", {
        agentId,
        subagentId,
        task: task.slice(0, 50),
      });
    } catch (err) {
      recordHookFailure("subagentStart", err);
    }
    return {};
  };
}

// ─── SubagentStop: Track subagent completion ───────────────────────────────

function createSubagentStopHook(agentId: string): HookCallback {
  return async (input) => {
    try {
      const subagentId = String(input.subagent_id ?? input.agent_id ?? "");
      const result = String(input.result ?? "");
      const status = String(input.status ?? "completed");
      const sessionId = input.session_id ? String(input.session_id) : null;

      // Update the audit log entry created by SubagentStart
      if (sessionId && subagentId) {
        const db = getDb();
        await db`UPDATE subagent_audit_log
           SET status = ${status}, result = ${result.slice(0, MAX_AUDIT_LENGTH)}, completed_at = NOW()
           WHERE parent_agent_id = ${agentId}
             AND session_id = ${sessionId}
             AND subagent_id = ${subagentId}
             AND completed_at IS NULL`;

        // Phase 2: Routing Feedback Loop - update scores based on outcome
        updateRoutingScores(db, sessionId, subagentId, status).catch(
          (err: unknown) =>
            log.warn("Routing score update failed", { error: String(err) }),
        );

        // Record revision/failure
        if (status !== "completed") {
          const { recordRevision } = await import("./outcome-tracker");
          const { classifyTask } = await import("./task-classifier");

          const task = String(input.task ?? "");
          const { taskHash } = await classifyTask(task, sessionId);

          await recordRevision(
            sessionId,
            taskHash,
            1,
            subagentId,
            result.slice(0, 500),
          );

          const { recordFailure } = await import("./failure-analyzer");
          await recordFailure(
            sessionId,
            subagentId,
            "general",
            result.slice(0, 500),
            status === "timeout" ? "timeout" : "error",
          );
        }

        // Phase 5: Self-reflection checks (fire-and-forget observability)
        const withDbTimeout = <T>(p: Promise<T>): Promise<T> =>
          Promise.race([
            p,
            new Promise<T>((_, reject) =>
              setTimeout(() => reject(new Error("db timeout")), 3000),
            ),
          ]);

        if (status === "timeout") {
          import("./self-reflection")
            .then(async ({ checkTimeout, shouldEscalate, getEscalationTarget }) => {
              const db = getDb();
              const startRow = await withDbTimeout(
                db`
                SELECT created_at FROM subagent_audit_log
                WHERE parent_agent_id = ${agentId}
                  AND session_id = ${sessionId}
                  AND subagent_id = ${subagentId}
                ORDER BY created_at DESC
                LIMIT 1
              `,
              );
              const startTime: Date =
                (startRow?.[0]?.created_at as Date | undefined) ??
                new Date(Date.now() - 60_000);
              const reflection = await checkTimeout(sessionId, startTime, subagentId);
              if (reflection && shouldEscalate(reflection)) {
                const target = getEscalationTarget(reflection);
                log.warn("Self-reflection recommends escalation", {
                  sessionId,
                  triggerType: reflection.triggerType,
                  escalationTarget: target,
                  actionTaken: reflection.actionTaken,
                });
              }
            })
            .catch((err: unknown) =>
              log.warn("Self-reflection timeout check failed", {
                error: String(err),
              }),
            );
        }

        if (status === "error" || status === "timeout") {
          import("./self-reflection")
            .then(async ({ checkRepeatedFailures, shouldEscalate, getEscalationTarget }) => {
              const db = getDb();
              const failureRows = await withDbTimeout(
                db<{ result: string }[]>`
                SELECT result FROM subagent_audit_log
                WHERE parent_agent_id = ${agentId}
                  AND session_id = ${sessionId}
                  AND status IN ('error', 'timeout')
                ORDER BY created_at DESC
                LIMIT 5
              `,
              );
              const recentErrors = (failureRows ?? []).map((r) =>
                String(r.result ?? "").slice(0, 200),
              );
              const reflection = await checkRepeatedFailures(
                sessionId,
                recentErrors.length,
                recentErrors,
                [],
              );
              if (reflection && shouldEscalate(reflection)) {
                const target = getEscalationTarget(reflection);
                log.warn("Self-reflection recommends escalation", {
                  sessionId,
                  triggerType: reflection.triggerType,
                  escalationTarget: target,
                  actionTaken: reflection.actionTaken,
                });
              }
            })
            .catch((err: unknown) =>
              log.warn("Self-reflection failure check failed", {
                error: String(err),
              }),
            );
        }

        // Generate post-mortem reflection for failed/partial tasks
        if (status !== "completed") {
          import("./reflection/postmortem")
            .then(async ({ generatePostMortem }) => {
              const db = getDb();
              const task = String(input.task ?? "");
              const { classifyTask } = await import("./task-classifier");
              const { taskHash } = await classifyTask(task, sessionId);

              // Get start time for duration calculation
              const startRow = await withDbTimeout(
                db`
                SELECT created_at FROM subagent_audit_log
                WHERE parent_agent_id = ${agentId}
                  AND session_id = ${sessionId}
                  AND subagent_id = ${subagentId}
                ORDER BY created_at DESC
                LIMIT 1
              `,
              );
              const startTime: Date =
                (startRow?.[0]?.created_at as Date | undefined) ??
                new Date(Date.now() - 60_000);
              const durationSec = (Date.now() - startTime.getTime()) / 1000;

              // Count revisions for this task
              const revisionRows = await withDbTimeout(
                db<{ count: number }[]>`
                SELECT COUNT(*) as count FROM subagent_audit_log
                WHERE session_id = ${sessionId}
                  AND subagent_id = ${subagentId}
                  AND status IN ('error', 'timeout')
              `,
              );
              const revisions = Number(revisionRows?.[0]?.count ?? 0);

              await generatePostMortem(sessionId, subagentId, taskHash, {
                status: status === "timeout" ? "failure" : "failure",
                result: result.slice(0, 1000),
                errorMessage: result.slice(0, 500),
                revisions,
                durationSec,
              });
            })
            .catch((err: unknown) =>
              log.warn("Post-mortem generation failed", {
                error: String(err),
              }),
            );
        }

        // Phase 3: Update agent load (decrement on completion)
        if (
          status === "completed" ||
          status === "error" ||
          status === "timeout"
        ) {
          const { updateAgentLoad } = await import("./load-balancer");
          await updateAgentLoad(subagentId, -1);
        }
      }

      log.info("Subagent stopped", {
        agentId,
        subagentId,
        status,
        resultLength: result.length,
      });
    } catch (err) {
      recordHookFailure("subagentStop", err);
    }
    return {};
  };
}

/**
 * Phase 2: Routing Feedback Loop
 * Update agent scores based on subagent outcomes
 */
async function updateRoutingScores(
  db: InstanceType<typeof SQL>,
  sessionId: string,
  agentId: string,
  status: string,
): Promise<void> {
  // Get the routing decision for this session
  const routingDecision = await db`
    SELECT selected_agent_id, outcome_status
    FROM routing_decisions
    WHERE session_id = ${sessionId}
    ORDER BY created_at DESC
    LIMIT 1
  `;

  if (!routingDecision || routingDecision.length === 0) {
    return; // No routing decision to update
  }

  // Update the routing decision outcome
  const outcomeStatus = status === "completed" ? "completed" : "error";
  await db`
    UPDATE routing_decisions
    SET outcome_status = ${outcomeStatus}
    WHERE session_id = ${sessionId} AND outcome_status IS NULL
  `;

  // Adjust agent scores based on outcome
  // Success: +5% to score for this domain
  // Failure: -10% to score for this domain
  const adjustment = outcomeStatus === "completed" ? 0.05 : -0.1;

  await db`
    UPDATE agent_scores
    SET score = LEAST(1.0, GREATEST(0.0, score + ${adjustment})),
        computed_at = NOW()
    WHERE agent_id = ${agentId}
      AND time_window = '1h'
  `;

  log.debug("Updated routing scores", {
    sessionId,
    agentId,
    outcome: outcomeStatus,
    adjustment,
  });
}

// ─── UserPromptSubmit: Log user prompts ────────────────────────────────────

function createUserPromptHook(agentId: string): HookCallback {
  return async (input) => {
    try {
      const db = getDb();
      const sessionId = input.session_id ? String(input.session_id) : null;
      const prompt = truncateText(
        String(input.prompt ?? ""),
        MAX_PROMPT_LENGTH,
      );
      const timestamp = new Date().toISOString();

      if (prompt && sessionId) {
        db`INSERT INTO user_prompt_log (agent_id, session_id, prompt, created_at)
           VALUES (${agentId}, ${sessionId}, ${prompt}, NOW())`.catch(
          (err: unknown) =>
            log.warn("User prompt log insert failed", { error: String(err) }),
        );

        // Classify the task asynchronously (bounded to 5s to avoid blocking DB shutdown)
        const classifyTimeout = new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error("classify timeout")), 5000),
        );
        Promise.race([classifyTask(prompt, sessionId), classifyTimeout]).catch(
          (err: unknown) =>
            log.warn("Task classification failed", { error: String(err) }),
        );

        // Phase 5: Extract and save user preferences from message
        import("../memory/preference-extractor")
          .then(async ({ extractPreferencesFromMessage, savePreferences }) => {
            const candidates = await extractPreferencesFromMessage(
              sessionId,
              `${sessionId}-${Date.now()}`,
              prompt,
            );
            if (candidates.length > 0) {
              await savePreferences(candidates, sessionId);
            }
          })
          .catch((err: unknown) =>
            log.debug("Preference extraction skipped", { error: String(err) }),
          );
      }
      log.debug("User prompt logged", {
        agentId,
        sessionId,
        promptLength: prompt.length,
      });
    } catch (err) {
      recordHookFailure("userPrompt", err);
    }
    return {};
  };
}

// ─── Assembly ──────────────────────────────────────────────────────────────

export function buildSdkHooks(opts: BuildHooksOptions): HookRecord {
  const { agentId, hooksConfig, onProgress } = opts;
  const hooks: Record<string, HookCallbackMatcher[]> = {};

  // Dangerous command blocking (default: off)
  if (hooksConfig?.dangerousCommandBlocking === true) {
    hooks.PreToolUse = [
      { matcher: "Bash", hooks: [createPreToolUseHook(agentId)] },
    ];
  }

  // Audit logger (default: on)
  if (hooksConfig?.auditLog !== false) {
    hooks.PostToolUse = [{ matcher: "*", hooks: [createAuditHook(agentId)] }];
    hooks.PostToolUseFailure = [
      { matcher: "*", hooks: [createAuditFailureHook(agentId)] },
    ];
  }

  // Notification forwarder (default: on)
  if (hooksConfig?.notifications !== false && onProgress) {
    hooks.Notification = [
      {
        matcher: "*",
        hooks: [createNotificationForwarder(agentId, onProgress)],
      },
    ];
  }

  // Session tracking (default: on)
  if (hooksConfig?.sessionTracking !== false) {
    hooks.SessionStart = [
      { matcher: "*", hooks: [createSessionStartHook(agentId)] },
    ];
    hooks.SessionEnd = [
      { matcher: "*", hooks: [createSessionEndHook(agentId)] },
    ];
  }

  // Subagent tracking (default: on)
  if (hooksConfig?.subagentTracking !== false) {
    hooks.SubagentStart = [
      { matcher: "*", hooks: [createSubagentStartHook(agentId)] },
    ];
    hooks.SubagentStop = [
      { matcher: "*", hooks: [createSubagentStopHook(agentId)] },
    ];
  }

  // User prompt logging (default: on)
  if (hooksConfig?.promptLogging !== false) {
    hooks.UserPromptSubmit = [
      { matcher: "*", hooks: [createUserPromptHook(agentId)] },
    ];
  }

  // Stop hook (always on for logging)
  hooks.Stop = [{ matcher: "*", hooks: [createStopHook(agentId)] }];

  return hooks;
}
