import { loadConfig } from "./config/loader";
import { bootstrap } from "./process/bootstrap";
import { getDb } from "./store/db";
import { createCoreClient, type CoreClient } from "./web/core-client";
import { createWebApp } from "./web/app";
import { createBookmarkProcessor } from "./sources/x/bookmarks/processor";
import { createAutolikeProcessor } from "./sources/x/interactions/processor";
import { createAutofollowProcessor } from "./sources/x/follow/processor";
import { createTimelineScrapeProcessor } from "./sources/x/timeline/processor";
import { createProcessSupervisor } from "./process/supervisor";
import { chat } from "./agent/chat";
import {
  addUserMessage,
  addAssistantMessage,
  getSessionHistory,
  clearSession,
} from "./agent/session";

import {
  createLogger,
  setLogLevel,
  setProcessName,
  startLogPersistence,
} from "./logger";
import uiHtml from "./web/ui/index.html";
// @ts-ignore — Bun file import
import logoFile from "./web/opencrow.png" with { type: "file" };
// @ts-ignore — Bun file import
import faviconFile from "./web/favicon.ico" with { type: "file" };

const log = createLogger("web-main");

async function main(): Promise<void> {
  const config = loadConfig();
  setProcessName("web");
  setLogLevel(config.logLevel);
  log.info("Starting OpenCrow web process...");

  // Bootstrap full agent capabilities (handles DB init, agent registry, tool registry, memory)
  const ctx = await bootstrap({
    config,
    processName: "web",
    dbPoolSize: 5,
  });
  startLogPersistence(getDb());

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

  // Cron store for CRUD — always available in web process (scheduler runs in cron process)
  const { createCronStore } = await import("./cron/store");
  const cronStore = createCronStore();

  // X processors for direct use (not started — no timer ticks).
  const bookmarkProcessor = createBookmarkProcessor();
  const autolikeProcessor = createAutolikeProcessor();
  const autofollowProcessor = createAutofollowProcessor();
  const timelineScrapeProcessor = createTimelineScrapeProcessor({
    memoryManager: ctx.memoryManager ?? undefined,
  });

  const mergedConfig = ctx.config;

  const webApp = createWebApp({
    config: mergedConfig,
    channels: new Map(),
    getDefaultAgentOptions: async () => {
      const agent = ctx.agentRegistry.getDefault();
      return ctx.buildOptionsForAgent(agent);
    },
    agentRegistry: ctx.agentRegistry,
    toolRegistry: ctx.baseToolRegistry ?? undefined,
    buildAgentOptions: ctx.buildOptionsForAgent,
    cronStore,
    memoryManager: ctx.memoryManager ?? undefined,
    coreClient,
    bookmarkProcessor,
    autolikeProcessor,
    autofollowProcessor,
    timelineScrapeProcessor,
    marketSymbols: config.market?.symbols ?? [],
    marketTypes: config.market?.marketTypes ?? [],
  });

  // Periodic agent reload — skip if config unchanged
  let lastConfigHash = "";
  setInterval(async () => {
    try {
      const { loadConfigWithOverrides } = await import("./config/loader");
      const fresh = await loadConfigWithOverrides();
      const hash = Bun.hash(JSON.stringify(fresh)).toString(36);
      if (hash === lastConfigHash) return;
      lastConfigHash = hash;
      ctx.agentRegistry.reload(fresh.agents, fresh.agent);
      log.info("Config reloaded (changed)", { hash });
    } catch (err) {
      log.error("Web agent reload failed (non-fatal)", { error: err });
    }
  }, 30_000);

  const MARKET_WS_URL = "ws://127.0.0.1:48084/ws/market";

  type WsData =
    | { kind: "market"; upstream: WebSocket | null }
    | { kind: "system"; id: number }
    | { kind: "chat"; chatId: string };

  let systemWsNextId = 0;
  const systemWsClients = new Set<import("bun").ServerWebSocket<WsData>>();

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
      "/favicon.ico": new Response(Bun.file(faviconFile), {
        headers: {
          "Content-Type": "image/x-icon",
          "Cache-Control": "public, max-age=86400",
        },
      }),
    },
    fetch(req, bunServer) {
      const url = new URL(req.url);

      // Serve CSS files dynamically (tailwind-out.css is a build artifact)
      if (url.pathname === "/tailwind-out.css" || url.pathname === "/style.css") {
        const cssPath = import.meta.dir + "/web/ui" + url.pathname;
        return new Response(Bun.file(cssPath), {
          headers: {
            "Content-Type": "text/css",
            "Cache-Control": "public, max-age=60",
          },
        });
      }

      // WebSocket market kline feed — proxy to market process
      if (url.pathname === "/ws/market") {
        const expectedToken = process.env.OPENCROW_WEB_TOKEN;
        if (expectedToken) {
          const protocol = req.headers.get("sec-websocket-protocol");
          const authHeader = req.headers.get("authorization");
          const bearerToken = authHeader?.startsWith("Bearer ")
            ? authHeader.slice(7)
            : null;
          const providedToken = protocol ?? bearerToken;
          if (providedToken !== expectedToken) {
            return new Response("Unauthorized", { status: 401 });
          }
        }
        const upgraded = bunServer.upgrade(req, {
          data: { kind: "market" as const, upstream: null },
        });
        if (upgraded) return undefined as unknown as Response;
        return new Response("WebSocket upgrade failed", { status: 400 });
      }

      // WebSocket system events feed — real-time dashboard updates
      if (url.pathname === "/ws/system") {
        const expectedToken = process.env.OPENCROW_WEB_TOKEN;
        if (expectedToken) {
          const protocol = req.headers.get("sec-websocket-protocol");
          const authHeader = req.headers.get("authorization");
          const bearerToken = authHeader?.startsWith("Bearer ")
            ? authHeader.slice(7)
            : null;
          const providedToken = protocol ?? bearerToken;
          if (providedToken !== expectedToken) {
            return new Response("Unauthorized", { status: 401 });
          }
        }
        const upgraded = bunServer.upgrade(req, {
          data: { kind: "system" as const, id: systemWsNextId++ },
        });
        if (upgraded) return undefined as unknown as Response;
        return new Response("WebSocket upgrade failed", { status: 400 });
      }

      // WebSocket chat — local agent execution with progress streaming
      if (url.pathname === "/ws/chat") {
        const expectedToken = process.env.OPENCROW_WEB_TOKEN;
        if (expectedToken) {
          const protocol = req.headers.get("sec-websocket-protocol");
          const authHeader = req.headers.get("authorization");
          const bearerToken = authHeader?.startsWith("Bearer ")
            ? authHeader.slice(7)
            : null;
          const providedToken = protocol ?? bearerToken;
          if (providedToken !== expectedToken) {
            return new Response("Unauthorized", { status: 401 });
          }
        }
        const upgraded = bunServer.upgrade(req, {
          data: { kind: "chat" as const, chatId: "web-default" },
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
        if (ws.data.kind === "system") {
          systemWsClients.add(ws);
          log.debug("System WS client connected", { clients: systemWsClients.size });
          return;
        }
        if (ws.data.kind === "chat") {
          log.debug("Chat WS client connected");
          return;
        }
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
          if (ws.data.kind === "market") ws.data.upstream = null;
          try {
            ws.close(1001, "upstream closed");
          } catch {
            /* already closed */
          }
        });

        upstream.addEventListener("error", (event) => {
          const errMsg = event instanceof ErrorEvent
            ? event.message || "WebSocket error"
            : String(event);
          log.warn("Upstream market WS error", { error: errMsg });
          if (ws.data.kind === "market") ws.data.upstream = null;
          try {
            ws.close(1011, "upstream error");
          } catch {
            /* already closed */
          }
        });

        if (ws.data.kind === "market") ws.data.upstream = upstream;
      },
      message(ws, msg) {
        if (ws.data.kind === "chat") {
          handleChatMessage(ws as import("bun").ServerWebSocket<{ kind: "chat"; chatId: string }>, msg);
          return;
        }
        if (ws.data.kind !== "market") return;
        const upstream = ws.data.upstream;
        if (upstream && upstream.readyState === WebSocket.OPEN) {
          upstream.send(typeof msg === "string" ? msg : new Uint8Array(msg));
        }
      },
      close(ws) {
        if (ws.data.kind === "system") {
          systemWsClients.delete(ws);
          log.debug("System WS client disconnected", { clients: systemWsClients.size });
          return;
        }
        if (ws.data.kind === "chat") {
          log.debug("Chat WS client disconnected");
          return;
        }
        log.debug("Market WS client disconnected — closing upstream");
        if (ws.data.kind !== "market") return;
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

  function safeSend(
    ws: import("bun").ServerWebSocket<WsData>,
    payload: unknown,
  ): void {
    try {
      ws.send(JSON.stringify(payload));
    } catch {
      // Client already disconnected
    }
  }

  function handleChatMessage(
    ws: import("bun").ServerWebSocket<{ kind: "chat"; chatId: string }>,
    msg: string | Buffer,
  ): void {
    const raw = typeof msg === "string" ? msg : new TextDecoder().decode(msg);

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      safeSend(ws, { type: "error", message: "Invalid JSON" });
      return;
    }

    if (parsed["type"] === "clear") {
      const chatId = (parsed["chatId"] as string | undefined) ?? ws.data.chatId;
      clearSession("web", chatId)
        .then(() => safeSend(ws, { type: "cleared" }))
        .catch((err) => safeSend(ws, { type: "error", message: String(err) }));
      return;
    }

    if (parsed["type"] === "message") {
      const text = parsed["text"] as string | undefined;
      if (!text?.trim()) {
        safeSend(ws, { type: "error", message: "Empty message" });
        return;
      }

      const chatId = (parsed["chatId"] as string | undefined) ?? ws.data.chatId;
      const agentId = parsed["agentId"] as string | undefined;

      processChatMessage(ws, chatId, text, agentId).catch((err) => {
        log.error("Chat WS message processing failed", { error: err });
        safeSend(ws, { type: "error", message: String(err) });
      });
    }
  }

  async function processChatMessage(
    ws: import("bun").ServerWebSocket<WsData>,
    chatId: string,
    text: string,
    agentId: string | undefined,
  ): Promise<void> {
    await addUserMessage("web", chatId, "web-user", text);
    const history = await getSessionHistory("web", chatId);

    const agent = agentId
      ? (ctx.agentRegistry.getById(agentId) ?? ctx.agentRegistry.getDefault())
      : ctx.agentRegistry.getDefault();

    const agentOptions = await ctx.buildOptionsForAgent(agent, (event) => {
      safeSend(ws, event);
    });

    const response = await chat(history, {
      ...agentOptions,
      usageContext: { channel: "web", chatId, source: "web" as const },
    });

    await addAssistantMessage("web", chatId, response.text);

    safeSend(ws, {
      type: "response",
      text: response.text,
      usage: response.usage,
      toolUseCount: response.toolUseCount,
    });
  }

  log.info(`OpenCrow web: http://${config.web.host}:${config.web.port}`);

  // Broadcast system status to WS clients (replaces per-client HTTP polling)
  let lastStatusJson = "";
  setInterval(async () => {
    if (systemWsClients.size === 0) return;
    try {
      const res = await webApp.fetch(
        new Request(`http://localhost:${config.web.port}/api/status`, {
          headers: process.env.OPENCROW_WEB_TOKEN
            ? { Authorization: `Bearer ${process.env.OPENCROW_WEB_TOKEN}` }
            : {},
        }),
      );
      const body = await res.json() as Record<string, unknown>;
      const json = JSON.stringify(body);
      if (json === lastStatusJson) return;
      lastStatusJson = json;
      const event = JSON.stringify({ type: "status", data: body, ts: Date.now() });
      for (const ws of systemWsClients) {
        try { ws.send(event); } catch { systemWsClients.delete(ws); }
      }
    } catch {
      // Status fetch failed — skip this tick
    }
  }, 5_000);

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
