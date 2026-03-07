import type { ToolDefinition, ToolCategory } from "./types";
import type { AgentRegistry } from "../agents/registry";
import {
  getMergedAgentsWithSource,
  computeMergedAgentHash,
  type AgentWithSource,
} from "../config/loader";
import {
  addAgentToDb,
  updateAgentInDb,
  removeAgentFromDb,
  AgentConflictError,
} from "../config/agent-mutations";
import { createLogger } from "../logger";

const log = createLogger("tool:manage-agent");

const AGENT_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

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
          description: "Model to use (e.g. claude-sonnet-4-20250514).",
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

      try {
        switch (action) {
          case "list":
            return await handleList();
          case "get":
            return await handleGet(input);
          case "create":
            return await handleCreate(input, config);
          case "update":
            return await handleUpdate(input, config);
          case "delete":
            return await handleDelete(input, config);
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

  const agents = await getMergedAgentsWithSource();
  const hash = computeMergedAgentHash(agents);

  const def = {
    id: agentId,
    name,
    ...buildAgentFields(input),
  };

  await addAgentToDb(def, hash);
  await config.reloadRegistry();

  log.info("Agent created", { agentId });
  return {
    output: `Agent "${agentId}" created successfully.`,
    isError: false,
  };
}

async function handleUpdate(
  input: Record<string, unknown>,
  config: ManageAgentToolConfig,
): Promise<{ output: string; isError: boolean }> {
  const agentId = input.agent_id as string | undefined;
  if (!agentId) {
    return {
      output: "Error: agent_id is required for 'update'",
      isError: true,
    };
  }

  const agents = await getMergedAgentsWithSource();
  const hash = computeMergedAgentHash(agents);

  const partial = {
    ...(input.name !== undefined ? { name: input.name as string } : {}),
    ...buildAgentFields(input),
  };

  await updateAgentInDb(agentId, partial, hash);
  await config.reloadRegistry();

  log.info("Agent updated", { agentId });
  return {
    output: `Agent "${agentId}" updated successfully.`,
    isError: false,
  };
}

async function handleDelete(
  input: Record<string, unknown>,
  config: ManageAgentToolConfig,
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

  await removeAgentFromDb(agentId, hash);
  await config.reloadRegistry();

  log.info("Agent deleted", { agentId });
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
