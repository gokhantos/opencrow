/**
 * SDK configuration builders for the Agent SDK.
 * Constructs thinking options, system prompt config, MCP servers, and allowed tools.
 */
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import type { AgentOptions } from "./types";
import type { createOpenCrowMcpServer } from "./mcp-bridge";

/**
 * Build thinking/effort/beta options from AgentOptions.
 * Uses per-agent modelParams when available, falls back to sane defaults.
 */
export function buildThinkingOptions(
  options: AgentOptions,
): Record<string, unknown> {
  const params = options.modelParams;
  const result: Record<string, unknown> = {};

  // Thinking configuration
  const mode =
    params?.thinkingMode ??
    (options.reasoning === true ? "adaptive" : undefined);
  if (mode === "adaptive") {
    result.thinking = { type: "adaptive" };
  } else if (mode === "enabled") {
    result.thinking = {
      type: "enabled",
      budgetTokens: params?.thinkingBudget ?? 32_000,
    };
  } else if (mode === "disabled") {
    result.thinking = { type: "disabled" };
  }

  // Effort level — not supported by agent-sdk CLI, skipped.
  // The thinking budget effectively controls effort instead.

  // Extended context window beta
  if (params?.extendedContext) {
    result.betas = ["context-1m-2025-08-07"];
  }

  // Budget limit
  if (params?.maxBudgetUsd !== undefined) {
    result.maxBudgetUsd = params.maxBudgetUsd;
  }

  return result;
}

/**
 * Build the systemPrompt option using the claude_code preset.
 * This keeps Claude Code's full built-in system prompt (tool usage, methodology,
 * CLAUDE.md loading, etc.) and appends OpenCrow's custom instructions on top.
 */
export function buildSystemPromptOption(customPrompt: string): {
  type: "preset";
  preset: "claude_code";
  append: string;
} {
  return {
    type: "preset",
    preset: "claude_code",
    append: customPrompt,
  };
}

/**
 * Build the mcpServers config object based on enabled flags in AgentOptions.
 */
export function buildMcpServers(
  options: AgentOptions,
  opencrowMcp: ReturnType<typeof createOpenCrowMcpServer>,
): Record<string, McpServerConfig> {
  return {
    "opencrow-tools": opencrowMcp,
    ...(options.browserEnabled
      ? {
          playwright: {
            type: "stdio" as const,
            command: "npx",
            args: ["@playwright/mcp@latest", "--headless"],
          },
        }
      : {}),
    ...(options.githubEnabled
      ? {
          github: {
            type: "http" as const,
            url: "https://api.githubcopilot.com/mcp/",
          },
        }
      : {}),
    ...(options.context7Enabled
      ? {
          context7: {
            type: "stdio" as const,
            command: "npx",
            args: ["-y", "@upstash/context7-mcp@latest"],
          },
        }
      : {}),
    ...(options.sequentialThinkingEnabled
      ? {
          "sequential-thinking": {
            type: "stdio" as const,
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-sequential-thinking"],
          },
        }
      : {}),
    ...(options.dbhubEnabled
      ? {
          dbhub: {
            type: "stdio" as const,
            command: "npx",
            args: [
              "-y",
              "@bytebase/dbhub",
              "--dsn",
              process.env.DATABASE_URL ??
                "postgres://opencrow:opencrow@127.0.0.1:5432/opencrow",
            ],
          },
        }
      : {}),
    ...(options.filesystemEnabled
      ? {
          filesystem: {
            type: "stdio" as const,
            command: "npx",
            args: [
              "-y",
              "@modelcontextprotocol/server-filesystem",
              "/home/opencrow",
            ],
          },
        }
      : {}),
    ...(options.gitEnabled
      ? {
          git: {
            type: "stdio" as const,
            command: `${process.env.HOME}/.local/bin/uvx`,
            args: ["mcp-server-git"],
          },
        }
      : {}),
    ...(options.qdrantEnabled
      ? {
          qdrant: {
            type: "stdio" as const,
            command: `${process.env.HOME}/.local/bin/uvx`,
            args: ["qdrant-mcp-server"],
            env: {
              QDRANT_URL: process.env.QDRANT_URL ?? "http://127.0.0.1:6333",
              ...(process.env.QDRANT_API_KEY
                ? { QDRANT_API_KEY: process.env.QDRANT_API_KEY }
                : {}),
            },
          },
        }
      : {}),
    ...(options.braveSearchEnabled
      ? {
          "brave-search": {
            type: "stdio" as const,
            command: "npx",
            args: ["-y", "brave-search-mcp"],
            env: {
              ...(process.env.BRAVE_API_KEY
                ? { BRAVE_API_KEY: process.env.BRAVE_API_KEY }
                : {}),
            },
          },
        }
      : {}),
    ...(options.firecrawlEnabled
      ? {
          firecrawl: {
            type: "stdio" as const,
            command: "npx",
            args: ["-y", "firecrawl-mcp"],
            env: {
              ...(process.env.FIRECRAWL_API_KEY
                ? { FIRECRAWL_API_KEY: process.env.FIRECRAWL_API_KEY }
                : {}),
            },
          },
        }
      : {}),
  };
}

/**
 * Build the allowedTools array based on enabled flags in AgentOptions.
 */
export function buildAllowedTools(options: AgentOptions): string[] {
  return [
    "mcp__opencrow-tools__*",
    ...(options.webSearchEnabled ? ["WebSearch", "WebFetch"] : []),
    ...(options.browserEnabled ? ["mcp__playwright__*"] : []),
    ...(options.githubEnabled ? ["mcp__github__*"] : []),
    ...(options.context7Enabled ? ["mcp__context7__*"] : []),
    ...(options.sequentialThinkingEnabled
      ? ["mcp__sequential-thinking__*"]
      : []),
    ...(options.dbhubEnabled ? ["mcp__dbhub__*"] : []),
    ...(options.filesystemEnabled ? ["mcp__filesystem__*"] : []),
    ...(options.gitEnabled ? ["mcp__git__*"] : []),
    ...(options.qdrantEnabled ? ["mcp__qdrant__*"] : []),
    ...(options.braveSearchEnabled ? ["mcp__brave-search__*"] : []),
    ...(options.firecrawlEnabled ? ["mcp__firecrawl__*"] : []),
  ];
}
