import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb, getDb } from "./db";
import { getAgentMemories, setMemory } from "./memory";

const TEST_AGENT = "test-agent-memory-integration";

describe("store/memory", () => {
  beforeEach(async () => {
    await initDb(process.env.DATABASE_URL);
    const db = getDb();
    await db.unsafe(
      `DELETE FROM agent_memory WHERE agent_id LIKE 'test-agent-memory-%'`,
    );
  });

  afterEach(async () => {
    const db = getDb();
    await db.unsafe(
      `DELETE FROM agent_memory WHERE agent_id LIKE 'test-agent-memory-%'`,
    );
    await closeDb();
  });

  describe("setMemory + getAgentMemories round-trip", () => {
    it("stores a key-value pair and retrieves it", async () => {
      await setMemory(TEST_AGENT, "goal", "build something cool");

      const entries = await getAgentMemories(TEST_AGENT);

      expect(entries.length).toBe(1);
      expect(entries[0]!.key).toBe("goal");
      expect(entries[0]!.value).toBe("build something cool");
      expect(entries[0]!.updatedAt).toBeGreaterThan(0);
    });

    it("returns empty array when agent has no memories", async () => {
      const entries = await getAgentMemories("test-agent-memory-nonexistent");
      expect(entries).toEqual([]);
    });

    it("stores multiple keys for the same agent", async () => {
      await setMemory(TEST_AGENT, "name", "Alice");
      await setMemory(TEST_AGENT, "role", "engineer");
      await setMemory(TEST_AGENT, "team", "platform");

      const entries = await getAgentMemories(TEST_AGENT);

      expect(entries.length).toBe(3);
      const keys = entries.map((e) => e.key);
      expect(keys).toContain("name");
      expect(keys).toContain("role");
      expect(keys).toContain("team");
    });
  });

  describe("setMemory upsert", () => {
    it("overwrites value on conflict (same agent + key)", async () => {
      await setMemory(TEST_AGENT, "mood", "happy");
      await setMemory(TEST_AGENT, "mood", "focused");

      const entries = await getAgentMemories(TEST_AGENT);

      expect(entries.length).toBe(1);
      expect(entries[0]!.key).toBe("mood");
      expect(entries[0]!.value).toBe("focused");
    });
  });

  describe("agent isolation", () => {
    it("memories are scoped per agent", async () => {
      const agentA = "test-agent-memory-a";
      const agentB = "test-agent-memory-b";

      await setMemory(agentA, "secret", "alpha");
      await setMemory(agentB, "secret", "beta");

      const entriesA = await getAgentMemories(agentA);
      const entriesB = await getAgentMemories(agentB);

      expect(entriesA.length).toBe(1);
      expect(entriesA[0]!.value).toBe("alpha");
      expect(entriesB.length).toBe(1);
      expect(entriesB[0]!.value).toBe("beta");
    });
  });

  describe("ordering", () => {
    it("returns entries ordered by updated_at ascending", async () => {
      const db = getDb();
      const now = Math.floor(Date.now() / 1000);
      // Seed with explicit timestamps to avoid sleeps
      await db.unsafe(
        `INSERT INTO agent_memory (agent_id, key, value, updated_at)
         VALUES ('${TEST_AGENT}', 'first', '1', ${now - 100}),
                ('${TEST_AGENT}', 'second', '2', ${now})`,
      );

      const entries = await getAgentMemories(TEST_AGENT);

      expect(entries.length).toBe(2);
      expect(entries[0]!.key).toBe("first");
      expect(entries[1]!.key).toBe("second");
      expect(entries[0]!.updatedAt).toBeLessThan(entries[1]!.updatedAt);
    });
  });
});
