import type { AgentOptions, AgentResponse, ConversationMessage } from "./types";
import { retryAsync } from "../infra/retry";
import { createLogger } from "../logger";

const log = createLogger("opencode-direct");

function getCredentials(): { apiKey: string; baseUrl: string } {
  const apiKey = process.env.OPENCODE_API_KEY;
  if (!apiKey) {
    log.warn("OPENCODE_API_KEY is not set");
    throw new Error("OPENCODE_API_KEY is not set");
  }
  const baseUrl = process.env.OPENCODE_BASE_URL ?? "";
  if (!baseUrl) {
    log.warn("OPENCODE_BASE_URL is not set");
    throw new Error("OPENCODE_BASE_URL is not set");
  }
  return { apiKey, baseUrl };
}

interface OpenCodeMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

interface OpenCodeChoice {
  readonly message: {
    readonly role: "assistant";
    readonly content: string;
  };
  readonly finish_reason: string;
}

interface OpenCodeResponse {
  readonly choices: readonly OpenCodeChoice[];
  readonly usage?: {
    readonly prompt_tokens: number;
    readonly completion_tokens: number;
  };
}

function toOpenCodeMessages(
  systemPrompt: string,
  messages: readonly ConversationMessage[],
): OpenCodeMessage[] {
  const result: OpenCodeMessage[] = [
    { role: "system", content: systemPrompt },
  ];
  for (const msg of messages) {
    result.push({ role: msg.role, content: msg.content });
  }
  return result;
}

function isRetryable(err: unknown): boolean {
  if (err instanceof Error) {
    const msg = err.message;
    if (msg.includes("429") || msg.includes("rate limit")) return true;
    if (msg.includes("500") || msg.includes("502") || msg.includes("503"))
      return true;
    if (msg.includes("ECONNREFUSED") || msg.includes("ETIMEDOUT")) return true;
  }
  return false;
}

async function callOpenCode(
  baseUrl: string,
  apiKey: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<OpenCodeResponse> {
  const res = await fetch(`${baseUrl}/zen/go/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    // Wire the per-call deadline / external abort into the HTTP request so a
    // hung response is actually cancelled.
    ...(signal ? { signal } : {}),
  });

  if (!res.ok) {
    const text = await res.text();
    let detail = text;
    try {
      const parsed = JSON.parse(text);
      if (parsed.error?.message) detail = parsed.error.message;
    } catch {
      // keep raw text
    }
    throw new Error(`OpenCode API error (${res.status}): ${detail}`);
  }

  return res.json() as Promise<OpenCodeResponse>;
}

export async function chat(
  messages: readonly ConversationMessage[],
  options: AgentOptions,
): Promise<AgentResponse> {
  log.debug("Sending message to OpenCode direct", {
    model: options.model,
    messageCount: messages.length,
  });

  const { apiKey, baseUrl } = getCredentials();

  const body: Record<string, unknown> = {
    model: options.model,
    max_tokens: options.maxOutputTokens ?? 16384,
    messages: toOpenCodeMessages(options.systemPrompt, messages),
    // OpenCode (Zen Go endpoint) honors thinking:{type:disabled}, NOT
    // enable_thinking. Disable extended thinking for these direct calls.
    thinking: { type: "disabled" },
  };

  try {
    const response = await retryAsync(
      () => callOpenCode(baseUrl, apiKey, body, options.abortSignal),
      {
        label: "opencode.chat",
        shouldRetry: isRetryable,
        ...(options.abortSignal ? { signal: options.abortSignal } : {}),
      },
    );

    const text = response.choices[0]?.message.content ?? "";

    log.info("OpenCode direct response received", {
      model: options.model,
      inputTokens: response.usage?.prompt_tokens,
      outputTokens: response.usage?.completion_tokens,
    });

    return {
      text,
      provider: "opencode",
      usage: response.usage
        ? {
            inputTokens: response.usage.prompt_tokens,
            outputTokens: response.usage.completion_tokens,
          }
        : undefined,
    };
  } catch (error) {
    log.error("OpenCode direct API error", { error });
    throw new Error(
      `OpenCode API error: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
