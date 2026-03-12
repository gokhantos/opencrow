import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb, getDb } from "./db";
import { getLatestSummary, clearSummaries } from "./summaries";

const TEST_CHANNEL = "test-summaries-ch";
const TEST_CHAT = "test-summaries-chat";

describe("store/summaries", () => {
  beforeEach(async () => {
    await initDb(process.env.DATABASE_URL);
    const db = getDb();
    await db.unsafe(
      `DELETE FROM conversation_summaries WHERE channel LIKE 'test-summaries-%'`,
    );
  });

  afterEach(async () => {
    const db = getDb();
    await db.unsafe(
      `DELETE FROM conversation_summaries WHERE channel LIKE 'test-summaries-%'`,
    );
    await closeDb();
  });

  /** Insert a summary row directly (no store function for create). */
  async function insertSummary(opts: {
    channel: string;
    chatId: string;
    summary: string;
    messageCount: number;
    tokenEstimate: number;
    createdAt: number;
  }): Promise<string> {
    const db = getDb();
    const id = crypto.randomUUID();
    const rows = await db`
      INSERT INTO conversation_summaries
        (id, channel, chat_id, summary, message_count, token_estimate, created_at)
      VALUES
        (${id}, ${opts.channel}, ${opts.chatId}, ${opts.summary},
         ${opts.messageCount}, ${opts.tokenEstimate}, ${opts.createdAt})
      RETURNING id
    `;
    return (rows[0] as { id: string }).id;
  }

  describe("getLatestSummary", () => {
    it("returns null when no summaries exist", async () => {
      const result = await getLatestSummary(TEST_CHANNEL, "nonexistent-chat");
      expect(result).toBeNull();
    });

    it("returns the single summary when one exists", async () => {
      const now = Math.floor(Date.now() / 1000);
      await insertSummary({
        channel: TEST_CHANNEL,
        chatId: TEST_CHAT,
        summary: "We discussed testing strategies.",
        messageCount: 12,
        tokenEstimate: 450,
        createdAt: now,
      });

      const result = await getLatestSummary(TEST_CHANNEL, TEST_CHAT);

      expect(result).not.toBeNull();
      expect(result!.channel).toBe(TEST_CHANNEL);
      expect(result!.chatId).toBe(TEST_CHAT);
      expect(result!.summary).toBe("We discussed testing strategies.");
      expect(result!.messageCount).toBe(12);
      expect(result!.tokenEstimate).toBe(450);
      expect(result!.createdAt).toBe(now);
      expect(typeof result!.id).toBe("string");
    });

    it("returns the most recent summary when multiple exist", async () => {
      const now = Math.floor(Date.now() / 1000);
      await insertSummary({
        channel: TEST_CHANNEL,
        chatId: TEST_CHAT,
        summary: "Old summary",
        messageCount: 5,
        tokenEstimate: 200,
        createdAt: now - 100,
      });
      await insertSummary({
        channel: TEST_CHANNEL,
        chatId: TEST_CHAT,
        summary: "Latest summary",
        messageCount: 20,
        tokenEstimate: 800,
        createdAt: now,
      });

      const result = await getLatestSummary(TEST_CHANNEL, TEST_CHAT);

      expect(result).not.toBeNull();
      expect(result!.summary).toBe("Latest summary");
      expect(result!.messageCount).toBe(20);
    });

    it("scopes by channel and chatId", async () => {
      const now = Math.floor(Date.now() / 1000);
      await insertSummary({
        channel: TEST_CHANNEL,
        chatId: TEST_CHAT,
        summary: "Correct channel+chat",
        messageCount: 10,
        tokenEstimate: 300,
        createdAt: now,
      });
      await insertSummary({
        channel: "test-summaries-other",
        chatId: TEST_CHAT,
        summary: "Different channel",
        messageCount: 5,
        tokenEstimate: 100,
        createdAt: now,
      });

      const result = await getLatestSummary(TEST_CHANNEL, TEST_CHAT);

      expect(result).not.toBeNull();
      expect(result!.summary).toBe("Correct channel+chat");
    });

    it("scopes by chatId within the same channel", async () => {
      const now = Math.floor(Date.now() / 1000);
      await insertSummary({
        channel: TEST_CHANNEL,
        chatId: TEST_CHAT,
        summary: "Correct chat",
        messageCount: 8,
        tokenEstimate: 250,
        createdAt: now,
      });
      await insertSummary({
        channel: TEST_CHANNEL,
        chatId: "test-summaries-other-chat",
        summary: "Different chat",
        messageCount: 4,
        tokenEstimate: 120,
        createdAt: now,
      });

      const result = await getLatestSummary(TEST_CHANNEL, TEST_CHAT);

      expect(result).not.toBeNull();
      expect(result!.summary).toBe("Correct chat");
    });
  });

  describe("clearSummaries", () => {
    it("deletes all summaries for the given channel+chatId", async () => {
      const now = Math.floor(Date.now() / 1000);
      await insertSummary({
        channel: TEST_CHANNEL,
        chatId: TEST_CHAT,
        summary: "First",
        messageCount: 3,
        tokenEstimate: 100,
        createdAt: now - 10,
      });
      await insertSummary({
        channel: TEST_CHANNEL,
        chatId: TEST_CHAT,
        summary: "Second",
        messageCount: 7,
        tokenEstimate: 250,
        createdAt: now,
      });

      await clearSummaries(TEST_CHANNEL, TEST_CHAT);

      const result = await getLatestSummary(TEST_CHANNEL, TEST_CHAT);
      expect(result).toBeNull();
    });

    it("does not delete summaries for other channel+chatId pairs", async () => {
      const now = Math.floor(Date.now() / 1000);
      await insertSummary({
        channel: TEST_CHANNEL,
        chatId: TEST_CHAT,
        summary: "To be cleared",
        messageCount: 3,
        tokenEstimate: 100,
        createdAt: now,
      });
      await insertSummary({
        channel: "test-summaries-keep",
        chatId: "test-summaries-keep-chat",
        summary: "Should survive",
        messageCount: 5,
        tokenEstimate: 200,
        createdAt: now,
      });

      await clearSummaries(TEST_CHANNEL, TEST_CHAT);

      const cleared = await getLatestSummary(TEST_CHANNEL, TEST_CHAT);
      expect(cleared).toBeNull();

      const kept = await getLatestSummary(
        "test-summaries-keep",
        "test-summaries-keep-chat",
      );
      expect(kept).not.toBeNull();
      expect(kept!.summary).toBe("Should survive");
    });

    it("is a no-op when no matching summaries exist", async () => {
      // Should not throw
      await clearSummaries(TEST_CHANNEL, "nonexistent");
      const result = await getLatestSummary(TEST_CHANNEL, "nonexistent");
      expect(result).toBeNull();
    });
  });
});
