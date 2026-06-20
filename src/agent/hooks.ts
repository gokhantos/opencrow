import { getDb } from "../store/db";
import { createLogger } from "../logger";
import type { ProgressEvent } from "./types";

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

// ─── Dangerous-command patterns ─────────────────────────────────────────────
//
// BEST-EFFORT, NOT THE BOUNDARY. These regexes are defense-in-depth on top of
// the OS sandbox (src/tools/sandbox.ts), which is the real filesystem/network
// containment. String matching on shell is fundamentally bypassable (env,
// base64, globbing, $IFS, nested interpreters). Treat additions here as making
// the obvious attacks louder, never as a guarantee.
const DANGEROUS_COMMANDS = [
  /\brm\s+(-[rf]+\s+)?\/(?:etc|usr|var|home|root|boot)/, // rm system dirs
  /\brm\s+-[rf]*r[rf]*\s+(\/|~|\$home)\s*$/i, // rm -rf / | ~ | $HOME
  /\bdd\s+if=.*of=/, // dd disk write
  /\bchmod\s+(-R\s+)?777/, // chmod 777 (recursive or not)
  /\bchown\s+-R\s+/, // chown -R (risky)
  /:\(\)\{\s*:\|:\s*&\s*\};:/, // fork bomb
  /\bmkfs/, // filesystem format
  />\s*\/dev\/sd[a-z]/, // raw disk write (e.g., > /dev/sda)
  />\s*:?\s*\/dev\/sd[a-z]/, // raw disk write variant (e.g., >: /dev/sda)
  // Pipe-to-shell installers: curl/wget … | sh|bash|zsh
  /\b(?:curl|wget|fetch)\b[^|]*\|\s*(?:sudo\s+)?(?:ba|z|d|fi)?sh\b/i,
  // Writes/appends into sensitive paths (/etc, ~/.ssh, authorized_keys)
  />>?\s*(?:\/etc\/|~\/\.ssh\/|\$home\/\.ssh\/|[^\s]*authorized_keys)/i,
  // Privilege escalation invoked directly
  /\b(?:sudo|doas|pkexec)\b/, // run-as-root

  // --- Secret-file reads (cat/xxd/base64/od/strings of credential material) ---
  /\b(?:cat|less|more|head|tail|xxd|hexdump|od|strings|base64|gpg|openssl)\b[^|;&\n]*(?:\.env\b|id_rsa\b|id_ed25519\b|id_ecdsa\b|id_dsa\b|\.ssh\/|\.aws\/|\.pem\b|\.pgpass\b|\.netrc\b|\.npmrc\b|credentials\b|authorized_keys\b)/i,

  // --- Network exfiltration of files/data ---
  // curl/wget upload flags carrying file or data payloads.
  /\b(?:curl|wget)\b[^|;&\n]*(?:--post-file|--data-binary|--upload-file|-T\b|--form\b|-F\b)/i,
  /\bcurl\b[^|;&\n]*(?:--data\b|-d\b)\s*@/i, // curl -d @file / --data @file
  // Bash /dev/tcp (and /dev/udp) pseudo-device exfil channels.
  /\/dev\/(?:tcp|udp)\//i,

  // --- Reading env tokens/secrets ---
  // env/printenv filtered for *TOKEN*/*SECRET*/*KEY*/*PASSWORD* on one segment.
  /\b(?:env|printenv)\b[^|;&\n]*\b\w*(?:TOKEN|SECRET|API_?KEY|PASSWORD|CREDENTIAL)\w*/i,
  // env/printenv piped into a filter searching for a secret keyword
  // (e.g. `printenv | grep TOKEN`, `env | grep -i secret`).
  /\b(?:env|printenv)\b[^|;&\n]*\|\s*(?:grep|rg|ag|awk|sed|fgrep|egrep)\b[^|;&\n]*(?:TOKEN|SECRET|API_?KEY|PASSWORD|CREDENTIAL)/i,
  // echo/printf of an env var that looks like a secret (e.g. echo $GITHUB_TOKEN).
  /\b(?:echo|printf)\b[^|;&\n]*\$\{?\w*(?:TOKEN|SECRET|API_?KEY|PASSWORD|CREDENTIAL)\w*/i,
];

// Wrapper/launcher commands that are TRANSPARENT: they execute another command,
// so we must strip them and re-scan the remaining command. Otherwise
// `env curl …` or `timeout 5 sh -c '…'` would slip past the leading-token-based
// reasoning some attackers rely on.
const WRAPPER_PREFIX =
  /^\s*(?:env(?:\s+\w+=\S*)*|exec|command|builtin|nice(?:\s+-n\s*-?\d+)?|nohup|setsid|stdbuf(?:\s+\S+)*|timeout\s+\S+|xargs(?:\s+\S+)*)\s+/i;

// Nested interpreter invocations: sh -c '…', bash -c "…", zsh -c …. We extract
// the quoted (or bare) body and scan it recursively so payloads hidden one level
// deep are still seen.
const NESTED_SHELL =
  /\b(?:ba|z|da|a|fi)?sh\b\s+(?:-[a-z]*c|--command)\b\s*(?:(['"])([\s\S]*?)\1|(\S[\s\S]*))$/i;

function matchesDangerousPattern(command: string): boolean {
  return DANGEROUS_COMMANDS.some((pattern) => pattern.test(command));
}

function isDangerousCommand(command: string, depth = 0): boolean {
  if (depth > 4) return false; // bound recursion on adversarial nesting
  const cmd = command.trim();
  if (!cmd) return false;

  if (matchesDangerousPattern(cmd)) return true;

  // Strip a transparent wrapper prefix and re-scan the inner command.
  const unwrapped = cmd.replace(WRAPPER_PREFIX, "");
  if (unwrapped !== cmd && isDangerousCommand(unwrapped, depth + 1)) {
    return true;
  }

  // Scan the body of a nested shell invocation (sh -c '<body>').
  const nested = NESTED_SHELL.exec(cmd);
  if (nested) {
    const body = nested[2] ?? nested[3];
    if (body && isDangerousCommand(body, depth + 1)) return true;
  }

  return false;
}

export { isDangerousCommand };

// ─── PreToolUse: Dangerous Command Blocking ────────────────────────────────

function createPreToolUseHook(agentId: string): HookCallback {
  return async (input) => {
    try {
      const toolName = String(input.tool_name ?? "");

      // Check both the Agent SDK "Bash" tool and the custom lowercase "bash"
      // tool (used on the pi-ai/OpenRouter path) for dangerous commands.
      if (toolName === "Bash" || toolName === "bash") {
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
      if (prompt && sessionId) {
        db`INSERT INTO user_prompt_log (agent_id, session_id, prompt, created_at)
           VALUES (${agentId}, ${sessionId}, ${prompt}, NOW())`.catch(
          (err: unknown) =>
            log.warn("User prompt log insert failed", { error: String(err) }),
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

  // Dangerous command blocking (default: ON — safe by default).
  // The hook callback itself matches both "Bash" and "bash", so a single
  // wildcard matcher covers the SDK Bash tool and the custom bash tool.
  if (hooksConfig?.dangerousCommandBlocking !== false) {
    hooks.PreToolUse = [
      { matcher: "*", hooks: [createPreToolUseHook(agentId)] },
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
