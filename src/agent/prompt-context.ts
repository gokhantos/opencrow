/**
 * Prompt building and context enrichment utilities for the Agent SDK.
 * Handles conversation history injection, cross-session memory, and user preferences.
 */
import { createLogger } from "../logger";
import { searchRelatedSessions } from "../memory/cross-session-memory";
import {
  getActivePreferences,
  formatPreferencesForPrompt,
} from "../memory/preference-extractor";
import type { ConversationMessage } from "./types";

const log = createLogger("prompt-context");

export const MAX_HISTORY_IN_PROMPT = 10;

/**
 * Extract the last message content from a messages array.
 */
export function lastUserMessage(
  messages: readonly ConversationMessage[],
): string {
  if (messages.length === 0) return "";
  return messages[messages.length - 1]!.content;
}

/**
 * Build a prompt that includes recent conversation history.
 *
 * The Agent SDK's session resume is supposed to maintain context, but sessions
 * break on errors, process restarts, or expiry. By including recent history
 * in the prompt, the model retains conversational context even when the session
 * is lost. When the session IS valid, the history is redundant but harmless.
 */
export function buildPromptWithHistory(
  messages: readonly ConversationMessage[],
): string {
  const lastMsg = lastUserMessage(messages);

  // Single message or empty — no history to include
  if (messages.length <= 1) return lastMsg;

  // Take recent history (excluding the last message)
  const historySlice = messages.slice(
    Math.max(0, messages.length - 1 - MAX_HISTORY_IN_PROMPT),
    messages.length - 1,
  );

  if (historySlice.length === 0) return lastMsg;

  const history = historySlice
    .map((m) => `[${m.role}]: ${m.content}`)
    .join("\n\n");

  return `<conversation_history>\n${history}\n</conversation_history>\n\n[user]: ${lastMsg}`;
}

export function extractTopicsFromMessage(message: string): string[] {
  const topics: string[] = [];
  const topicPatterns = [
    { pattern: /database|db|sql|query|table|schema/i, topic: "database" },
    { pattern: /api|endpoint|route|rest|graphql/i, topic: "api" },
    { pattern: /react|component|ui|frontend|css|style/i, topic: "frontend" },
    { pattern: /server|backend|node|express|hono/i, topic: "backend" },
    { pattern: /test|spec|jest|vitest|coverage/i, topic: "testing" },
    { pattern: /deploy|docker|kubernetes|ci|cd|pipeline/i, topic: "devops" },
    { pattern: /security|auth|owasp|xss|injection/i, topic: "security" },
    { pattern: /performance|optimize|slow|benchmark/i, topic: "performance" },
    { pattern: /refactor|migrate|upgrade|modernize/i, topic: "refactoring" },
    { pattern: /bug|fix|error|issue|debug/i, topic: "bugfix" },
    {
      pattern: /feature|create|build|implement/i,
      topic: "feature-development",
    },
  ];

  for (const { pattern, topic } of topicPatterns) {
    if (pattern.test(message)) {
      topics.push(topic);
    }
  }

  return topics;
}

export function lastUserMessageFromPrompt(prompt: string): string {
  const match = prompt.match(/\[user\]:\s*(.+)$/s);
  return match ? match[1]!.trim() : prompt;
}

/**
 * Inject cross-session memory and user preferences into the prompt.
 * Phase 5: Advanced Intelligence
 */
export async function enrichPromptWithContext(
  basePrompt: string,
  sessionId?: string,
): Promise<string> {
  let enrichedPrompt = basePrompt;

  // Add cross-session context if sessionId provided
  if (sessionId) {
    try {
      const lastMsg = lastUserMessageFromPrompt(basePrompt);
      const topics = extractTopicsFromMessage(lastMsg);
      const relatedMemories = await searchRelatedSessions(topics, 2);

      if (relatedMemories.length > 0) {
        enrichedPrompt += "\n\n<cross_session_context>\n";
        for (const memory of relatedMemories) {
          enrichedPrompt += `- Previous session (${memory.context.sessionId}): ${memory.context.summary}\n`;
          if (memory.matchedTopics.length > 0) {
            enrichedPrompt += `  Related topics: ${memory.matchedTopics.join(", ")}\n`;
          }
        }
        enrichedPrompt += "</cross_session_context>\n";
      }
    } catch (err) {
      log.debug("Cross-session memory lookup failed", { error: String(err) });
    }
  }

  // Add user preferences
  try {
    const preferences = await getActivePreferences();
    if (preferences.length > 0) {
      const formattedPrefs = formatPreferencesForPrompt(preferences);
      enrichedPrompt += `\n\n${formattedPrefs}`;
    }
  } catch (err) {
    log.debug("Failed to load user preferences", { error: String(err) });
  }

  return enrichedPrompt;
}
