/**
 * Anthropic provider using pi-ai — same library OpenClaw uses.
 *
 * Features (matching OpenClaw):
 * - Streaming via pi-ai's completeSimple (streams internally, returns complete)
 * - OAuth token auto-refresh via pi-ai's getOAuthApiKey
 * - Prompt caching via cacheRetention: "short"
 * - Proper Anthropic beta headers for OAuth
 */
import {
  completeSimple,
  getOAuthApiKey,
  type AssistantMessage,
  type Model,
  type SimpleStreamOptions,
  type OAuthCredentials,
  type UserMessage,
} from "@mariozechner/pi-ai";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { createLogger } from "../logger";
import type { AgentOptions, AgentResponse, ConversationMessage } from "./types";

const log = createLogger("anthropic-direct");

// Sonnet 4.6 pricing: $3/1M input, $15/1M output
const INPUT_COST_PER_TOKEN = 3 / 1_000_000;
const OUTPUT_COST_PER_TOKEN = 15 / 1_000_000;

const CREDS_PATH = join(homedir(), ".claude", ".credentials.json");

// OAuth beta headers — same as OpenClaw's PI_AI_OAUTH_ANTHROPIC_BETAS
const OAUTH_BETA_HEADERS = [
  "claude-code-20250219",
  "oauth-2025-04-20",
  "prompt-caching-2024-07-31",
  "fine-grained-tool-streaming-2025-05-14",
  "interleaved-thinking-2025-05-14",
].join(",");

// ─── OAuth Credential Management ─────────────────────────────────────────────

let _cachedCreds: OAuthCredentials | undefined;

async function readOAuthCredentials(): Promise<OAuthCredentials> {
  const raw = await readFile(CREDS_PATH, "utf-8");
  const parsed = JSON.parse(raw) as {
    claudeAiOauth?: {
      accessToken?: string;
      refreshToken?: string;
      expiresAt?: number;
    };
  };
  const oauth = parsed.claudeAiOauth;
  if (!oauth?.accessToken) {
    throw new Error(
      "No OAuth token in ~/.claude/.credentials.json. Run 'claude login' first.",
    );
  }
  return {
    access: oauth.accessToken,
    refresh: oauth.refreshToken ?? "",
    expires: oauth.expiresAt ?? 0,
  };
}

/**
 * Get a valid API key using pi-ai's OAuth token refresh.
 * If the token is expired, pi-ai will refresh it automatically using
 * the same endpoint and client ID that OpenClaw uses.
 */
async function getApiKey(): Promise<string> {
  // Re-read credentials if we don't have them or they're about to expire
  if (!_cachedCreds || Date.now() > _cachedCreds.expires - 60_000) {
    _cachedCreds = await readOAuthCredentials();
  }

  try {
    // pi-ai getOAuthApiKey takes Record<string, OAuthCredentials>
    // Key MUST match the providerId ("anthropic") — getOAuthApiKey does credentials[providerId]
    const result = await getOAuthApiKey("anthropic", {
      anthropic: _cachedCreds,
    });

    if (result) {
      // Update cached credentials with refreshed ones
      _cachedCreds = result.newCredentials;
      return result.apiKey;
    }

    // Fallback: use access token directly
    return _cachedCreds.access;
  } catch (err) {
    // If refresh fails, re-read credentials (another process may have refreshed)
    log.warn("OAuth token refresh failed, re-reading credentials", { err });
    _cachedCreds = await readOAuthCredentials();
    return _cachedCreds.access;
  }
}

// ─── Model Builder ───────────────────────────────────────────────────────────

function buildModel(modelId: string): Model<"anthropic-messages"> {
  return {
    id: modelId,
    name: modelId,
    api: "anthropic-messages",
    provider: "anthropic",
    baseUrl: "https://api.anthropic.com",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    contextWindow: 200_000,
    maxTokens: 16384,
    headers: {
      "anthropic-beta": OAUTH_BETA_HEADERS,
      "anthropic-dangerous-direct-browser-access": "true",
      "user-agent": "claude-cli/1.0.0 (external, cli)",
      "x-app": "cli",
    },
  };
}

// ─── Message Conversion ──────────────────────────────────────────────────────

function toPiMessages(
  messages: readonly ConversationMessage[],
): UserMessage[] {
  // For simple chat completions, all messages are sent as user messages.
  // Multi-turn conversations with assistant context are flattened into the
  // system prompt or handled by the caller before reaching here.
  // If there ARE assistant messages, we include them as context in the last
  // user message to avoid pi-ai type mismatches.
  if (messages.length <= 1 || messages.every((m) => m.role === "user")) {
    return messages.map((msg) => ({
      role: "user" as const,
      content: msg.content,
      timestamp: msg.timestamp,
    }));
  }

  // Flatten multi-turn into a single user message with conversation context
  const contextLines: string[] = [];
  for (const msg of messages.slice(0, -1)) {
    const prefix = msg.role === "assistant" ? "Assistant" : "User";
    contextLines.push(`${prefix}: ${msg.content}`);
  }
  const lastMsg = messages[messages.length - 1]!;
  const flattenedContent = contextLines.length > 0
    ? `Previous conversation:\n${contextLines.join("\n")}\n\nUser: ${lastMsg.content}`
    : lastMsg.content;

  return [{
    role: "user" as const,
    content: flattenedContent,
    timestamp: lastMsg.timestamp,
  }];
}

// ─── Public API ──────────────────────────────────────────────────────────────

function isTextBlock(
  block: AssistantMessage["content"][number],
): block is { type: "text"; text: string } {
  return block.type === "text";
}

export async function chat(
  messages: readonly ConversationMessage[],
  options: AgentOptions,
): Promise<AgentResponse> {
  log.debug("Sending message to Anthropic via pi-ai", {
    model: options.model,
    messageCount: messages.length,
  });

  const apiKey = await getApiKey();
  const model = buildModel(options.model);
  const piMessages = toPiMessages(messages);

  const streamOptions: SimpleStreamOptions = {
    apiKey,
    maxTokens: options.maxOutputTokens ?? 16384,
    cacheRetention: "short",
  };

  try {
    const response: AssistantMessage = await completeSimple(
      model,
      {
        systemPrompt: options.systemPrompt ?? undefined,
        messages: piMessages,
      },
      streamOptions,
    );

    const textBlocks = response.content.filter(isTextBlock);
    const text = textBlocks.map((b) => b.text).join("");

    if (!text) {
      const blockTypes = response.content.map((b) => b.type).join(", ");
      log.error("Anthropic response contained no text blocks", {
        model: options.model,
        blockTypes: blockTypes || "empty",
        contentLength: response.content.length,
        stopReason: response.stopReason,
        usage: response.usage,
      });
      throw new Error(
        `Anthropic response contained no text (blocks: [${blockTypes || "none"}], stopReason: ${response.stopReason ?? "unknown"})`,
      );
    }

    const inputTokens = response.usage?.input ?? 0;
    const outputTokens = response.usage?.output ?? 0;
    const cacheReadTokens = response.usage?.cacheRead ?? 0;
    const costUsd =
      inputTokens * INPUT_COST_PER_TOKEN +
      outputTokens * OUTPUT_COST_PER_TOKEN;

    log.info("Anthropic pi-ai response received", {
      model: options.model,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      costUsd: costUsd.toFixed(4),
    });

    return {
      text,
      provider: "anthropic",
      usage: {
        inputTokens,
        outputTokens,
        costUsd,
      },
    };
  } catch (error) {
    log.error("Anthropic pi-ai API error", { error });
    throw new Error(
      `Anthropic API error: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
