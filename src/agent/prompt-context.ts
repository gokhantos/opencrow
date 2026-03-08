/**
 * Prompt building and context enrichment utilities for the Agent SDK.
 * Handles conversation history injection and user preferences.
 */
import { createLogger } from "../logger";
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

/**
 * Inject user preferences into the prompt.
 */
export async function enrichPromptWithContext(
  basePrompt: string,
  _sessionId?: string,
): Promise<string> {
  let enrichedPrompt = basePrompt;

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
