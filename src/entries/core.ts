/**
 * Slim core entry point — orchestrator + internal API only.
 * No bootstrap, no cron, no channels, no memory, no tools.
 *
 * Usage:
 *   bun src/entries/core.ts
 */
import { loadConfig } from "../config/loader";
import { loadConfigWithOverrides } from "../config/loader";
import { initDb } from "../store/db";
import { createAgentRegistry } from "../agents/registry";
import { createChannelRegistry } from "../channels/registry";
import { registerDefaultPlugins } from "../channels/default-plugins";

import { createProcessSupervisor } from "../process/supervisor";
import { createOrchestrator } from "../process/orchestrator";
import { createInternalApi } from "../internal/server";
import {
  createLogger,
  setLogLevel,
  setProcessName,
  startLogPersistence,
} from "../logger";

const log = createLogger("core-entry");

const CORE_PORT = 48081;

async function main(): Promise<void> {
  const config = loadConfig();
  setProcessName("core");
  setLogLevel(config.logLevel);

  // Minimal DB init — for orchestrator process registry only
  const dbUrl = process.env.DATABASE_URL ?? config.postgres.url;
  const db = await initDb(dbUrl, { max: 3 });
  startLogPersistence(db);
  log.info("Database initialized (PostgreSQL)");

  // Agent registry — for manifest resolution (which agents have bot tokens)
  const mergedConfig = await loadConfigWithOverrides();
  const agentRegistry = createAgentRegistry(
    mergedConfig.agents,
    mergedConfig.agent,
  );

  // Channel registry — metadata only, no live connections
  const channelRegistry = createChannelRegistry();
  registerDefaultPlugins(channelRegistry);

  // Process orchestrator — uses merged config so DB overrides (bot tokens, features) are included
  const orchestrator = createOrchestrator(mergedConfig, agentRegistry);

  // Internal API — process management endpoints only
  const internalApp = createInternalApi({
    agentRegistry,
    orchestrator,
    channelRegistry,
  });

  const server = Bun.serve({
    port: CORE_PORT,
    hostname: config.internalApi.host,
    reusePort: true,
    fetch: internalApp.fetch,
  });

  log.info(`Core internal API: http://${config.internalApi.host}:${CORE_PORT}`);

  const supervisor = createProcessSupervisor("core", {
    type: "core",
    port: CORE_PORT,
  });

  supervisor.onShutdown(async () => {
    server.stop(true);
  });

  supervisor.onShutdown(() => orchestrator.stop());

  await supervisor.start();

  // Start orchestrator after everything else is ready
  await orchestrator.start();
  log.info("Process orchestrator started");

  // Periodic config + agent registry reload — picks up DB changes (new agents,
  // channel config, bot tokens) so the orchestrator can spawn/remove processes.
  let lastConfigHash = "";
  setInterval(async () => {
    try {
      const fresh = await loadConfigWithOverrides();
      const hash = Bun.hash(JSON.stringify(fresh)).toString(36);
      if (hash === lastConfigHash) return;
      lastConfigHash = hash;
      agentRegistry.reload(fresh.agents, fresh.agent);
      if (orchestrator) {
        orchestrator.updateConfig(fresh);
      }
      log.info("Config reloaded (changed)", { hash });
    } catch (err) {
      log.error("Core config reload failed (non-fatal)", { error: err });
    }
  }, 30_000);

  log.info("Core process started");
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
  log.error("Core process failed to start", { error: err });
  process.exit(1);
});
