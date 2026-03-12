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

  cronScheduler.start();
  log.info("Cron scheduler started");

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

      await ensureDeepHealthCheckJob(cronStore, telegramChatId);
      await ensureHooksHealthCheckJob(cronStore, telegramChatId);

      // Run initial hooks health check after startup
      runHooksHealthCheck();

      log.info("Proactive monitor started");
    } else {
      log.warn("No primary Telegram user configured, monitor disabled");
    }
  }

  const supervisor = createProcessSupervisor("cron", {
    type: "cron",
  });
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
