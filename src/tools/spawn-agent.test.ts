import { describe, it, expect, beforeEach, mock } from "bun:test";
import type { SpawnAgentToolConfig } from "./spawn-agent";
import type { AgentRegistry } from "../agents/registry";
import type { ToolRegistry } from "./registry";
import type { SubAgentTracker } from "../agents/tracker";
import type { ResolvedAgent } from "../agents/types";

// Mock runAgentIsolated before importing the module
const mockRunAgentIsolated = mock(() =>
  Promise.resolve({
    text: "task completed",
    provider: "agent-sdk" as const,
    toolUseCount: 3,
    usage: { inputTokens: 1000, outputTokens: 500 },
  }),
);

mock.module("../agents/runner", () => ({
  runAgentIsolated: mockRunAgentIsolated,
}));

import { createSpawnAgentTool } from "./spawn-agent";

function makeAgent(overrides: Partial<ResolvedAgent> = {}): ResolvedAgent {
  return {
    id: "test-agent",
    name: "Test Agent",
    description: "A test agent",
    default: false,
    provider: "agent-sdk",
    model: "claude-sonnet-4-20250514",
    systemPrompt: "You are a test agent.",
    toolFilter: { mode: "all", tools: [] },
    subagents: { allowAgents: ["worker"], maxChildren: 5 },
    mcpServers: {},
    skills: [],
    ...overrides,
  };
}

function makeConfig(
  overrides: Partial<SpawnAgentToolConfig> = {},
): SpawnAgentToolConfig {
  const parentAgent = makeAgent({
    id: "parent",
    subagents: { allowAgents: ["worker"], maxChildren: 5 },
  });
  const workerAgent = makeAgent({ id: "worker", name: "Worker Agent" });

  const agentMap = new Map<string, ResolvedAgent>();
  agentMap.set("parent", parentAgent);
  agentMap.set("worker", workerAgent);

  const mockAgentRegistry: AgentRegistry = {
    agents: [parentAgent, workerAgent],
    getDefault: () => parentAgent,
    getById: (id: string) => agentMap.get(id),
    listIds: () => ["parent", "worker"],
    listForAgent: () => [workerAgent],
    reload: () => {},
  };

  const mockTracker: SubAgentTracker = {
    register: mock(() => Promise.resolve()),
    complete: mock(() => Promise.resolve()),
    fail: mock(() => Promise.resolve()),
    getActiveForSession: () => [],
    countActiveForSession: () => 0,
    getCompletedForSession: mock(() => Promise.resolve([])),
  };

  const mockToolRegistry = {
    definitions: [],
    getAnthropicTools: () => [],
    getOpenAITools: () => [],
    execute: mock(() =>
      Promise.resolve({ output: "ok", isError: false }),
    ),
    findByName: () => undefined,
    filter: () => mockToolRegistry as unknown as ToolRegistry,
  } as unknown as ToolRegistry;

  return {
    agentRegistry: mockAgentRegistry,
    baseToolRegistry: mockToolRegistry,
    tracker: mockTracker,
    currentAgentId: "parent",
    sessionId: "test-session",
    maxIterations: 50,
    ...overrides,
  };
}

