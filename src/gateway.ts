import type { OpenCrowConfig } from "./config/schema";
import type { AgentOptions, ProgressEvent } from "./agent/types";
import { createRouter } from "./router/router";
import { createInternalApi } from "./internal/server";
import { closeDb } from "./store/db";
import type { AgentRegistry } from "./agents/registry";
import { createCronStore, type CronStore } from "./cron/store";
import { createCronScheduler, type CronScheduler } from "./cron/scheduler";
import { registerScoringCronJob } from "./cron/scoring-engine";
import { createLogger } from "./logger";
import type { MemoryManager } from "./memory/types";
import type { ObservationHook } from "./memory/observation-hook";
import type { ResolvedAgent } from "./agents/types";
import type { Channel } from "./channels/types";
import { createChannelRegistry } from "./channels/registry";
import { registerDefaultPlugins } from "./channels/default-plugins";
import { createChannelManager } from "./channels/manager";
import { createTelegramChannel } from "./channels/telegram/client";
import {
  createMarketPipeline,
  type MarketPipeline,
} from "./sources/markets/pipeline";
import {
  createBookmarkProcessor,
  type BookmarkProcessor,
} from "./sources/x/bookmarks/processor";
import {
  createAutolikeProcessor,
  type AutolikeProcessor,
} from "./sources/x/interactions/processor";
import {
  createAutofollowProcessor,
  type AutofollowProcessor,
} from "./sources/x/follow/processor";
import {
  createTimelineScrapeProcessor,
  type TimelineScrapeProcessor,
} from "./sources/x/timeline/processor";
import { createPHScraper, type PHScraper } from "./sources/producthunt/scraper";
import { createHNScraper, type HNScraper } from "./sources/hackernews/scraper";
import { createHFScraper, type HFScraper } from "./sources/huggingface/scraper";
import {
  createRedditScraper,
  type RedditScraper,
} from "./sources/reddit/scraper";
import {
  createGithubScraper,
  type GithubScraper,
} from "./sources/github/scraper";
import { createArxivScraper, type ArxivScraper } from "./sources/arxiv/scraper";
import {
  createScholarScraper,
  type ScholarScraper,
} from "./sources/scholar/scraper";
import {
  createNewsProcessor,
  type NewsProcessor,
} from "./sources/news/processor";
import {
  createDexScreenerProcessor,
  type DexScreenerProcessor,
} from "./sources/dexscreener/processor";
import {
  createLiveKlineHub,
  type LiveKlineHub,
  type WsClientData,
} from "./sources/markets/ws-hub";
import { bootstrap, type BootstrapContext } from "./process/bootstrap";
import { createProcessSupervisor } from "./process/supervisor";
import { createDeliveryStore } from "./cron/delivery-store";
import { createAgentBotHandler } from "./channels/telegram/agent-handler";
import { createWhatsAppAgentHandler } from "./channels/whatsapp/agent-handler";

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
  let marketPipeline: MarketPipeline | null = null;
  let liveHub: LiveKlineHub | null = null;
  let bookmarkProcessor: BookmarkProcessor | null = null;
  let autolikeProcessor: AutolikeProcessor | null = null;
  let autofollowProcessor: AutofollowProcessor | null = null;
  let timelineScrapeProcessor: TimelineScrapeProcessor | null = null;
  let phScraper: PHScraper | null = null;
  let hnScraper: HNScraper | null = null;
  let hfScraper: HFScraper | null = null;
  let redditScraper: RedditScraper | null = null;
  let githubScraper: GithubScraper | null = null;
  let arxivScraper: ArxivScraper | null = null;
  let scholarScraper: ScholarScraper | null = null;
  let newsProcessor: NewsProcessor | null = null;
  let dexScreenerProcessor: DexScreenerProcessor | null = null;

  const channelRegistry = createChannelRegistry();
  registerDefaultPlugins(channelRegistry);

  const channelManager = createChannelManager(channelRegistry);

  return {
    async start() {
      log.info("Starting OpenCrow gateway...");

      // Bootstrap: DB, config, agent registry, tools, memory, observations
      ctx = await bootstrap({ config });
      const {
        agentRegistry,
        baseToolRegistry,
        memoryManager,
        observationHook,
      } = ctx;
      const mergedConfig = ctx.config;

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
      const waDefaultAgentId = mergedConfig.channels.whatsapp.defaultAgent;
      if (waDefaultAgentId && mergedConfig.channels.whatsapp.enabled) {
        const waChannel = channelManager.getChannels().get("whatsapp");
        const waAgent = agentRegistry.getById(waDefaultAgentId);
        if (waChannel && waAgent) {
          log.info("Wiring WhatsApp to dedicated agent", {
            agentId: waDefaultAgentId,
          });

          createWhatsAppAgentHandler({
            channel: waChannel,
            agent: waAgent,
            agentId: waDefaultAgentId,
            allowedNumbers: mergedConfig.channels.whatsapp.allowedNumbers,
            allowedGroups: mergedConfig.channels.whatsapp.allowedGroups,
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

      {
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
        log.info("Cron scheduler started", {
          tickIntervalMs: config.cron.tickIntervalMs,
        });

        // Register performance scoring engine (runs every 5 minutes)
        await registerScoringCronJob();

        // Register daily news briefing cron job if it doesn't exist
        const existingJobs = await cronStore.listJobs();
        const hasBriefing = existingJobs.some(
          (j) => j.name === "daily-news-briefing",
        );
        if (!hasBriefing) {
          const primaryTelegramUser =
            config.channels.telegram.allowedUserIds[0];
          const delivery = primaryTelegramUser
            ? {
                mode: "announce" as const,
                channel: "telegram",
                chatId: String(primaryTelegramUser),
              }
            : { mode: "none" as const };

          await cronStore.addJob({
            name: "daily-news-briefing",
            enabled: false,
            schedule: { kind: "cron", expr: "0 8 * * *" },
            payload: {
              kind: "agentTurn",
              message:
                "Generate a comprehensive daily news briefing. Use search_news and get_calendar to gather the latest articles and economic events from the past 24 hours, then synthesize key themes, market-moving events, and notable developments into a concise briefing.",
            },
            delivery,
          });
          log.info("Registered daily-news-briefing cron job (08:00 daily)", {
            delivery: delivery.mode,
            chatId: primaryTelegramUser ?? "none",
          });
        }

        // Register idea generation cron jobs — phased pipeline
        // Research: every 4h (UTC: 0,4,8,12,16,20) — accumulate signals
        // Ideation: twice daily (UTC: 6,18 = 9AM/9PM UTC+3) — synthesize signals into ideas
        // Research runs 2h before ideation so fresh signals are ready

        const ideaGenAgents = [
          "mobile-idea-gen",
          "crypto-idea-gen",
          "ai-idea-gen",
          "oss-idea-gen",
        ] as const;

        const ideaCronJobs = ideaGenAgents.flatMap((agentId) => {
          const label = agentId.replace(/-/g, " ").replace(" gen", "");
          return [
            {
              name: `${agentId}-research`,
              agentId,
              schedule: "0 0,4,8,12,16,20 * * *",
              mode: "research" as const,
              logLabel: `${label} research (every 4h)`,
            },
            {
              name: `${agentId}-ideation`,
              agentId,
              schedule: "0 6,18 * * *",
              mode: "ideation" as const,
              logLabel: `${label} ideation (9AM/9PM UTC+3)`,
            },
          ];
        });

        for (const job of ideaCronJobs) {
          const existing = existingJobs.find((j) => j.name === job.name);
          if (!existing) {
            const primaryTelegramUser =
              config.channels.telegram.allowedUserIds[0];
            const hasAgentBot = agentBots.channelsByAgent.has(job.agentId);
            const delivery =
              primaryTelegramUser && hasAgentBot
                ? {
                    mode: "announce" as const,
                    channel: `telegram:${job.agentId}`,
                    chatId: String(primaryTelegramUser),
                  }
                : primaryTelegramUser
                  ? {
                      mode: "announce" as const,
                      channel: "telegram",
                      chatId: String(primaryTelegramUser),
                    }
                  : { mode: "none" as const };

            await cronStore.addJob({
              name: job.name,
              enabled: true,
              schedule: { kind: "cron", expr: job.schedule },
              payload: {
                kind: "agentTurn",
                agentId: job.agentId,
                mode: job.mode,
              },
              delivery,
            });
            log.info(`Registered ${job.logLabel} cron job`, {
              agentId: job.agentId,
              mode: job.mode,
              delivery: delivery.mode,
              channel:
                delivery.mode === "announce"
                  ? (delivery as { channel: string }).channel
                  : "none",
            });
          } else if (existing.payload.kind === "agentTurn") {
            // Sync mode and delivery channel for existing jobs
            const primaryTelegramUser =
              config.channels.telegram.allowedUserIds[0];
            const hasAgentBot = agentBots.channelsByAgent.has(job.agentId);
            const expectedChannel = hasAgentBot
              ? `telegram:${job.agentId}`
              : "telegram";

            const needsModeUpdate =
              existing.payload.mode !== job.mode;
            const needsDeliveryUpdate =
              primaryTelegramUser &&
              existing.delivery.mode === "announce" &&
              existing.delivery.channel !== expectedChannel;

            if (needsModeUpdate || needsDeliveryUpdate) {
              await cronStore.updateJob(existing.id, {
                ...(needsModeUpdate && {
                  payload: {
                    kind: "agentTurn" as const,
                    agentId: job.agentId,
                    mode: job.mode,
                  },
                }),
                ...(needsDeliveryUpdate && {
                  delivery: {
                    mode: "announce" as const,
                    channel: expectedChannel,
                    chatId: String(primaryTelegramUser),
                  },
                }),
              });
              log.info(`Updated ${job.name} cron job`, {
                agentId: job.agentId,
                mode: job.mode,
                modeUpdated: needsModeUpdate,
                deliveryUpdated: needsDeliveryUpdate,
              });
            }
          }
        }

        // Register idea-validator cron job — runs daily at 10:00 UTC
        {
          const existing = existingJobs.find((j) => j.name === "idea-validator");
          if (!existing) {
            const primaryTelegramUser =
              config.channels.telegram.allowedUserIds[0];
            const delivery = primaryTelegramUser
              ? {
                  mode: "announce" as const,
                  channel: "telegram",
                  chatId: String(primaryTelegramUser),
                }
              : { mode: "none" as const };

            await cronStore.addJob({
              name: "idea-validator",
              enabled: true,
              schedule: { kind: "cron", expr: "0 10 * * *" },
              payload: {
                kind: "agentTurn",
                agentId: "idea-validator",
              },
              delivery,
            });
            log.info("Registered idea-validator cron job (10:00 UTC daily)");
          }
        }

        // Register signal-archival internal handler — runs daily at 03:00 UTC
        {
          const existing = existingJobs.find((j) => j.name === "signal-archival");
          if (!existing) {
            await cronStore.addJob({
              name: "signal-archival",
              enabled: true,
              schedule: { kind: "cron", expr: "0 3 * * *" },
              payload: {
                kind: "internal",
                handler: "signal-archival",
              },
              delivery: { mode: "none" },
            });
            log.info("Registered signal-archival cron job (03:00 UTC daily)");
          }
        }
      }

      // --- Start subsystems with isolation ---
      // Each subsystem is wrapped in try/catch so a failure in one
      // (e.g. missing Python, DB issue, bad config) never crashes the gateway.

      try {
        if (config.market.enabled) {
          liveHub = createLiveKlineHub();
          marketPipeline = createMarketPipeline(config.market, liveHub);
          await marketPipeline.start();
          log.info("Market pipeline started", {
            marketTypes: config.market.marketTypes,
            symbols: config.market.symbols,
          });
        }
      } catch (err) {
        log.error("Market pipeline failed to start (non-fatal)", {
          error: err,
        });
      }

      try {
        bookmarkProcessor = createBookmarkProcessor();
        bookmarkProcessor.start();
        log.info("Bookmark processor started");
      } catch (err) {
        log.error("Bookmark processor failed to start (non-fatal)", {
          error: err,
        });
      }

      try {
        autolikeProcessor = createAutolikeProcessor();
        autolikeProcessor.start();
        log.info("Autolike processor started");
      } catch (err) {
        log.error("Autolike processor failed to start (non-fatal)", {
          error: err,
        });
      }

      try {
        autofollowProcessor = createAutofollowProcessor();
        autofollowProcessor.start();
        log.info("Autofollow processor started");
      } catch (err) {
        log.error("Autofollow processor failed to start (non-fatal)", {
          error: err,
        });
      }

      try {
        timelineScrapeProcessor = createTimelineScrapeProcessor({
          memoryManager: memoryManager ?? undefined,
        });
        timelineScrapeProcessor.start();
        log.info("Timeline scrape processor started");
      } catch (err) {
        log.error("Timeline processor failed to start (non-fatal)", {
          error: err,
        });
      }

      try {
        phScraper = createPHScraper({
          memoryManager: memoryManager ?? undefined,
        });
        phScraper.start();
        log.info("PH scraper started");
      } catch (err) {
        log.error("PH scraper failed to start (non-fatal)", { error: err });
      }

      try {
        hnScraper = createHNScraper({
          memoryManager: memoryManager ?? undefined,
        });
        hnScraper.start();
        log.info("HN scraper started");
      } catch (err) {
        log.error("HN scraper failed to start (non-fatal)", { error: err });
      }

      try {
        hfScraper = createHFScraper({
          memoryManager: memoryManager ?? undefined,
        });
        hfScraper.start();
        log.info("HF scraper started");
      } catch (err) {
        log.error("HF scraper failed to start (non-fatal)", { error: err });
      }

      try {
        redditScraper = createRedditScraper({
          memoryManager: memoryManager ?? undefined,
        });
        redditScraper.start();
        log.info("Reddit scraper started");
      } catch (err) {
        log.error("Reddit scraper failed to start (non-fatal)", { error: err });
      }

      try {
        githubScraper = createGithubScraper({
          memoryManager: memoryManager ?? undefined,
        });
        githubScraper.start();
        log.info("GitHub scraper started");
      } catch (err) {
        log.error("GitHub scraper failed to start (non-fatal)", { error: err });
      }

      try {
        arxivScraper = createArxivScraper({
          memoryManager: memoryManager ?? undefined,
        });
        arxivScraper.start();
        log.info("arXiv scraper started");
      } catch (err) {
        log.error("arXiv scraper failed to start (non-fatal)", { error: err });
      }

      try {
        scholarScraper = createScholarScraper({
          memoryManager: memoryManager ?? undefined,
        });
        scholarScraper.start();
        log.info("Scholar scraper started");
      } catch (err) {
        log.error("Scholar scraper failed to start (non-fatal)", {
          error: err,
        });
      }

      try {
        newsProcessor = createNewsProcessor({
          memoryManager: memoryManager ?? undefined,
        });
        newsProcessor.start();
        log.info("News processor started");
      } catch (err) {
        log.error("News processor failed to start (non-fatal)", { error: err });
      }

      try {
        dexScreenerProcessor = createDexScreenerProcessor({
          memoryManager: memoryManager ?? undefined,
        });
        dexScreenerProcessor.start();
        log.info("DexScreener processor started");
      } catch (err) {
        log.error("DexScreener processor failed to start (non-fatal)", { error: err });
      }

      // Start internal API for the web process to call
      {
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
          marketPipeline: marketPipeline ?? undefined,
          marketSymbols: config.market.symbols,
          marketTypes: config.market.marketTypes,
          bookmarkProcessor: bookmarkProcessor ?? undefined,
          autolikeProcessor: autolikeProcessor ?? undefined,
          autofollowProcessor: autofollowProcessor ?? undefined,
          timelineScrapeProcessor: timelineScrapeProcessor ?? undefined,
          hnScraper: hnScraper ?? undefined,
          hfScraper: hfScraper ?? undefined,
          redditScraper: redditScraper ?? undefined,
          phScraper: phScraper ?? undefined,
          githubScraper: githubScraper ?? undefined,
          arxivScraper: arxivScraper ?? undefined,
          scholarScraper: scholarScraper ?? undefined,
          newsProcessor: newsProcessor ?? undefined,
          dexScreenerProcessor: dexScreenerProcessor ?? undefined,
          observationHook: observationHook ?? undefined,
        });
        const hub = liveHub;
        server = Bun.serve({
          port: config.internalApi.port,
          hostname: config.internalApi.host,
          reusePort: true,
          fetch(req, bunServer) {
            // Handle WebSocket upgrade for live kline relay
            if (hub) {
              const url = new URL(req.url);
              if (url.pathname === "/ws/market") {
                const upgraded = bunServer.upgrade(req, {
                  data: { subscriptions: new Set<string>() },
                });
                if (upgraded) return undefined as unknown as Response;
                return new Response("WebSocket upgrade failed", {
                  status: 400,
                });
              }
            }
            return internalApp.fetch(req);
          },
          websocket: {
            open: (ws) =>
              hub?.onOpen(ws as import("bun").ServerWebSocket<WsClientData>),
            message: (ws, msg) =>
              hub?.onMessage(
                ws as import("bun").ServerWebSocket<WsClientData>,
                msg,
              ),
            close: (ws) =>
              hub?.onClose(ws as import("bun").ServerWebSocket<WsClientData>),
          },
        });
        log.info(
          `Internal API: http://${config.internalApi.host}:${config.internalApi.port}`,
        );
      }

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
          log.error("Failed to record known-good commit (non-fatal)", {
            error: err,
          });
        }
      }, STABILITY_MS);

      // Notify users if we recovered from a crash-loop rollback
      try {
        const { consumeRollbackEvents } =
          await import("./health/rollback-notifier");
        const rollbackEvents = await consumeRollbackEvents();
        const seen = new Set<string>();
        const merged = [...channelManager.getChannels(), ...allChannels];

        for (const event of rollbackEvents) {
          const msg =
            `[Guardian] Crash-loop detected and auto-recovered.\n` +
            `Rolled back from ${event.from.slice(0, 8)} to ${event.to.slice(0, 8)}.\n` +
            `Reason: ${event.reason}\n` +
            `Time: ${event.timestamp}`;

          log.warn("Rollback recovery notification", { event });

          for (const [id, ch] of merged) {
            if (seen.has(id)) continue;
            seen.add(id);
            try {
              await ch.sendMessage("rollback", { text: msg });
            } catch {
              // Channel may not support arbitrary chatId — best-effort
            }
          }
        }
      } catch (err) {
        log.error("Failed to process rollback events (non-fatal)", {
          error: err,
        });
      }
    },

    async stop() {
      log.info("Stopping OpenCrow gateway...");

      if (hnScraper) {
        hnScraper.stop();
        hnScraper = null;
        log.info("HN scraper stopped");
      }

      if (hfScraper) {
        hfScraper.stop();
        hfScraper = null;
        log.info("HF scraper stopped");
      }

      if (redditScraper) {
        redditScraper.stop();
        redditScraper = null;
        log.info("Reddit scraper stopped");
      }

      if (phScraper) {
        phScraper.stop();
        phScraper = null;
        log.info("PH scraper stopped");
      }

      if (githubScraper) {
        githubScraper.stop();
        githubScraper = null;
        log.info("GitHub scraper stopped");
      }

      if (arxivScraper) {
        arxivScraper.stop();
        arxivScraper = null;
        log.info("arXiv scraper stopped");
      }

      if (scholarScraper) {
        scholarScraper.stop();
        scholarScraper = null;
        log.info("Scholar scraper stopped");
      }

      if (bookmarkProcessor) {
        bookmarkProcessor.stop();
        bookmarkProcessor = null;
        log.info("Bookmark processor stopped");
      }

      if (autolikeProcessor) {
        autolikeProcessor.stop();
        autolikeProcessor = null;
        log.info("Autolike processor stopped");
      }

      if (autofollowProcessor) {
        autofollowProcessor.stop();
        autofollowProcessor = null;
        log.info("Autofollow processor stopped");
      }

      if (timelineScrapeProcessor) {
        timelineScrapeProcessor.stop();
        timelineScrapeProcessor = null;
        log.info("Timeline scrape processor stopped");
      }

      if (newsProcessor) {
        newsProcessor.stop();
        newsProcessor = null;
        log.info("News processor stopped");
      }

      if (dexScreenerProcessor) {
        dexScreenerProcessor.stop();
        dexScreenerProcessor = null;
        log.info("DexScreener processor stopped");
      }

      if (marketPipeline) {
        await marketPipeline.stop();
        marketPipeline = null;
        log.info("Market pipeline stopped");
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
