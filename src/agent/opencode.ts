import type {
  AgentOptions,
  AgentResponse,
  ConversationMessage,
  OpenAIContentPart,
  OpenAIMessage,
  OpenAIToolCall,
} from "./types";
import type { ToolRegistry } from "../tools/registry";
import { retryAsync } from "../infra/retry";
import { createLogger } from "../logger";
import { createLoopDetector } from "./loop-detection";
import {
  computeToolResultBudget,
  truncateToolResult as truncateToolResultToBudget,
} from "./tool-result-budget";
import { compressOldIterationsOpenAI } from "./sliding-window-openai";
import { pruneToolResultsOpenAI } from "./context-pruning-openai";

const log = createLogger("opencode");

// OpenCode Go subscription gateway (flat-rate, covers the curated coding models:
// deepseek-v4-flash/pro, glm-5.x, kimi, qwen3.x, minimax, mimo, …). For the
// pay-per-token OpenCode Zen gateway instead, set OPENCODE_BASE_URL to
// "https://opencode.ai/zen/v1".
const DEFAULT_BASE_URL = "https://opencode.ai/zen/go/v1/chat/completions";
const DEFAULT_MODEL = "deepseek-v4-flash";
const DEFAULT_CONTEXT_WINDOW = 180_000;
const TOKEN_BUDGET_MULTIPLIER = 1.5;
const MAX_AGENTIC_HISTORY = 15;

async function getApiKey(): Promise<string> {
  const { getSecret } = await import("../config/secrets");
  const key = await getSecret("OPENCODE_API_KEY");
  if (!key) {
    throw new Error("OPENCODE_API_KEY is not set");
  }
  return key;
}

/** Reject an OPENCODE_BASE_URL override that would silently mis-send the bearer
 *  key: an unparseable URL, a non-http(s) scheme, or embedded `user:pass@`
 *  credentials. Mirrors the alibaba-endpoints precedent (operator-controlled
 *  secret, validated as defense-in-depth). */
function assertValidBaseUrlOverride(raw: string): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(
      `OPENCODE_BASE_URL is not a valid absolute URL: "${raw}". ` +
        `Expected something like ${DEFAULT_BASE_URL}`,
    );
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(
      `OPENCODE_BASE_URL must use an http(s) scheme; got "${url.protocol}"`,
    );
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error(
      "OPENCODE_BASE_URL must not contain embedded credentials (user:pass@host)",
    );
  }
}

/** Resolve the chat-completions URL, allowing an OPENCODE_BASE_URL override.
 *  The override may be either the full chat-completions URL or the OpenAI-style
 *  base (".../v1"), in which case "/chat/completions" is appended. */
async function getBaseUrl(): Promise<string> {
  const { getSecret } = await import("../config/secrets");
  const override = await getSecret("OPENCODE_BASE_URL");
  if (!override) return DEFAULT_BASE_URL;
  const trimmed = override.trim();
  assertValidBaseUrlOverride(trimmed);
  const noSlash = trimmed.replace(/\/+$/, "");
  return noSlash.endsWith("/chat/completions")
    ? noSlash
    : `${noSlash}/chat/completions`;
}

/** Strip <think>...</think> reasoning blocks from reasoning models.
 *  If stripping would leave nothing, extract the last thinking block as the response. */
function stripThinkingBlocks(text: string): string {
  const stripped = text.replace(/<think>[\s\S]*?<\/think>\s*/g, "").trim();
  if (stripped) return stripped;

  // All content was inside <think> blocks — extract the last one as fallback
  const matches = [...text.matchAll(/<think>([\s\S]*?)<\/think>/g)];
  if (matches.length > 0) {
    const lastThought = matches[matches.length - 1]![1]?.trim() ?? "";
    if (lastThought) return lastThought;
  }

  return text.trim();
}

