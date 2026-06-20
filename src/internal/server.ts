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
import type { Context } from "hono";
import { createLogger } from "../logger";

const log = createLogger("internal-api");

/**
 * Header an agent-caller (the process_manage tool) sets to advertise its own
 * process identity. Operator/web callers (core-client) do NOT set it, which is
 * how we distinguish operator capability from agent capability — the shared
 * bearer token authorizes ANY caller, so auth alone cannot tell them apart.
 */
export const CALLER_PROCESS_HEADER = "x-opencrow-caller-process";

/**
 * Shared infrastructure processes that host the orchestrator's clients and/or
 * the agent/SIGE/pipeline runs themselves in-process. An agent caller resolves
 * its own identity from env (see self-restart.ts `getOwnProcessName`), and a
 * run triggered via the dashboard executes INSIDE the `web` process — so its
 * caller identity is literally `web`. A naive "self" check (caller === target)
 * therefore lets such a run restart `web`, which kills the run, which resumes
 * and re-issues the restart: a self-inflicted restart loop.
 *
 * These processes may only be restarted/stopped by an operator (no caller
 * header). An agent self-targeting one of them is never legitimate.
 */
const PROTECTED_SHARED_PROCESSES: ReadonlySet<string> = new Set([
  "web",
  "cron",
  "core",
]);

/**
 * Outcome of the self-only authorization decision. When `allowed` is false,
 * `status` and `error` carry the HTTP response the route should return.
 */
export type SelfOnlyDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly status: 403; readonly error: string };

/**
 * Pure self-only authorization decision for process control. When the
 * caller-process header is present (an agent), the agent may only act on the
 * process it owns; any other target is denied with 403. Operator/web callers
 * (no header) keep full power. This is the authoritative check — the tool-side
 * check in self-restart.ts is defense-in-depth only.
 *
 * Additionally, an agent caller may NOT act on a shared infrastructure process
 * ({@link PROTECTED_SHARED_PROCESSES}) even when it appears to be a self-match:
 * agents and dashboard-triggered SIGE/pipeline runs execute in-process under
 * `web`, so caller === target === "web" otherwise lets a run restart the very
 * process it runs in, killing itself in a loop. Operators (no header) keep full
 * power over these processes.
 *
 * Kept pure (no Hono `Context`, no logging) so it is directly unit-testable.
 */
export function decideSelfOnlyProcessControl(
  caller: string | undefined,
  target: string,
  action: string,
): SelfOnlyDecision {
  if (!caller) return { allowed: true }; // operator capability — full power
  if (PROTECTED_SHARED_PROCESSES.has(target)) {
    return {
      allowed: false,
      status: 403,
      error: `Self-only: agent '${caller}' may not ${action} shared infrastructure process '${target}' (it runs in-process and would loop). Only an operator can.`,
    };
  }
  if (caller === target) return { allowed: true }; // self — allowed
  return {
    allowed: false,
    status: 403,
    error: `Self-only: '${caller}' may not ${action} '${target}'. Cross-process control requires an operator.`,
  };
}

/**
 * Route-level wrapper around {@link decideSelfOnlyProcessControl}: reads the
 * caller header from the request, logs denials, and returns a 403 `Response`
 * when the action is not permitted (or `null` to continue).
 */
function enforceSelfOnlyProcessControl(
  c: Context,
  target: string,
  action: string,
): Response | null {
  const caller = c.req.header(CALLER_PROCESS_HEADER);
  const decision = decideSelfOnlyProcessControl(caller, target, action);
  if (decision.allowed) return null;
  log.warn("Self-only process control: rejected cross-process action", {
    caller,
    target,
    action,
  });
  return c.json({ error: decision.error }, decision.status);
}

