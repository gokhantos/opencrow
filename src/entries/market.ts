/**
 * Standalone entry point for the market pipeline + WS hub.
 *
 * Usage:
 *   bun src/entries/market.ts
 */
import { loadConfig, loadConfigWithOverrides } from "../config/loader";
import { bootstrap } from "../process/bootstrap";
import { createProcessSupervisor } from "../process/supervisor";
import { getOverride } from "../store/config-overrides";
import {
  createMarketPipeline,
  type MarketPipeline,
} from "../sources/markets/pipeline";
import {
  createLiveKlineHub,
  type LiveKlineHub,
  type WsClientData,
} from "../sources/markets/ws-hub";
import { createLogger } from "../logger";

const log = createLogger("market-entry");

const MARKET_PORT = 48084;

async function main(): Promise<void> {
  const baseConfig = loadConfig();
  await bootstrap({
    config: baseConfig,
    processName: "market",
    skipMemory: true,
    skipObservations: true,
    dbPoolSize: 5,
  });

  // Reload with DB overrides now that DB is initialized
  const config = await loadConfigWithOverrides();

  const marketOverride = await getOverride("features", "marketEnabled");
  if (marketOverride === false) {
    log.info("Market feature disabled via DB toggle, exiting");
    process.exit(0);
  }

  if (config.market === undefined) {
    log.warn("Market pipeline not configured, exiting");
    process.exit(0);
  }

  const liveHub = createLiveKlineHub();
  const marketPipeline = createMarketPipeline(config.market, liveHub);
  await marketPipeline.start();

  log.info("Market pipeline started", {
    marketTypes: config.market.marketTypes,
    symbols: config.market.symbols,
  });

  // Expose WS hub on a dedicated port
  const server = Bun.serve<WsClientData>({
    port: MARKET_PORT,
    hostname: "127.0.0.1",
    reusePort: true,
    fetch(req, bunServer) {
      const url = new URL(req.url);
      if (url.pathname === "/ws/market") {
        const upgraded = bunServer.upgrade(req, {
          data: { subscriptions: new Set<string>() } as WsClientData,
        });
        if (upgraded) return undefined as unknown as Response;
        return new Response("WebSocket upgrade failed", { status: 400 });
      }
      if (url.pathname === "/health") {
        return Response.json({
          status: "ok",
          pipeline: marketPipeline.getStatus(),
        });
      }
      return new Response("Not found", { status: 404 });
    },
    websocket: {
      open: (ws) => liveHub.onOpen(ws),
      message: (ws, msg) => liveHub.onMessage(ws, msg),
      close: (ws) => liveHub.onClose(ws),
    },
  });

  log.info(`Market WS hub listening on :${MARKET_PORT}`);

  const supervisor = createProcessSupervisor("market", {
    type: "market",
    port: MARKET_PORT,
  });

  supervisor.onShutdown(() => marketPipeline.stop());
  supervisor.onShutdown(async () => {
    server.stop(true);
  });

  await supervisor.start();

  log.info("Market process started");
}

process.on("unhandledRejection", (reason: unknown) => {
  log.error("Unhandled promise rejection (non-fatal)", { error: reason });
});

process.on("uncaughtException", (error: Error) => {
  log.error("Uncaught exception (non-fatal)", {
    error: error.message,
    stack: error.stack,
  });
});

main().catch((err) => {
  log.error("Market process failed to start", { error: err });
  process.exit(1);
});
