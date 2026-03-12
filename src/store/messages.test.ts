import { describe, it, expect, beforeEach, afterEach, vi } from "bun:test";
import {
  saveMessage,
  getMessagesByChat,
  getMessagesByChatPaginated,
  getRecentMessages,
  clearChatMessages,
  type StoredMessage,
} from "./messages";
import { initDb, closeDb, getDb } from "./db";

// Note: Using real database for integration testing
// Mocks pollute the module cache and break other tests

describe("messages", () => {
  beforeEach(async () => {
    await initDb(process.env.DATABASE_URL);
    vi.clearAllMocks();

    // Clean up test data
    const db = getDb();
    await db.unsafe("DELETE FROM messages WHERE channel = 'test-channel'");
  });

  afterEach(async () => {
    const db = getDb();
    await db.unsafe("DELETE FROM messages WHERE channel = 'test-channel'");
    await closeDb();
  });

  const createMsg = (
    id: string,
    chatId = "chat-123",
    timestamp?: number,
  ) => ({
    id,
    channel: "test-channel" as const,
    chatId,
    senderId: "sender-1",
    senderName: "Test User",
    role: "user" as const,
    content: `Message ${id}`,
    mediaType: "text",
    timestamp: timestamp ?? Math.floor(Date.now() / 1000),
  });

  describe("saveMessage", () => {
    it("inserts and returns with all fields mapped", async () => {
      const msg = createMsg("msg-1");
      const result = await saveMessage(msg);

      expect(result.id).toBe("msg-1");
      expect(result.channel).toBe("test-channel");
      expect(result.chatId).toBe("chat-123");
      expect(result.senderId).toBe("sender-1");
      expect(result.senderName).toBe("Test User");
      expect(result.role).toBe("user");
      expect(result.content).toBe("Message msg-1");
      expect(result.mediaType).toBe("text");
      expect(result.timestamp).toBe(msg.timestamp);
      expect(typeof result.createdAt).toBe("number");
    });

    it("handles null senderName and mediaType", async () => {
      const msg = {
        id: "msg-null",
        channel: "test-channel" as const,
        chatId: "chat-123",
        senderId: "sender-1",
        role: "assistant" as const,
        content: "No name or media",
        timestamp: Math.floor(Date.now() / 1000),
      };

      const result = await saveMessage(msg);

      expect(result.senderName).toBeNull();
      expect(result.mediaType).toBeNull();
    });
  });

  describe("getMessagesByChat", () => {
    it("returns messages in chronological order", async () => {
      const base = Math.floor(Date.now() / 1000);
      await saveMessage(createMsg("msg-a", "chat-123", base + 1));
      await saveMessage(createMsg("msg-b", "chat-123", base + 2));
      await saveMessage(createMsg("msg-c", "chat-123", base + 3));

      const result = await getMessagesByChat("test-channel", "chat-123");

      const ids = result.map((m) => m.id);
      const aIdx = ids.indexOf("msg-a");
      const bIdx = ids.indexOf("msg-b");
      const cIdx = ids.indexOf("msg-c");
      expect(aIdx).toBeLessThan(bIdx);
      expect(bIdx).toBeLessThan(cIdx);
    });

    it("with before cursor returns older messages", async () => {
      const base = Math.floor(Date.now() / 1000);
      await saveMessage(createMsg("msg-old", "chat-123", base + 1));
      await saveMessage(createMsg("msg-mid", "chat-123", base + 2));
      await saveMessage(createMsg("msg-new", "chat-123", base + 3));

      // Pass msg-new as the before cursor — should return only older ones
      const result = await getMessagesByChat(
        "test-channel",
        "chat-123",
        50,
        "msg-new",
      );

      const ids = result.map((m) => m.id);
      expect(ids).toContain("msg-old");
      expect(ids).toContain("msg-mid");
      expect(ids).not.toContain("msg-new");
    });
  });

  describe("getMessagesByChatPaginated", () => {
    it("returns hasMore and nextCursor when more pages exist", async () => {
      const base = Math.floor(Date.now() / 1000);
      for (let i = 0; i < 4; i++) {
        await saveMessage(createMsg(`msg-page-${i}`, "chat-page", base + i));
      }

      // Request only 2, there are 4 total
      const result = await getMessagesByChatPaginated(
        "test-channel",
        "chat-page",
        2,
      );

      expect(result.messages.length).toBe(2);
      expect(result.nextCursor).not.toBeNull();
    });

    it("returns null cursor when no more pages", async () => {
      const base = Math.floor(Date.now() / 1000);
      await saveMessage(createMsg("msg-only-1", "chat-single", base + 1));
      await saveMessage(createMsg("msg-only-2", "chat-single", base + 2));

      // Request more than exist
      const result = await getMessagesByChatPaginated(
        "test-channel",
        "chat-single",
        10,
      );

      expect(result.messages.length).toBe(2);
      expect(result.nextCursor).toBeNull();
    });
  });

  describe("getRecentMessages", () => {
    it("returns messages including recently saved ones", async () => {
      const base = Math.floor(Date.now() / 1000);
      await saveMessage(createMsg("msg-recent-1", "chat-123", base + 1));
      await saveMessage(createMsg("msg-recent-2", "chat-123", base + 2));

      const result = await getRecentMessages(50);

      const ids = result.map((m: StoredMessage) => m.id);
      expect(ids).toContain("msg-recent-1");
      expect(ids).toContain("msg-recent-2");
    });
  });

  describe("clearChatMessages", () => {
    it("returns count of deleted messages and removes them", async () => {
      const base = Math.floor(Date.now() / 1000);
      await saveMessage(createMsg("msg-del-1", "chat-clear", base + 1));
      await saveMessage(createMsg("msg-del-2", "chat-clear", base + 2));

      const count = await clearChatMessages("test-channel", "chat-clear");

      expect(count).toBe(2);

      const remaining = await getMessagesByChat(
        "test-channel",
        "chat-clear",
      );
      expect(remaining.length).toBe(0);
    });
  });
});
