/**
 * Default agent definitions seeded into the DB on first startup.
 *
 * Rules:
 * - No systemPrompt (loaded from prompts/agents/{id}.md at runtime)
 * - No telegramBotToken or other secrets
 * - DB is source of truth once a record exists — seeder never overwrites
 */
import type { AgentDefinition } from "../agents/types";

// ---------------------------------------------------------------------------
// Agent seed definitions
// ---------------------------------------------------------------------------

export const AGENT_SEEDS: readonly AgentDefinition[] = [
  // -------------------------------------------------------------------------
  // OpenCrow (main orchestrator)
  // -------------------------------------------------------------------------
  {
    id: "opencrow",
    category: "orchestrator",
    name: "OpenCrow",
    description: "",
    default: true,
    model: "claude-sonnet-4-6",
    maxIterations: 150,
    stateless: false,
    reasoning: true,
    toolFilter: { mode: "all", tools: [] },
    modelParams: { effort: "max", thinkingMode: "adaptive", thinkingBudget: 128000, extendedContext: false },
    subagents: { allowAgents: ["*"], maxChildren: 10 },
    mcpServers: {
      git: true,
      dbhub: true,
      github: true,
      qdrant: true,
      serena: true,
      browser: true,
      context7: true,
      firecrawl: true,
      filesystem: true,
      braveSearch: true,
      sequentialThinking: true,
    },
    hooks: { auditLog: true, notifications: true },
    skills: [],
  },
] as const;
