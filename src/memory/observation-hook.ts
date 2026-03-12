import type { MemoryManager, ObservationForIndex } from "./types";
import { extractObservations } from "./observation-extractor";
import { saveObservations } from "../store/observations";
import { createLogger } from "../logger";

const log = createLogger("observation-hook");

interface ConversationTurn {
  readonly role: "user" | "assistant";
  readonly content: string;
}

interface ObservationHookConfig {
  readonly memoryManager: MemoryManager | null;
  readonly model?: string;
  readonly minMessages?: number;
  readonly maxPerConversation?: number;
  readonly debounceSec?: number;
}

export interface ObservationHook {
  afterConversation(params: {
    readonly agentId: string;
    readonly channel: string;
    readonly chatId: string;
    readonly messages: readonly ConversationTurn[];
    readonly toolsUsed?: readonly string[];
  }): void;
}

export function createObservationHook(
  config: ObservationHookConfig,
): ObservationHook {
  const minMessages = config.minMessages ?? 4;
  const maxPerConversation = config.maxPerConversation ?? 3;
  const debounceSec = config.debounceSec ?? 300;

  // Track last extraction time per chat to debounce
  const lastExtraction = new Map<string, number>();

  return {
    afterConversation(params) {
      const { agentId, channel, chatId, messages, toolsUsed } = params;

      // Skip short conversations
      if (messages.length < minMessages) {
        log.debug("Skipping observation extraction (too few messages)", {
          agentId,
          messageCount: messages.length,
          minMessages,
        });
        return;
      }

      // Evict stale entries to prevent the map from growing unboundedly.
      const TTL_SEC = debounceSec * 2;
      const now = Math.floor(Date.now() / 1000);
      for (const [k, t] of lastExtraction) {
        if (now - t > TTL_SEC) {
          lastExtraction.delete(k);
        }
      }

      // Debounce: skip if we extracted recently for this chat
      const chatKey = `${channel}:${chatId}`;
      const lastTime = lastExtraction.get(chatKey) ?? 0;
      if (now - lastTime < debounceSec) {
        log.debug("Skipping observation extraction (debounced)", {
          agentId,
          chatKey,
          secondsSinceLast: now - lastTime,
        });
        return;
      }

      lastExtraction.set(chatKey, now);

      // Fire-and-forget async extraction
      processObservations({
        agentId,
        channel,
        chatId,
        messages,
        toolsUsed,
        maxPerConversation,
        memoryManager: config.memoryManager,
        model: config.model,
      }).catch((error) => {
        log.error("Observation processing failed (silent)", {
          agentId,
          chatKey,
          error,
        });
      });
    },
  };
}

async function processObservations(params: {
  readonly agentId: string;
  readonly channel: string;
  readonly chatId: string;
  readonly messages: readonly ConversationTurn[];
  readonly toolsUsed?: readonly string[];
  readonly maxPerConversation: number;
  readonly memoryManager: MemoryManager | null;
  readonly model?: string;
}): Promise<void> {
  const {
    agentId,
    channel,
    chatId,
    messages,
    toolsUsed,
    maxPerConversation,
    memoryManager,
    model,
  } = params;

  // Extract observations using Agent SDK
  const observations = await extractObservations({
    agentId,
    channel,
    chatId,
    messages,
    toolsUsed,
    model,
    maxObservations: maxPerConversation,
  });

  if (observations.length === 0) {
    log.debug("No observations extracted", { agentId, channel, chatId });
    return;
  }

  // Save to conversation_observations table
  await saveObservations(observations);

  // Index into Qdrant for semantic search
  if (memoryManager) {
    const forIndex: readonly ObservationForIndex[] = observations.map((o) => ({
      id: o.id,
      observationType: o.observationType,
      title: o.title,
      summary: o.summary,
      facts: o.facts,
      concepts: o.concepts,
    }));

    await memoryManager.indexObservations(agentId, forIndex, {
      channel,
      chatId,
    });
  }

  log.info("Observations processed and indexed", {
    agentId,
    channel,
    chatId,
    count: observations.length,
  });
}