interface OpenCodeChoice {
  readonly message: {
    readonly role: "assistant";
    readonly content: string | null;
    readonly tool_calls?: readonly OpenAIToolCall[];
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
): OpenAIMessage[] {
  const result: OpenAIMessage[] = [{ role: "system", content: systemPrompt }];

  for (const msg of messages) {
    if (msg.imageBase64 && msg.imageMimeType && msg.role === "user") {
      const parts: OpenAIContentPart[] = [];
      if (msg.content) {
        parts.push({ type: "text", text: msg.content });
      }
      parts.push({
        type: "image_url",
        image_url: {
          url: `data:${msg.imageMimeType};base64,${msg.imageBase64}`,
        },
      });
      result.push({ role: msg.role, content: parts });
    } else {
      result.push({ role: msg.role, content: msg.content });
    }
  }

  return result;
}

function isRetryableError(err: unknown): boolean {
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
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<OpenCodeResponse> {
  const [apiKey, baseUrl] = await Promise.all([getApiKey(), getBaseUrl()]);

  const res = await fetch(baseUrl, {
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
    // Parse error JSON for a cleaner message when available
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
  const model = options.model || DEFAULT_MODEL;

  log.debug("Sending message to OpenCode Zen", {
    model,
    messageCount: messages.length,
  });

  try {
    const chatBody: Record<string, unknown> = {
      model,
      max_tokens: options.maxOutputTokens ?? 16384,
      messages: toOpenCodeMessages(options.systemPrompt, messages),
    };
    const response = await retryAsync(
      () => callOpenCode(chatBody, options.abortSignal),
      {
        label: "opencode.chat",
        shouldRetry: isRetryableError,
        ...(options.abortSignal ? { signal: options.abortSignal } : {}),
      },
    );

    const rawText = response.choices[0]?.message.content ?? "";
    const text = stripThinkingBlocks(rawText);

    log.info("OpenCode Zen response received", {
      model,
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
    log.error("OpenCode Zen API error", error);
    throw new Error(
      `OpenCode API error: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function agenticChat(
  messages: readonly ConversationMessage[],
  options: AgentOptions,
  registry: ToolRegistry,
  maxIterations: number,
  onProgress?: (event: import("./types").ProgressEvent) => void,
): Promise<AgentResponse> {
  const model = options.model || DEFAULT_MODEL;
  const tools = registry.getOpenAITools();
  const budget = computeToolResultBudget(DEFAULT_CONTEXT_WINDOW);
  const loopDetector = createLoopDetector();

  // Cap pre-loop history — pin first message (user constraints) + recent context
  const recentMessages =
    messages.length > MAX_AGENTIC_HISTORY
      ? [messages[0]!, ...messages.slice(-(MAX_AGENTIC_HISTORY - 1))]
      : messages;

  let loopMessages: OpenAIMessage[] = toOpenCodeMessages(
    options.systemPrompt,
    recentMessages,
  );
  const preLoopCount = loopMessages.length;

  const agentId = options.agentId ?? "default";

  log.debug("Starting agentic chat (OpenCode Zen)", {
    model,
    messageCount: loopMessages.length,
    originalHistorySize: messages.length,
    toolCount: tools.length,
    maxIterations,
    toolResultBudget: budget.maxSingleResultChars,
  });

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let toolUseCount = 0;
  const textParts: string[] = [];

  try {
    for (let iteration = 0; iteration < maxIterations; iteration++) {
      onProgress?.({ type: "iteration", agentId, iteration: iteration + 1 });

      log.debug(
        `OpenCode Zen agentic iteration ${iteration + 1}/${maxIterations}`,
      );

      const requestBody: Record<string, unknown> = {
        model,
        max_tokens: options.maxOutputTokens ?? 16384,
        messages: loopMessages,
      };
      if (tools.length > 0) {
        requestBody.tools = tools;
        requestBody.tool_choice = "auto";
      }

      const response = await retryAsync(
        () => callOpenCode(requestBody, options.abortSignal),
        {
          label: "opencode.agenticChat",
          shouldRetry: isRetryableError,
          ...(options.abortSignal ? { signal: options.abortSignal } : {}),
        },
      );

      const choice = response.choices[0];
      if (!choice) {
        log.warn("OpenCode Zen returned empty choices");
        break;
      }

      if (response.usage) {
        totalInputTokens += response.usage.prompt_tokens;
        totalOutputTokens += response.usage.completion_tokens;
      }

      // Token budget guard: stop runaway agents before they consume too much
      const tokenBudget = Math.round(
        DEFAULT_CONTEXT_WINDOW * TOKEN_BUDGET_MULTIPLIER,
      );
      if (totalInputTokens > tokenBudget) {
        log.warn("Token budget exceeded, force-stopping agentic loop", {
          totalInputTokens,
          tokenBudget,
          iteration: iteration + 1,
          toolUseCount,
        });
        textParts.push(
          `\n\n[Stopped: token budget exceeded (${totalInputTokens} > ${tokenBudget})]`,
        );
        break;
      }

      log.info("OpenCode Zen agentic iteration", {
        iteration: iteration + 1,
        inputTokens: response.usage?.prompt_tokens ?? 0,
        outputTokens: response.usage?.completion_tokens ?? 0,
        messageCount: loopMessages.length,
      });

      if (choice.message.content) {
        textParts.push(choice.message.content);
      }

      if (choice.finish_reason !== "tool_calls") {
        log.info("OpenCode Zen agentic loop complete", {
          totalIterations: iteration + 1,
          totalInputTokens,
          totalOutputTokens,
          toolUseCount,
        });
        break;
      }

      if (iteration === maxIterations - 1) {
        log.warn("OpenCode Zen agentic loop hit max iterations", {
          maxIterations,
          toolUseCount,
        });
        textParts.push("\n\n[Reached maximum tool-use iterations]");
        break;
      }

      const toolCalls = choice.message.tool_calls ?? [];

      // Loop detection — check and record in a single pass
      for (const tc of toolCalls) {
        let parsedInput: unknown;
        try {
          parsedInput = JSON.parse(tc.function.arguments);
        } catch {
          parsedInput = { __raw: tc.function.arguments };
        }
        const detection = loopDetector.check(tc.function.name, parsedInput);
        if (detection.level) {
          log.warn("Tool loop detected (OpenCode Zen)", {
            tool: tc.function.name,
            level: detection.level,
          });
        }
        if (detection.stuck) {
          textParts.push(
            `\n\n[Stopped: agent stuck in loop calling ${tc.function.name}]`,
          );
          return {
            text: stripThinkingBlocks(textParts.join("\n")),
            provider: "opencode",
            toolUseCount,
            usage: {
              inputTokens: totalInputTokens,
              outputTokens: totalOutputTokens,
            },
          };
        }
      }

      toolUseCount += toolCalls.length;
      toolCalls.forEach((tc) =>
        log.info("Executing tool (OpenCode Zen)", {
          name: tc.function.name,
          id: tc.id,
        }),
      );

      const toolResultMessages: OpenAIMessage[] = await Promise.all(
        toolCalls.map(async (tc) => {
          let input: Record<string, unknown>;
          try {
            input = JSON.parse(tc.function.arguments);
          } catch {
            input = {};
          }

          onProgress?.({ type: "tool_start", agentId, tool: tc.function.name });
          const result = await registry.executeTool(tc.function.name, input);
          onProgress?.({ type: "tool_done", agentId, tool: tc.function.name });
          return {
            role: "tool" as const,
            tool_call_id: tc.id,
            content: truncateToolResultToBudget(
              result.output,
              budget.maxSingleResultChars,
            ),
          };
        }),
      );

      const newMessages: OpenAIMessage[] = [
        ...loopMessages,
        {
          role: "assistant",
          content: choice.message.content,
          tool_calls: toolCalls,
        },
        ...toolResultMessages,
      ];
      // 1) Compress old iterations (strip reasoning, summarize results)
      const windowed = compressOldIterationsOpenAI(newMessages, preLoopCount);
      // 2) Prune remaining large tool results progressively
      loopMessages = pruneToolResultsOpenAI(windowed, DEFAULT_CONTEXT_WINDOW);
    }

    return {
      text: stripThinkingBlocks(textParts.join("\n")),
      provider: "opencode",
      toolUseCount,
      usage: {
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
      },
    };
  } catch (error) {
    log.error("OpenCode Zen agentic chat error", error);
    throw new Error(
      `OpenCode agentic error: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