export function createInternalApi(deps: InternalApiDeps): Hono {
  const app = new Hono();

  // Health check — unauthenticated (used for liveness probes)
  app.get("/internal/health", (c) =>
    c.json({ status: "ok", timestamp: Date.now() }),
  );

  // Auth middleware for all other internal endpoints — FAIL-CLOSED.
  // /internal/health is registered above and is intentionally exempt (liveness probes).
  // IMPORTANT: any route registered BEFORE this middleware is also exempt — keep health first.
  //
  // The internal control-plane exposes privileged primitives (full shell/db/deploy
  // via /internal/chat, plus process start/stop/restart and scraper control). It MUST
  // never be reachable without a configured token. When no token is configured (neither
  // DB-stored secret nor env), we reject every privileged request with 503 instead of
  // allowing it through (which would leave the control plane wide open).
  //
  // The token is resolved per-request via getSecret() so DB-stored rotations take effect
  // without a restart — mirroring how the web token is resolved in src/web/app.ts.
  if (!process.env.OPENCROW_INTERNAL_TOKEN) {
    log.warn(
      "OPENCROW_INTERNAL_TOKEN not in env — checking DB per request; internal API is fail-closed until a token is configured",
    );
  }

  app.use("/internal/*", async (c, next) => {
    const { getSecret } = await import("../config/secrets");
    let internalToken: string | undefined;
    try {
      internalToken = await getSecret("OPENCROW_INTERNAL_TOKEN");
    } catch (error) {
      log.error("Failed to resolve internal token — failing closed", { error });
      return c.json(
        { error: "Internal API auth unavailable" },
        503,
      );
    }

    // Fail closed: no token configured means the control plane is locked down.
    if (!internalToken) {
      log.error(
        "Internal API request rejected — OPENCROW_INTERNAL_TOKEN is not configured (fail-closed)",
        { path: c.req.path },
      );
      return c.json(
        {
          error:
            "Internal API is not configured. Set OPENCROW_INTERNAL_TOKEN to enable the control plane.",
        },
        503,
      );
    }

    const authHeader = c.req.header("authorization");
    const bearerToken = authHeader?.startsWith("Bearer ")
      ? authHeader.slice(7)
      : null;
    if (bearerToken !== internalToken) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    await next();
  });

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

    return c.json({
      channels: channelStatus,
      cron: cronStatus
        ? {
            running: cronStatus.running,
            jobCount: cronStatus.jobCount,
            nextDueAt: cronStatus.nextDueAt,
          }
        : null,
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

    if (!deps.channelRegistry) {
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
          if (!deps.channelManager) {
            return c.json({ error: "Channel manager not available in this process" }, 500);
          }
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
          if (deps.channelManager && plugin.config.isConfigured(updated)) {
            await deps.channelManager.startChannel(
              id,
              updated,
              deps.messageHandler!,
            );
          }
          const channel = deps.channelManager?.getChannel(id);
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
          if (deps.channelManager) {
            await deps.channelManager.stopChannel(id);
          }
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
          if (deps.channelManager && shouldRestart && plugin.config.isEnabled(updated)) {
            await deps.channelManager.stopChannel(id);
            await deps.channelManager.startChannel(
              id,
              updated,
              deps.messageHandler!,
            );
          }
          const channel = deps.channelManager?.getChannel(id);
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

          // Try channelManager first (agent process)
          let waChannel = deps.channelManager?.getChannel("whatsapp") as
            | WhatsAppChannel
            | undefined;

          // If no channelManager (core process), create a temporary channel for pairing
          if (!waChannel) {
            const { createWhatsAppChannel } = await import("../channels/whatsapp/client");
            const tempChannel = createWhatsAppChannel("pairing");
            await tempChannel.connect();
            const code = await tempChannel.requestPairingCode(phoneNumber);
            // Don't disconnect — keep auth session alive for agent to pick up
            return c.json({ data: { code } });
          }

          const code = await waChannel.requestPairingCode(phoneNumber);
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
    const denial = enforceSelfOnlyProcessControl(c, name, "restart");
    if (denial) return denial;
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
    const denial = enforceSelfOnlyProcessControl(c, name, "stop");
    if (denial) return denial;
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
    const denial = enforceSelfOnlyProcessControl(c, name, "start");
    if (denial) return denial;
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
