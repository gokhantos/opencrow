import { describe, it, expect, beforeEach, afterEach, vi } from "bun:test";
import {
  addRoutingRule,
  listRoutingRules,
  getRoutingRulesForChannel,
  updateRoutingRule,
  removeRoutingRule,
  resolveAgentForMessage,
  type RoutingRule,
} from "./routing-rules";
import { initDb, closeDb, getDb } from "./db";

// Note: Using real database for integration testing
// Mocks pollute the module cache and break other tests

describe("routing-rules", () => {
  beforeEach(async () => {
    await initDb(process.env.DATABASE_URL);
    vi.clearAllMocks();

    // Clean up test data
    const db = getDb();
    await db.unsafe("DELETE FROM routing_rules WHERE channel = 'test-channel'");
  });

  afterEach(async () => {
    const db = getDb();
    await db.unsafe("DELETE FROM routing_rules WHERE channel = 'test-channel'");
    await closeDb();
  });

  const baseRule = (): Omit<RoutingRule, "id" | "createdAt" | "updatedAt"> => ({
    channel: "test-channel",
    matchType: "chat",
    matchValue: "chat-123",
    agentId: "agent-alpha",
    priority: 10,
    enabled: true,
    notes: null,
  });

  describe("addRoutingRule", () => {
    it("creates and returns a correctly mapped rule", async () => {
      const rule = await addRoutingRule(baseRule());

      expect(rule.id).toBeDefined();
      expect(rule.channel).toBe("test-channel");
      expect(rule.matchType).toBe("chat");
      expect(rule.matchValue).toBe("chat-123");
      expect(rule.agentId).toBe("agent-alpha");
      expect(rule.priority).toBe(10);
      expect(rule.enabled).toBe(true);
      expect(rule.notes).toBeNull();
      expect(rule.createdAt).toBeGreaterThan(0);
      expect(rule.updatedAt).toBeGreaterThan(0);
    });
  });

  describe("listRoutingRules", () => {
    it("returns rules sorted by priority DESC", async () => {
      await addRoutingRule({ ...baseRule(), matchValue: "chat-low", priority: 1 });
      await addRoutingRule({ ...baseRule(), matchValue: "chat-high", priority: 100 });
      await addRoutingRule({ ...baseRule(), matchValue: "chat-mid", priority: 50 });

      const rules = await listRoutingRules();

      const testRules = rules.filter((r) => r.channel === "test-channel");
      expect(testRules.length).toBeGreaterThanOrEqual(3);

      // Verify descending priority order within test rules
      for (let i = 1; i < testRules.length; i++) {
        expect(testRules[i - 1]!.priority).toBeGreaterThanOrEqual(
          testRules[i]!.priority,
        );
      }
    });
  });

  describe("getRoutingRulesForChannel", () => {
    it("filters by channel and includes wildcard rules", async () => {
      const db = getDb();

      // Insert a wildcard rule directly so we can clean it up separately
      await db.unsafe(
        `INSERT INTO routing_rules
          (id, channel, match_type, match_value, agent_id, priority, enabled, notes, created_at, updated_at)
         VALUES
          ('wc-test-id', '*', 'chat', 'chat-any', 'agent-wildcard', 5, true, null,
           extract(epoch from now())::bigint, extract(epoch from now())::bigint)`,
      );

      await addRoutingRule({ ...baseRule(), matchValue: "chat-123", agentId: "agent-specific" });

      try {
        const rules = await getRoutingRulesForChannel("test-channel");

        const channels = rules.map((r) => r.channel);
        expect(channels).toContain("test-channel");
        expect(channels).toContain("*");
      } finally {
        await db.unsafe("DELETE FROM routing_rules WHERE id = 'wc-test-id'");
      }
    });

    it("only returns enabled rules", async () => {
      await addRoutingRule({ ...baseRule(), matchValue: "chat-enabled", enabled: true });
      await addRoutingRule({ ...baseRule(), matchValue: "chat-disabled", enabled: false });

      const rules = await getRoutingRulesForChannel("test-channel");

      for (const rule of rules) {
        expect(rule.enabled).toBe(true);
      }

      const disabledFound = rules.find((r) => r.matchValue === "chat-disabled");
      expect(disabledFound).toBeUndefined();
    });
  });

  describe("updateRoutingRule", () => {
    it("updates agentId", async () => {
      const rule = await addRoutingRule(baseRule());

      const updated = await updateRoutingRule(rule.id, { agentId: "agent-beta" });

      expect(updated).not.toBeNull();
      expect(updated!.agentId).toBe("agent-beta");
    });

    it("updates priority", async () => {
      const rule = await addRoutingRule(baseRule());

      const updated = await updateRoutingRule(rule.id, { priority: 99 });

      expect(updated).not.toBeNull();
      expect(updated!.priority).toBe(99);
    });

    it("updates multiple fields at once", async () => {
      const rule = await addRoutingRule(baseRule());

      const updated = await updateRoutingRule(rule.id, {
        agentId: "agent-gamma",
        priority: 77,
        enabled: false,
        notes: "updated notes",
      });

      expect(updated).not.toBeNull();
      expect(updated!.agentId).toBe("agent-gamma");
      expect(updated!.priority).toBe(77);
      expect(updated!.enabled).toBe(false);
      expect(updated!.notes).toBe("updated notes");
    });

    it("returns null for a nonexistent ID", async () => {
      const result = await updateRoutingRule(
        "00000000-0000-0000-0000-000000000000",
        { agentId: "nobody" },
      );

      expect(result).toBeNull();
    });
  });

  describe("removeRoutingRule", () => {
    it("returns true on first removal then false on second", async () => {
      const rule = await addRoutingRule(baseRule());

      const first = await removeRoutingRule(rule.id);
      expect(first).toBe(true);

      const second = await removeRoutingRule(rule.id);
      expect(second).toBe(false);
    });
  });

  describe("resolveAgentForMessage", () => {
    it("matches a chat rule and returns the agent ID", async () => {
      await addRoutingRule({
        ...baseRule(),
        matchType: "chat",
        matchValue: "chat-resolve",
        agentId: "agent-resolved",
        priority: 10,
        enabled: true,
      });

      const agentId = await resolveAgentForMessage(
        "test-channel",
        "chat-resolve",
        "user-xyz",
      );

      expect(agentId).toBe("agent-resolved");
    });

    it("returns null when no rule matches", async () => {
      const agentId = await resolveAgentForMessage(
        "test-channel",
        "chat-no-match",
        "user-no-match",
      );

      expect(agentId).toBeNull();
    });
  });
});
