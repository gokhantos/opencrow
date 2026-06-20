import { Hono } from "hono";
import type { WebAppDeps } from "../app";
import {
  getMessagesByChatPaginated,
  getRecentMessages,
} from "../../store/messages";
import { getAllSessions } from "../../store/sessions";
import {
  getSessionHistory,
  addUserMessage,
  addAssistantMessage,
  clearSession,
} from "../../agent/session";
import { chat } from "../../agent/chat";
import { chatStream } from "../../agent/stream";
import type { StreamEvent } from "../../agent/types";
import { createLogger } from "../../logger";

const log = createLogger("web-chat");

function clampLimit(raw: string | undefined): number {
  const n = Number(raw ?? "50");
  if (Number.isNaN(n)) return 50;
  return Math.max(1, Math.min(n, 200));
}

export function createChatRoutes(deps: WebAppDeps): Hono {
  const app = new Hono();

  app.get("/messages", async (c) => {
    const channel = c.req.query("channel");
    const chatId = c.req.query("chatId");
    const limit = clampLimit(c.req.query("limit"));
    const before = c.req.query("before"); // cursor: message ID

    if (channel && chatId) {
      const result = await getMessagesByChatPaginated(
        channel,
        chatId,
        limit,
        before || undefined,
      );
      return c.json({
        success: true,
        data: result.messages,
        meta: { nextCursor: result.nextCursor },
      });
    }

    const messages = await getRecentMessages(limit);
    return c.json({ success: true, data: messages });
  });

  app.post("/chat", async (c) => {
    let chatId = "web-default";
    try {
      const body = await c.req.json<{
        message: string;
        chatId?: string;
        agentId?: string;
      }>();
      const { message } = body;
      chatId = body.chatId ?? "web-default";

      if (!message?.trim()) {
        return c.json({ success: false, error: "Message is required" }, 400);
      }
      if (message.length > 100_000) {
        return c.json({ success: false, error: "Message too long" }, 413);
      }

      // Proxy to core process when running as standalone web
      if (deps.coreClient) {
        try {
          const result = await deps.coreClient.chat({
            message,
            chatId,
            agentId: body.agentId,
          });
          return c.json({ success: true, data: result });
        } catch (err) {
          const status = (err as { status?: number }).status;
          // Fall through to local handling if core doesn't support chat (503)
          if (status !== 503) {
            log.error("Core proxy chat error", err);
            return c.json(
              {
                success: false,
                error: "An internal error occurred. Please try again.",
              },
              500,
            );
          }
          log.info("Core does not support chat, falling back to local");
        }
      }

      let agentOptions: import("../../agent/types").AgentOptions;
      if (body.agentId && deps.buildAgentOptions) {
        const agent = deps.agentRegistry.getById(body.agentId);
        agentOptions = agent
          ? await deps.buildAgentOptions(agent)
          : await deps.getDefaultAgentOptions();
      } else {
        agentOptions = await deps.getDefaultAgentOptions();
      }
      agentOptions = {
        ...agentOptions,
        usageContext: { channel: "web", chatId, source: "web" as const },
      };

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
        success: true,
        data: {
          text: response.text,
          usage: response.usage,
        },
      });
    } catch (error) {
      log.error("Chat error", error);

      const errMsg = "An internal error occurred. Please try again.";
      await addAssistantMessage("web", chatId, errMsg).catch((e) =>
        log.error("Failed to save error placeholder", { error: e }),
      );

      return c.json({ success: false, error: errMsg }, 500);
    }
  });

  app.post("/chat/stream", async (c) => {
    try {
      const body = await c.req.json<{
        message: string;
        chatId?: string;
        agentId?: string;
      }>();
      const { message } = body;
      const chatId = body.chatId ?? "web-default";

      if (!message?.trim()) {
        return c.json({ success: false, error: "Message is required" }, 400);
      }
      if (message.length > 100_000) {
        return c.json({ success: false, error: "Message too long" }, 413);
      }

      // Proxy to core process when running as standalone web
      if (deps.coreClient) {
        try {
          const coreRes = await deps.coreClient.chatStream({
            message,
            chatId,
            agentId: body.agentId,
          });
          return new Response(coreRes.body, {
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
              "X-Accel-Buffering": "no",
            },
          });
        } catch (err) {
          log.error("Core proxy stream error", err);
          return c.json(
            {
              success: false,
              error: "An internal error occurred. Please try again.",
            },
            500,
          );
        }
      }

      let agentOptions: import("../../agent/types").AgentOptions;
      if (body.agentId && deps.buildAgentOptions) {
        const agent = deps.agentRegistry.getById(body.agentId);
        agentOptions = agent
          ? await deps.buildAgentOptions(agent)
          : await deps.getDefaultAgentOptions();
      } else {
        agentOptions = await deps.getDefaultAgentOptions();
      }
      agentOptions = {
        ...agentOptions,
        usageContext: { channel: "web", chatId, source: "web" as const },
      };

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
            log.error("SSE read error", err);
            streamErrored = true;
            controller.close();
          } finally {
            reader.releaseLock();
            // Only save if we got text — avoids orphaned user message with no assistant reply
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
              // Save a placeholder to keep history alternating (user/assistant)
              log.warn(
                "Stream failed before producing text, saving error placeholder",
                { chatId },
              );
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
      log.error("Chat stream setup error", error);
      return c.json(
        {
          success: false,
          error: "An internal error occurred. Please try again.",
        },
        500,
      );
    }
  });

  app.post("/chat/clear", async (c) => {
    const chatId = c.req.query("chatId") ?? "web-default";
    await clearSession("web", chatId);
    return c.json({ success: true });
  });

  app.get("/sessions", async (c) => {
    const sessions = await getAllSessions();
    return c.json({ success: true, data: sessions });
  });

  return app;
}
