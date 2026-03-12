import { describe, it, expect, beforeEach, afterEach, vi } from "bun:test";
import {
  saveSdkSessionId,
  getSdkSessionId,
  clearSdkSession,
  clearAllSdkSessions,
} from "./sdk-sessions";
import { initDb, closeDb, getDb } from "./db";

// Note: Using real database for integration testing
// Mocks pollute the module cache and break other tests

describe("sdk-sessions", () => {
  beforeEach(async () => {
    await initDb(process.env.DATABASE_URL);
    vi.clearAllMocks();

    // Clean up test data
    const db = getDb();
    await db.unsafe("DELETE FROM sdk_sessions WHERE channel = 'test-channel'");
  });

  afterEach(async () => {
    const db = getDb();
    await db.unsafe("DELETE FROM sdk_sessions WHERE channel = 'test-channel'");
    await closeDb();
  });

  describe("saveSdkSessionId / getSdkSessionId", () => {
    it("round-trips a saved session id", async () => {
      await saveSdkSessionId(
        "test-channel",
        "chat-123",
        "agent-1",
        "sdk-abc-123",
      );

      const result = await getSdkSessionId(
        "test-channel",
        "chat-123",
        "agent-1",
      );

      expect(result).toBe("sdk-abc-123");
    });

    it("upsert updates an existing session id", async () => {
      await saveSdkSessionId(
        "test-channel",
        "chat-123",
        "agent-1",
        "sdk-first",
      );
      await saveSdkSessionId(
        "test-channel",
        "chat-123",
        "agent-1",
        "sdk-second",
      );

      const result = await getSdkSessionId(
        "test-channel",
        "chat-123",
        "agent-1",
      );

      expect(result).toBe("sdk-second");
    });
  });

  describe("getSdkSessionId", () => {
    it("returns null when session does not exist", async () => {
      const result = await getSdkSessionId(
        "test-channel",
        "chat-none",
        "agent-none",
      );

      expect(result).toBeNull();
    });
  });

  describe("clearSdkSession", () => {
    it("removes only the specified agent session", async () => {
      await saveSdkSessionId(
        "test-channel",
        "chat-123",
        "agent-1",
        "sdk-a",
      );
      await saveSdkSessionId(
        "test-channel",
        "chat-123",
        "agent-2",
        "sdk-b",
      );

      await clearSdkSession("test-channel", "chat-123", "agent-1");

      const removed = await getSdkSessionId(
        "test-channel",
        "chat-123",
        "agent-1",
      );
      const kept = await getSdkSessionId(
        "test-channel",
        "chat-123",
        "agent-2",
      );

      expect(removed).toBeNull();
      expect(kept).toBe("sdk-b");
    });
  });

  describe("clearAllSdkSessions", () => {
    it("removes all sessions for a given channel and chatId", async () => {
      await saveSdkSessionId(
        "test-channel",
        "chat-clear",
        "agent-1",
        "sdk-x",
      );
      await saveSdkSessionId(
        "test-channel",
        "chat-clear",
        "agent-2",
        "sdk-y",
      );
      await saveSdkSessionId(
        "test-channel",
        "chat-clear",
        "agent-3",
        "sdk-z",
      );

      await clearAllSdkSessions("test-channel", "chat-clear");

      const a1 = await getSdkSessionId("test-channel", "chat-clear", "agent-1");
      const a2 = await getSdkSessionId("test-channel", "chat-clear", "agent-2");
      const a3 = await getSdkSessionId("test-channel", "chat-clear", "agent-3");

      expect(a1).toBeNull();
      expect(a2).toBeNull();
      expect(a3).toBeNull();
    });
  });
});
