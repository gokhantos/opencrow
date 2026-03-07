export interface ToolFilter {
  readonly mode: "all" | "allowlist" | "blocklist";
  readonly tools: readonly string[];
}

export interface SubagentConfig {
  readonly allowAgents: readonly string[];
  readonly maxChildren: number;
}

export interface McpServersConfig {
  readonly browser?: boolean;
  readonly github?: boolean;
  readonly context7?: boolean;
  readonly sequentialThinking?: boolean;
  readonly dbhub?: boolean;
  readonly filesystem?: boolean;
  readonly git?: boolean;
  readonly qdrant?: boolean;
  readonly braveSearch?: boolean;
  readonly firecrawl?: boolean;
  readonly webSearch?: boolean;
  readonly serena?: boolean;
}

export interface HooksConfig {
  readonly auditLog?: boolean;
  readonly notifications?: boolean;
}

import type { AiProvider } from "../agent/types";
import type { ModelParams } from "../config/schema";

export interface AgentDefinition {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly default?: boolean;
  readonly provider?: AiProvider;
  readonly model?: string;
  readonly systemPrompt?: string;
  readonly maxIterations?: number;
  readonly modelParams?: ModelParams;
  readonly toolFilter?: ToolFilter;
  readonly subagents?: SubagentConfig;
  readonly reasoning?: boolean;
  readonly stateless?: boolean;
  readonly maxInputLength?: number;
  readonly maxHistoryMessages?: number;
  readonly maxOutputTokens?: number;
  readonly keepAssistantMessages?: number;
  readonly mcpServers?: McpServersConfig;
  readonly hooks?: HooksConfig;
  readonly telegramBotToken?: string;
  readonly skills?: readonly string[];
}

export interface ResolvedAgent {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly default: boolean;
  readonly provider: AiProvider;
  readonly model: string;
  readonly systemPrompt: string;
  readonly maxIterations?: number;
  readonly modelParams?: ModelParams;
  readonly reasoning?: boolean;
  readonly stateless?: boolean;
  readonly maxInputLength?: number;
  readonly maxHistoryMessages?: number;
  readonly maxOutputTokens?: number;
  readonly keepAssistantMessages?: number;
  readonly toolFilter: ToolFilter;
  readonly subagents: SubagentConfig;
  readonly mcpServers: McpServersConfig;
  readonly hooks?: HooksConfig;
  readonly telegramBotToken?: string;
  readonly skills: readonly string[];
}
