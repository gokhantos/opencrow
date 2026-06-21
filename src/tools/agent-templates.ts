import { AGENT_SEEDS } from "../config/agent-seeds";
import { getModelRoute } from "../store/model-routing";
import { DEFAULT_AGENT_TOOL_ALLOWLIST } from "./privilege";

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

/**
 * Build the agent tool templates. The default provider+model for templates is
 * resolved from the `agent-templates` model route (DB-backed, hot reloaded) so
 * no provider/model is hardcoded here. A per-seed `seed.model` still overrides
 * the routed model (`seed.model ?? route.model`); the provider always comes
 * from the route. Async because the route is read at call time — the single
 * consumer (`GET /agents/templates`) is already an async handler.
 */
export async function getAgentTemplates(): Promise<readonly AgentTemplate[]> {
  const route = await getModelRoute("agent-templates");

  const genericTemplates: readonly AgentTemplate[] = [
    {
      templateId: "chatbot",
      name: "Chatbot",
      description: "Simple conversational bot — no tools, just chat",
      config: {
        provider: route.provider,
        model: route.model,
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
        provider: route.provider,
        model: route.model,
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

  const seedTemplates: readonly AgentTemplate[] = AGENT_SEEDS.map((seed) => ({
    templateId: seed.id,
    name: seed.name,
    description: seed.description ?? "",
    config: {
      provider: route.provider,
      model: seed.model ?? route.model,
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

  return [...genericTemplates, ...seedTemplates];
}
