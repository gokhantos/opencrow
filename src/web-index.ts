import { loadConfig } from "./config/loader";
import { loadConfigWithOverrides } from "./config/loader";
import { initDb, closeDb } from "./store/db";
import { createAgentRegistry } from "./agents/registry";
import { createCronStore } from "./cron/store";
import { createMemoryManager } from "./memory/manager";
import { createEmbeddingProvider } from "./memory/embeddings";
import { createQdrantClient } from "./memory/qdrant";
import { createCoreClient, type CoreClient } from "./web/core-client";
import { createWebApp } from "./web/app";
import { createBookmarkProcessor } from "./sources/x/bookmarks/processor";
import { createAutolikeProcessor } from "./sources/x/interactions/processor";
import { createAutofollowProcessor } from "./sources/x/follow/processor";
import { createProcessSupervisor } from "./process/supervisor";

import {
  createLogger,
  setLogLevel,
  setProcessName,
  startLogPersistence,
} from "./logger";
import { initQuestDBReadOnly } from "./sources/markets/questdb";
import uiHtml from "./web/ui/index.html";
// @ts-ignore — Bun file import
import logoFile from "./web/opencrow.png" with { type: "file" };
import type { AgentOptions } from "./agent/types";
import type { MemoryManager } from "./memory/types";

const log = createLogger("web-main");

