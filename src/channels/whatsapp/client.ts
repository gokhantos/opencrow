import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  DisconnectReason,
  Browsers,
  type WASocket,
  type AuthenticationState,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import pino from "pino";
import path from "node:path";
import type {
  Channel,
  MessageHandler,
  MessageContent,
  ChannelName,
} from "../types";
import { createWhatsAppHandler } from "./handler";
import { createLogger } from "../../logger";

import type { GroupParticipant } from "../types";

export type PairingState = "disconnected" | "waiting" | "pairing" | "connected";

export interface WhatsAppChannel extends Channel {
  requestPairingCode(phoneNumber: string): Promise<string>;
  getPairingState(): PairingState;
  getQrCode(): string | null;
  getGroupParticipants(chatId: string): Promise<readonly GroupParticipant[]>;
}

const AUTH_DIR = path.join(process.cwd(), "data", "whatsapp-auth");
const baileysLogger = pino({ level: "silent" });

export function createWhatsAppChannel(botName: string): WhatsAppChannel {
  const log = createLogger("whatsapp");
  let sock: WASocket | null = null;
  let messageHandler: MessageHandler | null = null;
  let connected = false;
  let connecting = false;
  let pairingState: PairingState = "disconnected";
  let registered = false;
  let intentionalDisconnect = false;
  let qrCode: string | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempts = 0;
  let lastConnectedAt = 0;
  const STABLE_CONNECTION_MS = 30_000; // 30s = "stable" connection

  // Cache group participants: groupJid → Map<jid, name>
  // Populated from groupMetadata AND incoming message pushNames
  const groupNameCache = new Map<string, Map<string, string>>();
  const groupMetaFetched = new Map<string, number>();
  const GROUP_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

  // Called on every incoming group message to learn names
  function trackParticipantName(
    chatId: string,
    participantJid: string,
    pushName: string | undefined,
  ): void {
    if (!chatId.endsWith("@g.us") || !pushName) return;
    let names = groupNameCache.get(chatId);
    if (!names) {
      names = new Map();
      groupNameCache.set(chatId, names);
    }
    names.set(participantJid, pushName);
  }

  async function fetchGroupParticipants(
    chatId: string,
  ): Promise<readonly GroupParticipant[]> {
    if (!sock || !chatId.endsWith("@g.us")) return [];

    const lastFetch = groupMetaFetched.get(chatId) ?? 0;
    if (Date.now() - lastFetch > GROUP_CACHE_TTL_MS) {
      try {
        const meta = await sock.groupMetadata(chatId);
        let names = groupNameCache.get(chatId);
        if (!names) {
          names = new Map();
          groupNameCache.set(chatId, names);
        }
        // Merge metadata notify names (don't overwrite pushNames)
        for (const p of meta.participants) {
          if (p.notify && !names.has(p.id)) {
            names.set(p.id, p.notify);
          }
        }
        groupMetaFetched.set(chatId, Date.now());
      } catch (err) {
        log.debug("Failed to fetch group metadata", {
          chatId,
          error: err,
        });
      }
    }

    const names = groupNameCache.get(chatId);
    if (!names) return [];

    return Array.from(names.entries()).map(([jid, name]) => ({ jid, name }));
  }

  function resolveTextMentions(
    text: string,
    participants: readonly GroupParticipant[],
  ): { text: string; mentions: string[] } {
    const mentions: string[] = [];
    let result = text;

    log.debug("Resolving mentions", {
      text: text.slice(0, 100),
      participantCount: participants.length,
      names: participants.filter((p) => p.name).map((p) => p.name),
    });

    for (const p of participants) {
      if (!p.name) continue;
      // Match @Name — use word boundary or followed by space/punctuation/end
      const pattern = new RegExp(
        `@${escapeRegex(p.name)}(?=[\\s.,!?;:'\"\\)\\]}\u200b]|$)`,
        "gi",
      );
      if (pattern.test(result)) {
        mentions.push(p.jid);
        const number = p.jid.split("@")[0]?.split(":")[0] ?? "";
        // Reset lastIndex since .test() advances it
        pattern.lastIndex = 0;
        result = result.replace(pattern, `@${number}`);
        log.debug("Resolved mention", { name: p.name, jid: p.jid });
      }
    }

    // Also match first names (without @) if the model writes just "Name"
    // after an @ that was already in the text
    // e.g., model writes "@Erkin piçi" — handled above

    if (mentions.length > 0) {
      log.info("Mentions resolved", { count: mentions.length, mentions });
    }

    return { text: result, mentions };
  }

  function escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function cancelReconnect(): void {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function getReconnectDelay(): number {
    const base = 2000;
    const max = 30000;
    const delay = Math.min(base * Math.pow(1.5, reconnectAttempts), max);
    // Add jitter (±25%)
    return delay * (0.75 + Math.random() * 0.5);
  }

  async function clearAuth(): Promise<void> {
    const fs = await import("node:fs/promises");
    try {
      await fs.rm(AUTH_DIR, { recursive: true, force: true });
      log.info("Cleared WhatsApp auth state");
    } catch {
      // directory may not exist
    }
  }

  async function initSocket(): Promise<void> {
    const fs = await import("node:fs/promises");
    await fs.mkdir(AUTH_DIR, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    registered = Boolean((state as AuthenticationState).creds?.registered);

    // Fetch latest WA Web version — critical to avoid server rejection
    let version: [number, number, number] | undefined;
    try {
      const result = await fetchLatestBaileysVersion();
      version = result.version as [number, number, number];
      log.info("Using WA version", { version });
    } catch {
      log.warn("Failed to fetch latest WA version, using default");
    }

    const socket = makeWASocket({
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, baileysLogger),
      },
      ...(version ? { version } : {}),
      logger: baileysLogger,
      browser: Browsers.ubuntu("Chrome"),
      syncFullHistory: false,
      markOnlineOnConnect: false,
    });

    sock = socket;

    // Prevent unhandled WS errors from crashing the process
    const ws = socket.ws as unknown as {
      on?: (e: string, cb: (err: Error) => void) => void;
    };
    if (ws?.on) {
      ws.on("error", (err: Error) => {
        log.error("WebSocket error", { error: String(err) });
      });
    }

    socket.ev.on("creds.update", async (creds) => {
      await saveCreds();
      if (creds.registered) {
        registered = true;
      }
    });

    socket.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect } = update;

      if (update.qr) {
        qrCode = update.qr;
        pairingState = "waiting";
        log.info("QR code available for pairing");
      }

      if (connection === "close") {
        connected = false;

        const statusCode =
          lastDisconnect?.error instanceof Boom
            ? lastDisconnect.error.output.statusCode
            : (lastDisconnect?.error as Boom | undefined)?.output?.statusCode;

        if (statusCode === DisconnectReason.loggedOut) {
          log.warn("WhatsApp logged out, clearing auth", { statusCode });
          pairingState = "disconnected";
          registered = false;
          qrCode = null;
          reconnectAttempts = 0;
          clearAuth().catch(() => {});
          sock = null;
          return;
        }

        // 405 = server rejected connection (stale keys) — clear and retry fresh
        if (statusCode === 405) {
          log.info("Clearing stale auth (server rejected, 405)");
          registered = false;
          clearAuth().catch(() => {});
        }

        // 515 = restart required after pairing
        if (statusCode === DisconnectReason.restartRequired) {
          log.info("Restart required after pairing, reconnecting immediately");
          reconnectAttempts = 0;
          initSocket().catch((err) => {
            log.error("Failed to restart WhatsApp", err);
          });
          return;
        }

        if (intentionalDisconnect) {
          pairingState = "disconnected";
          return;
        }

        // Detect rapid disconnect (connected < 30s) — don't reset backoff
        const connectionDuration =
          lastConnectedAt > 0 ? Date.now() - lastConnectedAt : 0;
        if (lastConnectedAt > 0 && connectionDuration < STABLE_CONNECTION_MS) {
          // Connection was too short — this is a flapping session
          reconnectAttempts++;
          log.warn("Rapid disconnect detected", {
            statusCode,
            connectionDurationMs: connectionDuration,
            attempt: reconnectAttempts,
          });
        }

        // Don't reconnect forever for unregistered sessions
        if (!registered && reconnectAttempts >= 5) {
          log.warn("Max reconnect attempts for unregistered session, stopping");
          pairingState = "disconnected";
          reconnectAttempts = 0;
          return;
        }

        // Stop after too many rapid disconnects — auth is likely invalid
        if (reconnectAttempts >= 10) {
          log.error("Too many rapid disconnects, stopping WhatsApp", {
            statusCode,
            attempts: reconnectAttempts,
          });
          pairingState = "disconnected";
          reconnectAttempts = 0;
          sock = null;
          return;
        }

        const delay = getReconnectDelay();
        log.info("WhatsApp disconnected, reconnecting...", {
          statusCode,
          registered,
          attempt: reconnectAttempts + 1,
          delayMs: Math.round(delay),
        });

        if (!registered) {
          pairingState = "waiting";
        }

        cancelReconnect();
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          if (!connected && !connecting && !intentionalDisconnect) {
            reconnectAttempts++;
            initSocket().catch((err) => {
              log.error("Failed to reconnect WhatsApp", err);
            });
          }
        }, delay);
      } else if (connection === "open") {
        connected = true;
        registered = true;
        pairingState = "connected";
        qrCode = null;
        lastConnectedAt = Date.now();
        // Only reset backoff if previous connection was stable (>30s)
        // This prevents rapid connect/disconnect loops from resetting the counter
        if (reconnectAttempts <= 1) {
          reconnectAttempts = 0;
        }
        log.info("WhatsApp connected");
      } else if (connection === "connecting") {
        log.debug("WhatsApp connecting...");
      }
    });

    createWhatsAppHandler(
      socket,
      (msg) => {
        // Track sender name for mention resolution
        if (msg.chatId.endsWith("@g.us") && msg.senderId && msg.senderName) {
          trackParticipantName(msg.chatId, msg.senderId, msg.senderName);
        }
        if (messageHandler) {
          return messageHandler(msg);
        }
        return Promise.resolve();
      },
      botName,
      fetchGroupParticipants,
    );
  }

  const channel: WhatsAppChannel = {
    name: "whatsapp" as ChannelName,

    async connect() {
      if (connected || connecting) {
        log.warn("WhatsApp already connected or connecting");
        return;
      }
      connecting = true;
      intentionalDisconnect = false;
      reconnectAttempts = 0;

      try {
        await initSocket();
      } finally {
        connecting = false;
      }
    },

    async disconnect() {
      intentionalDisconnect = true;
      connected = false;
      pairingState = "disconnected";
      cancelReconnect();

      if (sock) {
        try {
          sock.end(undefined);
        } catch {
          // best-effort
        }
        sock = null;
      }
      log.info("WhatsApp disconnected");
    },

    async sendMessage(
      chatId: string,
      content: MessageContent,
    ): Promise<number | void> {
      if (!sock) {
        throw new Error("WhatsApp not connected");
      }

      if (content.media?.buffer) {
        const mediaType = content.media.type;
        const caption = content.media.caption ?? content.text;

        if (mediaType === "image") {
          await sock.sendMessage(chatId, {
            image: content.media.buffer,
            caption,
            mimetype: content.media.mimeType ?? "image/jpeg",
          });
        } else if (mediaType === "audio") {
          await sock.sendMessage(chatId, {
            audio: content.media.buffer,
            mimetype: content.media.mimeType ?? "audio/ogg; codecs=opus",
          });
        } else if (mediaType === "video") {
          await sock.sendMessage(chatId, {
            video: content.media.buffer,
            caption,
            mimetype: content.media.mimeType ?? "video/mp4",
          });
        } else {
          await sock.sendMessage(chatId, {
            document: content.media.buffer,
            mimetype: content.media.mimeType ?? "application/octet-stream",
            fileName: content.media.filename ?? "file",
          });
        }
        return;
      }

      if (content.text) {
        // Resolve @Name mentions to JIDs for group messages
        if (chatId.endsWith("@g.us")) {
          const participants = await fetchGroupParticipants(chatId);
          if (participants.length > 0) {
            const resolved = resolveTextMentions(content.text, participants);
            await sock.sendMessage(chatId, {
              text: resolved.text,
              mentions: resolved.mentions,
            });
            return;
          }
        }
        await sock.sendMessage(chatId, { text: content.text });
      }
    },

    async sendTyping(chatId: string) {
      if (!sock) return;
      try {
        await sock.sendPresenceUpdate("composing", chatId);
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

    async getGroupParticipants(
      chatId: string,
    ): Promise<readonly GroupParticipant[]> {
      return fetchGroupParticipants(chatId);
    },

    async requestPairingCode(phoneNumber: string): Promise<string> {
      // Stop any pending reconnect loop
      intentionalDisconnect = true;
      cancelReconnect();

      // If we have stale auth from a failed pairing, clear it first
      if (!registered && sock) {
        log.info("Clearing stale auth before new pairing attempt");
        try {
          sock.end(undefined);
        } catch {
          // ignore
        }
        sock = null;
        await clearAuth();
      }

      intentionalDisconnect = false;
      reconnectAttempts = 0;

      // Create a fresh socket for pairing
      if (!sock) {
        await initSocket();
      }

      if (!sock) {
        throw new Error("Failed to create WhatsApp socket");
      }

      pairingState = "pairing";

      // Wait for WS + noise handshake to complete
      await new Promise((r) => setTimeout(r, 5000));

      if (!sock) {
        throw new Error("Socket disconnected before pairing could start");
      }

      const code = await sock.requestPairingCode(phoneNumber);
      log.info("Pairing code generated", {
        phoneNumber: phoneNumber.slice(0, 4) + "...",
      });
      return code;
    },

    getPairingState(): PairingState {
      return pairingState;
    },

    getQrCode(): string | null {
      return qrCode;
    },
  };

  return channel;
}
