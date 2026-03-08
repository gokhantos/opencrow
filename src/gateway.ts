import type { OpenCrowConfig } from "./config/schema";
import type { AgentOptions, ProgressEvent } from "./agent/types";
import { createRouter } from "./router/router";
import { createInternalApi } from "./internal/server";
import { closeDb } from "./store/db";
import type { AgentRegistry } from "./agents/registry";
import { createCronStore } from "./cron/store";
import { createCronScheduler, type CronScheduler } from "./cron/scheduler";
import { createLogger } from "./logger";
import type { MemoryManager } from "./memory/types";
import type { ObservationHook } from "./memory/observation-hook";
import type { ResolvedAgent } from "./agents/types";
import type { Channel } from "./channels/types";
import { createChannelRegistry } from "./channels/registry";
import { registerDefaultPlugins } from "./channels/default-plugins";
import { createChannelManager } from "./channels/manager";
import { createTelegramChannel } from "./channels/telegram/client";
import type { WsClientData } from "./sources/markets/ws-hub";
import { bootstrap, type BootstrapContext } from "./process/bootstrap";
import { createProcessSupervisor } from "./process/supervisor";
import { createDeliveryStore } from "./cron/delivery-store";
import { createAgentBotHandler } from "./channels/telegram/agent-handler";
import { createWhatsAppAgentHandler } from "./channels/whatsapp/agent-handler";
import { createSubsystemRegistry } from "./gateway/subsystems";
import { seedDefaultCronJobs } from "./gateway/cron-seeds";
import { notifyRollbackRecovery } from "./gateway/crash-recovery";

const log = createLogger("gateway");

export interface Gateway {
  start(): Promise<void>;
  stop(): Promise<void>;
}

async function startAgentTelegramBots(
  agents: readonly ResolvedAgent[],
  allowedUserIds: readonly number[],
  buildOptions: (
    agent: ResolvedAgent,
    onProgress?: (event: ProgressEvent) => void,
  ) => Promise<AgentOptions>,
  opts?: {
    memoryManager?: MemoryManager;
    agentRegistry?: AgentRegistry;
    observationHook?: ObservationHook;
  },
): Promise<{ channels: Channel[]; channelsByAgent: Map<string, Channel> }> {
  const channels: Channel[] = [];
  const channelsByAgent = new Map<string, Channel>();

  for (const agent of agents) {
    if (!agent.telegramBotToken) continue;

    const agentId = agent.id;
    log.info("Starting per-agent Telegram bot", { agentId });

    const channel = createTelegramChannel(agent.telegramBotToken);

    createAgentBotHandler({
      agent,
      channel,
      allowedUserIds,
      buildOptions,
      agentRegistry: opts?.agentRegistry,
      memoryManager: opts?.memoryManager,
      observationHook: opts?.observationHook,
    });

    try {
      await channel.connect();
      channels.push(channel);
      channelsByAgent.set(agentId, channel);
    } catch (err) {
      log.error("Failed to start agent Telegram bot, skipping", {
        agentId,
        error: err instanceof Error ? err.message : err,
      });
    }
  }

  return { channels, channelsByAgent };
}

