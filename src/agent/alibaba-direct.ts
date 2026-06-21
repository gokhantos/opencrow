import type { AgentOptions, AgentResponse, ConversationMessage } from "./types";
import { retryAsync } from "../infra/retry";
import { createLogger } from "../logger";
import { resolveAlibabaEndpoint } from "./alibaba-endpoints";

const log = createLogger("alibaba-direct");

async function getCredentials(): Promise<{ apiKey: string; baseUrl: string }> {
  const { getSecret } = await import("../config/secrets");
  const apiKey = await getSecret("ALIBABA_API_KEY");
  if (!apiKey) {
    throw new Error("ALIBABA_API_KEY is not set");
  }
  const baseUrl = resolveAlibabaEndpoint(
    "openai",
    await getSecret("ALIBABA_BASE_URL"),
  );
  return { apiKey, baseUrl };
}

interface AlibabaMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

interface AlibabaChoice {
  readonly message: {
    readonly role: "assistant";
    readonly content: string;
  };
  readonly finish_reason: string;
}

interface AlibabaResponse {
  readonly choices: readonly AlibabaChoice[];
  readonly usage?: {
    readonly prompt_tokens: number;
    readonly completion_tokens: number;
  };
}

function toAlibabaMessages(
  systemPrompt: string,
  messages: readonly ConversationMessage[],
): AlibabaMessage[] {
  const result: AlibabaMessage[] = [{ role: "system", content: systemPrompt }];
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

async function callAlibaba(
  baseUrl: string,
  apiKey: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<AlibabaResponse> {
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      // Disable DashScope's input/output content moderation ("data inspection" /
      // green-net). We feed it UNTRUSTED scraped reviews/posts, not user-facing
      // chat, and that corpus intermittently trips the gate — returning a 400
      // "Input text data may contain inappropriate content" that fails the whole
      // pipeline/SIGE run. The platform moderation is inappropriate for this
      // scraped-data analysis path. (DashScope honors `disable` on this header.)
      "X-DashScope-DataInspection": "disable",
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
    throw new Error(`Alibaba API error (${res.status}): ${detail}`);
  }

  return res.json() as Promise<AlibabaResponse>;
}

export async function chat(
  messages: readonly ConversationMessage[],
  options: AgentOptions,
): Promise<AgentResponse> {
  log.debug("Sending message to Alibaba direct", {
    model: options.model,
    messageCount: messages.length,
  });

  const { apiKey, baseUrl } = await getCredentials();

  const body: Record<string, unknown> = {
    model: options.model,
    max_tokens: options.maxOutputTokens ?? 16384,
    messages: toAlibabaMessages(options.systemPrompt, messages),
    // Reasoning models routed here (glm-*, deepseek-*, qwen*) emit large
    // reasoning-token traces by default, which blow the per-call LLM timeout on
    // non-agentic steps (e.g. idea-pipeline synthesis). Disable thinking unless
    // the caller explicitly opts in via options.reasoning. The OpenAI-compatible
    // token-plan endpoint accepts both flags harmlessly; send both for
    // cross-model robustness (glm/deepseek honor thinking:{type:disabled};
    // qwen honors enable_thinking:false).
    ...(options.reasoning === true
      ? {}
      : { thinking: { type: "disabled" }, enable_thinking: false }),
  };

  try {
    const response = await retryAsync(
      () => callAlibaba(baseUrl, apiKey, body, options.abortSignal),
      {
        label: "alibaba.chat",
        shouldRetry: isRetryable,
        ...(options.abortSignal ? { signal: options.abortSignal } : {}),
      },
    );

    const text = response.choices[0]?.message.content ?? "";

    log.info("Alibaba direct response received", {
      model: options.model,
      inputTokens: response.usage?.prompt_tokens,
      outputTokens: response.usage?.completion_tokens,
    });

    return {
      text,
      provider: "alibaba",
      usage: response.usage
        ? {
            inputTokens: response.usage.prompt_tokens,
            outputTokens: response.usage.completion_tokens,
          }
        : undefined,
    };
  } catch (error) {
    log.error("Alibaba direct API error", { error });
    throw new Error(
      `Alibaba API error: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