describe("spawn-agent tool", () => {
  beforeEach(() => {
    mockRunAgentIsolated.mockClear();
  });

  describe("tool definition", () => {
    it("should have correct name", () => {
      const tool = createSpawnAgentTool(makeConfig());
      expect(tool.name).toBe("spawn_agent");
    });

    it("should have system category", () => {
      const tool = createSpawnAgentTool(makeConfig());
      expect(tool.categories).toContain("system");
    });

    it("should require task parameter", () => {
      const tool = createSpawnAgentTool(makeConfig());
      expect(tool.inputSchema.required).toEqual(["task"]);
    });

    it("should have agent_id, task, and timeout_seconds properties", () => {
      const tool = createSpawnAgentTool(makeConfig());
      const props = tool.inputSchema.properties as Record<string, unknown>;
      expect(props.agent_id).toBeDefined();
      expect(props.task).toBeDefined();
      expect(props.timeout_seconds).toBeDefined();
    });

    it("should have a description mentioning sub-agent", () => {
      const tool = createSpawnAgentTool(makeConfig());
      expect(tool.description).toContain("sub-agent");
    });
  });

  describe("task validation", () => {
    it("should reject empty task", async () => {
      const tool = createSpawnAgentTool(makeConfig());
      const result = await tool.execute({ task: "" });
      expect(result.isError).toBe(true);
      expect(result.output).toContain("task is required");
    });

    it("should reject task exceeding 50000 characters", async () => {
      const tool = createSpawnAgentTool(makeConfig());
      const longTask = "x".repeat(50_001);
      const result = await tool.execute({ task: longTask });
      expect(result.isError).toBe(true);
      expect(result.output).toContain("task too long");
    });

    it("should accept task at exactly 50000 characters", async () => {
      mockRunAgentIsolated.mockResolvedValueOnce({
        text: "done",
        provider: "agent-sdk" as const,
        toolUseCount: 1,
        usage: { inputTokens: 100, outputTokens: 50 },
      });

      const tool = createSpawnAgentTool(makeConfig());
      const result = await tool.execute({ task: "x".repeat(50_000) });
      // Should not be rejected by length validation
      expect(result.output).not.toContain("task too long");
    });
  });

  describe("current agent resolution", () => {
    it("should error if current agent not found in registry", async () => {
      const config = makeConfig({ currentAgentId: "nonexistent" });
      const tool = createSpawnAgentTool(config);
      const result = await tool.execute({ task: "do something" });
      expect(result.isError).toBe(true);
      expect(result.output).toContain("current agent not found");
    });
  });

  describe("sub-agent allowlist", () => {
    it("should error if no sub-agents are allowed", async () => {
      const parentAgent = makeAgent({
        id: "parent",
        subagents: { allowAgents: [], maxChildren: 5 },
      });

      const agentMap = new Map<string, ResolvedAgent>();
      agentMap.set("parent", parentAgent);

      const config = makeConfig({
        agentRegistry: {
          agents: [parentAgent],
          getDefault: () => parentAgent,
          getById: (id: string) => agentMap.get(id),
          listIds: () => ["parent"],
          listForAgent: () => [],
          reload: () => {},
        },
      });

      const tool = createSpawnAgentTool(config);
      const result = await tool.execute({ task: "do something" });
      expect(result.isError).toBe(true);
      expect(result.output).toContain("no sub-agents allowed");
    });

    it("should error if requested agent is not in allowed list", async () => {
      const tool = createSpawnAgentTool(makeConfig());
      const result = await tool.execute({
        task: "do something",
        agent_id: "forbidden-agent",
      });
      expect(result.isError).toBe(true);
      expect(result.output).toContain("not in the allowed list");
    });

    it("should allow wildcard (*) to permit any agent", async () => {
      const parentAgent = makeAgent({
        id: "parent",
        subagents: { allowAgents: ["*"], maxChildren: 5 },
      });
      const anyAgent = makeAgent({ id: "any-agent" });

      const agentMap = new Map<string, ResolvedAgent>();
      agentMap.set("parent", parentAgent);
      agentMap.set("any-agent", anyAgent);

      mockRunAgentIsolated.mockResolvedValueOnce({
        text: "done",
        provider: "agent-sdk" as const,
        toolUseCount: 1,
        usage: { inputTokens: 100, outputTokens: 50 },
      });

      const config = makeConfig({
        agentRegistry: {
          agents: [parentAgent, anyAgent],
          getDefault: () => parentAgent,
          getById: (id: string) => agentMap.get(id),
          listIds: () => ["parent", "any-agent"],
          listForAgent: () => [anyAgent],
          reload: () => {},
        },
      });

      const tool = createSpawnAgentTool(config);
      const result = await tool.execute({
        task: "do it",
        agent_id: "any-agent",
      });
      expect(result.isError).toBe(false);
    });
  });

  describe("target agent resolution", () => {
    it("should error if target agent not found in registry", async () => {
      const parentAgent = makeAgent({
        id: "parent",
        subagents: {
          allowAgents: ["ghost-agent"],
          maxChildren: 5,
        },
      });

      const agentMap = new Map<string, ResolvedAgent>();
      agentMap.set("parent", parentAgent);

      const config = makeConfig({
        agentRegistry: {
          agents: [parentAgent],
          getDefault: () => parentAgent,
          getById: (id: string) => agentMap.get(id),
          listIds: () => ["parent"],
          listForAgent: () => [],
          reload: () => {},
        },
      });

      const tool = createSpawnAgentTool(config);
      const result = await tool.execute({
        task: "do something",
        agent_id: "ghost-agent",
      });
      expect(result.isError).toBe(true);
      expect(result.output).toContain('agent "ghost-agent" not found');
    });

    it("should default to first non-wildcard allowed agent when no agent_id", async () => {
      mockRunAgentIsolated.mockResolvedValueOnce({
        text: "default agent result",
        provider: "agent-sdk" as const,
        toolUseCount: 2,
        usage: { inputTokens: 200, outputTokens: 100 },
      });

      const tool = createSpawnAgentTool(makeConfig());
      const result = await tool.execute({ task: "do something" });
      expect(result.isError).toBe(false);
      // The default should be "worker" (the first non-* agent in allowAgents)
      expect(mockRunAgentIsolated).toHaveBeenCalled();
    });

    it("should use intelligent routing when only wildcard in allowAgents and no agent_id provided", async () => {
      const parentAgent = makeAgent({
        id: "parent",
        subagents: { allowAgents: ["*"], maxChildren: 5 },
      });
      const workerAgent = makeAgent({ id: "worker" });

      const agentMap = new Map<string, ResolvedAgent>();
      agentMap.set("parent", parentAgent);
      agentMap.set("worker", workerAgent);

      // Default mock will be used - just checking that routing doesn't error
      const config = makeConfig({
        agentRegistry: {
          agents: [parentAgent, workerAgent],
          getDefault: () => parentAgent,
          getById: (id: string) => agentMap.get(id),
          listIds: () => ["parent", "worker"],
          listForAgent: () => [],
          reload: () => {},
        },
      });

      const tool = createSpawnAgentTool(config);
      const result = await tool.execute({ task: "do something" });
      // With intelligent routing, it should select an agent automatically
      // (routing may fail due to no DB, but should fallback and succeed)
      expect(result.isError).toBe(false);
      expect(result.output).toContain("task completed");
    });
  });

  describe("max children limit", () => {
    it("should error when max children reached", async () => {
      const config = makeConfig();
      // Override tracker to report max active
      (config.tracker as any).countActiveForSession = () => 5;

      const tool = createSpawnAgentTool(config);
      const result = await tool.execute({
        task: "do something",
        agent_id: "worker",
      });
      expect(result.isError).toBe(true);
      expect(result.output).toContain("max children limit reached");
    });
  });

  describe("successful execution", () => {
    it("should return agent result with metadata", async () => {
      mockRunAgentIsolated.mockResolvedValueOnce({
        text: "task completed successfully",
        provider: "agent-sdk" as const,
        toolUseCount: 5,
        usage: { inputTokens: 2000, outputTokens: 800 },
      });

      const tool = createSpawnAgentTool(makeConfig());
      const result = await tool.execute({
        task: "analyze data",
        agent_id: "worker",
      });

      expect(result.isError).toBe(false);
      expect(result.output).toContain("task completed successfully");
      expect(result.output).toContain("5 tool calls");
      expect(result.output).toContain("2000 input");
      expect(result.output).toContain("800 output");
    });

    it("should call tracker.register and tracker.complete", async () => {
      mockRunAgentIsolated.mockResolvedValueOnce({
        text: "done",
        provider: "agent-sdk" as const,
        toolUseCount: 1,
        usage: { inputTokens: 100, outputTokens: 50 },
      });

      const config = makeConfig();
      const tool = createSpawnAgentTool(config);
      await tool.execute({ task: "do work", agent_id: "worker" });

      expect(config.tracker.register).toHaveBeenCalled();
      expect(config.tracker.complete).toHaveBeenCalled();
    });
  });

  describe("execution failure", () => {
    it("should handle agent runtime errors", async () => {
      // Reject all attempts (initial + retry + escalation)
      mockRunAgentIsolated.mockRejectedValue(
        new Error("API rate limited"),
      );

      const config = makeConfig();
      const tool = createSpawnAgentTool(config);
      const result = await tool.execute({
        task: "do work",
        agent_id: "worker",
      });

      expect(result.isError).toBe(true);
      expect(result.output).toContain("Sub-agent error");
      expect(result.output).toContain("API rate limited");

      // Reset mock to default
      mockRunAgentIsolated.mockReset();
      mockRunAgentIsolated.mockResolvedValue({
        text: "ok",
        provider: "agent-sdk" as const,
        toolUseCount: 0,
        usage: { inputTokens: 100, outputTokens: 50 },
      });
    });

    it("should call tracker.fail on error", async () => {
      // Reject all attempts (initial + retry + escalation)
      mockRunAgentIsolated.mockRejectedValue(new Error("boom"));

      const config = makeConfig();
      const tool = createSpawnAgentTool(config);
      await tool.execute({ task: "do work", agent_id: "worker" });

      expect(config.tracker.fail).toHaveBeenCalled();

      // Reset mock to default
      mockRunAgentIsolated.mockReset();
      mockRunAgentIsolated.mockResolvedValue({
        text: "ok",
        provider: "agent-sdk" as const,
        toolUseCount: 0,
        usage: { inputTokens: 100, outputTokens: 50 },
      });
    });

    it("should fire onProgress events on error", async () => {
      mockRunAgentIsolated.mockRejectedValue(new Error("fail"));

      const onProgress = mock(() => {});
      const config = makeConfig({ onProgress });
      const tool = createSpawnAgentTool(config);
      await tool.execute({ task: "do work", agent_id: "worker" });

      // Should have both start and done events
      const calls = onProgress.mock.calls;
      expect(calls.some((c: any) => c[0]?.type === "subagent_start")).toBe(
        true,
      );
      expect(calls.some((c: any) => c[0]?.type === "subagent_done")).toBe(
        true,
      );

      // Reset mock to default
      mockRunAgentIsolated.mockReset();
      mockRunAgentIsolated.mockResolvedValue({
        text: "ok",
        provider: "agent-sdk" as const,
        toolUseCount: 0,
        usage: { inputTokens: 100, outputTokens: 50 },
      });
    });
  });

  describe("progress events", () => {
    it("should fire subagent_start and subagent_done on success", async () => {
      mockRunAgentIsolated.mockResolvedValueOnce({
        text: "ok",
        provider: "agent-sdk" as const,
        toolUseCount: 0,
        usage: { inputTokens: 10, outputTokens: 5 },
      });

      const onProgress = mock(() => {});
      const config = makeConfig({ onProgress });
      const tool = createSpawnAgentTool(config);
      await tool.execute({ task: "do work", agent_id: "worker" });

      const calls = onProgress.mock.calls;
      expect(calls.length).toBeGreaterThanOrEqual(2);
      expect((calls[0] as any)[0]?.type).toBe("subagent_start");
      expect((calls[1] as any)[0]?.type).toBe("subagent_done");
    });
  });
});