export function createGateway(config: OpenCrowConfig): Gateway {
  let server: ReturnType<typeof Bun.serve> | null = null;
  let ctx: BootstrapContext | null = null;
  let cronScheduler: CronScheduler | null = null;
  let agentTelegramChannels: Channel[] = [];
  let subsystemRegistry: ReturnType<typeof createSubsystemRegistry> | null = null;

  const channelRegistry = createChannelRegistry();
  registerDefaultPlugins(channelRegistry);
  const channelManager = createChannelManager(channelRegistry);

  return {
    async start() {
      log.info("Starting OpenCrow gateway...");

      // Bootstrap: DB, config, agent registry, tools, memory, observations
      ctx = await bootstrap({ config });
      const { agentRegistry, baseToolRegistry, memoryManager, observationHook } = ctx;
      const mergedConfig = ctx.config;

      subsystemRegistry = createSubsystemRegistry({ config, memoryManager });

      const cronStore = createCronStore();
      log.info("Cron store initialized");

      async function getDefaultAgentOptions(
        onProgress?: (event: ProgressEvent) => void,
      ): Promise<AgentOptions> {
        const agent = agentRegistry.getDefault();
        return ctx!.buildOptionsForAgent(agent, onProgress);
      }

      const router = createRouter({
        getDefaultAgentOptions,
        channels: channelManager.getChannels(),
        channelRegistry,
        config,
        agentRegistry,
        buildAgentOptions: ctx.buildOptionsForAgent,
        memoryManager: memoryManager ?? undefined,
        observationHook: observationHook ?? undefined,
      });

      await channelManager.startAll(mergedConfig, router.handleMessage);

      // Wire WhatsApp to dedicated agent if configured
      const waDefaultAgentId = mergedConfig.channels.whatsapp?.defaultAgent;
      if (waDefaultAgentId && mergedConfig.channels.whatsapp !== undefined) {
        const waChannel = channelManager.getChannels().get("whatsapp");
        const waAgent = agentRegistry.getById(waDefaultAgentId);
        if (waChannel && waAgent) {
          log.info("Wiring WhatsApp to dedicated agent", { agentId: waDefaultAgentId });
          createWhatsAppAgentHandler({
            channel: waChannel,
            agent: waAgent,
            agentId: waDefaultAgentId,
            allowedNumbers: mergedConfig.channels.whatsapp!.allowedNumbers,
            allowedGroups: mergedConfig.channels.whatsapp!.allowedGroups,
            buildOptions: ctx.buildOptionsForAgent,
            agentRegistry,
            observationHook: observationHook ?? undefined,
          });
        } else {
          log.warn("WhatsApp defaultAgent not found or channel missing", {
            agentId: waDefaultAgentId,
            hasChannel: Boolean(waChannel),
            hasAgent: Boolean(waAgent),
          });
        }
      }

      const agentBots = await startAgentTelegramBots(
        agentRegistry.agents,
        config.channels.telegram.allowedUserIds,
        ctx.buildOptionsForAgent,
        {
          memoryManager: memoryManager ?? undefined,
          agentRegistry,
          observationHook: observationHook ?? undefined,
        },
      );
      agentTelegramChannels = agentBots.channels;

      // Build merged channels map: main channels + agent-specific telegram bots
      const allChannels = new Map(channelManager.getChannels());
      for (const [agentId, ch] of agentBots.channelsByAgent) {
        allChannels.set(`telegram:${agentId}`, ch);
      }

      // Cron scheduler setup
      const deliveryStore = createDeliveryStore();
      cronScheduler = createCronScheduler({
        cronStore,
        agentRegistry,
        baseToolRegistry,
        channels: allChannels,
        config: config.cron,
        toolsConfig: config.tools,
        buildRegistryForAgent: ctx.buildRegistryForAgent,
        buildSystemPrompt: ctx.enrichSystemPrompt,
        deliveryStore,
      });

      ctx.cronToolConfig = {};
      cronScheduler.start();
      log.info("Cron scheduler started", { tickIntervalMs: config.cron.tickIntervalMs });

      // Seed default cron jobs (idempotent — skips already-registered jobs)
      await seedDefaultCronJobs({
        cronStore,
        config,
        agentBotChannels: agentBots.channelsByAgent,
      });

      // Start all subsystems with isolated error handling
      const { instances, failed, started } = await subsystemRegistry!.startAll();

      if (failed.length > 0) {
        log.warn("Some subsystems failed to start", {
          started: started.length,
          failed: failed.length,
          failedNames: failed,
        });
      }

      // Start internal API
      const internalApp = createInternalApi({
        channels: allChannels,
        channelRegistry,
        channelManager,
        getDefaultAgentOptions,
        agentRegistry,
        cronStore: cronStore ?? undefined,
        cronScheduler: cronScheduler ?? undefined,
        buildAgentOptions: ctx.buildOptionsForAgent,
        messageHandler: router.handleMessage,
        memoryManager: memoryManager ?? undefined,
        marketPipeline: instances.marketPipeline,
        marketSymbols: config.market?.symbols ?? [],
        marketTypes: config.market?.marketTypes ?? [],
        bookmarkProcessor: instances.bookmarkProcessor,
        autolikeProcessor: instances.autolikeProcessor,
        autofollowProcessor: instances.autofollowProcessor,
        timelineScrapeProcessor: instances.timelineScrapeProcessor,
        hnScraper: instances.hnScraper,
        hfScraper: instances.hfScraper,
        redditScraper: instances.redditScraper,
        phScraper: instances.phScraper,
        githubScraper: instances.githubScraper,
        newsProcessor: instances.newsProcessor,
        observationHook: observationHook ?? undefined,
      });

      const hub = instances.liveHub;
      server = Bun.serve({
        port: config.internalApi.port,
        hostname: config.internalApi.host,
        reusePort: true,
        fetch(req, bunServer) {
          if (hub) {
            const url = new URL(req.url);
            if (url.pathname === "/ws/market") {
              const upgraded = bunServer.upgrade(req, {
                data: { subscriptions: new Set<string>() },
              });
              if (upgraded) return undefined as unknown as Response;
              return new Response("WebSocket upgrade failed", { status: 400 });
            }
          }
          return internalApp.fetch(req);
        },
        websocket: {
          open: (ws) =>
            hub?.onOpen(ws as import("bun").ServerWebSocket<WsClientData>),
          message: (ws, msg) =>
            hub?.onMessage(ws as import("bun").ServerWebSocket<WsClientData>, msg),
          close: (ws) =>
            hub?.onClose(ws as import("bun").ServerWebSocket<WsClientData>),
        },
      });
      log.info(`Internal API: http://${config.internalApi.host}:${config.internalApi.port}`);

      log.info("OpenCrow gateway started");

      // Register as monolith process for the Processes UI panel
      const supervisor = createProcessSupervisor("core", {
        type: "monolith",
        port: config.internalApi.port,
        channels: [...channelManager.getChannels().keys()],
        agentBots: agentTelegramChannels.length,
      });
      await supervisor.start();

      // Record known-good commit after 5 min stability window
      const STABILITY_MS = 5 * 60 * 1000;
      setTimeout(async () => {
        try {
          const { recordKnownGoodCommit } = await import("./health/checkpoint");
          await recordKnownGoodCommit();
        } catch (err) {
          log.error("Failed to record known-good commit (non-fatal)", { error: err });
        }
      }, STABILITY_MS);

      // Notify users if we recovered from a crash-loop rollback
      await notifyRollbackRecovery(new Map([...channelManager.getChannels(), ...allChannels]));

    },

    async stop() {
      log.info("Stopping OpenCrow gateway...");

      if (subsystemRegistry) {
        await subsystemRegistry.stopAll();
        subsystemRegistry = null;
      }

      if (cronScheduler) {
        cronScheduler.stop();
        cronScheduler = null;
        log.info("Cron scheduler stopped");
      }

      for (const ch of agentTelegramChannels) {
        await ch.disconnect();
      }
      agentTelegramChannels = [];

      await channelManager.stopAll();
      await closeDb();

      if (server) {
        server.stop();
        server = null;
      }

      log.info("OpenCrow gateway stopped");
    },
  };
}
