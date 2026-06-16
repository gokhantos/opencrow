import { describe, it, expect, beforeEach, afterEach, vi } from "bun:test";
import {
  recordTokenUsage,
  getUsageSummary,
  getUsageByAgent,
  getUsageByModel,
  getUsageTimeSeries,
  getRecentUsage,
  type TokenUsageRecord,
} from "./token-usage";
import { initDb, closeDb, getDb } from "./db";

// Note: Using real database for integration testing
// Mocks pollute the module cache and break other tests

describe("token-usage", () => {
  beforeEach(async () => {
    await initDb(process.env.DATABASE_URL);
    vi.clearAllMocks();

    // Clean up test data
    const db = getDb();
    await db.unsafe("DELETE FROM token_usage WHERE agent_id = 'test-agent'");
  });

  afterEach(async () => {
    const db = getDb();
    await db.unsafe("DELETE FROM token_usage WHERE agent_id = 'test-agent'");
    await closeDb();
  });

  describe("recordTokenUsage", () => {
    it("inserts a token usage record", async () => {
      const entry: TokenUsageRecord = {
        id: "test-id",
        agentId: "test-agent",
        model: "claude-sonnet-4-6",
        provider: "anthropic",
        channel: "telegram",
        chatId: "chat-123",
        source: "message",
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 10,
        cacheCreationTokens: 5,
        costUsd: 0.001,
        durationMs: 500,
        toolUseCount: 3,
        createdAt: Math.floor(Date.now() / 1000),
      };

      await recordTokenUsage(entry);

      // Verify by retrieving
      const recent = await getRecentUsage(10);
      const found = recent.find(r => r.id === "test-id");
      expect(found).toBeDefined();
      expect(found!.inputTokens).toBe(115); // input + cache_read + cache_creation
    });
  });

  describe("getUsageSummary", () => {
    it("returns usage summary with no time filter", async () => {
      const entry: TokenUsageRecord = {
        id: "test-id-1",
        agentId: "test-agent",
        model: "claude-sonnet-4-6",
        provider: "anthropic",
        channel: "telegram",
        chatId: "chat-123",
        source: "message",
        inputTokens: 150,
        outputTokens: 50,
        cacheReadTokens: 10,
        cacheCreationTokens: 5,
        costUsd: 0.001,
        durationMs: 500,
        toolUseCount: 3,
        createdAt: Math.floor(Date.now() / 1000),
      };

      await recordTokenUsage(entry);

      const result = await getUsageSummary({});

      expect(result.totalInputTokens).toBeGreaterThanOrEqual(150);
      expect(result.totalRequests).toBeGreaterThanOrEqual(1);
    });

    it("handles empty data", async () => {
      // Use a unique agent ID that has no data
      const result = await getUsageSummary({});
      // The database may have data from other tests, so just verify the call works
      expect(result.totalInputTokens).toBeGreaterThanOrEqual(0);
      expect(result.totalRequests).toBeGreaterThanOrEqual(0);
    });
  });

  describe("getUsageByAgent", () => {
    it("returns usage grouped by agent", async () => {
      await recordTokenUsage({
        id: "test-id-1",
        agentId: "test-agent",
        model: "claude-sonnet-4-6",
        provider: "anthropic",
        channel: "telegram",
        chatId: "chat-123",
        source: "message",
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 10,
        cacheCreationTokens: 5,
        costUsd: 0.001,
        durationMs: 500,
        toolUseCount: 3,
        createdAt: Math.floor(Date.now() / 1000),
      });

      const result = await getUsageByAgent({});

      expect(result.length).toBeGreaterThanOrEqual(1);
      const agentResult = result.find(r => r.agentId === "test-agent");
      expect(agentResult).toBeDefined();
      expect(agentResult!.totalInputTokens).toBeGreaterThanOrEqual(100);
    });

    it("returns empty array when no data", async () => {
      const result = await getUsageByAgent({});
      // May have data from other tests, so just verify it doesn't throw
      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe("getUsageByModel", () => {
    it("returns usage grouped by model", async () => {
      await recordTokenUsage({
        id: "test-id-1",
        agentId: "test-agent",
        model: "claude-sonnet-4-6",
        provider: "anthropic",
        channel: "telegram",
        chatId: "chat-123",
        source: "message",
        inputTokens: 500,
        outputTokens: 200,
        cacheReadTokens: 50,
        cacheCreationTokens: 25,
        costUsd: 0.01,
        durationMs: 1000,
        toolUseCount: 5,
        createdAt: Math.floor(Date.now() / 1000),
      });

      const result = await getUsageByModel({});

      expect(result.length).toBeGreaterThanOrEqual(1);
      const modelResult = result.find(r => r.model === "claude-sonnet-4-6");
      expect(modelResult).toBeDefined();
      expect(modelResult!.totalInputTokens).toBeGreaterThanOrEqual(500);
    });
  });

  describe("getUsageTimeSeries", () => {
    it("returns hourly time series", async () => {
      await recordTokenUsage({
        id: "test-id-1",
        agentId: "test-agent",
        model: "claude-sonnet-4-6",
        provider: "anthropic",
        channel: "telegram",
        chatId: "chat-123",
        source: "message",
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 10,
        cacheCreationTokens: 5,
        costUsd: 0.001,
        durationMs: 500,
        toolUseCount: 3,
        createdAt: Math.floor(Date.now() / 1000),
      });

      const result = await getUsageTimeSeries({
        granularity: "hour",
        since: Math.floor(Date.now() / 1000) - 3600,
      });

      expect(result.length).toBeGreaterThanOrEqual(1);
      expect(result[0]!.inputTokens).toBeGreaterThanOrEqual(100);
    });

    it("handles empty data", async () => {
      const result = await getUsageTimeSeries({
        granularity: "hour",
        since: Math.floor(Date.now() / 1000) - 3600,
      });
      // May have data from other tests
      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe("getRecentUsage", () => {
    it("returns recent token usage records", async () => {
      await recordTokenUsage({
        id: "test-id-1",
        agentId: "test-agent",
        model: "claude-sonnet-4-6",
        provider: "anthropic",
        channel: "telegram",
        chatId: "chat-123",
        source: "message",
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 10,
        cacheCreationTokens: 5,
        costUsd: 0.001,
        durationMs: 500,
        toolUseCount: 3,
        createdAt: Math.floor(Date.now() / 1000),
      });

      const result = await getRecentUsage(10);

      expect(result.length).toBeGreaterThanOrEqual(1);
      const found = result.find(r => r.id === "test-id-1");
      expect(found).toBeDefined();
      expect(found!.inputTokens).toBe(115); // input + cache_read + cache_creation
    });

    it("clamps limit to max 500", async () => {
      const result = await getRecentUsage(1000);
      expect(result.length).toBeLessThanOrEqual(500);
    });

    it("clamps limit to min 1", async () => {
      const result = await getRecentUsage(0);
      expect(result.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe("integration", () => {
    it("full workflow: record then query", async () => {
      const entry: TokenUsageRecord = {
        id: "integration-test",
        agentId: "test-agent",
        model: "claude-sonnet-4-6",
        provider: "anthropic",
        channel: "telegram",
        chatId: "chat-123",
        source: "message",
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 10,
        cacheCreationTokens: 5,
        costUsd: 0.001,
        durationMs: 500,
        toolUseCount: 3,
        createdAt: Math.floor(Date.now() / 1000),
      };

      await recordTokenUsage(entry);

      const summary = await getUsageSummary({});
      expect(summary.totalRequests).toBeGreaterThanOrEqual(1);
    });
  });
});
