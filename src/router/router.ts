import type { IncomingMessage, Channel } from "../channels/types";
import type { ChannelRegistry } from "../channels/registry";
import type { OpenCrowConfig } from "../config/schema";
import { chat } from "../agent/chat";
import { chunkMessage } from "../agent/chunk";
import {
  getSessionHistory,
  addUserMessage,
  addAssistantMessage,
  clearSession,
} from "../agent/session";
import type { AgentOptions, ProgressEvent } from "../agent/types";
import type { AgentRegistry } from "../agents/registry";
import type { ResolvedAgent } from "../agents/types";
import type { MemoryManager } from "../memory/types";
import type { ObservationHook } from "../memory/observation-hook";
import { createActivityLog } from "./activity-log";
import {
  getSdkSessionId,
  saveSdkSessionId,
  clearSdkSession,
  clearAllSdkSessions,
} from "../store/sdk-sessions";
import { resolveAgentForMessage } from "../store/routing-rules";
import { generateHandoff } from "../agent/handoff";
import { createLogger } from "../logger";

const log = createLogger("router");

interface RouterConfig {
  readonly getDefaultAgentOptions: (
    onProgress?: (event: ProgressEvent) => void,
  ) => Promise<AgentOptions>;
  readonly channels: ReadonlyMap<string, Channel>;
  readonly channelRegistry: ChannelRegistry;
  readonly config: OpenCrowConfig;
  readonly agentRegistry: AgentRegistry;
  readonly buildAgentOptions: (
    agent: ResolvedAgent,
    onProgress?: (event: ProgressEvent) => void,
  ) => Promise<AgentOptions>;
  readonly memoryManager?: MemoryManager;
  readonly observationHook?: ObservationHook;
}

function isAuthorized(
  message: IncomingMessage,
  channelRegistry: ChannelRegistry,
  config: OpenCrowConfig,
): boolean {
  const plugin = channelRegistry.get(message.channel);
  if (!plugin) return true;

  const allowed = plugin.config.getAllowedSenders(config);
  if (allowed.length === 0) return true;

  return (allowed as readonly (string | number)[]).includes(
    typeof allowed[0] === "number"
      ? Number(message.senderId)
      : message.senderId,
  );
}

function chatKey(channel: string, chatId: string): string {
  return `${channel}:${chatId}`;
}

export { createProgressTracker } from "./activity-log";

