import { z } from "zod";
import type { ToolDefinition, ToolCategory } from "./types";
import type { AgentRegistry } from "../agents/registry";
import type { CallerContext } from "../config/agent-mutations";
import type { ToolFilter } from "../agents/types";
import {
  getMergedAgentsWithSource,
  computeMergedAgentHash,
} from "../config/loader";
import {
  addAgentToDb,
  updateAgentInDb,
  removeAgentFromDb,
  AgentConflictError,
  PrivilegeError,
} from "../config/agent-mutations";
import { buildToolCatalog } from "./catalog";
import { createLogger } from "../logger";

const log = createLogger("tool:manage-agent");

const AGENT_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Strict tool-filter schema validated against the live tool catalog. Unknown or
 * garbage tool names are rejected so an injected manage_agent call cannot smuggle
 * in fabricated tool identifiers (or typo'd high-impact names) past the filter.
 */
function buildToolFilterSchema(): z.ZodType<ToolFilter> {
  const catalogNames = buildToolCatalog().map((e) => e.name);
  // Include builder-time tools not present in the static catalog so legitimate
  // grants (sub-agent, cron, search) are not falsely rejected.
  const extraNames = [
    "cron",
    "trigger_cron",
    "list_agents",
    "spawn_agent",
    "search_memory",
    "manage_agent",
    "git_operations",
    "web_fetch",
    "agent_templates",
    "sige_start_session",
    "sige_get_report",
    "sige_get_session",
    "sige_list_sessions",
    "sige_query_game_history",
    "sige_search_strategic_ideas",
    "sige_get_population_dynamics",
  ];
  const allNames = Array.from(new Set([...catalogNames, ...extraNames]));
  const toolName = z.enum(allNames as [string, ...string[]]);
  return z.object({
    mode: z.enum(["all", "allowlist", "blocklist"]),
    tools: z.array(toolName),
  });
}

/**
 * Resolve the caller context for a manage_agent invocation.
 *
 * The tool only ever runs inside an agent process (OPENCROW_AGENT_ID is set), so
 * the caller is the owning agent and mutations must be privilege-monotonic. If
 * the env var is absent we still treat the caller as an (unknown) agent and fail
 * closed with an empty tool filter rather than granting operator power.
 */
function resolveCaller(registry: AgentRegistry): CallerContext {
  const agentId = process.env.OPENCROW_AGENT_ID;
  if (!agentId) {
    return {
      kind: "agent",
      agentId: "unknown",
      toolFilter: { mode: "allowlist", tools: [] },
    };
  }
  const self = registry.getById(agentId);
  const toolFilter: ToolFilter = self?.toolFilter ?? {
    mode: "allowlist",
    tools: [],
  };
  return { kind: "agent", agentId, toolFilter };
}

const SNAKE_TO_CAMEL: Record<string, string> = {
  system_prompt: "systemPrompt",
  max_iterations: "maxIterations",
  tool_filter: "toolFilter",
};

export interface ManageAgentToolConfig {
  readonly agentRegistry: AgentRegistry;
  readonly reloadRegistry: () => Promise<void>;
}

export function createManageAgentTool(
  config: ManageAgentToolConfig,
): ToolDefinition {
  return {
    name: "manage_agent",
    description:
      "Manage agents — list, get, create, update, delete. Use action 'list' to see all agents, 'get' for details, or 'create'/'update'/'delete' to modify.",
    categories: ["system"] as readonly ToolCategory[],
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "get", "create", "update", "delete"],
          description: "Action to perform.",
        },
        agent_id: {
          type: "string",
          description:
            "Agent ID (required for get/create/update/delete). Must be lowercase alphanumeric with hyphens.",
        },
        name: {
          type: "string",
          description: "Agent display name (required for create).",
        },
        description: {
          type: "string",
          description: "Agent description.",
        },
        system_prompt: {
          type: "string",
          description: "System prompt for the agent.",
        },
        model: {
          type: "string",
          description: "Model to use (e.g. claude-sonnet-4-6).",
        },
        provider: {
          type: "string",
          enum: ["agent-sdk", "openrouter", "alibaba"],
          description: "AI provider.",
        },
        max_iterations: {
          type: "number",
          description: "Max tool-use iterations per turn.",
        },
        tool_filter: {
          type: "object",
          description:
            'Tool filter: { mode: "all"|"allowlist"|"blocklist", tools: string[] }.',
        },
        subagents: {
          type: "object",
          description:
            "Sub-agent config: { allowAgents: string[], maxChildren: number }.",
        },
        reasoning: {
          type: "boolean",
          description: "Enable extended reasoning.",
        },
        stateless: {
          type: "boolean",
          description: "Stateless mode (no conversation history).",
        },
        skills: {
          type: "array",
          items: { type: "string" },
          description: "List of skill IDs.",
        },
        confirm_delete: {
          type: "boolean",
          description: "Must be true to actually delete an agent.",
        },
      },
      required: ["action"],
    },
    async execute(
      input: Record<string, unknown>,
    ): Promise<{ output: string; isError: boolean }> {
      const action = String(input.action);
      const caller = resolveCaller(config.agentRegistry);

      try {
        switch (action) {
          case "list":
            return await handleList();
          case "get":
            return await handleGet(input);
          case "create":
            return await handleCreate(input, config, caller);
          case "update":
            return await handleUpdate(input, config, caller);
          case "delete":
            return await handleDelete(input, config, caller);
          default:
            return { output: `Unknown action: ${action}`, isError: true };
        }
      } catch (error) {
        if (error instanceof AgentConflictError) {
          return {
            output:
              "Agent list has changed since last read. Please retry the operation.",
            isError: true,
          };
        }
        if (error instanceof PrivilegeError) {
          log.warn("manage_agent privilege denied", {
            action,
            error: error.message,
          });
          return { output: `Permission denied: ${error.message}`, isError: true };
        }
        const msg = error instanceof Error ? error.message : String(error);
        log.error("manage_agent failed", { action, error: msg });
        return { output: `Error: ${msg}`, isError: true };
      }
    },
  };
}

