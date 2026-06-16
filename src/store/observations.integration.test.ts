import { describe, it, expect, beforeEach, afterEach, vi } from "bun:test";
import {
  saveObservations,
  getRecentObservations,
  getObservationsByChat,
  formatObservationBlock,
  type Observation,
} from "./observations";
import { initDb, closeDb, getDb } from "./db";

// Note: Using real database for integration testing
// Mocks pollute the module cache and break other tests

describe("observations", () => {
  beforeEach(async () => {
    await initDb(process.env.DATABASE_URL);
    vi.clearAllMocks();

    // Clean up test data
    const db = getDb();
    await db.unsafe("DELETE FROM conversation_observations WHERE agent_id = 'test-agent'");
  });

  afterEach(async () => {
    const db = getDb();
    await db.unsafe("DELETE FROM conversation_observations WHERE agent_id = 'test-agent'");
    await closeDb();
  });

  const createObservation = (
    id: string,
    type: string,
    chatId?: string,
  ): Observation => ({
    id,
    agentId: "test-agent",
    channel: "telegram",
    chatId: chatId || "chat-123",
    observationType: type as Observation["observationType"],
    title: `Test ${type} title`,
    summary: `Test ${type} summary`,
    facts: [`Fact 1 about ${type}`, `Fact 2 about ${type}`],
    concepts: [`Concept A`, `Concept B`],
    toolsUsed: ["tool1", "tool2"],
    sourceMessageCount: 10,
    createdAt: Math.floor(Date.now() / 1000),
  });

  describe("saveObservations", () => {
    it("saves multiple observations in a transaction", async () => {
      const observations: Observation[] = [
        createObservation("obs-1", "preference"),
        createObservation("obs-2", "decision"),
        createObservation("obs-3", "discovery"),
      ];

      await saveObservations(observations);

      // Verify by retrieving
      const retrieved = await getRecentObservations("test-agent", 10);
      expect(retrieved.length).toBe(3);
    });

    it("does nothing when observations array is empty", async () => {
      await saveObservations([]);
      const retrieved = await getRecentObservations("test-agent", 10);
      expect(retrieved.length).toBe(0);
    });
  });

  describe("getRecentObservations", () => {
    it("returns recent observations for an agent", async () => {
      const obs1 = createObservation("obs-1", "preference");
      const obs2 = createObservation("obs-2", "decision", "chat-456");

      await saveObservations([obs1, obs2]);

      const result = await getRecentObservations("test-agent", 10);

      expect(result.length).toBeGreaterThanOrEqual(2);
      const foundObs1 = result.find(o => o.id === "obs-1");
      expect(foundObs1).toBeDefined();
      expect(foundObs1!.observationType).toBe("preference");
    });

    it("returns empty array when no observations", async () => {
      const result = await getRecentObservations("nonexistent-agent", 10);
      expect(result).toEqual([]);
    });

    it("handles observations without facts", async () => {
      const obs: Observation = {
        ...createObservation("obs-1", "context"),
        facts: [],
      };

      await saveObservations([obs]);
      const result = await getRecentObservations("test-agent", 10);

      const found = result.find(o => o.id === "obs-1");
      expect(found).toBeDefined();
      expect(found!.facts).toEqual([]);
    });

    it("includes facts when present", async () => {
      const obs: Observation = {
        ...createObservation("obs-1", "capability"),
        facts: ["Fact A", "Fact B"],
      };

      await saveObservations([obs]);
      const result = await getRecentObservations("test-agent", 10);

      const found = result.find(o => o.id === "obs-1");
      expect(found!.facts).toEqual(["Fact A", "Fact B"]);
    });
  });

  describe("getObservationsByChat", () => {
    it("returns observations for a specific chat", async () => {
      const obs = createObservation("obs-1", "task", "chat-123");
      await saveObservations([obs]);

      const result = await getObservationsByChat("telegram", "chat-123", 10);

      expect(result.length).toBeGreaterThanOrEqual(1);
      expect(result[0]!.chatId).toBe("chat-123");
      expect(result[0]!.channel).toBe("telegram");
    });

    it("returns empty array when no observations for chat", async () => {
      const result = await getObservationsByChat("telegram", "nonexistent-chat");
      expect(result).toEqual([]);
    });
  });

  describe("formatObservationBlock", () => {
    it("returns empty string for empty array", () => {
      const result = formatObservationBlock([]);
      expect(result).toBe("");
    });

    it("formats a single observation", () => {
      const obs = createObservation("obs-1", "preference");
      const result = formatObservationBlock([obs]);

      expect(result).toContain("## Observations from Past Conversations");
      expect(result).toContain("[preference]");
      expect(result).toContain("Test preference title");
      expect(result).toContain("Fact 1 about preference");
    });

    it("formats multiple observations", () => {
      const observations: Observation[] = [
        createObservation("obs-1", "preference"),
        createObservation("obs-2", "decision"),
        createObservation("obs-3", "discovery"),
      ];

      const result = formatObservationBlock(observations);

      expect(result).toContain("## Observations from Past Conversations");
      expect(result.split("\n").filter((l) => l.startsWith("  -")).length).toBe(3);
    });

    it("handles observations without facts", () => {
      const obs: Observation = {
        ...createObservation("obs-1", "context"),
        facts: [],
      };

      const result = formatObservationBlock([obs]);
      expect(result).not.toContain("Facts:");
    });

    it("includes facts when present", () => {
      const obs: Observation = {
        ...createObservation("obs-1", "capability"),
        facts: ["Fact A", "Fact B"],
      };

      const result = formatObservationBlock([obs]);
      expect(result).toContain("Facts: Fact A; Fact B");
    });

    it("formats all observation types", () => {
      const types: Observation["observationType"][] = [
        "preference",
        "decision",
        "capability",
        "context",
        "task",
        "discovery",
      ];

      const observations = types.map((type, i) =>
        createObservation(`obs-${i}`, type),
      );

      const result = formatObservationBlock(observations);

      types.forEach((type) => {
        expect(result).toContain(`[${type}]`);
      });
    });
  });

  describe("integration", () => {
    it("full workflow: save then retrieve", async () => {
      const observations: Observation[] = [
        createObservation("obs-1", "preference"),
        createObservation("obs-2", "decision", "chat-789"),
      ];

      // Save
      await saveObservations(observations);

      // Retrieve
      const result = await getRecentObservations("test-agent", 10);
      expect(result.length).toBeGreaterThanOrEqual(2);
    });
  });
});
