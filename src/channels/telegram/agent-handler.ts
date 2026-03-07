import type { AgentOptions, ProgressEvent } from "../../agent/types";
import type { AgentRegistry } from "../../agents/registry";
import type { MemoryManager } from "../../memory/types";
import type { ObservationHook } from "../../memory/observation-hook";
import type { ResolvedAgent } from "../../agents/types";
import type { Channel } from "../types";
import { createActivityLog } from "../../router/activity-log";
import { chat } from "../../agent/chat";
import { chunkMessage } from "../../agent/chunk";
import {
  getSessionHistory,
  addUserMessage,
  addAssistantMessage,
  clearSession,
} from "../../agent/session";
import {
  getSdkSessionId,
  saveSdkSessionId,
  clearSdkSession,
  clearAllSdkSessions,
} from "../../store/sdk-sessions";
import { getQuestionBus } from "../../agent/question-bus";
import { createLogger } from "../../logger";

const log = createLogger("telegram:agent-handler");

export interface AgentBotHandlerDeps {
  readonly agent: ResolvedAgent;
  readonly channel: Channel;
  readonly allowedUserIds: readonly number[];
  readonly buildOptions: (
    agent: ResolvedAgent,
    onProgress?: (event: ProgressEvent) => void,
  ) => Promise<AgentOptions>;
  readonly agentRegistry?: AgentRegistry;
  readonly memoryManager?: MemoryManager;
  readonly observationHook?: ObservationHook;
}

