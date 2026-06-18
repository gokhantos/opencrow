import type { ToolDefinition, ToolCategory } from "./types";
import { createLogger } from "../logger";
import { AGENT_SEEDS } from "../config/agent-seeds";
import { DEFAULT_AGENT_TOOL_ALLOWLIST } from "./privilege";

const log = createLogger("tool:agent-templates");

export interface AgentTemplate {
  readonly templateId: string;
  readonly name: string;
  readonly description: string;
  readonly config: {
    readonly provider: string;
    readonly model: string;
    readonly maxIterations: number;
    readonly stateless: boolean;
    readonly reasoning: boolean;
    readonly toolFilter: {
      readonly mode: string;
      readonly tools: readonly string[];
    };
    readonly modelParams: Record<string, unknown>;
  };
}

const GENERIC_TEMPLATES: readonly AgentTemplate[] = [
  {
    templateId: "chatbot",
    name: "Chatbot",
    description: "Simple conversational bot — no tools, just chat",
    config: {
      provider: "agent-sdk",
      model: "claude-haiku-4-5",
      maxIterations: 1,
      stateless: false,
      reasoning: false,
      toolFilter: { mode: "allowlist", tools: [] },
      modelParams: { thinkingMode: "disabled", effort: "low" },
    },
  },
  {
    templateId: "custom",
    name: "Custom (blank)",
    description: "Minimal agent — customize everything yourself",
    config: {
      provider: "agent-sdk",
      model: "claude-haiku-4-5",
      maxIterations: 50,
      stateless: false,
      reasoning: false,
      // Fail-closed: a blank agent starts with the conservative default allowlist
      // (read/research/memory + read-only scrapers), NOT every tool.
      toolFilter: {
        mode: "allowlist",
        tools: [...DEFAULT_AGENT_TOOL_ALLOWLIST],
      },
      modelParams: { thinkingMode: "disabled", effort: "medium" },
    },
  },
];

const SEED_TEMPLATES: readonly AgentTemplate[] = AGENT_SEEDS.map((seed) => ({
  templateId: seed.id,
  name: seed.name,
  description: seed.description ?? "",
  config: {
    provider: "agent-sdk",
    model: seed.model ?? "claude-haiku-4-5",
    maxIterations: seed.maxIterations ?? 50,
    stateless: seed.stateless ?? false,
    reasoning: seed.reasoning ?? false,
    toolFilter: seed.toolFilter ?? {
      mode: "allowlist",
      tools: [...DEFAULT_AGENT_TOOL_ALLOWLIST],
    },
    modelParams: (seed.modelParams as Record<string, unknown>) ?? {},
  },
}));

export const TEMPLATES: readonly AgentTemplate[] = [
  ...GENERIC_TEMPLATES,
  ...SEED_TEMPLATES,
];

function handleList(): { readonly output: string; readonly isError: boolean } {
  const lines = TEMPLATES.map(
    (t) => `- **${t.templateId}** — ${t.name}: ${t.description}`,
  );
  return { output: lines.join("\n"), isError: false };
}

function handleGet(templateId: string | undefined): {
  readonly output: string;
  readonly isError: boolean;
} {
  if (!templateId) {
    return {
      output: "template_id is required for the 'get' action.",
      isError: true,
    };
  }

  const template = TEMPLATES.find((t) => t.templateId === templateId);
  if (!template) {
    return {
      output: `Unknown template "${templateId}". Use action "list" to see available templates.`,
      isError: true,
    };
  }

  const payload = {
    ...template,
    hint: "Use manage_agent with these settings to create the agent.",
  };

  return { output: JSON.stringify(payload, null, 2), isError: false };
}

export function createAgentTemplatesTool(): ToolDefinition {
  return {
    name: "agent_templates",
    description:
      "List pre-built agent templates or get template details. Use with manage_agent to quickly create agents from templates.",
    categories: ["system"] as readonly ToolCategory[],
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "get"],
          description: 'Action to perform: "list" all templates or "get" one.',
        },
        template_id: {
          type: "string",
          description:
            'Template ID (required for "get"). Use action "list" to see available IDs.',
        },
      },
      required: ["action"],
    },
    async execute(input: Record<string, unknown>) {
      const action = input.action as string | undefined;
      const templateId = input.template_id as string | undefined;

      log.info("agent_templates called", { action, templateId });

      if (action === "list") {
        return handleList();
      }

      if (action === "get") {
        return handleGet(templateId);
      }

      return {
        output: `Unknown action "${action ?? "(missing)"}". Use "list" or "get".`,
        isError: true,
      };
    },
  };
}
