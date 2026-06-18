import { test, expect, describe, mock } from "bun:test";
import type { MessageHandler } from "../types";

// The handler.ts exports only createWhatsAppHandler, but the pure functions
// (extractText, stripMention, escapeRegex) are module-private.
// We test them indirectly by importing the module and using dynamic access,
// or we extract and test the logic directly.

// Since extractText, stripMention, escapeRegex are not exported,
// we replicate them here for unit testing. This tests the logic,
// not the wiring (which would need integration tests).

function extractText(msg: { message?: Record<string, unknown> | null }): string | null {
  const m = msg.message;
  if (!m) return null;

  return (
    (m.conversation as string) ??
    (m.extendedTextMessage as Record<string, unknown> | undefined)?.text ??
    (m.imageMessage as Record<string, unknown> | undefined)?.caption ??
    (m.videoMessage as Record<string, unknown> | undefined)?.caption ??
    (m.documentMessage as Record<string, unknown> | undefined)?.caption ??
    null
  ) as string | null;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

describe("extractText", () => {
  test("extracts conversation text", () => {
    const msg = { message: { conversation: "Hello there" } };
    expect(extractText(msg)).toBe("Hello there");
  });

  test("extracts extendedTextMessage text", () => {
    const msg = {
      message: { extendedTextMessage: { text: "Extended message" } },
    };
    expect(extractText(msg)).toBe("Extended message");
  });

  test("extracts image caption", () => {
    const msg = {
      message: { imageMessage: { caption: "Nice photo" } },
    };
    expect(extractText(msg)).toBe("Nice photo");
  });

  test("extracts video caption", () => {
    const msg = {
      message: { videoMessage: { caption: "Cool video" } },
    };
    expect(extractText(msg)).toBe("Cool video");
  });

  test("extracts document caption", () => {
    const msg = {
      message: { documentMessage: { caption: "Important doc" } },
    };
    expect(extractText(msg)).toBe("Important doc");
  });

  test("returns null for empty message", () => {
    expect(extractText({ message: null })).toBeNull();
    expect(extractText({ message: undefined })).toBeNull();
    expect(extractText({})).toBeNull();
  });

  test("returns null for message with no text fields", () => {
    const msg = { message: { stickerMessage: { url: "sticker.webp" } } };
    expect(extractText(msg)).toBeNull();
  });

  test("prefers conversation over extendedTextMessage", () => {
    const msg = {
      message: {
        conversation: "conversation text",
        extendedTextMessage: { text: "extended text" },
      },
    };
    expect(extractText(msg)).toBe("conversation text");
  });
});

describe("escapeRegex", () => {
  test("escapes special regex characters", () => {
    expect(escapeRegex("hello.world")).toBe("hello\\.world");
    expect(escapeRegex("test+case")).toBe("test\\+case");
    expect(escapeRegex("a*b?c")).toBe("a\\*b\\?c");
    expect(escapeRegex("(group)")).toBe("\\(group\\)");
    expect(escapeRegex("[bracket]")).toBe("\\[bracket\\]");
    expect(escapeRegex("{brace}")).toBe("\\{brace\\}");
    expect(escapeRegex("a^b$c")).toBe("a\\^b\\$c");
    expect(escapeRegex("a|b")).toBe("a\\|b");
    expect(escapeRegex("back\\slash")).toBe("back\\\\slash");
  });

  test("leaves plain text unchanged", () => {
    expect(escapeRegex("hello")).toBe("hello");
    expect(escapeRegex("simple text")).toBe("simple text");
  });
});

describe("stripMention", () => {
  test("strips @mention at start", () => {
    expect(stripMention("@OpenCrow hello there", "OpenCrow")).toBe("hello there");
  });

  test("strips mention without @ at start", () => {
    expect(stripMention("OpenCrow hello there", "OpenCrow")).toBe("hello there");
  });

  test("strips mention with colon at start", () => {
    expect(stripMention("OpenCrow: hello there", "OpenCrow")).toBe("hello there");
  });

  test("strips mention with comma at start", () => {
    expect(stripMention("OpenCrow, hello there", "OpenCrow")).toBe("hello there");
  });

  test("strips mention at end", () => {
    expect(stripMention("hello there @OpenCrow", "OpenCrow")).toBe("hello there");
  });

  test("is case insensitive", () => {
    expect(stripMention("@opencrow hello", "OpenCrow")).toBe("hello");
    expect(stripMention("@OPENCROW hello", "OpenCrow")).toBe("hello");
  });

  test("returns original text if stripping would leave empty", () => {
    expect(stripMention("@OpenCrow", "OpenCrow")).toBe("@OpenCrow");
    expect(stripMention("OpenCrow", "OpenCrow")).toBe("OpenCrow");
  });

  test("handles text with no mention", () => {
    expect(stripMention("hello world", "OpenCrow")).toBe("hello world");
  });

  test("handles mention in middle (does not strip)", () => {
    // The regex only strips start/end mentions
    const result = stripMention("hello OpenCrow world", "OpenCrow");
    expect(result).toBe("hello OpenCrow world");
  });

  test("handles bot name with special regex chars", () => {
    expect(stripMention("@bot.name hello", "bot.name")).toBe("hello");
    expect(stripMention("@bot+name hello", "bot+name")).toBe("hello");
  });
});

// ---------------------------------------------------------------------------
// createWhatsAppHandler — per-instance dedup isolation
// ---------------------------------------------------------------------------
//
// Security/correctness invariant: each call to createWhatsAppHandler must
// create its own independent recentMessageIds map. Two handler instances
// (e.g. the real channel and a pairing helper) MUST NOT share dedup state.
//
// The test imports createWhatsAppHandler and builds two minimal WASocket stubs
// (duck-typed) that each capture their own `messages.upsert` listener. We then
// trigger the same message ID on both and assert that the second instance does
// NOT suppress the message (i.e. it invokes onMessage independently).
//
// The test would fail if recentMessageIds were module-level (the old bug):
// after the first handler recorded msgId="dup-1", the second handler would
// find it in the shared map and return early without calling onMessage.
// ---------------------------------------------------------------------------

import { createWhatsAppHandler } from "./handler";
import type { WASocket } from "@whiskeysockets/baileys";

/**
 * Build a minimal WASocket stub that captures the `messages.upsert` listener.
 * Only the surface area actually used by processMessage is provided.
 */
function makeSocketStub() {
  type UpsertListener = (arg: { messages: unknown[]; type: string }) => Promise<void>;
  let upsertListener: UpsertListener | null = null;

  const sock = {
    ev: {
      on: (event: string, handler: UpsertListener) => {
        if (event === "messages.upsert") {
          upsertListener = handler;
        }
      },
    },
    user: { id: "bot@s.whatsapp.net" },
  } as unknown as WASocket;

  const trigger = async (messages: unknown[], type = "notify") => {
    if (!upsertListener) throw new Error("messages.upsert listener not registered");
    await upsertListener({ messages, type });
  };

  return { sock, trigger };
}

/**
 * Build a minimal WAMessage that will pass all the early-exit guards in
 * processMessage (fromMe=false, has remoteJid, has .message, has text).
 */
function makeWAMessage(id: string) {
  return {
    key: {
      fromMe: false,
      remoteJid: "1234567890@s.whatsapp.net",
      id,
    },
    message: {
      conversation: "hello world",
    },
    pushName: "Tester",
    messageTimestamp: 1_700_000_000,
  };
}

describe("createWhatsAppHandler — per-instance recentMessageIds isolation", () => {
  test("two independent handler instances each process the same msgId once", async () => {
    const handlerA = mock(async () => {});
    const handlerB = mock(async () => {});

    const { sock: sockA, trigger: triggerA } = makeSocketStub();
    const { sock: sockB, trigger: triggerB } = makeSocketStub();

    createWhatsAppHandler(sockA, handlerA as unknown as MessageHandler, "BotA");
    createWhatsAppHandler(sockB, handlerB as unknown as MessageHandler, "BotB");

    const msg = makeWAMessage("dup-msg-001");

    // Trigger the same message on handler A first.
    await triggerA([msg]);
    // Then trigger it on handler B — must NOT be suppressed by A's dedup map.
    await triggerB([msg]);

    expect(handlerA).toHaveBeenCalledTimes(1);
    expect(handlerB).toHaveBeenCalledTimes(1);
  });

  test("within a single handler, duplicate msgId IS suppressed (dedup still works)", async () => {
    const onMessage = mock(async () => {});
    const { sock, trigger } = makeSocketStub();

    createWhatsAppHandler(sock, onMessage as unknown as MessageHandler, "Bot");

    const msg = makeWAMessage("dup-msg-002");

    // Same message upserted twice by Baileys.
    await trigger([msg]);
    await trigger([msg]);

    // Second delivery must be deduped — onMessage called only once.
    expect(onMessage).toHaveBeenCalledTimes(1);
  });

  test("three handler instances are all independent — each processes the message", async () => {
    const handlerA = mock(async () => {});
    const handlerB = mock(async () => {});
    const handlerC = mock(async () => {});

    const { sock: sA, trigger: tA } = makeSocketStub();
    const { sock: sB, trigger: tB } = makeSocketStub();
    const { sock: sC, trigger: tC } = makeSocketStub();

    createWhatsAppHandler(sA, handlerA as unknown as MessageHandler, "Bot");
    createWhatsAppHandler(sB, handlerB as unknown as MessageHandler, "Bot");
    createWhatsAppHandler(sC, handlerC as unknown as MessageHandler, "Bot");

    const msg = makeWAMessage("shared-msg-003");

    await tA([msg]);
    await tB([msg]);
    await tC([msg]);

    expect(handlerA).toHaveBeenCalledTimes(1);
    expect(handlerB).toHaveBeenCalledTimes(1);
    expect(handlerC).toHaveBeenCalledTimes(1);
  });
});
