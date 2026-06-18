import type { WASocket } from "@whiskeysockets/baileys";
import { downloadMediaMessage } from "@whiskeysockets/baileys";
import type {
  IncomingMessage,
  MessageHandler,
  GroupParticipant,
} from "../types";
import { createLogger } from "../../logger";

const log = createLogger("whatsapp-handler");

const STATUS_BROADCAST = "status@broadcast";
const MAX_DEDUP_SIZE = 1000;
const DEDUP_TTL_MS = 5 * 60 * 1000; // 5 minutes

type GetGroupParticipants = (
  chatId: string,
) => Promise<readonly GroupParticipant[]>;

export function createWhatsAppHandler(
  sock: WASocket,
  onMessage: MessageHandler,
  botName: string,
  getGroupParticipants?: GetGroupParticipants,
): void {
  // Scoped per channel instance so that a real channel and a pairing helper
  // running concurrently do not share dedup state and suppress each other's
  // legitimate messages.
  const recentMessageIds = new Map<string, number>();

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      try {
        await processMessage(
          msg,
          sock,
          onMessage,
          botName,
          recentMessageIds,
          getGroupParticipants,
        );
      } catch (error) {
        log.error("Error processing WhatsApp message", error);
      }
    }
  });
}

async function processMessage(
  msg: import("@whiskeysockets/baileys").WAMessage,
  sock: WASocket,
  onMessage: MessageHandler,
  botName: string,
  recentMessageIds: Map<string, number>,
  getGroupParticipants?: GetGroupParticipants,
): Promise<void> {
  // Skip own messages
  if (msg.key.fromMe) return;

  // Skip status broadcasts
  const remoteJid = msg.key.remoteJid;
  if (!remoteJid || remoteJid === STATUS_BROADCAST) return;

  // Skip protocol messages (no content)
  if (!msg.message) return;

  // Deduplicate: Baileys can emit duplicate messages.upsert events
  const msgId = msg.key.id;
  if (msgId) {
    if (recentMessageIds.has(msgId)) {
      log.debug("Skipping duplicate message", { msgId });
      return;
    }
    recentMessageIds.set(msgId, Date.now());

    // Evict expired entries when over capacity
    if (recentMessageIds.size > MAX_DEDUP_SIZE) {
      const cutoff = Date.now() - DEDUP_TTL_MS;
      for (const [id, ts] of recentMessageIds) {
        if (ts < cutoff) recentMessageIds.delete(id);
      }
      // Still over limit — drop oldest
      if (recentMessageIds.size > MAX_DEDUP_SIZE) {
        const first = recentMessageIds.keys().next().value;
        if (first !== undefined) recentMessageIds.delete(first);
      }
    }
  }

  const text = extractText(msg);
  // Allow image-only messages through even without caption text — extractText
  // returns "[Image]" as a placeholder, so text will be non-null.
  if (!text) return;

  const isGroup = remoteJid.endsWith("@g.us");

  // In groups, detect whether bot was mentioned by name or @tagged
  let mentioned = !isGroup; // DMs are always "mentioned"
  if (isGroup) {
    const lowerText = text.toLowerCase();
    const lowerBotName = botName.toLowerCase();

    const mentionedByName =
      lowerText.includes(lowerBotName) ||
      lowerText.includes(`@${lowerBotName}`);

    // WhatsApp @ mentions use LIDs or JIDs — check mentionedJid against both
    const botJid = sock.user?.id;
    const botLid = (sock.user as unknown as Record<string, unknown>)?.lid as
      | string
      | undefined;
    const botJidBare = botJid?.split("@")[0]?.split(":")[0];
    const botLidBare = botLid?.split("@")[0]?.split(":")[0];
    const mentionedJids: readonly string[] =
      msg.message?.extendedTextMessage?.contextInfo?.mentionedJid ?? [];
    const mentionedByJid = mentionedJids.some((jid) => {
      const bare = jid.split("@")[0]?.split(":")[0];
      return bare === botJidBare || bare === botLidBare;
    });

    // Reply-to-bot: check if user replied to a bot message
    const contextInfo =
      msg.message?.extendedTextMessage?.contextInfo ??
      msg.message?.imageMessage?.contextInfo ??
      msg.message?.videoMessage?.contextInfo ??
      msg.message?.audioMessage?.contextInfo ??
      msg.message?.documentMessage?.contextInfo ??
      msg.message?.stickerMessage?.contextInfo ??
      null;
    const replyParticipant = contextInfo?.participant;
    const repliedToBot = replyParticipant
      ? (() => {
          const bare = replyParticipant.split("@")[0]?.split(":")[0];
          return bare === botJidBare || bare === botLidBare;
        })()
      : false;

    mentioned = mentionedByName || mentionedByJid || repliedToBot;
  }

  // Strip bot name and all @mention IDs (JID, LID) from text when mentioned
  let cleanedText = mentioned ? stripMention(text, botName) : text;
  if (isGroup && mentioned) {
    const mentionedJids: readonly string[] =
      msg.message?.extendedTextMessage?.contextInfo?.mentionedJid ?? [];
    for (const jid of mentionedJids) {
      const bare = jid.split("@")[0]?.split(":")[0] ?? "";
      if (bare) {
        cleanedText = stripMention(cleanedText, bare);
      }
    }
  }

  const senderId = isGroup ? (msg.key.participant ?? remoteJid) : remoteJid;

  const pushName = msg.pushName ?? "Unknown";

  // Fetch group participants for context (non-blocking)
  const groupParticipants =
    isGroup && mentioned && getGroupParticipants
      ? await getGroupParticipants(remoteJid)
      : undefined;

  // Download image buffer if present and within size limit
  let mediaBuffer: Buffer | undefined;
  let mediaMimeType: string | undefined;

  const imageMsg = msg.message?.imageMessage;
  if (imageMsg) {
    const fileLength = Number(imageMsg.fileLength ?? 0);
    if (fileLength <= 5 * 1024 * 1024) {
      try {
        const downloadResult = await Promise.race([
          downloadMediaMessage(msg, "buffer", {}),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("Image download timeout")), 10_000),
          ),
        ]);
        mediaBuffer = Buffer.isBuffer(downloadResult)
          ? downloadResult
          : Buffer.from(downloadResult as Uint8Array);
        mediaMimeType = imageMsg.mimetype ?? "image/jpeg";
      } catch (err) {
        log.debug("Failed to download WhatsApp image", { error: err });
      }
    } else {
      log.debug("Skipping large image download", { fileLength });
    }
  }

  const incoming: IncomingMessage = {
    id: msg.key.id ?? crypto.randomUUID(),
    channel: "whatsapp",
    chatId: remoteJid,
    senderId,
    senderName: pushName,
    content: {
      text: cleanedText,
      ...(mediaBuffer
        ? {
            media: {
              type: "image" as const,
              buffer: mediaBuffer,
              mimeType: mediaMimeType ?? "image/jpeg",
            },
          }
        : {}),
    },
    timestamp: msg.messageTimestamp
      ? Number(msg.messageTimestamp)
      : Math.floor(Date.now() / 1000),
    mentioned,
    raw: msg,
    groupParticipants,
  };

  log.debug("Received WhatsApp message", {
    chatId: remoteJid,
    senderId,
    isGroup,
  });

  await onMessage(incoming);
}

