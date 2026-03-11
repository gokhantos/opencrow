import { Hono } from "hono";
import type { WebAppDeps } from "../app";
import {
  getMessagesByChat,
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

      const chatId = "web-default";
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

export function renderChatPage(token?: string): string {
  return getChatStyles() + getChatHtml() + getChatScript(token);
}

function getChatStyles(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>OpenCrow Chat</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0a0a0a; color: #e0e0e0; height: 100vh; display: flex; flex-direction: column; }
    .header { padding: 1rem 1.5rem; border-bottom: 1px solid #222; display: flex; justify-content: space-between; align-items: center; }
    .header h1 { font-size: 1.2rem; }
    .header-actions { display: flex; gap: 0.5rem; }
    .header-actions button, .header-actions a { padding: 0.4rem 0.8rem; background: #222; border: 1px solid #333; border-radius: 6px; color: #ccc; cursor: pointer; font-size: 0.85rem; text-decoration: none; }
    .header-actions button:hover, .header-actions a:hover { background: #333; }
    .messages { flex: 1; overflow-y: auto; padding: 1.5rem; display: flex; flex-direction: column; gap: 1rem; }
    .message { max-width: 80%; padding: 0.75rem 1rem; border-radius: 12px; line-height: 1.5; white-space: pre-wrap; word-wrap: break-word; }
    .message.user { align-self: flex-end; background: #1e40af; color: #fff; border-bottom-right-radius: 4px; }
    .message.assistant { align-self: flex-start; background: #1a1a1a; border: 1px solid #333; border-bottom-left-radius: 4px; }
    .message.system { align-self: center; color: #666; font-size: 0.85rem; font-style: italic; }
    .input-area { padding: 1rem 1.5rem; border-top: 1px solid #222; display: flex; gap: 0.75rem; }
    .input-area textarea { flex: 1; padding: 0.75rem; background: #1a1a1a; border: 1px solid #333; border-radius: 8px; color: #e0e0e0; font-size: 1rem; resize: none; font-family: inherit; min-height: 44px; max-height: 120px; }
    .input-area textarea:focus { outline: none; border-color: #2563eb; }
    .input-area button { padding: 0.75rem 1.5rem; background: #2563eb; border: none; border-radius: 8px; color: #fff; cursor: pointer; font-size: 1rem; }
    .input-area button:hover { background: #1d4ed8; }
    .input-area button:disabled { background: #333; cursor: not-allowed; }
    .typing { color: #888; font-style: italic; padding: 0.5rem 1rem; }
  </style>
</head>`;
}

function getChatHtml(): string {
  return `<body>
  <div class="header">
    <h1>OpenCrow</h1>
    <div class="header-actions">
      <button onclick="clearChat()">Clear</button>
      <a href="/">Dashboard</a>
    </div>
  </div>
  <div class="messages" id="messages">
    <div class="message system">Send a message to start chatting with OpenCrow.</div>
  </div>
  <div class="input-area">
    <textarea id="input" placeholder="Type a message..." rows="1"
      onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();sendMessage()}"></textarea>
    <button id="send-btn" onclick="sendMessage()">Send</button>
  </div>`;
}

function getChatScript(token?: string): string {
  const headersObj = token
    ? `{ 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + ${JSON.stringify(token)} }`
    : `{ 'Content-Type': 'application/json' }`;

  const fetchHeaders = token
    ? `{ headers: { 'Authorization': 'Bearer ' + ${JSON.stringify(token)} } }`
    : `{}`;

  return `<script>
    var messagesEl = document.getElementById('messages');
    var inputEl = document.getElementById('input');
    var sendBtn = document.getElementById('send-btn');
    inputEl.addEventListener('input', function() {
      inputEl.style.height = 'auto';
      inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
    });
    async function sendMessage() {
      var text = inputEl.value.trim();
      if (!text) return;
      inputEl.value = '';
      inputEl.style.height = 'auto';
      sendBtn.disabled = true;
      appendMessage('user', text);
      var typingEl = appendTyping();
      try {
        var res = await fetch('/api/chat', {
          method: 'POST',
          headers: ${headersObj},
          body: JSON.stringify({ message: text })
        });
        var data = await res.json();
        typingEl.remove();
        if (data.success) { appendMessage('assistant', data.data.text); }
        else { appendMessage('system', 'Error: ' + data.error); }
      } catch (err) {
        typingEl.remove();
        appendMessage('system', 'Failed to send message.');
      } finally {
        sendBtn.disabled = false;
        inputEl.focus();
      }
    }
    function appendMessage(role, text) {
      var div = document.createElement('div');
      div.className = 'message ' + role;
      div.textContent = text;
      messagesEl.appendChild(div);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
    function appendTyping() {
      var div = document.createElement('div');
      div.className = 'typing';
      div.textContent = 'OpenCrow is thinking...';
      messagesEl.appendChild(div);
      messagesEl.scrollTop = messagesEl.scrollHeight;
      return div;
    }
    async function clearChat() {
      await fetch('/api/chat/clear', { method: 'POST', headers: ${headersObj} });
      messagesEl.innerHTML = '<div class="message system">Session cleared.</div>';
    }
    (async function() {
      try {
        var res = await fetch('/api/messages?channel=web&chatId=web-default', ${fetchHeaders});
        var data = await res.json();
        if (data.success && data.data.length > 0) {
          messagesEl.innerHTML = '';
          for (var i = 0; i < data.data.length; i++) {
            appendMessage(data.data[i].role, data.data[i].content);
          }
        }
      } catch(e) {}
    })();
  </script>
</body>
</html>`;
}
