import type { Bot, Context } from "grammy";
import { sequentialize } from "@grammyjs/runner";
import type { IncomingMessage, MessageHandler } from "../types";
import { getQuestionBus } from "../../agent/question-bus";
import { clearObservationsByChat } from "../../store/observations";
import { createLogger } from "../../logger";

const log = createLogger("telegram-handler");

export function createTelegramHandler(
  bot: Bot,
  onMessage: MessageHandler,
): void {
  // Queue messages per-chat so only one processes at a time.
  // Commands (/, /stop, /clear) bypass the queue for immediate execution.
  bot.use(
    sequentialize((ctx) => {
      const text = ctx.message?.text ?? "";
      if (text.startsWith("/")) return undefined; // commands bypass queue
      return ctx.chat?.id.toString(); // regular messages queue per-chat
    }),
  );

  bot.command("stop", async (ctx) => {
    const chatId = String(ctx.chat.id);
    const senderId = String(ctx.from?.id ?? "unknown");

    await onMessage({
      id: String(ctx.message?.message_id ?? crypto.randomUUID()),
      channel: "telegram",
      chatId,
      senderId,
      senderName: ctx.from?.first_name,
      content: { text: "/stop" },
      timestamp: ctx.message?.date ?? Math.floor(Date.now() / 1000),
    });
  });

  bot.command("clear", async (ctx) => {
    const chatId = String(ctx.chat.id);
    const senderId = String(ctx.from?.id ?? "unknown");

    await onMessage({
      id: String(ctx.message?.message_id ?? crypto.randomUUID()),
      channel: "telegram",
      chatId,
      senderId,
      senderName: ctx.from?.first_name,
      content: { text: "/clear" },
      timestamp: ctx.message?.date ?? Math.floor(Date.now() / 1000),
    });
  });

  bot.command("status", async (ctx) => {
    await ctx.reply("OpenCrow is online.");
  });

  bot.command("clearobs", async (ctx) => {
    const chatId = String(ctx.chat.id);
    try {
      const count = await clearObservationsByChat("telegram", chatId);
      await ctx.reply(`Cleared ${count} observation${count === 1 ? "" : "s"}.`);
    } catch (error) {
      log.error("Failed to clear observations", { chatId, error });
      await ctx.reply("Failed to clear observations.");
    }
  });

  // Handle inline keyboard button clicks
  bot.on("callback_query:data", async (ctx) => {
    const chatId = String(ctx.chat?.id ?? ctx.callbackQuery.message?.chat.id);
    const data = ctx.callbackQuery.data;

    if (!chatId || !data) {
      await ctx.answerCallbackQuery();
      return;
    }

    const bus = getQuestionBus();
    if (bus.hasPending(chatId)) {
      bus.answer(chatId, data);
      log.info("Routed callback query as question answer", { chatId, data });

      // Edit the message to show the selected option and remove keyboard
      try {
        const originalText = ctx.callbackQuery.message?.text ?? "";
        await ctx.editMessageText(`${originalText}\n\n✅ Selected: ${data}`, {
          reply_markup: undefined,
        });
      } catch {
        // best-effort — message may not be editable
      }
    }

    // Always answer callback query to dismiss the loading spinner
    await ctx.answerCallbackQuery();
  });

  bot.on("message:text", async (ctx) => {
    const message = buildTextMessage(ctx);
    if (!message) return;

    log.debug("Received text message", {
      chatId: message.chatId,
      senderId: message.senderId,
    });

    try {
      await onMessage(message);
    } catch (error) {
      log.error("Error handling message", error);
      await ctx.reply("Sorry, something went wrong processing your message.");
    }
  });

  bot.on("message:photo", async (ctx) => {
    const photos = ctx.message.photo;
    if (!photos || photos.length === 0) return;

    const largest = photos[photos.length - 1];
    if (!largest) return;

    const file = await ctx.api.getFile(largest.file_id);
    const caption = ctx.message.caption ?? "";

    const message: IncomingMessage = {
      id: String(ctx.message.message_id),
      channel: "telegram",
      chatId: String(ctx.chat.id),
      senderId: String(ctx.from?.id ?? "unknown"),
      senderName: ctx.from?.first_name,
      content: {
        text: caption || "Image received",
        media: {
          type: "image",
          url: file.file_path ? file.file_path : undefined,
          mimeType: "image/jpeg",
          caption,
        },
      },
      timestamp: ctx.message.date,
    };

    try {
      await onMessage(message);
    } catch (error) {
      log.error("Error handling photo", error);
      await ctx.reply("Sorry, something went wrong processing your photo.");
    }
  });

  bot.on("message:voice", async (ctx) => {
    const voice = ctx.message.voice;
    const file = await ctx.api.getFile(voice.file_id);

    const message: IncomingMessage = {
      id: String(ctx.message.message_id),
      channel: "telegram",
      chatId: String(ctx.chat.id),
      senderId: String(ctx.from?.id ?? "unknown"),
      senderName: ctx.from?.first_name,
      content: {
        text: "Voice message received",
        media: {
          type: "audio",
          url: file.file_path ? file.file_path : undefined,
          mimeType: voice.mime_type ?? "audio/ogg",
        },
      },
      timestamp: ctx.message.date,
    };

    try {
      await onMessage(message);
    } catch (error) {
      log.error("Error handling voice message", error);
      await ctx.reply(
        "Sorry, something went wrong processing your voice message.",
      );
    }
  });

  bot.on("message:document", async (ctx) => {
    const doc = ctx.message.document;
    const file = await ctx.api.getFile(doc.file_id);

    const message: IncomingMessage = {
      id: String(ctx.message.message_id),
      channel: "telegram",
      chatId: String(ctx.chat.id),
      senderId: String(ctx.from?.id ?? "unknown"),
      senderName: ctx.from?.first_name,
      content: {
        text: ctx.message.caption ?? `Document: ${doc.file_name ?? "file"}`,
        media: {
          type: "document",
          url: file.file_path ? file.file_path : undefined,
          mimeType: doc.mime_type ?? "application/octet-stream",
          filename: doc.file_name ?? undefined,
        },
      },
      timestamp: ctx.message.date,
    };

    try {
      await onMessage(message);
    } catch (error) {
      log.error("Error handling document", error);
      await ctx.reply("Sorry, something went wrong processing your document.");
    }
  });
}

function buildTextMessage(ctx: Context): IncomingMessage | null {
  if (!ctx.message?.text || !ctx.chat) return null;

  return {
    id: String(ctx.message.message_id),
    channel: "telegram",
    chatId: String(ctx.chat.id),
    senderId: String(ctx.from?.id ?? "unknown"),
    senderName: ctx.from?.first_name,
    content: { text: ctx.message.text },
    timestamp: ctx.message.date,
  };
}