function extractText(
  msg: import("@whiskeysockets/baileys").WAMessage,
): string | null {
  const m = msg.message;
  if (!m) return null;

  const text =
    m.conversation ??
    m.extendedTextMessage?.text ??
    m.imageMessage?.caption ??
    m.videoMessage?.caption ??
    m.documentMessage?.caption ??
    null;

  if (text) return text;

  // Media-only messages — return placeholder so the agent can acknowledge them
  if (m.imageMessage) return "[Image]";
  if (m.videoMessage) return "[Video]";
  if (m.audioMessage) return "[Audio message]";
  if (m.ptvMessage) return "[Voice message]";
  if (m.stickerMessage) return "[Sticker]";
  if (m.documentMessage) {
    const rawName = m.documentMessage.fileName;
    const safeName = rawName
      ? rawName.replace(/[\[\]\n\r]/g, "").slice(0, 100)
      : "";
    return safeName ? `[Document: ${safeName}]` : "[Document]";
  }
  if (m.contactMessage) return "[Contact card]";
  if (m.locationMessage) return "[Location]";

  return null;
}

function stripMention(text: string, botName: string): string {
  const patterns = [
    new RegExp(`^@?${escapeRegex(botName)}[,:]?\\s*`, "i"),
    new RegExp(`\\s*@?${escapeRegex(botName)}$`, "i"),
  ];

  let result = text;
  for (const pattern of patterns) {
    result = result.replace(pattern, "");
  }
  return result.trim() || text;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
