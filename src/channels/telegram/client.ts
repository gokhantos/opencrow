import { Bot, InputFile, InlineKeyboard } from "grammy";
import type {
  Channel,
  MessageHandler,
  MessageContent,
  ChannelName,
} from "../types";
import { createTelegramHandler } from "./handler";
import { markdownToTelegramHtml } from "./format";
import { createLogger } from "../../logger";
import { createSendQueue } from "./send-queue";

function tokenTag(token: string): string {
  const parts = token.split(":");
  return parts[0] ?? token.slice(0, 6);
}

/** Check if an error is a 409 getUpdates conflict. */
function isGetUpdatesConflict(err: unknown): boolean {
  const msg =
    err instanceof Error ? err.message : typeof err === "string" ? err : "";
  return msg.includes("409") && msg.toLowerCase().includes("getupdates");
}

export function createTelegramChannel(botToken: string): Channel {
  const log = createLogger(`tg:${tokenTag(botToken)}`);
  const bot = new Bot(botToken);
  const sendQ = createSendQueue();
  let messageHandler: MessageHandler | null = null;
  let connected = false;
  let connecting = false;
  let handlersRegistered = false;
  let abortController: AbortController | null = null;

  bot.catch((err) => {
    log.error("grammY middleware error", { error: err.message ?? err });
  });

  // Register grammY handlers exactly once
  function ensureHandlers(): void {
    if (handlersRegistered) return;
    handlersRegistered = true;

    createTelegramHandler(bot, (msg) => {
      if (messageHandler) {
        return messageHandler(msg);
      }
      return Promise.resolve();
    });
  }

  /**
   * Simple serial polling loop — only ONE getUpdates call at a time.
   * Avoids the @grammyjs/runner's concurrent supplier model that causes
   * overlapping sessions and perpetual 409 conflicts.
   */
  async function pollLoop(signal: AbortSignal): Promise<void> {
    let offset = 0;
    let consecutive409 = 0;
    const MAX_409 = 20;

    while (!signal.aborted) {
      try {
        const updates = await bot.api.getUpdates({
          offset,
          limit: 100,
          timeout: 30,
        });
        consecutive409 = 0; // reset on success
        connected = true;

        for (const update of updates) {
          offset = update.update_id + 1;
          try {
            await bot.handleUpdate(update);
          } catch (err) {
            log.error("Error handling update", {
              updateId: update.update_id,
              error: err,
            });
          }
        }
      } catch (err) {
        if (signal.aborted) return;

        if (isGetUpdatesConflict(err)) {
          consecutive409++;
          if (consecutive409 > MAX_409) {
            log.error("Too many 409 conflicts, giving up", {
              count: consecutive409,
            });
            connected = false;
            return;
          }
          // Wait 5s — enough for any previous session to fully expire
          log.warn("409 conflict, waiting", { attempt: consecutive409 });
          await new Promise((r) => setTimeout(r, 5_000));
          continue;
        }

        // Network or other transient error — short backoff
        const msg = err instanceof Error ? err.message : String(err);
        log.error("getUpdates error", { error: msg });
        connected = false;
        await new Promise((r) => setTimeout(r, 3_000));
      }
    }
  }

  const channel: Channel = {
    name: "telegram" as ChannelName,

    async connect() {
      if (connected || connecting) {
        log.warn("Telegram already connected or connecting");
        return;
      }
      connecting = true;

      try {
        ensureHandlers();
        await bot.init();
        await bot.api.deleteWebhook({ drop_pending_updates: false });

        // Flush any in-flight getUpdates from a stale process — forces their 409 immediately
        await bot.api.getUpdates({ offset: -1, limit: 1, timeout: 0 });

        abortController = new AbortController();
        // Run poll loop in background — don't await it (it runs until disconnect)
        pollLoop(abortController.signal).catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          log.error("Poll loop exited with error", { error: msg });
          connected = false;
        });

        // Give the first getUpdates a moment
        await new Promise((r) => setTimeout(r, 500));
        connected = true;

        log.info("Telegram channel connected", {
          username: bot.botInfo.username,
        });
      } finally {
        connecting = false;
      }
    },

    async disconnect() {
      if (!connected && !abortController) return;
      connected = false;

      // Signal the poll loop to stop
      abortController?.abort();
      abortController = null;

      log.info("Telegram bot stopped");
    },

    async sendMessage(
      chatId: string,
      content: MessageContent,
    ): Promise<number | void> {
      const numericChatId = Number(chatId);

      if (content.media?.buffer) {
        const inputFile = new InputFile(content.media.buffer);
        const rawCaption = content.media.caption ?? content.text;
        const caption = rawCaption
          ? markdownToTelegramHtml(rawCaption)
          : undefined;
        const sendMedia = async (
          method: "sendPhoto" | "sendDocument" | "sendAudio" | "sendVideo",
        ): Promise<number> => {
          try {
            const msg = await sendQ.enqueue(() =>
              bot.api[method](numericChatId, inputFile, {
                caption,
                parse_mode: "HTML",
              }) as Promise<{ message_id: number }>,
            );
            return msg.message_id;
          } catch {
            log.warn("HTML parse failed in caption, retrying as plain text", {
              chatId,
            });
            const msg = await sendQ.enqueue(() =>
              bot.api[method](numericChatId, inputFile, {
                caption: rawCaption,
              }) as Promise<{ message_id: number }>,
            );
            return msg.message_id;
          }
        };
        switch (content.media.type) {
          case "image":
            return sendMedia("sendPhoto");
          case "document":
            return sendMedia("sendDocument");
          case "audio":
            return sendMedia("sendAudio");
          case "video":
            return sendMedia("sendVideo");
        }
      }

      if (content.text) {
        // Build inline keyboard if buttons provided
        let reply_markup: InlineKeyboard | undefined;
        if (content.inlineButtons && content.inlineButtons.length > 0) {
          const kb = new InlineKeyboard();
          for (const row of content.inlineButtons) {
            for (const btn of row) {
              kb.text(btn.label, btn.callbackData);
            }
            kb.row();
          }
          reply_markup = kb;
        }

        // Convert markdown to HTML; if parseAsHtml is already set, skip conversion
        const htmlText = content.parseAsHtml
          ? content.text
          : markdownToTelegramHtml(content.text);

        try {
          const msg = await sendQ.enqueue(() =>
            bot.api.sendMessage(numericChatId, htmlText, {
              parse_mode: "HTML",
              reply_markup,
            }),
          );
          return msg.message_id;
        } catch {
          log.warn("HTML parse failed, retrying as plain text", { chatId });
          const msg = await sendQ.enqueue(() =>
            bot.api.sendMessage(numericChatId, content.text!, {
              reply_markup,
            }),
          );
          return msg.message_id;
        }
      }
    },

    async editMessage(chatId: string, messageId: number, text: string) {
      const isNotModified = (e: unknown): boolean =>
        e instanceof Error && e.message.includes("message is not modified");

      try {
        await sendQ.enqueue(() =>
          bot.api.editMessageText(Number(chatId), messageId, text, {
            parse_mode: "HTML",
          }),
        );
      } catch (err) {
        if (isNotModified(err)) return;
        try {
          await sendQ.enqueue(() =>
            bot.api.editMessageText(Number(chatId), messageId, text),
          );
        } catch (retryErr) {
          if (isNotModified(retryErr)) return;
          log.warn("editMessage failed", {
            chatId,
            messageId,
            error: retryErr,
          });
        }
      }
    },

    async deleteMessage(chatId: string, messageId: number) {
      try {
        await sendQ.enqueue(() =>
          bot.api.deleteMessage(Number(chatId), messageId),
        );
      } catch {
        // best-effort — message may already be gone
      }
    },

    async sendTyping(chatId: string) {
      try {
        await sendQ.enqueue(() =>
          bot.api.sendChatAction(Number(chatId), "typing"),
        );
      } catch {
        // non-fatal
      }
    },

    onMessage(handler: MessageHandler) {
      messageHandler = handler;
    },

    isConnected() {
      return connected;
    },
  };

  return channel;
}
