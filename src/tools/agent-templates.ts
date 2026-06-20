import { AGENT_SEEDS } from "../config/agent-seeds";
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
