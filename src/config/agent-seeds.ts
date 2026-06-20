/**
 * Default agent definitions seeded into the DB on first startup.
 *
 * Rules:
 * - No systemPrompt (loaded from prompts/agents/{id}.md at runtime)
 * - No telegramBotToken or other secrets
 * - DB is source of truth once a record exists — seeder never overwrites
 */
import type { AgentDefinition } from "../agents/types";
import { DEFAULT_AGENT_TOOL_ALLOWLIST } from "../tools/privilege";

// ---------------------------------------------------------------------------
// Agent seed definitions
// ---------------------------------------------------------------------------

/**
 * Explicit tool allowlist for the trusted orchestrator ('opencrow') agent.
 *
 * Previously this agent ran with toolFilter `{ mode: "all" }`, which implicitly
 * granted every high-impact tool (bash, write/edit, db_query, process_manage,
 * spawn_agent, cron). That implicit grant is the
 * escalation surface behind the prompt-injection findings — so high-impact tools
 * are now listed EXPLICITLY here rather than granted by mode:"all". The default
 * fail-closed allowlist (read/research/memory + read-only scrapers) is the base;
 * the orchestrator's operator-level high-impact tools are added on top.
 */
const OPENCROW_TOOL_ALLOWLIST: readonly string[] = [
  ...DEFAULT_AGENT_TOOL_ALLOWLIST,
  // High-impact tools — explicit grants for the trusted orchestrator only.
  "bash",
  "write_file",
  "edit_file",
  "db_query",
  "cron",
  "trigger_cron",
  "process_manage",
  "spawn_agent",
  // SIGE session control (start is a write operation)
  "sige_start_session",
];

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
    toolFilter: { mode: "allowlist", tools: [...OPENCROW_TOOL_ALLOWLIST] },
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
