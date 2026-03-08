import { Hono } from "hono";
import type { InternalApiDeps } from "./types";
import { chat } from "../agent/chat";
import { chatStream } from "../agent/stream";
import type { StreamEvent } from "../agent/types";
import {
  getSessionHistory,
  addUserMessage,
  addAssistantMessage,
} from "../agent/session";
import { loadConfigWithOverrides } from "../config/loader";
import type { WhatsAppChannel } from "../channels/whatsapp/client";
import { getProcessStatuses } from "../process/health";
import { sendCommand } from "../process/commands";
import type { ProcessName } from "../process/types";
import { createLogger } from "../logger";

import { getErrorMessage } from "../lib/error-serialization";
const log = createLogger("internal-api");

export function createInternalApi(deps: InternalApiDeps): Hono {
  const app = new Hono();

  // Health check
  app.get("/internal/health", (c) =>
    c.json({ status: "ok", timestamp: Date.now() }),
  );

  // --- Live status ---
  app.get("/internal/status", async (c) => {
    const channels = deps.channels ?? new Map();
    const channelStatus: Record<string, { status: string; type: string }> = {};
    if (channels.size > 0) {
      for (const [name, channel] of channels.entries()) {
        channelStatus[name] = {
          status: channel.isConnected() ? "connected" : "disconnected",
          type: name === "whatsapp" ? "whatsapp" : "telegram",
        };
      }
    } else {
      // No in-memory channels (distributed mode) — derive from process registry
      const statuses = await getProcessStatuses();
      const currentConfig = await loadConfigWithOverrides();
      const waDefaultAgent = currentConfig.channels?.whatsapp?.defaultAgent;

      for (const proc of statuses) {
        if (proc.name.startsWith("agent:")) {
          const agentId = proc.name.replace("agent:", "");
          const isWaOwner = agentId === waDefaultAgent && currentConfig.channels?.whatsapp !== undefined;
          channelStatus[proc.name] = {
            status: proc.status === "alive" ? "connected" : "disconnected",
            type: isWaOwner ? "telegram+whatsapp" : "telegram",
          };
        }
      }
    }

    const cronStatus = deps.cronScheduler
      ? await deps.cronScheduler.getStatus()
      : null;

    const marketStatus = deps.marketPipeline
      ? deps.marketPipeline.getStatus()
      : null;

    return c.json({
      channels: channelStatus,
      cron: cronStatus
        ? {
            running: cronStatus.running,
            jobCount: cronStatus.jobCount,
            nextDueAt: cronStatus.nextDueAt,
          }
        : null,
      market: marketStatus,
    });
  });

  // --- Chat execution ---
  app.post("/internal/chat", async (c) => {
    if (!deps.getDefaultAgentOptions) {
      return c.json({ error: "Chat not available on this process" }, 503);
    }

    try {
      const body = await c.req.json<{
        message: string;
        chatId?: string;
        agentId?: string;
      }>();
      const { message } = body;
      const chatId = body.chatId ?? "web-default";

      if (!message?.trim()) {
        return c.json({ error: "Message is required" }, 400);
      }

      let agentOptions = await deps.getDefaultAgentOptions();
      if (body.agentId && deps.buildAgentOptions) {
        const agent = deps.agentRegistry.getById(body.agentId);
        if (agent) {
          agentOptions = await deps.buildAgentOptions(agent);
        }
      }

      await addUserMessage("web", chatId, "web-user", message);
      const history = await getSessionHistory("web", chatId);
      const response = await chat(history, agentOptions);
      await addAssistantMessage("web", chatId, response.text);

      // Fire-and-forget observation extraction
      deps.observationHook?.afterConversation({
        agentId: agentOptions.agentId ?? "default",
        channel: "web",
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

      return c.json({
        text: response.text,
        usage: response.usage,
      });
    } catch (error) {
      log.error("Internal chat error", error);
      const chatId = "web-default";
      const errMsg = "An internal error occurred. Please try again.";
      await addAssistantMessage("web", chatId, errMsg).catch((e) =>
        log.error("Failed to save error placeholder", { error: e }),
      );
      return c.json({ error: errMsg }, 500);
    }
  });

  // --- Chat streaming ---
  app.post("/internal/chat/stream", async (c) => {
    if (!deps.getDefaultAgentOptions) {
      return c.json({ error: "Chat not available on this process" }, 503);
    }

    try {
      const body = await c.req.json<{
        message: string;
        chatId?: string;
        agentId?: string;
      }>();
      const { message } = body;
      const chatId = body.chatId ?? "web-default";

      if (!message?.trim()) {
        return c.json({ error: "Message is required" }, 400);
      }

      let agentOptions = await deps.getDefaultAgentOptions();
      if (body.agentId && deps.buildAgentOptions) {
        const agent = deps.agentRegistry.getById(body.agentId);
        if (agent) {
          agentOptions = await deps.buildAgentOptions(agent);
        }
      }

      await addUserMessage("web", chatId, "web-user", message);
      const history = await getSessionHistory("web", chatId);
      const eventStream = chatStream(history, agentOptions);

      let accumulatedText = "";
      let streamErrored = false;

      const sseStream = new ReadableStream({
        async start(controller) {
          const encoder = new TextEncoder();
          const reader = eventStream.getReader();

          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;

              const event = value as StreamEvent;
              if (event.type === "text_delta") {
                accumulatedText += event.text;
              }
              if (event.type === "error") {
                streamErrored = true;
              }

              const sseData = `data: ${JSON.stringify(event)}\n\n`;
              controller.enqueue(encoder.encode(sseData));

              if (event.type === "done" || event.type === "error") {
                controller.close();
                break;
              }
            }
          } catch (err) {
            log.error("Internal SSE read error", err);
            streamErrored = true;
            controller.close();
          } finally {
            reader.releaseLock();
            if (accumulatedText && !streamErrored) {
              addAssistantMessage("web", chatId, accumulatedText).catch((err) =>
                log.error("Failed to save streamed message", { error: err }),
              );

              // Fire-and-forget observation extraction for streamed responses
              deps.observationHook?.afterConversation({
                agentId: agentOptions.agentId ?? "default",
                channel: "web",
                chatId,
                messages: [
                  ...history,
                  {
                    role: "assistant" as const,
                    content: accumulatedText,
                    timestamp: Date.now(),
                  },
                ],
              });
            } else if (streamErrored && !accumulatedText) {
              addAssistantMessage(
                "web",
                chatId,
                "An error occurred while processing your message.",
              ).catch((e) =>
                log.error("Failed to save stream error placeholder", {
                  error: e,
                }),
              );
            }
          }
        },
      });

      return new Response(sseStream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        },
      });
    } catch (error) {
      log.error("Internal chat stream error", error);
      return c.json({ error: "Stream setup failed" }, 500);
    }
  });

  // --- Channel management ---
  app.get("/internal/channels", async (c) => {
    if (!deps.channelRegistry) {
      return c.json({ data: [] });
    }

    const plugins = deps.channelRegistry.list();
    const currentConfig = await loadConfigWithOverrides();
    const liveChannels = deps.channels ?? new Map();

    const snapshots = deps.channelManager
      ? deps.channelManager.getSnapshots(currentConfig)
      : deps.channelRegistry.getSnapshots(currentConfig, liveChannels);

    // In distributed mode (no in-memory channels), derive `connected`
    // from agent process heartbeats
    if (liveChannels.size === 0) {
      const statuses = await getProcessStatuses();
      const agentProcs = statuses.filter((p) => p.name.startsWith("agent:"));
      const anyAgentAlive = agentProcs.some((p) => p.status === "alive");

      const waDefaultAgent = currentConfig.channels?.whatsapp?.defaultAgent ?? "opencrow";
      const waProc = agentProcs.find((p) => p.name === `agent:${waDefaultAgent}`);
      const waAlive = waProc?.status === "alive";

      if (snapshots.telegram) {
        snapshots.telegram = { ...snapshots.telegram, connected: anyAgentAlive };
      }
      if (snapshots.whatsapp) {
        snapshots.whatsapp = { ...snapshots.whatsapp, connected: waAlive ?? false };
      }
    }

    const channelList = plugins.map((plugin) => ({
      id: plugin.id,
      meta: plugin.meta,
      capabilities: plugin.capabilities,
      snapshot: snapshots[plugin.id] ?? {
        enabled: false,
        configured: false,
        connected: false,
      },
    }));

    return c.json({ data: channelList });
  });

  app.post("/internal/channels/:id/:action", async (c) => {
    const id = c.req.param("id");
    const action = c.req.param("action");

    if (!deps.channelRegistry || !deps.channelManager) {
      return c.json({ error: "Channel system not initialized" }, 500);
    }

    const plugin = deps.channelRegistry.get(id);
    if (!plugin) {
      return c.json({ error: `Unknown channel: ${id}` }, 404);
    }

    try {
      const currentConfig = await loadConfigWithOverrides();

      switch (action) {
        case "restart": {
          await deps.channelManager.stopChannel(id);
          await deps.channelManager.startChannel(
            id,
            currentConfig,
            deps.messageHandler!,
          );
          const channel = deps.channelManager.getChannel(id);
          const snapshot = plugin.config.getSnapshot(currentConfig, channel);
          return c.json({ data: { snapshot } });
        }
        case "enable": {
          const { setOverride } = await import("../store/config-overrides");
          const applied = plugin.setup.applyConfig(currentConfig, {
            enabled: true,
          });
          const channelDiff = extractChannelDiff(currentConfig, applied, id);
          await setOverride("channels", id, channelDiff);
          const updated = await loadConfigWithOverrides();
          if (plugin.config.isConfigured(updated)) {
            await deps.channelManager.startChannel(
              id,
              updated,
              deps.messageHandler!,
            );
          }
          const channel = deps.channelManager.getChannel(id);
          const snapshot = plugin.config.getSnapshot(updated, channel);
          return c.json({ data: { snapshot } });
        }
        case "disable": {
          const { setOverride } = await import("../store/config-overrides");
          const applied = plugin.setup.applyConfig(currentConfig, {
            enabled: false,
          });
          const channelDiff = extractChannelDiff(currentConfig, applied, id);
          await setOverride("channels", id, channelDiff);
          await deps.channelManager.stopChannel(id);
          const updated = await loadConfigWithOverrides();
          const snapshot = plugin.config.getSnapshot(updated, undefined);
          return c.json({ data: { snapshot } });
        }
        case "setup": {
          const { setOverride } = await import("../store/config-overrides");
          const input = await c.req.json();
          const validationError = plugin.setup.validateInput(input);
          if (validationError) {
            return c.json({ error: validationError }, 400);
          }
          const applied = plugin.setup.applyConfig(currentConfig, input);
          const channelDiff = extractChannelDiff(currentConfig, applied, id);
          await setOverride("channels", id, channelDiff);
          const updated = await loadConfigWithOverrides();
          const shouldRestart =
            input.enabled !== undefined || input.botToken !== undefined;
          if (shouldRestart && plugin.config.isEnabled(updated)) {
            await deps.channelManager.stopChannel(id);
            await deps.channelManager.startChannel(
              id,
              updated,
              deps.messageHandler!,
            );
          }
          const channel = deps.channelManager.getChannel(id);
          const snapshot = plugin.config.getSnapshot(updated, channel);
          return c.json({ data: { snapshot } });
        }
        case "pair": {
          if (id !== "whatsapp") {
            return c.json({ error: "Pair only supported for WhatsApp" }, 400);
          }
          const body = await c.req.json();
          const phoneNumber = body.phoneNumber as string | undefined;
          if (!phoneNumber || !/^\d{7,15}$/.test(phoneNumber)) {
            return c.json({ error: "Invalid phone number" }, 400);
          }
          const channel = deps.channelManager.getChannel("whatsapp") as
            | WhatsAppChannel
            | undefined;
          if (!channel) {
            return c.json({ error: "WhatsApp channel is not running" }, 400);
          }
          const code = await channel.requestPairingCode(phoneNumber);
          return c.json({ data: { code } });
        }
        default:
          return c.json({ error: `Unknown action: ${action}` }, 400);
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Channel action failed";
      return c.json({ error: message }, 500);
    }
  });

  // --- Scraper actions ---
  app.post("/internal/scraper/:name/:action", async (c) => {
    const name = c.req.param("name");
    const action = c.req.param("action");

    try {
      const body = await c.req.json().catch(() => ({}));

      switch (name) {
        case "hn": {
          if (!deps.hnScraper)
            return c.json({ error: "HN scraper not running" }, 503);
          if (action === "scrape-now")
            return c.json({ data: await deps.hnScraper.scrapeNow() });
          if (action === "backfill-rag")
            return c.json({ data: await deps.hnScraper.backfillRag() });
          break;
        }
        case "hf": {
          if (!deps.hfScraper)
            return c.json({ error: "HF scraper not running" }, 503);
          if (action === "scrape-now")
            return c.json({ data: await deps.hfScraper.scrapeNow() });
          if (action === "backfill-rag")
            return c.json({ data: await deps.hfScraper.backfillRag() });
          break;
        }
        case "reddit": {
          if (!deps.redditScraper)
            return c.json({ error: "Reddit scraper not running" }, 503);
          if (action === "scrape-now") {
            const accountId = (body as Record<string, string>).accountId ?? "";
            return c.json({
              data: await deps.redditScraper.scrapeNow(accountId),
            });
          }
          if (action === "backfill-rag")
            return c.json({ data: await deps.redditScraper.backfillRag() });
          break;
        }
        case "github": {
          if (!deps.githubScraper)
            return c.json({ error: "GitHub scraper not running" }, 503);
          if (action === "scrape-now")
            return c.json({ data: await deps.githubScraper.scrapeNow() });
          if (action === "backfill-rag")
            return c.json({ data: await deps.githubScraper.backfillRag() });
          break;
        }
        case "google-trends": {
          if (action === "backfill-rag" && deps.memoryManager) {
            const { getUnindexedTrends, markTrendsIndexed } =
              await import("../sources/google-trends/store");
            const { rowsToTrendsForIndex } =
              await import("../sources/google-trends/scraper");
            let totalIndexed = 0;
            while (true) {
              const unindexed = await getUnindexedTrends(50);
              if (unindexed.length === 0) break;
              const forIndex = rowsToTrendsForIndex(unindexed);
              const ids = unindexed.map((t) => t.id);
              await deps.memoryManager.indexTrends("google-trends", forIndex);
              await markTrendsIndexed(ids);
              totalIndexed += forIndex.length;
            }
            return c.json({ data: { indexed: totalIndexed } });
          }
          break;
        }
        case "ph": {
          if (!deps.phScraper)
            return c.json({ error: "PH scraper not running" }, 503);
          if (action === "scrape-now") {
            return c.json({ data: await deps.phScraper.scrapeNow() });
          }
          if (action === "backfill-rag")
            return c.json({ data: await deps.phScraper.backfillRag() });
          break;
        }
        case "news": {
          if (!deps.newsProcessor)
            return c.json({ error: "News processor not running" }, 503);
          if (action === "scrape-now") {
            const source = (body as Record<string, string>).source ?? "";
            return c.json({
              data: await deps.newsProcessor.scrapeNow(source as never),
            });
          }
          break;
        }
        case "x-bookmarks": {
          if (!deps.bookmarkProcessor)
            return c.json({ error: "Bookmark processor not running" }, 503);
          if (action === "share-now") {
            const accountId = (body as Record<string, string>).accountId ?? "";
            return c.json({
              data: await deps.bookmarkProcessor.shareNow(accountId),
            });
          }
          break;
        }
        case "x-interactions": {
          if (!deps.autolikeProcessor)
            return c.json({ error: "Autolike processor not running" }, 503);
          if (action === "run-now") {
            const accountId = (body as Record<string, string>).accountId ?? "";
            return c.json({
              data: await deps.autolikeProcessor.runNow(accountId),
            });
          }
          break;
        }
        case "x-follow": {
          if (!deps.autofollowProcessor)
            return c.json({ error: "Autofollow processor not running" }, 503);
          if (action === "run-now") {
            const accountId = (body as Record<string, string>).accountId ?? "";
            return c.json({
              data: await deps.autofollowProcessor.runNow(accountId),
            });
          }
          break;
        }
        case "x-timeline": {
          if (!deps.timelineScrapeProcessor)
            return c.json({ error: "Timeline processor not running" }, 503);
          if (action === "run-now") {
            const accountId = (body as Record<string, string>).accountId ?? "";
            return c.json({
              data: await deps.timelineScrapeProcessor.runNow(accountId),
            });
          }
          if (action === "backfill-rag")
            return c.json({
              data: await deps.timelineScrapeProcessor.backfillRag(),
            });
          break;
        }
        default:
          return c.json({ error: `Unknown scraper: ${name}` }, 404);
      }

      return c.json({ error: `Unknown action: ${action}` }, 400);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Scraper action failed";
      log.error("Internal scraper action error", {
        name,
        action,
        error: message,
      });
      return c.json({ error: message }, 500);
    }
  });

  // --- Cron run now ---
  app.post("/internal/cron/jobs/:id/run", async (c) => {
    if (!deps.cronScheduler) {
      return c.json({ error: "Cron not enabled" }, 503);
    }
    try {
      const id = c.req.param("id");
      await deps.cronScheduler.runJobNow(id);
      return c.json({ ok: true });
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      return c.json({ error: msg }, 500);
    }
  });

  // --- Cron status ---
  app.get("/internal/cron/status", async (c) => {
    if (!deps.cronScheduler) {
      return c.json({ error: "Cron not enabled" }, 503);
    }
    const status = await deps.cronScheduler.getStatus();
    return c.json({
      data: {
        running: status.running,
        jobCount: status.jobCount,
        nextDueAt: status.nextDueAt,
      },
    });
  });

  // --- Market status ---
  app.get("/internal/market/status", async (c) => {
    // Monolith mode: local pipeline available
    if (deps.marketPipeline) {
      return c.json({ data: deps.marketPipeline.getStatus() });
    }

    // Distributed mode: proxy to market process
    try {
      const resp = await fetch("http://127.0.0.1:48084/health", {
        signal: AbortSignal.timeout(3000),
      });
      if (!resp.ok) {
        return c.json({ error: `Market process returned ${resp.status}` }, 503);
      }
      const body = (await resp.json()) as { pipeline?: unknown };
      return c.json({ data: body.pipeline ?? null });
    } catch (err) {
      return c.json(
        {
          error: `Market process unreachable: ${getErrorMessage(err)}`,
        },
        503,
      );
    }
  });

  // --- Process management ---
  app.get("/internal/processes", async (c) => {
    try {
      const statuses = await getProcessStatuses();
      return c.json({ data: statuses });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to list processes";
      log.error("Failed to list processes", { error: message });
      return c.json({ error: message }, 500);
    }
  });

  app.post("/internal/processes/:name/restart", async (c) => {
    const name = c.req.param("name");
    try {
      if (deps.orchestrator) {
        await deps.orchestrator.restartProcess(name);
        return c.json({ ok: true });
      }
      const commandId = await sendCommand(name as ProcessName, "restart");
      return c.json({ ok: true, commandId });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Failed to send restart command";
      log.error("Failed to restart process", { name, error: message });
      return c.json({ error: message }, 500);
    }
  });

  app.post("/internal/processes/:name/stop", async (c) => {
    const name = c.req.param("name");
    try {
      if (deps.orchestrator) {
        await deps.orchestrator.stopProcess(name);
        return c.json({ ok: true });
      }
      const commandId = await sendCommand(name as ProcessName, "stop");
      return c.json({ ok: true, commandId });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to send stop command";
      log.error("Failed to stop process", { name, error: message });
      return c.json({ error: message }, 500);
    }
  });

  app.post("/internal/processes/:name/start", async (c) => {
    const name = c.req.param("name");
    try {
      if (deps.orchestrator) {
        deps.orchestrator.startProcess(name);
        return c.json({ ok: true });
      }
      return c.json({ error: "Orchestrator not enabled" }, 503);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to start process";
      log.error("Failed to start process", { name, error: message });
      return c.json({ error: message }, 500);
    }
  });

  // --- Orchestrator state ---
  app.get("/internal/orchestrator/state", (c) => {
    if (!deps.orchestrator) {
      return c.json({ data: null });
    }
    return c.json({ data: deps.orchestrator.getState() });
  });

  return app;
}

function extractChannelDiff(
  before: { channels: Record<string, unknown> },
  after: { channels: Record<string, unknown> },
  channelId: string,
): Record<string, unknown> {
  const afterChannel = (after.channels[channelId] ?? {}) as Record<
    string,
    unknown
  >;
  const beforeChannel = (before.channels[channelId] ?? {}) as Record<
    string,
    unknown
  >;

  const diff: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(afterChannel)) {
    if (JSON.stringify(value) !== JSON.stringify(beforeChannel[key])) {
      diff[key] = value;
    }
  }

  return diff;
}
