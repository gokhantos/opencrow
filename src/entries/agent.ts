/**
 * Unified agent entry point — each agent owns its channels.
 *
 * Env:
 *   OPENCROW_AGENT_ID  — required (e.g. "opencrow", "ai-idea-gen")
 *
 * Each agent owns its own connections (Telegram bot, WhatsApp device).
 * No fallbacks — no token means no channel.
 *
 * Usage:
 *   OPENCROW_AGENT_ID=opencrow bun src/entries/agent.ts
 *   OPENCROW_AGENT_ID=ai-idea-gen bun src/entries/agent.ts
 */
import { loadConfig, loadConfigWithOverrides } from "../config/loader";
import { bootstrap } from "../process/bootstrap";
import { createProcessSupervisor } from "../process/supervisor";
import { createDeliveryPoller } from "../cron/delivery-poller";
import { createDeliveryStore } from "../cron/delivery-store";
import { createTelegramChannel } from "../channels/telegram/client";
import { createAgentBotHandler } from "../channels/telegram/agent-handler";
import { createWhatsAppChannel } from "../channels/whatsapp/client";
import { createWhatsAppAgentHandler } from "../channels/whatsapp/agent-handler";
import { createRouter } from "../router/router";
import { createChannelRegistry } from "../channels/registry";
import { registerDefaultPlugins } from "../channels/default-plugins";
import { createChannelManager } from "../channels/manager";
import { createLogger } from "../logger";
import type { ProcessName } from "../process/types";

const log = createLogger("agent-entry");

const agentId = process.env.OPENCROW_AGENT_ID;
if (!agentId) {
  log.error("OPENCROW_AGENT_ID env var is required");
  process.exit(1);
}

