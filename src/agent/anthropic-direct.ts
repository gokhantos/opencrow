import Anthropic from "@anthropic-ai/sdk";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { retryAsync } from "../infra/retry";
import { createLogger } from "../logger";
import type { AgentOptions, AgentResponse, ConversationMessage } from "./types";

const log = createLogger("anthropic-direct");

// Sonnet 4.6 pricing: $3/1M input, $15/1M output
const INPUT_COST_PER_TOKEN = 3 / 1_000_000;
const OUTPUT_COST_PER_TOKEN = 15 / 1_000_000;

/** Claude Code identity prefix — required by Anthropic for OAuth API access. */
const CLAUDE_CODE_IDENTITY =
  "You are Claude Code, Anthropic's official CLI for Claude.";

const CREDS_PATH = join(homedir(), ".claude", ".credentials.json");

// ─── OAuth Token Management ──────────────────────────────────────────────────

let _client: Anthropic | undefined;
let _tokenExpiresAt: number | undefined;

/**
 * Read the OAuth access token from ~/.claude/.credentials.json.
 * Uses async file read to avoid blocking the event loop.
 * Re-reads on every call if the cached token is expired.
 */
async function readOAuthToken(): Promise<string> {
  const raw = await readFile(CREDS_PATH, "utf-8");
  const creds = JSON.parse(raw) as {
    claudeAiOauth?: { accessToken?: string; expiresAt?: number };
  };
  const oauth = creds.claudeAiOauth;
  if (!oauth?.accessToken) {
    throw new Error(
      "No OAuth token in ~/.claude/.credentials.json. Run 'claude login' first.",
    );
  }
  _tokenExpiresAt = oauth.expiresAt;
  return oauth.accessToken;
}

function isTokenExpired(): boolean {
  if (_tokenExpiresAt === undefined) return false;
  // Refresh 60s before actual expiry to avoid mid-request failures
  return Date.now() > _tokenExpiresAt - 60_000;
}

async function getClient(): Promise<Anthropic> {
  // Recreate client if token is expired or about to expire
  if (_client && !isTokenExpired()) {
    return _client;
  }

  if (_client && isTokenExpired()) {
    log.info("OAuth token expired or expiring soon, refreshing client");
    _client = undefined;
  }

  const token = await readOAuthToken();
  _client = new Anthropic({
    authToken: token,
    apiKey: null,
    defaultHeaders: {
      accept: "application/json",
      "anthropic-beta":
        "claude-code-20250219,oauth-2025-04-20,prompt-caching-2024-07-31,fine-grained-tool-streaming-2025-05-14,interleaved-thinking-2025-05-14",
      "anthropic-dangerous-direct-browser-access": "true",
      "user-agent": "claude-cli/1.0.0 (external, cli)",
      "x-app": "cli",
    },
  });
  log.info("Anthropic client initialized with OAuth token", {
    expiresAt: _tokenExpiresAt
      ? new Date(_tokenExpiresAt).toISOString()
      : "unknown",
  });

  return _client;
}

// ─── Message Helpers ─────────────────────────────────────────────────────────

function toAnthropicMessages(
  messages: readonly ConversationMessage[],
): Array<{ role: "user" | "assistant"; content: string }> {
  return messages.map((msg) => ({
    role: msg.role,
    content: msg.content,
  }));
}

function isRetryable(err: unknown): boolean {
  if (err instanceof Anthropic.APIError) {
    // Refresh client on 401 (expired token)
    if (err.status === 401) {
      _client = undefined;
      return true;
    }
    return err.status === 429 || err.status === 529 || err.status >= 500;
  }
  if (err instanceof Error) {
    const msg = err.message;
    if (msg.includes("ECONNREFUSED") || msg.includes("ETIMEDOUT")) return true;
  }
  return false;
}

// ─── Streaming API Call ──────────────────────────────────────────────────────

async function callAnthropicStreaming(
  client: Anthropic,
  options: AgentOptions,
  messages: Array<{ role: "user" | "assistant"; content: string }>,
): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
  // System prompt blocks with prompt caching enabled
  const system: Anthropic.Messages.TextBlockParam[] = [
    {
      type: "text",
      text: CLAUDE_CODE_IDENTITY,
      cache_control: { type: "ephemeral" },
    } as Anthropic.Messages.TextBlockParam,
    ...(options.systemPrompt
      ? [
          {
            type: "text" as const,
            text: options.systemPrompt,
            cache_control: { type: "ephemeral" as const },
          } as Anthropic.Messages.TextBlockParam,
        ]
      : []),
  ];

  // Use contextual max_tokens: lower for simple tasks, higher for generation
  const maxTokens = options.maxOutputTokens ?? 16384;

  const stream = client.messages.stream({
    model: options.model,
    max_tokens: maxTokens,
    system,
    messages,
    service_tier: "auto",
  });

  // Collect streamed text chunks
  const chunks: string[] = [];

  for await (const event of stream) {
    if (
      event.type === "content_block_delta" &&
      event.delta.type === "text_delta"
    ) {
      chunks.push(event.delta.text);
    }
  }

  const finalMessage = await stream.finalMessage();

  return {
    text: chunks.join(""),
    inputTokens: finalMessage.usage.input_tokens,
    outputTokens: finalMessage.usage.output_tokens,
  };
}

// ─── Public API ──────────────────────────────────────────────────────────────

export async function chat(
  messages: readonly ConversationMessage[],
  options: AgentOptions,
): Promise<AgentResponse> {
  log.debug("Sending message to Anthropic direct (streaming)", {
    model: options.model,
    messageCount: messages.length,
  });

  const anthropicMessages = toAnthropicMessages(messages);

  try {
    const { text, inputTokens, outputTokens } = await retryAsync(
      async () => {
        // Re-acquire client on retry (handles token refresh on 401)
        const c = await getClient();
        return callAnthropicStreaming(c, options, anthropicMessages);
      },
      {
        label: "anthropic.chat",
        shouldRetry: isRetryable,
      },
    );

    if (!text) {
      throw new Error("Anthropic response contained no text");
    }

    const costUsd =
      inputTokens * INPUT_COST_PER_TOKEN +
      outputTokens * OUTPUT_COST_PER_TOKEN;

    log.info("Anthropic direct response received", {
      model: options.model,
      inputTokens,
      outputTokens,
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
    log.error("Anthropic direct API error", { error });
    throw new Error(
      `Anthropic API error: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