async function main(): Promise<void> {
  const config = loadConfig();
  setProcessName("web");
  setLogLevel(config.logLevel);
  log.info("Starting OpenCrow web process...");

  // Init DB (separate connection pool from core)
  const dbUrl = process.env.DATABASE_URL ?? config.postgres.url;
  const db = await initDb(dbUrl, { max: 10 });
  startLogPersistence(db);
  log.info("Database initialized (PostgreSQL)");

  // Create core client pointing to internal API
  const coreUrl = `http://${config.internalApi.host}:${config.internalApi.port}`;
  const coreClient: CoreClient = createCoreClient(coreUrl);

  // Check core health
  const healthy = await coreClient.isHealthy();
  if (healthy) {
    log.info("Core process is healthy", { url: coreUrl });
  } else {
    log.warn("Core process is not reachable — some features will be degraded", {
      url: coreUrl,
    });
  }

  // Init QuestDB for market data queries (read-only from web process)
  if (config.market !== undefined) {
    try {
      await initQuestDBReadOnly();
      log.info("QuestDB initialized for market queries (read-only)");
    } catch (err) {
      log.warn("QuestDB unavailable — market charts will be empty", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Build agent registry (reads from DB for listing in UI)
  const mergedConfig = await loadConfigWithOverrides();
  const agentRegistry = createAgentRegistry(
    mergedConfig.agents,
    mergedConfig.agent,
  );
  log.info("Agent registry initialized", {
    count: agentRegistry.agents.length,
  });

  // Cron store for CRUD — always available in web process (scheduler runs in cron process)
  const cronStore = createCronStore();

  // Memory manager for search routes
  let memoryManager: MemoryManager | undefined;
  if (config.memorySearch !== undefined) {
    const embeddingKey =
      process.env.OPENROUTER_API_KEY ?? process.env.VOYAGE_API_KEY;
    const embeddingProvider = embeddingKey
      ? createEmbeddingProvider(embeddingKey)
      : null;

    const memSearch = config.memorySearch!;
    const qdrantUrl = process.env.QDRANT_URL ?? memSearch.qdrant.url;
    const qdrantCollection = memSearch.qdrant.collection;
    const qdrantClient = await createQdrantClient({
      url: qdrantUrl,
      apiKey: memSearch.qdrant.apiKey,
    });

    if (qdrantClient.available) {
      await qdrantClient.ensureCollection(qdrantCollection, 512);
    }

    memoryManager = createMemoryManager({
      embeddingProvider,
      qdrantClient,
      qdrantCollection,
      shared: memSearch.shared,
      defaultLimit: memSearch.defaultLimit,
      minScore: memSearch.minScore,
      vectorWeight: memSearch.vectorWeight,
      textWeight: memSearch.textWeight,
      mmrLambda: memSearch.mmrLambda,
    });
    log.info("Memory search initialized");
  }

  // Stub for getDefaultAgentOptions — web process proxies to core
  async function getDefaultAgentOptions(): Promise<AgentOptions> {
    const def = agentRegistry.getDefault();
    return {
      systemPrompt: def.systemPrompt,
      model: def.model,
      provider: def.provider,
      toolsEnabled: false,
      agentId: def.id,
      maxToolIterations: 0,
      cwd: process.cwd(),
    };
  }

  // Create X processors for direct use (not started — no timer ticks).
  // shareNow/runNow work standalone via DB, bypassing coreClient→internal API.
  const bookmarkProcessor = createBookmarkProcessor();
  const autolikeProcessor = createAutolikeProcessor();
  const autofollowProcessor = createAutofollowProcessor();

  const webApp = createWebApp({
    config: mergedConfig,
    channels: new Map(),
    getDefaultAgentOptions,
    agentRegistry,
    cronStore,
    memoryManager,
    coreClient,
    bookmarkProcessor,
    autolikeProcessor,
    autofollowProcessor,
    marketSymbols: config.market?.symbols ?? [],
    marketTypes: config.market?.marketTypes ?? [],
  });

  // Periodic agent reload
  setInterval(async () => {
    try {
      const fresh = await loadConfigWithOverrides();
      agentRegistry.reload(fresh.agents, fresh.agent);
    } catch (err) {
      log.error("Web agent reload failed (non-fatal)", { error: err });
    }
  }, 30_000);

  const MARKET_WS_URL = "ws://127.0.0.1:48084/ws/market";

  interface WsData {
    upstream: WebSocket | null;
  }

  const server = Bun.serve<WsData>({
    port: config.web.port,
    hostname: config.web.host,
    reusePort: true,
    development:
      process.env.NODE_ENV === "production"
        ? false
        : { hmr: true, console: true },
    routes: {
      "/": uiHtml,
      "/logo.png": new Response(Bun.file(logoFile), {
        headers: {
          "Content-Type": "image/png",
          "Cache-Control": "public, max-age=86400",
        },
      }),
    },
    fetch(req, bunServer) {
      const url = new URL(req.url);

      // WebSocket market kline feed — proxy to market process
      if (url.pathname === "/ws/market") {
        const token = url.searchParams.get("token");
        const expectedToken = process.env.OPENCROW_WEB_TOKEN;
        if (expectedToken && token !== expectedToken) {
          return new Response("Unauthorized", { status: 401 });
        }
        const upgraded = bunServer.upgrade(req, {
          data: { upstream: null } satisfies WsData,
        });
        if (upgraded) return undefined as unknown as Response;
        return new Response("WebSocket upgrade failed", { status: 400 });
      }

      // Internal restart endpoint — web process restarts itself
      if (url.pathname === "/internal/restart" && req.method === "POST") {
        log.info("Restart requested via /internal/restart");
        setTimeout(() => process.exit(0), 100);
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "Content-Type": "application/json" },
        });
      }

      return webApp.fetch(req);
    },
    websocket: {
      open(ws) {
        log.debug("Market WS client connected — opening upstream");
        const upstream = new WebSocket(MARKET_WS_URL);

        upstream.addEventListener("open", () => {
          log.debug("Upstream market WS connected");
        });

        upstream.addEventListener("message", (event) => {
          try {
            if (ws.readyState === 1) {
              ws.send(
                typeof event.data === "string"
                  ? event.data
                  : new Uint8Array(event.data as ArrayBuffer),
              );
            }
          } catch {
            // Client already closed — ignore
          }
        });

        upstream.addEventListener("close", () => {
          log.debug("Upstream market WS closed");
          ws.data.upstream = null;
          try {
            ws.close(1001, "upstream closed");
          } catch {
            /* already closed */
          }
        });

        upstream.addEventListener("error", (event) => {
          log.warn("Upstream market WS error", { error: String(event) });
          ws.data.upstream = null;
          try {
            ws.close(1011, "upstream error");
          } catch {
            /* already closed */
          }
        });

        ws.data.upstream = upstream;
      },
      message(ws, msg) {
        const upstream = ws.data.upstream;
        if (upstream && upstream.readyState === WebSocket.OPEN) {
          upstream.send(typeof msg === "string" ? msg : new Uint8Array(msg));
        }
      },
      close(ws) {
        log.debug("Market WS client disconnected — closing upstream");
        const upstream = ws.data.upstream;
        if (upstream) {
          ws.data.upstream = null;
          try {
            upstream.close();
          } catch {
            /* already closed */
          }
        }
      },
    },
  });

  log.info(`OpenCrow web: http://${config.web.host}:${config.web.port}`);

  const supervisor = createProcessSupervisor("web", {
    type: "web",
    port: config.web.port,
  });
  await supervisor.start();

  // NOTE: supervisor.start() already registers SIGTERM/SIGINT handlers that
  // call unregisterProcess + process.exit(0). We must NOT register our own
  // competing handlers — they race with the supervisor's DB unregister and
  // can close the DB connection before the unregister completes, leaving
  // stale PIDs in the registry and causing crash loops.
  // Instead, server.stop() is best-effort on exit. The DB pool auto-closes.

  process.on("unhandledRejection", (reason: unknown) => {
    log.error("Unhandled promise rejection (non-fatal)", { error: reason });
  });

  process.on("uncaughtException", (error: Error) => {
    log.error("Uncaught exception (non-fatal)", {
      error: error.message,
      stack: error.stack,
    });
  });
}

main().catch((err) => {
  log.error("Failed to start OpenCrow web", err);
  process.exit(1);
});
