import type {
  AgentDefinition,
  ResolvedAgent,
  ToolFilter,
  SubagentConfig,
  McpServersConfig,
} from "./types";
import type { AgentConfig } from "../config/schema";
import { createLogger } from "../logger";

const log = createLogger("agents:registry");

const DEFAULT_TOOL_FILTER: ToolFilter = { mode: "all", tools: [] };
const DEFAULT_SUBAGENT_CONFIG: SubagentConfig = {
  allowAgents: [],
  maxChildren: 5,
};
const DEFAULT_MCP_SERVERS: McpServersConfig = {};

export interface AgentRegistry {
  readonly agents: readonly ResolvedAgent[];
  getDefault(): ResolvedAgent;
  getById(id: string): ResolvedAgent | undefined;
  listIds(): readonly string[];
  listForAgent(requestingAgentId: string): readonly ResolvedAgent[];
  reload(
    agentConfigs: readonly AgentDefinition[],
    globalDefaults: AgentConfig,
  ): void;
}

export function createAgentRegistry(
  agentConfigs: readonly AgentDefinition[],
  globalDefaults: AgentConfig,
): AgentRegistry {
  let resolved: readonly ResolvedAgent[] = resolveAll(
    agentConfigs,
    globalDefaults,
  );
  let agentMap = new Map(resolved.map((a) => [a.id, a]));
  let defaultAgent: ResolvedAgent =
    resolved.find((a) => a.default) ?? resolved[0] ?? synthesizeDefaultAgent(globalDefaults);

  log.info("Agent registry initialized", {
    count: resolved.length,
    defaultId: defaultAgent.id,
    ids: resolved.map((a) => a.id),
  });

  return {
    get agents() {
      return resolved;
    },

    getDefault(): ResolvedAgent {
      return defaultAgent;
    },

    getById(id: string): ResolvedAgent | undefined {
      return agentMap.get(id);
    },

    listIds(): readonly string[] {
      return resolved.map((a) => a.id);
    },

    listForAgent(requestingAgentId: string): readonly ResolvedAgent[] {
      const requester = agentMap.get(requestingAgentId);
      if (!requester) return [];

      const allowed = requester.subagents.allowAgents;
      if (allowed.length === 0) return [];

      if (allowed.includes("*")) {
        return resolved.filter((a) => a.id !== requestingAgentId);
      }

      return resolved.filter((a) => allowed.includes(a.id));
    },

    reload(
      agentConfigs: readonly AgentDefinition[],
      globalDefaults: AgentConfig,
    ): void {
      const prev = resolved.map((a) => a.id).join(",");
      resolved = resolveAll(agentConfigs, globalDefaults);
      agentMap = new Map(resolved.map((a) => [a.id, a]));
      defaultAgent = resolved.find((a) => a.default) ?? resolved[0] ?? synthesizeDefaultAgent(globalDefaults);

      const curr = resolved.map((a) => a.id).join(",");
      if (curr !== prev) {
        log.info("Agent registry reloaded", {
          count: resolved.length,
          defaultId: defaultAgent.id,
          ids: resolved.map((a) => a.id),
        });
      } else {
        log.debug("Agent registry refreshed (no changes)");
      }
    },
  };
}

function resolveAll(
  agentConfigs: readonly AgentDefinition[],
  globalDefaults: AgentConfig,
): readonly ResolvedAgent[] {
  if (agentConfigs.length === 0) {
    return [synthesizeDefaultAgent(globalDefaults)];
  }

  const resolved = agentConfigs.map((def) => resolveAgent(def, globalDefaults));

  // Only include the default agent so it's visible in the UI
  const hasDefault = resolved.some((a) => a.default);
  if (!hasDefault) {
    // Mark the first agent as default without adding a new one
    const [first, ...rest] = resolved;
    return [{ ...first!, default: true }, ...rest];
  }

  return resolved;
}

function resolveAgent(
  def: AgentDefinition,
  defaults: AgentConfig,
): ResolvedAgent {
  return {
    id: def.id,
    name: def.name,
    description: def.description ?? "",
    default: def.default ?? false,
    provider: def.provider ?? "agent-sdk",
    model: def.model ?? defaults.model,
    systemPrompt: def.systemPrompt ?? defaults.systemPrompt,
    maxIterations: def.maxIterations,
    modelParams: def.modelParams,
    reasoning: def.reasoning,
    stateless: def.stateless,
    maxInputLength: def.maxInputLength,
    maxHistoryMessages: def.maxHistoryMessages,
    maxOutputTokens: def.maxOutputTokens,
    keepAssistantMessages: def.keepAssistantMessages,
    toolFilter: def.toolFilter ?? DEFAULT_TOOL_FILTER,
    subagents: def.subagents
      ? { ...DEFAULT_SUBAGENT_CONFIG, ...def.subagents }
      : DEFAULT_SUBAGENT_CONFIG,
    mcpServers: def.mcpServers ?? DEFAULT_MCP_SERVERS,
    hooks: def.hooks,
    telegramBotToken: def.telegramBotToken,
    skills: def.skills ?? [],
  };
}

function synthesizeDefaultAgent(defaults: AgentConfig): ResolvedAgent {
  return {
    id: "default",
    name: "OpenCrow",
    description: "",
    default: true,
    provider: "agent-sdk",
    model: defaults.model,
    systemPrompt: defaults.systemPrompt,
    toolFilter: DEFAULT_TOOL_FILTER,
    subagents: DEFAULT_SUBAGENT_CONFIG,
    mcpServers: DEFAULT_MCP_SERVERS,
    modelParams: {
      thinkingMode: "enabled",
      thinkingBudget: 128_000,
      effort: "max",
      extendedContext: false,
    },
    telegramBotToken: undefined,
    skills: [],
  };
}
