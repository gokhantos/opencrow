import type {
  AgentOptions,
  ProgressEvent,
  ConversationMessage,
} from "../../agent/types";
import type { AgentRegistry } from "../../agents/registry";
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
import { getMessagesByChat } from "../../store/messages";
import {
  getSdkSessionId,
  saveSdkSessionId,
  clearSdkSession,
  clearAllSdkSessions,
} from "../../store/sdk-sessions";
import { createLogger } from "../../logger";

const log = createLogger("whatsapp:agent-handler");

export interface WhatsAppHandlerDeps {
  readonly channel: Channel;
  readonly agent: ResolvedAgent;
  readonly agentId: string;
  readonly allowedNumbers: readonly string[];
  readonly allowedGroups: readonly string[];
  readonly buildOptions: (
    agent: ResolvedAgent,
    onProgress?: (event: ProgressEvent) => void,
  ) => Promise<AgentOptions>;
  readonly agentRegistry: AgentRegistry;
  readonly observationHook?: ObservationHook;
}

export function createWhatsAppAgentHandler(deps: WhatsAppHandlerDeps): void {
  const {
    channel,
    agent,
    agentId,
    allowedNumbers,
    allowedGroups,
    buildOptions,
    agentRegistry,
    observationHook,
  } = deps;

  const sessionNamespace = `whatsapp:${agentId}`;
  const activeSessions = new Map<string, AbortController>();

  channel.onMessage(async (msg) => {
    const isGroup = msg.chatId.endsWith("@g.us");

    if (isGroup && allowedGroups.length > 0) {
      const groupBare = msg.chatId.split("@")[0] ?? "";
      const allowed = allowedGroups.some(
        (g) => g === msg.chatId || g === groupBare,
      );
      if (!allowed) {
        log.debug("WhatsApp group not in allowlist, ignoring", {
          chatId: msg.chatId,
        });
        return;
      }
    }

    if (!isGroup && allowedNumbers.length > 0) {
      const senderBare = msg.senderId.split("@")[0]?.split(":")[0] ?? "";
      const allowed = allowedNumbers.some(
        (num) => senderBare === num,
      );
      if (!allowed) {
        log.debug("WhatsApp DM from non-allowed number, ignoring", {
          senderId: msg.senderId,
        });
        return;
      }
    }

    // Block DMs when no allowedNumbers are configured (groups-only mode)
    if (!isGroup && allowedNumbers.length === 0) return;

    const text = msg.content.text ?? "";

    if (text === "/clear") {
      const active = activeSessions.get(msg.chatId);
      if (active) {
        active.abort();
        activeSessions.delete(msg.chatId);
        log.info("Aborted in-flight chat on /clear (WhatsApp)", {
          chatId: msg.chatId,
        });
      }
      await clearSession(sessionNamespace, msg.chatId);
      await clearAllSdkSessions(sessionNamespace, msg.chatId);
      await channel.sendMessage(msg.chatId, { text: "Session cleared." });
      return;
    }

    if (!text.trim()) return;

    let participantContext = "";
    if (msg.groupParticipants && msg.groupParticipants.length > 0) {
      const names = msg.groupParticipants
        .filter((p) => p.name)
        .map((p) => p.name)
        .join(", ");
      if (names) {
        participantContext = `[Group members: ${names}]\n`;
      }
    }

    const labeledText =
      participantContext +
      (msg.senderName ? `[${msg.senderName}]: ${text}` : text);

    await addUserMessage(
      sessionNamespace,
      msg.chatId,
      msg.senderId,
      labeledText,
      msg.senderName,
    );

    if (!msg.mentioned) {
      log.debug("WhatsApp message stored (not mentioned, skipping response)", {
        chatId: msg.chatId,
      });
      return;
    }

    const freshAgent = agentRegistry.getById(agentId) ?? agent;
    if (freshAgent.maxInputLength && text.length > freshAgent.maxInputLength) {
      await channel.sendMessage(msg.chatId, {
        text: `Message too long (${text.length} chars). Maximum is ${freshAgent.maxInputLength} characters.`,
      });
      return;
    }

    const abortController = new AbortController();
    activeSessions.set(msg.chatId, abortController);

    const freshAgentPreCheck = agentRegistry.getById(agentId) ?? agent;
    const isStateless = freshAgentPreCheck.stateless === true;
    const historyLimit = freshAgentPreCheck.maxHistoryMessages;
    const keepAssistant = freshAgentPreCheck.keepAssistantMessages;

    const MAX_WA_CONTEXT = 20;
    let history: readonly ConversationMessage[];
    if (isStateless) {
      const recentMsgs = await getMessagesByChat(
        sessionNamespace,
        msg.chatId,
        MAX_WA_CONTEXT,
      );
      const contextLines = recentMsgs.map((m) => m.content);
      history = [
        {
          role: "user" as const,
          content: contextLines.join("\n"),
          timestamp: Date.now(),
        },
      ];
    } else {
      history = await getSessionHistory(sessionNamespace, msg.chatId);
    }

    // If agent has a custom history limit, trim to that size
    if (historyLimit && history.length > historyLimit) {
      history = history.slice(-historyLimit);
    }

    // If keepAssistantMessages is set, drop older assistant messages to save tokens.
    // This is useful for group bots whose own replies are verbose — only keep the
    // N most recent assistant turns so the model still has continuity.
    if (keepAssistant !== undefined) {
      const assistantIndices: number[] = [];
      for (let i = 0; i < history.length; i++) {
        if (history[i]!.role === "assistant") assistantIndices.push(i);
      }
      if (assistantIndices.length > keepAssistant) {
        const dropSet = new Set(
          assistantIndices.slice(0, assistantIndices.length - keepAssistant),
        );
        history = history.filter((_, i) => !dropSet.has(i));
      }
    }

    await channel.sendTyping?.(msg.chatId);

    const tracker = createActivityLog(channel, msg.chatId);

    const agentForOpts = agentRegistry.getById(agentId) ?? agent;
    const baseAgentOpts = await buildOptions(agentForOpts, tracker.onProgress);

    const isAgentSdk = (baseAgentOpts.provider ?? "agent-sdk") === "agent-sdk";
    const existingSdkSession = isAgentSdk
      ? await getSdkSessionId(sessionNamespace, msg.chatId, agentId)
      : null;

    const agentOpts = isAgentSdk
      ? {
          ...baseAgentOpts,
          sdkSessionId: existingSdkSession ?? undefined,
          onSdkSessionId: (sid: string) => {
            saveSdkSessionId(sessionNamespace, msg.chatId, agentId, sid).catch(
              (err) => log.error("Failed to save SDK session", { error: err }),
            );
          },
        }
      : baseAgentOpts;

    try {
      const response = await chat(history, agentOpts);
      await tracker.finalize();

      if (abortController.signal.aborted) {
        log.info("Chat response discarded (session cleared, WhatsApp)", {
          chatId: msg.chatId,
        });
        return;
      }
      activeSessions.delete(msg.chatId);

      const replyText =
        response.text.trim() ||
        (response.toolUseCount
          ? `Done (${response.toolUseCount} tool calls, no summary returned).`
          : "...");

      await addAssistantMessage(sessionNamespace, msg.chatId, replyText);

      const chunks = chunkMessage(replyText);
      for (const chunk of chunks) {
        await channel.sendMessage(msg.chatId, { text: chunk });
      }

      observationHook?.afterConversation({
        agentId,
        channel: "whatsapp",
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

      log.info("WhatsApp agent response sent", {
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

      log.error("WhatsApp agent error", { agentId, error });

      const detail = error instanceof Error ? error.message : String(error);
      const errMsg = detail.includes("API error")
        ? `Error: ${detail}`
        : "Sorry, I encountered an error processing your message.";

      await addAssistantMessage(sessionNamespace, msg.chatId, errMsg);
      await channel.sendMessage(msg.chatId, { text: errMsg });
    }
  });
}
