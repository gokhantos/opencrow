import { describe, it, expect, beforeEach, afterEach, vi } from "bun:test";
import {
  upsertAgentOverride,
  getAgentOverride,
  getAgentOverrides,
  tombstoneAgentOverride,
  deleteAgentOverrideRow,
} from "./agent-overrides";
import { initDb, closeDb, getDb } from "./db";
import type { AgentDefinition } from "../agents/types";

// Note: Using real database for integration testing
// Mocks pollute the module cache and break other tests

describe("agent-overrides", () => {
  beforeEach(async () => {
    await initDb(process.env.DATABASE_URL);
    vi.clearAllMocks();

    // Clean up test data
    const db = getDb();
    await db.unsafe(
      "DELETE FROM config_overrides WHERE namespace = 'agents' AND key LIKE 'test-%'",
    );
  });

  afterEach(async () => {
    const db = getDb();
    await db.unsafe(
      "DELETE FROM config_overrides WHERE namespace = 'agents' AND key LIKE 'test-%'",
    );
    await closeDb();
  });

  const testDef: AgentDefinition = {
    id: "test-agent",
    name: "Test Agent",
    provider: "agent-sdk" as const,
  };

  describe("upsertAgentOverride / getAgentOverride", () => {
    it("round-trips an agent definition", async () => {
      await upsertAgentOverride("test-agent", testDef);

      const result = await getAgentOverride("test-agent");

      expect(result).not.toBeNull();
      expect(result!.id).toBe("test-agent");
      expect(result!.definition.id).toBe("test-agent");
      expect(result!.definition.name).toBe("Test Agent");
      expect(result!.definition.provider).toBe("agent-sdk");
    });
  });

  describe("getAgentOverride", () => {
    it("returns null for a missing agent ID", async () => {
      const result = await getAgentOverride("test-nonexistent");

      expect(result).toBeNull();
    });
  });

  describe("getAgentOverrides", () => {
    it("returns all upserted agent overrides", async () => {
      const defA: AgentDefinition = { ...testDef, id: "test-agent-a", name: "Agent A" };
      const defB: AgentDefinition = { ...testDef, id: "test-agent-b", name: "Agent B" };

      await upsertAgentOverride("test-agent-a", defA);
      await upsertAgentOverride("test-agent-b", defB);

      const overrides = await getAgentOverrides();

      const ids = overrides.map((o) => o.id);
      expect(ids).toContain("test-agent-a");
      expect(ids).toContain("test-agent-b");
    });
  });

  describe("tombstoneAgentOverride", () => {
    it("sets _deleted: true on the stored definition", async () => {
      await upsertAgentOverride("test-agent", testDef);
      await tombstoneAgentOverride("test-agent");

      const result = await getAgentOverride("test-agent");

      expect(result).not.toBeNull();
      expect(result!.definition._deleted).toBe(true);
    });
  });

  describe("deleteAgentOverrideRow", () => {
    it("removes the entry entirely so getAgentOverride returns null", async () => {
      await upsertAgentOverride("test-agent", testDef);
      await deleteAgentOverrideRow("test-agent");

      const result = await getAgentOverride("test-agent");

      expect(result).toBeNull();
    });
  });
});
