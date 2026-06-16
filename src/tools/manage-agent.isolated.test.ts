import { test, expect, describe, mock, beforeEach } from "bun:test";
import { createManageAgentTool } from "./manage-agent";
import type { ManageAgentToolConfig } from "./manage-agent";
import type { AgentRegistry } from "../agents/registry";
import type { ResolvedAgent } from "../agents/types";
import type { AgentDefinition } from "../agents/types";

// --- Mocks ---

const mockReloadRegistry = mock(() => Promise.resolve());

const mockAgentRegistry: AgentRegistry = {
  agents: [],
  getDefault: () => ({}) as ResolvedAgent,
  getById: () => undefined,
  listIds: () => [],
  listForAgent: () => [],
  reload: (_configs: readonly AgentDefinition[], _defaults: unknown) => {},
};

const mockConfig: ManageAgentToolConfig = {
  agentRegistry: mockAgentRegistry,
  reloadRegistry: mockReloadRegistry,
};

// Mock external modules
const mockGetMergedAgentsWithSource = mock(() =>
  Promise.resolve([
    {
      id: "default",
      name: "Default Agent",
      description: "The default agent",
      model: "claude-sonnet-4-6",
      provider: "agent-sdk",
      default: true,
      _source: "file",
    },
    {
      id: "researcher",
      name: "Research Agent",
      description: "Research specialist",
      model: "claude-sonnet-4-6",
      provider: "agent-sdk",
      default: false,
      _source: "db",
      telegramBotToken: "secret-token-123",
    },
  ]),
);

const mockComputeMergedAgentHash = mock(() => "abc123hash");

const mockAddAgentToDb = mock((_def: unknown, _hash: string) =>
  Promise.resolve("newhash"),
);

const mockUpdateAgentInDb = mock(
  (_id: string, _partial: unknown, _hash: string) => Promise.resolve("newhash"),
);

const mockRemoveAgentFromDb = mock((_id: string, _hash: string) =>
  Promise.resolve("newhash"),
);

class MockAgentConflictError extends Error {
  constructor() {
    super("Agent list changed since last read. Refresh and retry.");
    this.name = "AgentConflictError";
  }
}

mock.module("../config/loader", () => ({
  getMergedAgentsWithSource: mockGetMergedAgentsWithSource,
  computeMergedAgentHash: mockComputeMergedAgentHash,
  loadConfigWithOverrides: mock(() => Promise.resolve({})),
}));

mock.module("../config/agent-mutations", () => ({
  addAgentToDb: mockAddAgentToDb,
  updateAgentInDb: mockUpdateAgentInDb,
  removeAgentFromDb: mockRemoveAgentFromDb,
  AgentConflictError: MockAgentConflictError,
}));

mock.module("../logger", () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
}));

