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

let _client: Anthropic | undefined;

/**
 * Resolve auth credentials. Prefers ANTHROPIC_API_KEY (x-api-key header),
 * falls back to OAuth token from ~/.claude/.credentials.json (Bearer header).
 */
function resolveAuth(): { apiKey: string } | { authToken: string } {
  if (process.env.ANTHROPIC_API_KEY) {
    return { apiKey: process.env.ANTHROPIC_API_KEY };
  }

  // Read OAuth token from Claude CLI credentials (uses Bearer auth)
  try {
    const credsPath = join(homedir(), ".claude", ".credentials.json");
    const raw = readFileSync(credsPath, "utf-8");
    const creds = JSON.parse(raw) as {
      claudeAiOauth?: { accessToken?: string; expiresAt?: number };
    };
    const oauth = creds.claudeAiOauth;
    if (oauth?.accessToken) {
      if (oauth.expiresAt && oauth.expiresAt < Date.now()) {
        log.warn("OAuth token expired", {
          expiresAt: new Date(oauth.expiresAt).toISOString(),
        });
      }
      log.info("Using OAuth token from Claude credentials");
      return { authToken: oauth.accessToken };
    }
  } catch (err) {
    log.debug("Could not read Claude credentials file", { error: err });
  }

  throw new Error(
    "No Anthropic API key found. Set ANTHROPIC_API_KEY or authenticate via 'claude login'.",
  );
}

function getClient(): Anthropic {
  if (!_client) {
    const auth = resolveAuth();
    _client = new Anthropic(
      "apiKey" in auth
        ? { apiKey: auth.apiKey }
        : { authToken: auth.authToken, apiKey: null },
    );
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
  return client.messages.create({
    model: options.model,
    max_tokens: options.maxOutputTokens ?? 16384,
    system: options.systemPrompt,
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