// --- Action Handlers ---

async function handleList(): Promise<{ output: string; isError: boolean }> {
  const agents = await getMergedAgentsWithSource();
  const hash = computeMergedAgentHash(agents);

  const summary = agents.map((a) => ({
    id: a.id,
    name: a.name,
    description: a.description,
    model: a.model,
    provider: a.provider,
    default: a.default,
    _source: a._source,
  }));

  return {
    output: JSON.stringify({ agents: summary, configHash: hash }, null, 2),
    isError: false,
  };
}

async function handleGet(
  input: Record<string, unknown>,
): Promise<{ output: string; isError: boolean }> {
  const agentId = input.agent_id as string | undefined;
  if (!agentId) {
    return { output: "Error: agent_id is required for 'get'", isError: true };
  }

  const agents = await getMergedAgentsWithSource();
  const agent = agents.find((a) => a.id === agentId);
  if (!agent) {
    return { output: `Error: agent "${agentId}" not found`, isError: true };
  }

  const redacted = redactSensitiveFields(
    agent as unknown as Record<string, unknown>,
  );
  return { output: JSON.stringify(redacted, null, 2), isError: false };
}

async function handleCreate(
  input: Record<string, unknown>,
  config: ManageAgentToolConfig,
  caller: CallerContext,
): Promise<{ output: string; isError: boolean }> {
  const agentId = input.agent_id as string | undefined;
  const name = input.name as string | undefined;

  if (!agentId) {
    return {
      output: "Error: agent_id is required for 'create'",
      isError: true,
    };
  }
  if (!name) {
    return { output: "Error: name is required for 'create'", isError: true };
  }
  if (!AGENT_ID_PATTERN.test(agentId)) {
    return {
      output:
        "Error: agent_id must be lowercase alphanumeric with hyphens, starting with a letter or digit.",
      isError: true,
    };
  }

  const fields = buildAgentFields(input);
  const filterError = validateToolFilterField(fields);
  if (filterError) return { output: filterError, isError: true };

  const agents = await getMergedAgentsWithSource();
  const hash = computeMergedAgentHash(agents);

  const def = {
    id: agentId,
    name,
    ...fields,
  };

  await addAgentToDb(def, hash, caller);
  await config.reloadRegistry();

  log.info("Agent created", { agentId, caller: caller.kind });
  return {
    output: `Agent "${agentId}" created successfully.`,
    isError: false,
  };
}

