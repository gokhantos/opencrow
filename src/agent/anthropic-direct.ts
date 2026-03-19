import Anthropic from "@anthropic-ai/sdk";
import { retryAsync } from "../infra/retry";
import { createLogger } from "../logger";
import type { AgentOptions, AgentResponse, ConversationMessage } from "./types";

const log = createLogger("anthropic-direct");

// Sonnet 4.6 pricing: $3/1M input, $15/1M output
const INPUT_COST_PER_TOKEN = 3 / 1_000_000;
const OUTPUT_COST_PER_TOKEN = 15 / 1_000_000;

let _client: Anthropic | undefined;

function getClient(): Anthropic {
  if (!_client) {
    _client = new Anthropic();
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