async function main(): Promise<void> {
  const baseConfig = loadConfig();
  const processName: ProcessName = `agent:${agentId}`;

  const ctx = await bootstrap({
    config: baseConfig,
    processName,
    dbPoolSize: 5,
  });

  // Reload with DB overrides now that DB is initialized
  const config = await loadConfigWithOverrides();

  const resolvedAgent = ctx.agentRegistry.getById(agentId!);
  const isDefault = resolvedAgent?.default ?? false;

  if (!resolvedAgent) {
    log.error("Agent not found", { agentId });
    process.exit(1);
  }

  // Default agent falls back to the shared Telegram bot token from config.
  const telegramToken =
    resolvedAgent.telegramBotToken ??
    (isDefault ? config.channels.telegram.botToken : undefined);

  const deliveryStore = createDeliveryStore();
  const supervisor = createProcessSupervisor(processName, {
    agentId,
    type: "agent",
    isDefault,
  });

  // --- Telegram channel ---
  if (telegramToken) {
    if (isDefault) {
      // Default agent uses the router for Telegram (multi-agent routing)
      const channelRegistry = createChannelRegistry();
      registerDefaultPlugins(channelRegistry);
      const channelManager = createChannelManager(channelRegistry);

      const router = createRouter({
        getDefaultAgentOptions: async (onProgress) => {
          const agent = ctx.agentRegistry.getDefault();
          return ctx.buildOptionsForAgent(agent, onProgress);
        },
        channels: channelManager.getChannels(),
        channelRegistry,
        config,
        agentRegistry: ctx.agentRegistry,
        buildAgentOptions: ctx.buildOptionsForAgent,
        memoryManager: ctx.memoryManager ?? undefined,
        observationHook: ctx.observationHook ?? undefined,
      });

      if (Boolean(config.channels.telegram.botToken)) {
        await channelManager.startChannel("telegram", config, router.handleMessage);
      }

      const telegramChannel = channelManager.getChannels().get("telegram");
      if (telegramChannel) {
        const poller = createDeliveryPoller(
          "telegram",
          telegramChannel,
          deliveryStore,
        );
        poller.start();
        supervisor.onShutdown(async () => {
          router.dispose();
          poller.stop();
          await telegramChannel.disconnect();
        });
      }
    } else {
      // Non-default agent: dedicated Telegram bot
      const channel = createTelegramChannel(telegramToken);

      createAgentBotHandler({
        agent: resolvedAgent,
        channel,
        allowedUserIds: config.channels.telegram.allowedUserIds,
        buildOptions: ctx.buildOptionsForAgent,
        agentRegistry: ctx.agentRegistry,
        memoryManager: ctx.memoryManager ?? undefined,
        observationHook: ctx.observationHook ?? undefined,
      });

      await channel.connect();
      log.info("Telegram bot connected", { agentId });

      const channelName = `telegram:${agentId}`;
      const poller = createDeliveryPoller(channelName, channel, deliveryStore);
      poller.start();
      supervisor.onShutdown(async () => {
        poller.stop();
        await channel.disconnect();
      });
    }
  } else {
    log.warn("No Telegram token available, skipping Telegram", { agentId });
  }

  // --- WhatsApp channel ---
  const waConfig = config.channels.whatsapp;
  const waDefaultAgentId = waConfig?.defaultAgent;
  const ownsWhatsApp =
    ((isDefault && waDefaultAgentId === resolvedAgent.id) ||
      waDefaultAgentId === agentId);

  if (ownsWhatsApp && waConfig) {
    try {
      const waChannel = createWhatsAppChannel(resolvedAgent.name ?? agentId!);

      createWhatsAppAgentHandler({
        channel: waChannel,
        agent: resolvedAgent,
        agentId: resolvedAgent.id,
        allowedNumbers: waConfig.allowedNumbers,
        allowedGroups: waConfig.allowedGroups,
        buildOptions: (agent, onProgress) =>
          ctx.buildOptionsForAgent(
            agent,
            onProgress,
            undefined,
          ),
        agentRegistry: ctx.agentRegistry,
        observationHook: ctx.observationHook ?? undefined,
      });

      await waChannel.connect();
      log.info("WhatsApp channel connected", { agentId });

      const waPoller = createDeliveryPoller(
        "whatsapp",
        waChannel,
        deliveryStore,
      );
      waPoller.start();
      supervisor.onShutdown(async () => {
        waPoller.stop();
        await waChannel.disconnect();
      });
    } catch (err) {
      log.error("WhatsApp failed to start (non-fatal)", { error: err });
    }
  }

  // --- Startup notification (default agent only, with 60s cooldown) ---
  const actualDefault = ctx.agentRegistry.getDefault();
  if (actualDefault.id === agentId && telegramToken) {
    const { getProcess } = await import("../process/registry");
    const prev = await getProcess(processName).catch(() => null);
    const prevStart = prev?.startedAt ?? 0;
    const secondsSinceLast = Math.floor(Date.now() / 1000) - prevStart;

    if (secondsSinceLast > 60) {
      const primaryUser = config.channels.telegram.allowedUserIds[0];
      if (primaryUser) {
        const { Bot } = await import("grammy");
        const notifyBot = new Bot(telegramToken);
        notifyBot.api
          .sendMessage(primaryUser, `Agent <b>${agentId}</b> is back online.`, {
            parse_mode: "HTML",
          })
          .catch((err) =>
            log.warn("Startup notification failed", { error: err }),
          );
      }
    } else {
      log.info("Skipping startup notification (cooldown)", {
        secondsSinceLast,
      });
    }
  }

  await supervisor.start();

  log.info("Agent process started", { agentId, processName });
}

process.on("unhandledRejection", (reason: unknown) => {
  log.error("Unhandled promise rejection (non-fatal)", { error: reason });
});

process.on("uncaughtException", (error: Error) => {
  log.error("Uncaught exception — exiting", {
    error: error.message,
    stack: error.stack,
  });
  process.exit(1);
});

main().catch((err) => {
  log.error("Agent process failed to start", { agentId, error: err });
  process.exit(1);
});
