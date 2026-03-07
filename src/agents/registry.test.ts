import { test, expect, describe } from "bun:test";
import { createAgentRegistry } from "./registry";
import type { AgentDefinition } from "./types";
import type { AgentConfig } from "../config/schema";

const globalDefaults: AgentConfig = {
  model: "claude-sonnet-4-6",
  systemPrompt: "You are OpenCrow.",
  retry: { attempts: 3, minDelayMs: 500, maxDelayMs: 30000, jitter: 0.15 },
  compaction: {
    maxContextTokens: 180_000,
    targetHistoryTokens: 80_000,
    summaryMaxTokens: 2048,
    stripToolResultsAfterTurns: 3,
  },
};

describe("createAgentRegistry", () => {
  test("synthesizes default agent when no agents configured", () => {
    const registry = createAgentRegistry([], globalDefaults);
    expect(registry.agents.length).toBe(1);
    expect(registry.getDefault().id).toBe("default");
    expect(registry.getDefault().name).toBe("OpenCrow");
    expect(registry.getDefault().model).toBe("claude-sonnet-4-6");
    expect(registry.getDefault().default).toBe(true);
  });

  test("resolves agents with global defaults", () => {
    const agents: AgentDefinition[] = [
      { id: "researcher", name: "Researcher", default: true },
      { id: "coder", name: "Coder", model: "claude-opus-4-6" },
    ];
    const registry = createAgentRegistry(agents, globalDefaults);

    expect(registry.agents.length).toBe(2);

    const researcher = registry.getById("researcher")!;
    expect(researcher.model).toBe("claude-sonnet-4-6");
    expect(researcher.systemPrompt).toBe("You are OpenCrow.");
    expect(researcher.default).toBe(true);

    const coder = registry.getById("coder")!;
    expect(coder.model).toBe("claude-opus-4-6");
    expect(coder.default).toBe(false);
  });

  test("getDefault returns the agent marked as default", () => {
    const agents: AgentDefinition[] = [
      { id: "a", name: "A" },
      { id: "b", name: "B", default: true },
    ];
    const registry = createAgentRegistry(agents, globalDefaults);
    expect(registry.getDefault().id).toBe("b");
  });

  test("getDefault returns first agent if none marked", () => {
    const agents: AgentDefinition[] = [
      { id: "x", name: "X" },
      { id: "y", name: "Y" },
    ];
    const registry = createAgentRegistry(agents, globalDefaults);
    expect(registry.getDefault().id).toBe("x");
  });

  test("listIds returns all agent IDs", () => {
    const agents: AgentDefinition[] = [
      { id: "alpha", name: "Alpha" },
      { id: "beta", name: "Beta" },
    ];
    const registry = createAgentRegistry(agents, globalDefaults);
    expect(registry.listIds()).toEqual(["alpha", "beta"]);
  });

  test("listForAgent returns allowed sub-agents", () => {
    const agents: AgentDefinition[] = [
      {
        id: "orchestrator",
        name: "Orchestrator",
        subagents: {
          allowAgents: ["worker"],
          maxChildren: 5,
        },
      },
      { id: "worker", name: "Worker" },
      { id: "other", name: "Other" },
    ];
    const registry = createAgentRegistry(agents, globalDefaults);

    const forOrchestrator = registry.listForAgent("orchestrator");
    expect(forOrchestrator.length).toBe(1);
    expect(forOrchestrator[0]!.id).toBe("worker");

    const forWorker = registry.listForAgent("worker");
    expect(forWorker.length).toBe(0);
  });

  test("getById returns undefined for unknown id", () => {
    const registry = createAgentRegistry([], globalDefaults);
    expect(registry.getById("nonexistent")).toBeUndefined();
  });

  test("merges tool filter from definition", () => {
    const agents: AgentDefinition[] = [
      {
        id: "limited",
        name: "Limited",
        toolFilter: { mode: "allowlist", tools: ["bash"] },
      },
    ];
    const registry = createAgentRegistry(agents, globalDefaults);
    const agent = registry.getById("limited")!;
    expect(agent.toolFilter.mode).toBe("allowlist");
    expect(agent.toolFilter.tools).toEqual(["bash"]);
  });

  test("uses default tool filter when not specified", () => {
    const agents: AgentDefinition[] = [{ id: "full", name: "Full" }];
    const registry = createAgentRegistry(agents, globalDefaults);
    expect(registry.getById("full")!.toolFilter.mode).toBe("all");
  });
});
