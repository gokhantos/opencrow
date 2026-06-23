/**
 * Standalone cron process — owns the cron scheduler and agent execution.
 *
 * Usage:
 *   bun src/entries/cron.ts
 */
import { loadConfig, loadConfigWithOverrides } from "../config/loader";
import { bootstrap } from "../process/bootstrap";
import { createProcessSupervisor } from "../process/supervisor";
import { createCronStore } from "../cron/store";
import { createCronScheduler } from "../cron/scheduler";
import { createDeliveryStore } from "../cron/delivery-store";
import { createLogger } from "../logger";
import { seedDefaultAgents } from "../gateway/agent-seeder";

const log = createLogger("cron-entry");

async function main(): Promise<void> {
  const baseConfig = loadConfig();

  const ctx = await bootstrap({
    config: baseConfig,
    processName: "cron",
    dbPoolSize: 10,
  });

  // Reload with DB overrides now that DB is initialized
  const config = await loadConfigWithOverrides();

  const cronStore = createCronStore();
  const deliveryStore = createDeliveryStore();

  // Seed default agent definitions (idempotent — skips existing DB records)
  await seedDefaultAgents();

  // No local channels — all delivery goes through cron_deliveries table
  const emptyChannels = new Map();

  const cronScheduler = createCronScheduler({
    cronStore,
    agentRegistry: ctx.agentRegistry,
    baseToolRegistry: ctx.baseToolRegistry,
    channels: emptyChannels,
    config: config.cron,
    toolsConfig: config.tools,
    buildRegistryForAgent: ctx.buildRegistryForAgent,
    buildSystemPrompt: ctx.enrichSystemPrompt,
    deliveryStore,
  });

  // Wire cron tool so agents can manage cron jobs during execution
  ctx.cronToolConfig = {};

  const supervisor = createProcessSupervisor("cron", {
    type: "cron",
  });

  cronScheduler.start();
  log.info("Cron scheduler started");

  supervisor.onShutdown(async () => {
    cronScheduler.stop();
  });

  // --- Deferred outcome re-probe scheduler (Phase 2, gated, default OFF) ---
  // A bespoke (non-CronPayload) scheduler: a CronPayload routes through
  // runAgentIsolated and can only express an AGENT job, but this is a pure data
  // job (claim due rows → re-run demand probes → diff vs baseline → supersede a
  // mem0 memory), so it cannot be modeled as a cron job. It mirrors the cron
  // scheduler's start/stop/non-reentrant shape and is added to graceful shutdown.
  const reprobeCfg = config.pipelines.ideas.smart.outcomeMemory.reprobe;
  const sigeMem0 = config.sige?.mem0;
  if (reprobeCfg.enabled && sigeMem0) {
    const { createDeferredOutcomeScheduler } = await import(
      "../cron/deferred-outcome-scheduler"
    );
    const { deferredOutcomeStore } = await import(
      "../pipelines/ideas/deferred-outcome-store"
    );
    const { Mem0Client } = await import("../sige/knowledge/mem0-client");

    // Build the mem0 client factory from config exactly like web/routes/pipelines.ts.
    const deferredScheduler = createDeferredOutcomeScheduler({
      deferredStore: deferredOutcomeStore,
      mem0Factory: () =>
        new Mem0Client({ baseUrl: sigeMem0.baseUrl, apiToken: sigeMem0.apiToken }),
      config: {
        reprobe: {
          tickIntervalMs: reprobeCfg.tickIntervalMs,
          batchSize: reprobeCfg.batchSize,
          scoreDeltaGrew: reprobeCfg.scoreDeltaGrew,
          scoreDeltaDecayed: reprobeCfg.scoreDeltaDecayed,
        },
        demand: config.pipelines.ideas.smart.demand,
        ideasUserId: sigeMem0.ideasUserId,
      },
    });
    deferredScheduler.start();
    supervisor.onShutdown(async () => {
      deferredScheduler.stop();
      await deferredScheduler.drain();
    });
    log.info("Deferred-outcome re-probe scheduler started", {
      tickIntervalMs: reprobeCfg.tickIntervalMs,
      delayDays: reprobeCfg.delayDays,
    });
  }

  // --- Idea-anchor retention prune scheduler (Phase 3, gated, default OFF) ---
  // The graph outcome-feedback loop MERGEs a NEW :IdeaAnchor per run, so the anchor
  // log grows unbounded once feedback projects to Neo4j. This bespoke (non-
  // CronPayload) scheduler DETACH DELETEs anchors older than anchorRetentionDays.
  // Gated exactly like the projection write-back: only runs when graphFeedback is
  // enabled, projectToNeo4j is on, AND a sige.neo4j connection is configured.
  const graphFeedbackCfg = config.pipelines.ideas.smart.graphFeedback;
  const sigeNeo4j = config.sige?.neo4j;
  if (
    graphFeedbackCfg.enabled &&
    graphFeedbackCfg.projectToNeo4j &&
    sigeNeo4j?.enabled
  ) {
    const { createIdeaAnchorPruneScheduler } = await import(
      "../cron/idea-anchor-prune-scheduler"
    );
    const { Neo4jWriteClient } = await import("../sige/knowledge/neo4j-write-client");

    // Build the WRITE client from sige.neo4j exactly like graph-outcome-feedback.
    const anchorPruneWriteClient = new Neo4jWriteClient({
      boltUrl: sigeNeo4j.boltUrl,
      user: sigeNeo4j.user,
      queryTimeoutMs: sigeNeo4j.queryTimeoutMs,
    });
    const anchorPruneScheduler = createIdeaAnchorPruneScheduler({
      writeClient: anchorPruneWriteClient,
      config: {
        tickIntervalMs: graphFeedbackCfg.pruneTickIntervalMs,
        anchorRetentionDays: graphFeedbackCfg.anchorRetentionDays,
      },
    });
    anchorPruneScheduler.start();
    supervisor.onShutdown(async () => {
      anchorPruneScheduler.stop();
      await anchorPruneScheduler.drain();
      await anchorPruneWriteClient.close().catch(() => {});
    });
    log.info("Idea-anchor prune scheduler started", {
      pruneTickIntervalMs: graphFeedbackCfg.pruneTickIntervalMs,
      anchorRetentionDays: graphFeedbackCfg.anchorRetentionDays,
    });
  }

  // --- Proactive Monitor ---
  if (config.monitor !== undefined) {
    const primaryUserId = config.channels.telegram.allowedUserIds[0];
    if (primaryUserId) {
      const { createAlertStore } = await import("../monitor/alert-store");
      const { createMonitorRunner } = await import("../monitor/runner");
      const { ensureDeepHealthCheckJob } =
        await import("../monitor/deep-check");
      const { ensureHooksHealthCheckJob, runHooksHealthCheck } =
        await import("../monitor/hooks-health-check");

      const telegramChatId = String(primaryUserId);
      const monitorRunner = createMonitorRunner({
        config: config.monitor!,
        deliveryStore,
        alertStore: createAlertStore(),
        telegramChatId,
      });
      monitorRunner.start();

      supervisor.onShutdown(async () => {
        monitorRunner.stop();
      });

      await ensureDeepHealthCheckJob(cronStore, telegramChatId);
      await ensureHooksHealthCheckJob(cronStore, telegramChatId);

      // Run initial hooks health check after startup
      runHooksHealthCheck();

      log.info("Proactive monitor started");
    } else {
      log.warn("No primary Telegram user configured, monitor disabled");
    }
  }

  // --- Memory Eviction ---
  if (config.memoryEviction?.enabled && ctx.memoryManager) {
    const { createMemoryEvictor } = await import("../memory/evictor");
    const evictor = createMemoryEvictor(config.memoryEviction, ctx.memoryManager);
    evictor.start();

    supervisor.onShutdown(async () => {
      evictor.stop();
    });

    log.info("Memory evictor started");
  }

  await supervisor.start();

  log.info("Cron process started");
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
  log.error("Cron process failed to start", { error: err });
  process.exit(1);
});