export function createAgentBotHandler(deps: AgentBotHandlerDeps): void {
  const {
    agent,
    channel,
    allowedUserIds,
    buildOptions,
    agentRegistry,
    observationHook,
  } = deps;

  const agentId = agent.id;
  const sessionNamespace = `telegram:${agentId}`;
  const activeSessions = new Map<string, AbortController>();

  channel.onMessage(async (msg) => {
    if (
      allowedUserIds.length > 0 &&
      !allowedUserIds.includes(Number(msg.senderId))
    ) {
      log.warn("Unauthorized message on agent Telegram bot", {
        agentId,
        senderId: msg.senderId,
      });
      return;
    }

    const text = msg.content.text ?? "";

    if (text === "/stop" || text.startsWith("/stop@")) {
      const active = activeSessions.get(msg.chatId);
      if (active) {
        getQuestionBus().cancel(msg.chatId);
        active.abort();
        activeSessions.delete(msg.chatId);
        log.info("Stopped in-flight chat on /stop (agent bot)", {
          agentId,
          chatId: msg.chatId,
        });
        await channel.sendMessage(msg.chatId, { text: "Stopped." });
      } else {
        await channel.sendMessage(msg.chatId, { text: "Nothing running." });
      }
      return;
    }

    if (text === "/clear") {
      const active = activeSessions.get(msg.chatId);
      if (active) {
        getQuestionBus().cancel(msg.chatId);
        active.abort();
        activeSessions.delete(msg.chatId);
        log.info("Aborted in-flight chat on /clear (agent bot)", {
          agentId,
          chatId: msg.chatId,
        });
      }
      await clearSession(sessionNamespace, msg.chatId);
      await clearAllSdkSessions(sessionNamespace, msg.chatId);
      await channel.sendMessage(msg.chatId, { text: "Session cleared." });
      return;
    }

    if (!text.trim()) return;

    if (activeSessions.has(msg.chatId)) {
      // If there's a pending question, route the reply as the answer
      const bus = getQuestionBus();
      if (bus.hasPending(msg.chatId)) {
        bus.answer(msg.chatId, text);
        log.info("Routed user message as question answer", {
          agentId,
          chatId: msg.chatId,
        });
        return;
      }

      await channel.sendMessage(msg.chatId, {
        text: "Still working on your previous message. Use /stop to cancel it first.",
      });
      return;
    }

    // Claim the session slot synchronously before any async work
    // to prevent concurrent messages from both passing the has() check
    const abortController = new AbortController();
    activeSessions.set(msg.chatId, abortController);

    const freshDef = agentRegistry?.getById(agentId) ?? agent;
    if (freshDef.maxInputLength && text.length > freshDef.maxInputLength) {
      activeSessions.delete(msg.chatId);
      await channel.sendMessage(msg.chatId, {
        text: `Message too long (${text.length} chars). Maximum is ${freshDef.maxInputLength} characters.`,
      });
      return;
    }

    await addUserMessage(
      sessionNamespace,
      msg.chatId,
      msg.senderId,
      text,
      msg.senderName,
    );
    const history = await getSessionHistory(sessionNamespace, msg.chatId);

    const tracker = createActivityLog(channel, msg.chatId);
    await tracker.start();

    const freshAgent = agentRegistry?.getById(agentId) ?? agent;
    let baseAgentOpts = await buildOptions(freshAgent, tracker.onProgress);

    // Inject ask_user tool so the agent can ask questions mid-execution
    if (baseAgentOpts.toolRegistry) {
      const { createAskUserTool } = await import("../../tools/ask-user");
      const askUserTool = createAskUserTool({
        chatId: msg.chatId,
        sendMessage: async (content) => {
          await channel.sendMessage(msg.chatId, content);
        },
      });
      baseAgentOpts = {
        ...baseAgentOpts,
        toolRegistry: baseAgentOpts.toolRegistry.withTools([askUserTool]),
      };
    }

    const isAgentSdk = (baseAgentOpts.provider ?? "agent-sdk") === "agent-sdk";
    const existingSdkSession = isAgentSdk
      ? await getSdkSessionId(sessionNamespace, msg.chatId, agentId)
      : null;

    const agentOpts = {
      ...baseAgentOpts,
      abortSignal: abortController.signal,
      ...(isAgentSdk
        ? {
            sdkSessionId: existingSdkSession ?? undefined,
            onSdkSessionId: (sid: string) => {
              saveSdkSessionId(
                sessionNamespace,
                msg.chatId,
                agentId,
                sid,
              ).catch((err) =>
                log.error("Failed to save SDK session", { error: err }),
              );
            },
          }
        : {}),
    };

    try {
      const response = await chat(history, agentOpts);
      await tracker.finalize();

      if (abortController.signal.aborted) {
        log.info("Chat response discarded (session cleared)", {
          agentId,
          chatId: msg.chatId,
        });
        return;
      }
      activeSessions.delete(msg.chatId);

      const replyText =
        response.text.trim() ||
        (response.toolUseCount
          ? `Done (${response.toolUseCount} tool calls, no summary returned).`
          : "Done (no response returned).");

      await addAssistantMessage(sessionNamespace, msg.chatId, replyText);

      const chunks = chunkMessage(replyText);
      for (const chunk of chunks) {
        await channel.sendMessage(msg.chatId, { text: chunk });
      }

      observationHook?.afterConversation({
        agentId,
        channel: `telegram:${agentId}`,
        chatId: msg.chatId,
        messages: [
          ...history,
          {
            role: "assistant" as const,
            content: response.text,
            timestamp: Date.now(),
          },
        ],
      });

      log.info("Agent bot response sent", {
        agentId,
        chatId: msg.chatId,
        inputTokens: response.usage?.inputTokens,
        outputTokens: response.usage?.outputTokens,
      });
    } catch (error) {
      await tracker.finalize({ error: true });

      if (abortController.signal.aborted) {
        activeSessions.delete(msg.chatId);
        return;
      }
      activeSessions.delete(msg.chatId);

      // Clear the SDK session so the next message starts fresh instead of
      // resuming a potentially corrupted session (e.g. after Claude downtime).
      if (isAgentSdk && existingSdkSession) {
        clearSdkSession(sessionNamespace, msg.chatId, agentId).catch((err) =>
          log.error("Failed to clear SDK session after error", { error: err }),
        );
      }

      log.error("Agent bot error", { agentId, error });

      const detail = error instanceof Error ? error.message : String(error);
      const errMsg = detail.includes("API error")
        ? `Error: ${detail}`
        : "Sorry, I encountered an error processing your message.";

      await addAssistantMessage(sessionNamespace, msg.chatId, errMsg);
      await channel.sendMessage(msg.chatId, { text: errMsg });
    }
  });
}
