import { createLogger } from "../logger";
import { getMessagesByChat } from "../store/messages";
import { chat } from "./chat";
import {
  addUserMessage,
  addAssistantMessage,
} from "./session";

const log = createLogger("agent:handoff");

const HANDOFF_MODEL = "claude-sonnet-4-20250514";
const MAX_HISTORY_MESSAGES = 30;

const SUMMARIZER_PROMPT = `You are summarizing a conversation for an agent handoff. The user is switching from one AI agent to another mid-conversation. Produce a concise structured summary so the new agent can pick up seamlessly.

Format:
**Topic**: What was being discussed
**Current task**: What the user is trying to accomplish right now
**Progress**: What has been done so far
**Key decisions**: Any decisions or preferences expressed
**Open questions**: Anything unresolved or pending

Keep it under 200 words. Be specific and actionable.`;

/**
 * Generate a handoff summary from recent conversation history and inject it
 * as messages so the new agent naturally picks it up via getSessionHistory.
 */
export async function generateHandoff(
  channel: string,
  chatId: string,
  fromAgentId: string,
  toAgentId: string,
): Promise<void> {
  const messages = await getMessagesByChat(channel, chatId, MAX_HISTORY_MESSAGES);

  if (messages.length < 2) {
    log.debug("Too few messages for handoff", { channel, chatId });
    return;
  }

  const transcript = messages
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
    .join("\n\n");

  try {
    const response = await chat(
      [{ role: "user", content: transcript, timestamp: Math.floor(Date.now() / 1000) }],
      {
        systemPrompt: SUMMARIZER_PROMPT,
        model: HANDOFF_MODEL,
        provider: "agent-sdk",
        toolsEnabled: false,
        agentId: "handoff-summarizer",
        maxOutputTokens: 512,
        usageContext: {
          channel,
          chatId,
          source: "subagent" as const,
        },
      },
    );

    const summary = response.text.trim();
    if (!summary) {
      log.warn("Handoff summary was empty", { channel, chatId });
      return;
    }

    await addUserMessage(
      channel,
      chatId,
      "system",
      `[Handoff from ${fromAgentId} → ${toAgentId}]\n\n${summary}`,
    );
    await addAssistantMessage(
      channel,
      chatId,
      "Understood. I have context from the previous agent and I'm ready to continue.",
    );

    log.info("Handoff summary injected", {
      channel,
      chatId,
      from: fromAgentId,
      to: toAgentId,
      summaryLength: summary.length,
    });
  } catch (err) {
    log.error("Failed to generate handoff summary", {
      channel,
      chatId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
