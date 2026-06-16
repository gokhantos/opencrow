import { describe, it, expect, beforeEach, afterEach, vi } from "bun:test";
import {
  getOrCreateSession,
  getAllSessions,
  type StoredSession,
} from "./sessions";
import { initDb, closeDb, getDb } from "./db";

// Note: Using real database for integration testing
// Mocks pollute the module cache and break other tests

describe("sessions", () => {
  beforeEach(async () => {
    await initDb(process.env.DATABASE_URL);
    vi.clearAllMocks();

    // Clean up test data
    const db = getDb();
    await db.unsafe("DELETE FROM sessions WHERE channel = 'test-channel'");
  });

  afterEach(async () => {
    const db = getDb();
    await db.unsafe("DELETE FROM sessions WHERE channel = 'test-channel'");
    await closeDb();
  });

  describe("getOrCreateSession", () => {
    it("creates a new session", async () => {
      const result = await getOrCreateSession("test-channel", "chat-new");

      expect(result.channel).toBe("test-channel");
      expect(result.chatId).toBe("chat-new");
      expect(typeof result.id).toBe("string");
      expect(result.id.length).toBeGreaterThan(0);
      expect(typeof result.createdAt).toBe("number");
      expect(typeof result.updatedAt).toBe("number");
    });

    it("returns the same session on second call", async () => {
      const first = await getOrCreateSession("test-channel", "chat-existing");
      const second = await getOrCreateSession("test-channel", "chat-existing");

      expect(second.id).toBe(first.id);
      expect(second.channel).toBe(first.channel);
      expect(second.chatId).toBe(first.chatId);
      expect(second.createdAt).toBe(first.createdAt);
    });
  });

  describe("getAllSessions", () => {
    it("returns sessions ordered by updated_at DESC", async () => {
      // Insert with controlled timing by doing two sequential upserts
      await getOrCreateSession("test-channel", "chat-alpha");
      // Small delay to ensure a different updated_at value
      await new Promise((r) => setTimeout(r, 1100));
      await getOrCreateSession("test-channel", "chat-beta");

      const result = await getAllSessions();

      const channels = result
        .filter((s: StoredSession) => s.channel === "test-channel")
        .map((s: StoredSession) => s.chatId);

      const betaIdx = channels.indexOf("chat-beta");
      const alphaIdx = channels.indexOf("chat-alpha");

      expect(betaIdx).toBeLessThan(alphaIdx);
    });
  });
});
