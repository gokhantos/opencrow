/* ───── Types ───── */
export interface ToolFilter {
  mode: "all" | "allowlist" | "blocklist";
  tools: string[];
}

export interface SubagentConfig {
  allowAgents: string[];
  maxChildren: number;
}

export type AiProvider = "openrouter" | "agent-sdk" | "alibaba";

export interface SkillInfo {
  id: string;
  name: string;
  description: string;
}

export interface ToolInfo {
  name: string;
  category: string;
  description?: string;
}

export interface McpServersConfig {
  browser?: boolean;
  github?: boolean;
  context7?: boolean;
  sequentialThinking?: boolean;
  dbhub?: boolean;
  filesystem?: boolean;
  git?: boolean;
  qdrant?: boolean;
  braveSearch?: boolean;
  firecrawl?: boolean;
  serena?: boolean;
}

export interface HooksConfig {
  auditLog?: boolean;
  notifications?: boolean;
}

export interface ModelParams {
  thinkingMode?: "adaptive" | "enabled" | "disabled";
  thinkingBudget?: number;
  effort?: "low" | "medium" | "high" | "max";
  extendedContext?: boolean;
  maxBudgetUsd?: number;
}

export interface AgentInfo {
  id: string;
  name: string;
  description: string;
  provider: AiProvider;
  model: string;
  maxIterations?: number;
  reasoning?: boolean;
  stateless?: boolean;
  maxInputLength?: number;
  modelParams?: ModelParams;
  isDefault: boolean;
  toolFilter: ToolFilter;
  subagents: SubagentConfig;
  mcpServers?: McpServersConfig;
  hooks?: HooksConfig;
  telegramBotToken?: string;
  skills?: string[];
  source?: "file" | "file+db" | "db" | "ecc";
}

export interface AgentDetail extends AgentInfo {
  systemPrompt: string;
}

export interface AgentsResponse {
  success: boolean;
  data: AgentInfo[];
  configHash?: string;
}

export interface AgentDetailResponse {
  success: boolean;
  data: AgentDetail;
  configHash?: string;
}

export interface MutationResponse {
  success: boolean;
  message?: string;
  configHash?: string;
  error?: string;
}

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

export type ProviderFilter = "all" | AiProvider;

/* ───── Helpers ───── */
export function providerLabel(provider: AiProvider): string {
  if (provider === "agent-sdk") return "Agent SDK";
  if (provider === "alibaba") return "Alibaba";
  return "OpenRouter";
}

export function getInitials(name: string): string {
  return name
    .split(" ")
    .map((w) => w[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
}

export function shortModel(model: string): string {
  if (!model) return "Default";
  // Truncate long model names intelligently
  const parts = model.split("/");
  const last = parts[parts.length - 1] ?? model;
  return last.length > 28 ? last.slice(0, 25) + "..." : last;
}