export function createRouter(routerConfig: RouterConfig) {
  const activeAgents = new Map<string, string>();
  /** Tracks in-flight chat() calls so /clear can cancel them. */
  const activeChatSessions = new Map<string, AbortController>();

  async function getAgentOptions(
    channel: string,
    chatId: string,
    senderId: string,
    onProgress?: (event: ProgressEvent) => void,
  ): Promise<AgentOptions> {
    // 1. Explicit /agent selection (highest priority)
    const key = chatKey(channel, chatId);
    const explicitId = activeAgents.get(key);
    if (explicitId) {
      const agent = routerConfig.agentRegistry.getById(explicitId);
      if (agent) return routerConfig.buildAgentOptions(agent, onProgress);
    }

    // 2. Persistent routing rules from DB
    try {
      const ruleAgentId = await resolveAgentForMessage(
        channel,
        chatId,
        senderId,
      );
      if (ruleAgentId) {
        const agent = routerConfig.agentRegistry.getById(ruleAgentId);
        if (agent) return routerConfig.buildAgentOptions(agent, onProgress);
      }
    } catch (err) {
      log.error("Failed to check routing rules", { error: err });
    }

    // 3. Default agent
    return routerConfig.getDefaultAgentOptions(onProgress);
  }

  async function handleMessage(message: IncomingMessage): Promise<void> {
    const { channel: channelName, chatId, senderId, content } = message;
    const text = content.text ?? "";

    if (
      !isAuthorized(message, routerConfig.channelRegistry, routerConfig.config)
    ) {
      log.warn("Unauthorized message rejected", {
        channel: channelName,
        senderId,
      });
      return;
    }

    log.info("Message received", { channel: channelName, chatId, senderId });

    if (text === "/stop" || text.startsWith("/stop@")) {
      const key = chatKey(channelName, chatId);
      const active = activeChatSessions.get(key);
      if (active) {
        active.abort();
        activeChatSessions.delete(key);
        log.info("Stopped in-flight chat on /stop", {
          channel: channelName,
          chatId,
        });
        await sendReply(channelName, chatId, "Stopped.");
      } else {
        await sendReply(channelName, chatId, "Nothing running.");
      }
      return;
    }

    if (text === "/clear") {
      const key = chatKey(channelName, chatId);
      // Abort any in-flight chat() for this session
      const active = activeChatSessions.get(key);
      if (active) {
        active.abort();
        activeChatSessions.delete(key);
        log.info("Aborted in-flight chat on /clear", {
          channel: channelName,
          chatId,
        });
      }
      await clearSession(channelName, chatId);
      await clearAllSdkSessions(channelName, chatId);
      activeAgents.delete(key);

      // Cancel any pending queued tasks for this session
      import("../agent/queue-manager")
        .then(({ cancelSessionTasks }) => cancelSessionTasks(key))
        .catch((err: unknown) =>
          log.warn("Failed to cancel queued tasks on /clear", {
            error: String(err),
          }),
        );
      await sendReply(channelName, chatId, "Session cleared. Starting fresh.");
      return;
    }

    if (text === "/status") {
      const status = buildStatusMessage(routerConfig.channels);
      await sendReply(channelName, chatId, status);
      return;
    }

    if (text.startsWith("/agent")) {
      await handleAgentCommand(channelName, chatId, text);
      return;
    }

    if (!text.trim()) {
      log.debug("Empty message, skipping", { channel: channelName, chatId });
      return;
    }

    // Reject new messages while a chat is already in-flight for this chatId
    const sessionKey = chatKey(channelName, chatId);
    if (activeChatSessions.has(sessionKey)) {
      await sendReply(
        channelName,
        chatId,
        "Still working on your previous message. Use /stop to cancel it first.",
      );
      return;
    }

    // Enforce per-agent input length limit
    const activeAgentId = activeAgents.get(chatKey(channelName, chatId));
    const resolvedAgent = activeAgentId
      ? routerConfig.agentRegistry.getById(activeAgentId)
      : routerConfig.agentRegistry.getDefault();
    if (
      resolvedAgent?.maxInputLength &&
      text.length > resolvedAgent.maxInputLength
    ) {
      await sendReply(
        channelName,
        chatId,
        `Message too long (${text.length} chars). Maximum is ${resolvedAgent.maxInputLength} characters.`,
      );
      return;
    }

    const abortController = new AbortController();
    activeChatSessions.set(sessionKey, abortController);

    await addUserMessage(
      channelName,
      chatId,
      senderId,
      text,
      message.senderName,
    );
    const history = await getSessionHistory(channelName, chatId);

    const channel = routerConfig.channels.get(channelName);
    const tracker = channel ? createActivityLog(channel, chatId) : null;

    await tracker?.start();

    const baseAgentOpts = await getAgentOptions(
      channelName,
      chatId,
      senderId,
      tracker?.onProgress,
    );

    // For agent-sdk providers, look up existing SDK session for resume
    const agentId = baseAgentOpts.agentId ?? "default";
    const isAgentSdk = (baseAgentOpts.provider ?? "agent-sdk") === "agent-sdk";
    const existingSdkSession = isAgentSdk
      ? await getSdkSessionId(channelName, chatId, agentId)
      : null;

    const agentOpts: AgentOptions = {
      ...baseAgentOpts,
      abortSignal: abortController.signal,
      usageContext: {
        channel: channelName,
        chatId,
        source: "message" as const,
      },
      ...(isAgentSdk
        ? {
            sdkSessionId: existingSdkSession ?? undefined,
            onSdkSessionId: (sid: string) => {
              saveSdkSessionId(channelName, chatId, agentId, sid).catch((err) =>
                log.error("Failed to save SDK session", { error: err }),
              );
            },
          }
        : {}),
    };

    const stopTyping = startTyping(channelName, chatId);

    try {
      const response = await chat(history, agentOpts);
      stopTyping();
      await tracker?.finalize();

      // If /clear was called while we were processing, discard the response
      if (abortController.signal.aborted) {
        log.info("Chat response discarded (session was cleared)", {
          channel: channelName,
          chatId,
        });
        return;
      }
      activeChatSessions.delete(sessionKey);

      await addAssistantMessage(channelName, chatId, response.text);

      // Fire-and-forget observation extraction
      routerConfig.observationHook?.afterConversation({
        agentId: agentOpts.agentId ?? "default",
        channel: channelName,
        chatId,
        messages: [
          ...history,
          {
            role: "assistant" as const,
            content: response.text,
            timestamp: Date.now(),
          },
        ],
      });

      const replyText =
        response.text.trim() ||
        (response.toolUseCount
          ? `Done (${response.toolUseCount} tool calls, no summary returned).`
          : "Done (no response returned).");
      const chunks = chunkMessage(replyText);
      for (const chunk of chunks) {
        await sendReply(channelName, chatId, chunk);
      }

      log.info("Response sent", {
        channel: channelName,
        chatId,
        provider: response.provider,
        agentId: agentOpts.agentId,
        inputTokens: response.usage?.inputTokens,
        outputTokens: response.usage?.outputTokens,
      });
    } catch (error) {
      stopTyping();
      await tracker?.finalize({ error: true });

      // If session was cleared, silently discard the error too
      if (abortController.signal.aborted) {
        log.info("Chat error discarded (session was cleared)", {
          channel: channelName,
          chatId,
        });
        activeChatSessions.delete(sessionKey);
        return;
      }
      activeChatSessions.delete(sessionKey);

      // Clear the SDK session so the next message starts fresh instead of
      // resuming a potentially corrupted session (e.g. after Claude downtime).
      if (isAgentSdk && existingSdkSession) {
        clearSdkSession(channelName, chatId, agentId).catch((err) =>
          log.error("Failed to clear SDK session after error", { error: err }),
        );
      }

      log.error("Failed to get response", { error });

      // Extract a useful error detail if available
      const detail = error instanceof Error ? error.message : String(error);
      const userMsg = detail.includes("API error")
        ? `Error: ${detail}`
        : "Sorry, I encountered an error processing your message. Please try again.";

      // Save a placeholder assistant message to keep history alternating
      // (user/assistant). Without this, consecutive user messages break the API.
      await addAssistantMessage(channelName, chatId, userMsg);
      await sendReply(channelName, chatId, userMsg);
    }
  }

  async function handleAgentCommand(
    channelName: string,
    chatId: string,
    text: string,
  ): Promise<void> {
    const parts = text.trim().split(/\s+/);
    const agentId = parts[1];

    if (!agentId) {
      const key = chatKey(channelName, chatId);
      const currentId =
        activeAgents.get(key) ?? routerConfig.agentRegistry.getDefault().id;
      const ids = routerConfig.agentRegistry.listIds();
      const lines = [
        `Current agent: *${currentId}*`,
        "",
        "Available agents:",
        ...ids.map((id) => `  - ${id}${id === currentId ? " (active)" : ""}`),
        "",
        "Usage: /agent <id>",
      ];
      await sendReply(channelName, chatId, lines.join("\n"));
      return;
    }

    const agent = routerConfig.agentRegistry.getById(agentId);
    if (!agent) {
      await sendReply(channelName, chatId, `Agent not found: ${agentId}`);
      return;
    }

    const key2 = chatKey(channelName, chatId);
    const prevAgentId =
      activeAgents.get(key2) ?? routerConfig.agentRegistry.getDefault().id;
    activeAgents.set(key2, agentId);
    await sendReply(
      channelName,
      chatId,
      `Switched to agent: ${agent.name} (${agent.id})`,
    );

    // Generate handoff summary in the background — non-blocking
    if (prevAgentId !== agentId) {
      generateHandoff(channelName, chatId, prevAgentId, agentId).catch(
        (err) =>
          log.error("Handoff generation failed", {
            error: err instanceof Error ? err.message : String(err),
          }),
      );
    }
  }

  function startTyping(channelName: string, chatId: string): () => void {
    const channel = routerConfig.channels.get(channelName);
    if (!channel?.sendTyping) return () => {};

    let stopped = false;
    const tick = async () => {
      while (!stopped) {
        await channel.sendTyping!(chatId);
        await new Promise((r) => setTimeout(r, 4000));
      }
    };
    tick();
    return () => {
      stopped = true;
    };
  }

  async function sendReply(
    channelName: string,
    chatId: string,
    text: string,
  ): Promise<void> {
    const channel = routerConfig.channels.get(channelName);
    if (!channel) {
      log.error("Channel not found for reply", { channelName });
      return;
    }

    try {
      await channel.sendMessage(chatId, { text });
    } catch (error) {
      log.error("Failed to send reply", { channelName, chatId, error });
    }
  }

  return { handleMessage };
}

function buildStatusMessage(channels: ReadonlyMap<string, Channel>): string {
  const lines = ["*OpenCrow Status*", ""];

  for (const [name, channel] of channels) {
    const status = channel.isConnected() ? "Connected" : "Disconnected";
    lines.push(`${name}: ${status}`);
  }

  return lines.join("\n");
}