async function handleUpdate(
  input: Record<string, unknown>,
  config: ManageAgentToolConfig,
  caller: CallerContext,
): Promise<{ output: string; isError: boolean }> {
  const agentId = input.agent_id as string | undefined;
  if (!agentId) {
    return {
      output: "Error: agent_id is required for 'update'",
      isError: true,
    };
  }

  const fields = buildAgentFields(input);
  const filterError = validateToolFilterField(fields);
  if (filterError) return { output: filterError, isError: true };

  const agents = await getMergedAgentsWithSource();
  const hash = computeMergedAgentHash(agents);

  const partial = {
    ...(input.name !== undefined ? { name: input.name as string } : {}),
    ...fields,
  };

  await updateAgentInDb(agentId, partial, hash, caller);
  await config.reloadRegistry();

  log.info("Agent updated", { agentId, caller: caller.kind });
  return {
    output: `Agent "${agentId}" updated successfully.`,
    isError: false,
  };
}

async function handleDelete(
  input: Record<string, unknown>,
  config: ManageAgentToolConfig,
  caller: CallerContext,
): Promise<{ output: string; isError: boolean }> {
  const agentId = input.agent_id as string | undefined;
  if (!agentId) {
    return {
      output: "Error: agent_id is required for 'delete'",
      isError: true,
    };
  }

  const confirmDelete = input.confirm_delete === true;
  if (!confirmDelete) {
    return {
      output: `To delete "${agentId}", call again with confirm_delete: true`,
      isError: false,
    };
  }

  const agents = await getMergedAgentsWithSource();
  const hash = computeMergedAgentHash(agents);

  await removeAgentFromDb(agentId, hash, caller);
  await config.reloadRegistry();

  log.info("Agent deleted", { agentId, caller: caller.kind });
  return {
    output: `Agent "${agentId}" deleted successfully.`,
    isError: false,
  };
}

// --- Helpers ---

/** Extract optional agent fields from input, mapping snake_case to camelCase. */
function buildAgentFields(
  input: Record<string, unknown>,
): Record<string, unknown> {
  const fields: Record<string, unknown> = {};

  const directKeys = [
    "description",
    "model",
    "provider",
    "subagents",
    "reasoning",
    "stateless",
    "skills",
  ] as const;

  for (const key of directKeys) {
    if (input[key] !== undefined) {
      fields[key] = input[key];
    }
  }

  for (const [snake, camel] of Object.entries(SNAKE_TO_CAMEL)) {
    if (input[snake] !== undefined) {
      fields[camel] = input[snake];
    }
  }

  return fields;
}

let cachedToolFilterSchema: z.ZodType<ToolFilter> | null = null;

/**
 * Validate a built fields object's `toolFilter` against the live tool catalog.
 * Returns an error string if invalid, or null if valid / absent. This rejects
 * unknown / garbage / typo'd tool names before they reach the mutation layer.
 */
function validateToolFilterField(
  fields: Record<string, unknown>,
): string | null {
  if (fields.toolFilter === undefined) return null;
  if (!cachedToolFilterSchema) {
    cachedToolFilterSchema = buildToolFilterSchema();
  }
  const result = cachedToolFilterSchema.safeParse(fields.toolFilter);
  if (!result.success) {
    const issue = result.error.issues[0];
    return `Error: invalid tool_filter — ${issue?.message ?? "unknown tool name(s)"}. Tools must be valid catalog names.`;
  }
  // Normalize to the validated value.
  fields.toolFilter = result.data;
  return null;
}

/** Redact sensitive fields (e.g. telegramBotToken) from agent data. */
function redactSensitiveFields(
  agent: Record<string, unknown>,
): Record<string, unknown> {
  const { telegramBotToken, _source, ...rest } = agent;
  return {
    ...rest,
    ...(telegramBotToken ? { telegramBotToken: "configured" } : {}),
    _source,
  };
}
