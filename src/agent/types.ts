import type { ToolRegistry } from "../tools/registry";

export type StreamEvent =
  | { readonly type: "text_delta"; readonly text: string }
  | {
      readonly type: "tool_use_start";
      readonly name: string;
      readonly id: string;
    }
  | {
      readonly type: "tool_result";
      readonly name: string;
      readonly id: string;
      readonly output: string;
      readonly isError: boolean;
    }
  | {
      readonly type: "turn_complete";
      readonly usage: {
        readonly inputTokens: number;
        readonly outputTokens: number;
      };
    }
  | { readonly type: "error"; readonly message: string }
  | {
      readonly type: "done";
      readonly totalUsage: {
        readonly inputTokens: number;
        readonly outputTokens: number;
      };
      readonly toolUseCount: number;
    };

export interface ConversationMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly timestamp: number;
}

export type AiProvider = "openrouter" | "agent-sdk" | "alibaba";

export type ProgressEvent =
  | {
      readonly type: "tool_start";
      readonly agentId: string;
      readonly tool: string;
    }
  | {
      readonly type: "tool_done";
      readonly agentId: string;
      readonly tool: string;
      readonly result?: string;
      readonly isError?: boolean;
    }
  | {
      readonly type: "thinking";
      readonly agentId: string;
      readonly summary: string;
    }
  | {
      readonly type: "text_output";
      readonly agentId: string;
      readonly preview: string;
    }
  | {
      readonly type: "complete";
      readonly agentId: string;
      readonly durationMs: number;
      readonly toolUseCount: number;
      readonly tokenUsage?: {
        readonly input: number;
        readonly output: number;
      };
    }
  | {
      readonly type: "subagent_start";
      readonly agentId: string;
      readonly childAgent: string;
      readonly task: string;
    }
  | {
      readonly type: "subagent_done";
      readonly agentId: string;
      readonly childAgent: string;
    }
  | {
      readonly type: "iteration";
      readonly agentId: string;
      readonly iteration: number;
    };

export interface AgentResponse {
  readonly text: string;
  readonly provider: AiProvider;
  readonly toolUseCount?: number;
  readonly usage?: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cacheReadTokens?: number;
    readonly cacheCreationTokens?: number;
    readonly costUsd?: number;
    readonly durationMs?: number;
  };
}

export interface ModelParams {
  readonly thinkingMode?: "adaptive" | "enabled" | "disabled";
  readonly thinkingBudget?: number;
  readonly effort?: "low" | "medium" | "high" | "max";
  readonly extendedContext?: boolean;
  readonly maxBudgetUsd?: number;
}

export interface UsageContext {
  readonly channel: string;
  readonly chatId: string;
  readonly source: "message" | "cron" | "web" | "subagent" | "workflow";
}

export interface AgentOptions {
  readonly systemPrompt: string;
  readonly model: string;
  readonly provider?: AiProvider;
  readonly toolsEnabled?: boolean;
  readonly agentId?: string;
  readonly toolRegistry?: ToolRegistry;
  readonly maxToolIterations?: number;
  readonly maxOutputTokens?: number;
  readonly onProgress?: (event: ProgressEvent) => void;
  readonly cwd?: string;
  readonly reasoning?: boolean;
  readonly modelParams?: ModelParams;
  readonly sdkSessionId?: string;
  readonly onSdkSessionId?: (sessionId: string) => void;
  readonly browserEnabled?: boolean;
  readonly githubEnabled?: boolean;
  readonly context7Enabled?: boolean;
  readonly sequentialThinkingEnabled?: boolean;
  readonly dbhubEnabled?: boolean;
  readonly filesystemEnabled?: boolean;
  readonly gitEnabled?: boolean;
  readonly qdrantEnabled?: boolean;
  readonly braveSearchEnabled?: boolean;
  readonly firecrawlEnabled?: boolean;
  readonly webSearchEnabled?: boolean;
  readonly serenaEnabled?: boolean;
  readonly hooksConfig?: import("../agents/types").HooksConfig;
  readonly sdkHooks?: Record<string, unknown>;
  readonly abortSignal?: AbortSignal;
  readonly usageContext?: UsageContext;
}

// ─── OpenAI / OpenRouter message format ──────────────────────────────────────

export interface OpenAIToolCall {
  readonly id: string;
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly arguments: string;
  };
}

export interface OpenAIMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content?: string | null;
  readonly tool_calls?: readonly OpenAIToolCall[];
  readonly tool_call_id?: string;
}
