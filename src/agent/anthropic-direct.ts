import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";
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

let _client: Anthropic | undefined;

/**
 * Read the OAuth access token from ~/.claude/.credentials.json.
 * This uses the Claude subscription (Pro/Max) — no API credits needed.
 */
function readOAuthToken(): string {
  const credsPath = join(homedir(), ".claude", ".credentials.json");
  const raw = readFileSync(credsPath, "utf-8");
  const creds = JSON.parse(raw) as {
    claudeAiOauth?: { accessToken?: string; expiresAt?: number };
  };
  const oauth = creds.claudeAiOauth;
  if (!oauth?.accessToken) {
    throw new Error(
      "No OAuth token in ~/.claude/.credentials.json. Run 'claude login' first.",
    );
  }
  if (oauth.expiresAt && oauth.expiresAt < Date.now()) {
    log.warn("OAuth token expired", {
      expiresAt: new Date(oauth.expiresAt).toISOString(),
    });
  }
  return oauth.accessToken;
}

function getClient(): Anthropic {
  if (!_client) {
    const token = readOAuthToken();
    // OAuth requires: Bearer auth, beta headers, and Claude Code identity headers.
    // Reverse-engineered from pi-ai's Anthropic provider (used by OpenClaw).
    _client = new Anthropic({
      authToken: token,
      apiKey: null,
      defaultHeaders: {
        accept: "application/json",
        "anthropic-beta":
          "claude-code-20250219,oauth-2025-04-20,fine-grained-tool-streaming-2025-05-14,interleaved-thinking-2025-05-14",
        "anthropic-dangerous-direct-browser-access": "true",
        "user-agent": "claude-cli/1.0.0 (external, cli)",
        "x-app": "cli",
      },
    });
    log.info("Anthropic client initialized with OAuth token");
  }
  return _client;
}

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
    return err.status === 429 || err.status === 529 || err.status >= 500;
  }
  if (err instanceof Error) {
    const msg = err.message;
    if (msg.includes("ECONNREFUSED") || msg.includes("ETIMEDOUT")) return true;
  }
  return false;
}

async function callAnthropic(
  client: Anthropic,
  options: AgentOptions,
  messages: Array<{ role: "user" | "assistant"; content: string }>,
): Promise<Anthropic.Message> {
  // OAuth requires Claude Code identity as the first system prompt block
  const system: Anthropic.Messages.TextBlockParam[] = [
    { type: "text", text: CLAUDE_CODE_IDENTITY },
    ...(options.systemPrompt
      ? [{ type: "text" as const, text: options.systemPrompt }]
      : []),
  ];

  return client.messages.create({
    model: options.model,
    max_tokens: options.maxOutputTokens ?? 16384,
    system,
    messages,
  });
}

export async function chat(
  messages: readonly ConversationMessage[],
  options: AgentOptions,
): Promise<AgentResponse> {
  log.debug("Sending message to Anthropic direct", {
    model: options.model,
    messageCount: messages.length,
  });

  const client = getClient();
  const anthropicMessages = toAnthropicMessages(messages);

  try {
    const response = await retryAsync(
      () => callAnthropic(client, options, anthropicMessages),
      {
        label: "anthropic.chat",
        shouldRetry: isRetryable,
      },
    );

    const firstBlock = response.content[0];
    if (!firstBlock || firstBlock.type !== "text") {
      throw new Error("Anthropic response contained no text block");
    }

    const text = firstBlock.text;
    const inputTokens = response.usage.input_tokens;
    const outputTokens = response.usage.output_tokens;
    const costUsd =
      inputTokens * INPUT_COST_PER_TOKEN +
      outputTokens * OUTPUT_COST_PER_TOKEN;

    log.info("Anthropic direct response received", {
      model: options.model,
      inputTokens,
      outputTokens,
      costUsd,
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