describe("manage_agent tool", () => {
  let tool: ReturnType<typeof createManageAgentTool>;

  beforeEach(() => {
    mockReloadRegistry.mockClear();
    mockGetMergedAgentsWithSource.mockClear();
    mockAddAgentToDb.mockClear();
    mockUpdateAgentInDb.mockClear();
    mockRemoveAgentFromDb.mockClear();
    mockComputeMergedAgentHash.mockClear();

    tool = createManageAgentTool(mockConfig);
  });

  test("has correct metadata", () => {
    expect(tool.name).toBe("manage_agent");
    expect(tool.categories).toEqual(["system"]);
    expect(tool.description).toContain("Manage agents");
  });

  test("rejects unknown action", async () => {
    const result = await tool.execute({ action: "unknown" });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("Unknown action");
  });

  describe("list", () => {
    test("returns agent summaries with config hash", async () => {
      const result = await tool.execute({ action: "list" });
      expect(result.isError).toBe(false);

      const parsed = JSON.parse(result.output);
      expect(parsed.agents).toHaveLength(2);
      expect(parsed.agents[0].id).toBe("default");
      expect(parsed.agents[0].name).toBe("Default Agent");
      expect(parsed.configHash).toBe("abc123hash");
    });

    test("redacts telegramBotToken from list", async () => {
      const result = await tool.execute({ action: "list" });
      expect(result.output).not.toContain("secret-token-123");
    });
  });

  describe("get", () => {
    test("returns full agent definition", async () => {
      const result = await tool.execute({
        action: "get",
        agent_id: "default",
      });
      expect(result.isError).toBe(false);

      const parsed = JSON.parse(result.output);
      expect(parsed.id).toBe("default");
      expect(parsed.name).toBe("Default Agent");
    });

    test("redacts telegramBotToken", async () => {
      const result = await tool.execute({
        action: "get",
        agent_id: "researcher",
      });
      expect(result.isError).toBe(false);

      const parsed = JSON.parse(result.output);
      expect(parsed.telegramBotToken).toBe("configured");
      expect(result.output).not.toContain("secret-token-123");
    });

    test("returns error for missing agent_id", async () => {
      const result = await tool.execute({ action: "get" });
      expect(result.isError).toBe(true);
      expect(result.output).toContain("agent_id");
    });

    test("returns error for nonexistent agent", async () => {
      const result = await tool.execute({
        action: "get",
        agent_id: "nonexistent",
      });
      expect(result.isError).toBe(true);
      expect(result.output).toContain("not found");
    });
  });

  describe("create", () => {
    test("creates agent with valid input", async () => {
      const result = await tool.execute({
        action: "create",
        agent_id: "new-agent",
        name: "New Agent",
        description: "A new agent",
        system_prompt: "You are helpful",
        model: "claude-sonnet-4-6",
        provider: "agent-sdk",
      });
      expect(result.isError).toBe(false);
      expect(result.output).toContain("new-agent");

      expect(mockAddAgentToDb).toHaveBeenCalledTimes(1);
      const call = mockAddAgentToDb.mock.calls[0]!;
      const def = call[0] as Record<string, unknown>;
      expect(def.id).toBe("new-agent");
      expect(def.name).toBe("New Agent");
      expect(def.systemPrompt).toBe("You are helpful");

      expect(mockReloadRegistry).toHaveBeenCalledTimes(1);
    });

    test("rejects missing agent_id", async () => {
      const result = await tool.execute({
        action: "create",
        name: "No ID",
      });
      expect(result.isError).toBe(true);
      expect(result.output).toContain("agent_id");
    });

    test("rejects missing name", async () => {
      const result = await tool.execute({
        action: "create",
        agent_id: "test-agent",
      });
      expect(result.isError).toBe(true);
      expect(result.output).toContain("name");
    });

    test("rejects invalid agent_id format", async () => {
      const result = await tool.execute({
        action: "create",
        agent_id: "Invalid_ID!",
        name: "Bad ID",
      });
      expect(result.isError).toBe(true);
      expect(result.output).toContain("lowercase");
    });

    test("rejects agent_id starting with hyphen", async () => {
      const result = await tool.execute({
        action: "create",
        agent_id: "-bad-start",
        name: "Bad Start",
      });
      expect(result.isError).toBe(true);
      expect(result.output).toContain("lowercase");
    });

    test("maps snake_case fields to camelCase", async () => {
      await tool.execute({
        action: "create",
        agent_id: "mapped-agent",
        name: "Mapped",
        system_prompt: "prompt",
        max_iterations: 10,
        tool_filter: { mode: "allowlist", tools: ["memory"] },
      });

      const call = mockAddAgentToDb.mock.calls[0]!;
      const defObj = call[0] as Record<string, unknown>;
      expect(defObj.systemPrompt).toBe("prompt");
      expect(defObj.maxIterations).toBe(10);
      expect(defObj.toolFilter).toEqual({
        mode: "allowlist",
        tools: ["memory"],
      });
      // Should not have snake_case keys
      expect(defObj.system_prompt).toBeUndefined();
      expect(defObj.max_iterations).toBeUndefined();
      expect(defObj.tool_filter).toBeUndefined();
    });
  });

  describe("update", () => {
    test("updates agent with partial fields", async () => {
      const result = await tool.execute({
        action: "update",
        agent_id: "researcher",
        name: "Updated Name",
        description: "Updated desc",
      });
      expect(result.isError).toBe(false);

      expect(mockUpdateAgentInDb).toHaveBeenCalledTimes(1);
      const updateCall = mockUpdateAgentInDb.mock.calls[0]!;
      expect(updateCall[0]).toBe("researcher");
      const partial = updateCall[1] as Record<string, unknown>;
      expect(partial.name).toBe("Updated Name");
      expect(partial.description).toBe("Updated desc");

      expect(mockReloadRegistry).toHaveBeenCalledTimes(1);
    });

    test("rejects missing agent_id", async () => {
      const result = await tool.execute({
        action: "update",
        name: "No ID",
      });
      expect(result.isError).toBe(true);
      expect(result.output).toContain("agent_id");
    });

    test("maps snake_case to camelCase on update", async () => {
      await tool.execute({
        action: "update",
        agent_id: "researcher",
        system_prompt: "new prompt",
        max_iterations: 5,
      });

      const updateCall2 = mockUpdateAgentInDb.mock.calls[0]!;
      const partialObj = updateCall2[1] as Record<string, unknown>;
      expect(partialObj.systemPrompt).toBe("new prompt");
      expect(partialObj.maxIterations).toBe(5);
    });
  });

  describe("delete", () => {
    test("requires confirm_delete", async () => {
      const result = await tool.execute({
        action: "delete",
        agent_id: "researcher",
      });
      expect(result.isError).toBe(false);
      expect(result.output).toContain("confirm_delete");
      expect(mockRemoveAgentFromDb).not.toHaveBeenCalled();
    });

    test("deletes agent when confirmed", async () => {
      const result = await tool.execute({
        action: "delete",
        agent_id: "researcher",
        confirm_delete: true,
      });
      expect(result.isError).toBe(false);
      expect(result.output).toContain("deleted");

      expect(mockRemoveAgentFromDb).toHaveBeenCalledTimes(1);
      expect(mockRemoveAgentFromDb.mock.calls[0]![0]).toBe("researcher");
      expect(mockReloadRegistry).toHaveBeenCalledTimes(1);
    });

    test("rejects missing agent_id", async () => {
      const result = await tool.execute({
        action: "delete",
        confirm_delete: true,
      });
      expect(result.isError).toBe(true);
      expect(result.output).toContain("agent_id");
    });
  });

  describe("error handling", () => {
    test("handles AgentConflictError gracefully", async () => {
      mockAddAgentToDb.mockRejectedValueOnce(new MockAgentConflictError());

      const result = await tool.execute({
        action: "create",
        agent_id: "conflict-agent",
        name: "Conflict",
      });
      expect(result.isError).toBe(true);
      expect(result.output).toContain("changed");
      expect(result.output).toContain("retry");
    });

    test("handles generic errors", async () => {
      mockAddAgentToDb.mockRejectedValueOnce(new Error("DB connection lost"));

      const result = await tool.execute({
        action: "create",
        agent_id: "error-agent",
        name: "Error",
      });
      expect(result.isError).toBe(true);
      expect(result.output).toContain("DB connection lost");
    });

    test("handles unexpected throw in list", async () => {
      mockGetMergedAgentsWithSource.mockRejectedValueOnce(
        new Error("Failed to load"),
      );

      const result = await tool.execute({ action: "list" });
      expect(result.isError).toBe(true);
      expect(result.output).toContain("Failed to load");
    });
  });
});
