import type { ConversationMessage } from "./types";
import {
  getMessagesByChat,
  saveMessage,
} from "../store/messages";
import { getOrCreateSession } from "../store/sessions";
import { getLatestSummary } from "../store/summaries";
import { getDb } from "../store/db";
import { createLogger } from "../logger";

const log = createLogger("session");

const MAX_HISTORY_MESSAGES = 100;
const SESSION_STALE_SECONDS = 7 * 24 * 3600; // 7 days

export async function getSessionHistory(
  channel: string,
  chatId: string,
  limit = MAX_HISTORY_MESSAGES,
): Promise<readonly ConversationMessage[]> {
  await getOrCreateSession(channel, chatId);

  const stored = await getMessagesByChat(channel, chatId, limit);

  // If the most recent message is older than 7 days, start fresh
  if (stored.length > 0) {
    const lastMessageAt = stored[stored.length - 1]!.timestamp;
    const now = Math.floor(Date.now() / 1000);
    const age = now - lastMessageAt;
    if (age > SESSION_STALE_SECONDS) {
      log.info("Clearing stale session", {
        channel,
        chatId,
        ageDays: Math.floor(age / 86400),
        messageCount: stored.length,
      });
      await clearSession(channel, chatId);
      return [];
    }
  }

  const history: ConversationMessage[] = stored.map((msg) => ({
    role: msg.role,
    content: msg.content,
    timestamp: msg.timestamp,
  }));

  const summary = await getLatestSummary(channel, chatId);
  if (summary) {
    log.debug("Prepending conversation summary", { channel, chatId });
    return [
      {
        role: "user" as const,
        content: `[Previous conversation summary]\n${summary.summary}`,
        timestamp: summary.createdAt,
      },
      {
        role: "assistant" as const,
        content:
          "I understand. I have the context from our previous conversation.",
        timestamp: summary.createdAt + 1,
      },
      ...history,
    ];
  }

  return history;
}

export async function addUserMessage(
  channel: string,
  chatId: string,
  senderId: string,
  text: string,
  senderName?: string,
): Promise<ConversationMessage> {
  const timestamp = Math.floor(Date.now() / 1000);
  const id = crypto.randomUUID();

  await saveMessage({
    id,
    channel,
    chatId,
    senderId,
    senderName,
    role: "user",
    content: text,
    timestamp,
  });

  log.debug("User message saved", { channel, chatId, senderId });

  return { role: "user", content: text, timestamp };
}

export async function addAssistantMessage(
  channel: string,
  chatId: string,
  text: string,
): Promise<ConversationMessage> {
  const timestamp = Math.floor(Date.now() / 1000);
  const id = crypto.randomUUID();

  await saveMessage({
    id,
    channel,
    chatId,
    senderId: "opencrow",
    role: "assistant",
    content: text,
    timestamp,
  });

  log.debug("Assistant message saved", { channel, chatId });

  return { role: "assistant", content: text, timestamp };
}

export async function clearSession(
  channel: string,
  chatId: string,
): Promise<void> {
  const db = getDb();
  await db.begin(async (tx) => {
    await tx`DELETE FROM messages WHERE channel = ${channel} AND chat_id = ${chatId}`;
    await tx`DELETE FROM conversation_summaries WHERE channel = ${channel} AND chat_id = ${chatId}`;
  });
  log.info("Session cleared", { channel, chatId });
}
