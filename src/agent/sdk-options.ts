/**
 * SDK configuration builders for the Agent SDK.
 * Constructs thinking options, system prompt config, MCP servers, and allowed tools.
 */
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import type { AgentOptions } from "./types";
import type { createOpenCrowMcpServer } from "./mcp-bridge";
import { createLogger } from "../logger";

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

  // Effort level — only supported on claude-opus-4-6
  if (params?.effort && options.model?.toLowerCase().includes("opus")) {
    result.effort = params.effort;
  }

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
    ...(options.serenaEnabled
      ? {
          serena: {
            type: "stdio" as const,
            command: `${process.env.HOME}/.local/bin/uvx`,
            args: [
              "--from",
              "git+https://github.com/oraios/serena",
              "serena",
              "start-mcp-server",
            ],
          },
        }
      : {}),
  };
}

/**
 * Build the disallowedTools array based on disabled flags in AgentOptions.
 *
 * The SDK's `allowedTools` only controls auto-permission (irrelevant with
 * bypassPermissions). To actually restrict tool visibility, we use
 * `disallowedTools` which removes tools from the model's context entirely.
 */
export function buildDisallowedTools(options: AgentOptions): string[] {
  return [
    ...(!options.webSearchEnabled ? ["WebSearch", "WebFetch"] : []),
    ...(!options.browserEnabled ? ["mcp__playwright__*"] : []),
    ...(!options.githubEnabled ? ["mcp__github__*"] : []),
    ...(!options.context7Enabled ? ["mcp__context7__*"] : []),
    ...(!options.sequentialThinkingEnabled
      ? ["mcp__sequential-thinking__*"]
      : []),
    ...(!options.dbhubEnabled ? ["mcp__dbhub__*"] : []),
    ...(!options.filesystemEnabled ? ["mcp__filesystem__*"] : []),
    ...(!options.gitEnabled ? ["mcp__git__*"] : []),
    ...(!options.qdrantEnabled ? ["mcp__qdrant__*"] : []),
    ...(!options.braveSearchEnabled ? ["mcp__brave-search__*"] : []),
    ...(!options.firecrawlEnabled ? ["mcp__firecrawl__*"] : []),
    ...(!options.serenaEnabled ? ["mcp__serena__*"] : []),
  ];
}

/**
 * Detect the runtime executable name for the Agent SDK at module load time.
 * The SDK expects `'bun' | 'node'`, not a full path, and resolves it via PATH.
 *
 * We detect whether we're running under Bun, but only return "bun" if `bun`
 * is actually resolvable in PATH.  On production servers Bun may be installed
 * under ~/.bun/bin which is not in the system PATH exported to child processes
 * (e.g. when launched by a systemd service unit), so the SDK would fail with
 * ENOENT when it tries to spawn `bun <claude-cli.js>`.  Fall back to "node"
 * when bun is not on PATH — Node.js can run the Claude Code CLI just as well.
 *
 * Result is memoised at module initialisation to avoid repeated process probes.
 */
function resolveExecutable(): "bun" | "node" {
  if (!process.execPath.toLowerCase().includes("bun")) {
    return "node";
  }

  // Verify "bun" is resolvable via PATH before trusting the detection.
  try {
    const { spawnSync } = require("child_process") as typeof import("child_process");
    const result = spawnSync("bun", ["--version"], { stdio: "ignore", timeout: 2000 });
    return result.error ? "node" : "bun";
  } catch {
    return "node";
  }
}

const RESOLVED_EXECUTABLE: "bun" | "node" = resolveExecutable();

/**
 * Build session-level options that apply to all SDK queries.
 */
export function buildSessionOptions(): Record<string, unknown> {
  return {
    persistSession: false,
    settingSources: [],
    executable: RESOLVED_EXECUTABLE,
  };
}

const stderrLog = createLogger("agent-sdk:stderr");

/**
 * Build a stderr handler that logs SDK subprocess stderr output.
 * Useful for diagnosing Claude Code subprocess crashes.
 */
export function buildStderrHandler(
  agentId: string,
): (data: string) => void {
  return (data: string) => {
    stderrLog.warn("SDK subprocess stderr", {
      agentId,
      stderr: data.slice(0, 2000),
    });
  };
}
