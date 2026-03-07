import type {
  AgentOptions,
  AgentResponse,
  ConversationMessage,
  OpenAIMessage,
  OpenAIToolCall,
} from "./types";
import type { ToolRegistry, OpenAITool } from "../tools/registry";
import type { ToolDefinition } from "../tools/types";
import { retryAsync } from "../infra/retry";
import { createLogger } from "../logger";
import { createLoopDetector } from "./loop-detection";
import {
  computeToolResultBudget,
  truncateToolResult as truncateToolResultToBudget,
} from "./tool-result-budget";
import { compressOldIterationsOpenAI } from "./sliding-window-openai";
import { pruneToolResultsOpenAI } from "./context-pruning-openai";

const log = createLogger("openrouter");

const BASE_URL = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_CONTEXT_WINDOW = 180_000;
const TOKEN_BUDGET_MULTIPLIER = 1.5;
const MAX_AGENTIC_HISTORY = 15;

function getApiKey(): string {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) {
    throw new Error("OPENROUTER_API_KEY environment variable is not set");
  }
  return key;
}

/** Strip <think>...</think> reasoning blocks from models like DeepSeek R1.
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

interface OpenRouterChoice {
  readonly message: {
    readonly role: "assistant";
    readonly content: string | null;
    readonly tool_calls?: readonly OpenAIToolCall[];
  };
  readonly finish_reason: string;
}

interface OpenRouterResponse {
  readonly choices: readonly OpenRouterChoice[];
  readonly usage?: {
    readonly prompt_tokens: number;
    readonly completion_tokens: number;
  };
}

function toOpenRouterMessages(
  systemPrompt: string,
  messages: readonly ConversationMessage[],
): OpenAIMessage[] {
  const result: OpenAIMessage[] = [{ role: "system", content: systemPrompt }];

  for (const msg of messages) {
    result.push({ role: msg.role, content: msg.content });
  }

  return result;
}

/** Build the OpenRouter `reasoning` config from agent options. */
function buildReasoningConfig(
  options: Pick<AgentOptions, "reasoning" | "modelParams">,
): Record<string, unknown> | null {
  if (options.reasoning === true) {
    const effort = options.modelParams?.effort ?? "high";
    const cfg: Record<string, unknown> = { effort };
    if (options.modelParams?.thinkingBudget) {
      cfg.max_tokens = options.modelParams.thinkingBudget;
    }
    return cfg;
  }
  if (options.reasoning === false) {
    return { effort: "none" };
  }
  return null;
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

async function callOpenRouter(
  body: Record<string, unknown>,
): Promise<OpenRouterResponse> {
  const apiKey = getApiKey();

  const res = await fetch(BASE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "HTTP-Referer": "https://github.com/gokhantos/opencrow",
      "X-Title": "OpenCrow AI Assistant",
    },
    body: JSON.stringify(body),
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
    throw new Error(`OpenRouter API error (${res.status}): ${detail}`);
  }

  return res.json() as Promise<OpenRouterResponse>;
}

export async function chat(
  messages: readonly ConversationMessage[],
  options: AgentOptions,
): Promise<AgentResponse> {
  log.debug("Sending message to OpenRouter", {
    model: options.model,
    messageCount: messages.length,
  });

  try {
    const chatBody: Record<string, unknown> = {
      model: options.model,
      max_tokens: options.maxOutputTokens ?? 16384,
      messages: toOpenRouterMessages(options.systemPrompt, messages),
    };
    const reasoning = buildReasoningConfig(options);
    if (reasoning) chatBody.reasoning = reasoning;
    const response = await retryAsync(() => callOpenRouter(chatBody), {
      label: "openrouter.chat",
      shouldRetry: isRetryableError,
    });

    const rawText = response.choices[0]?.message.content ?? "";
    const text = stripThinkingBlocks(rawText);

    log.info("OpenRouter response received", {
      model: options.model,
      inputTokens: response.usage?.prompt_tokens,
      outputTokens: response.usage?.completion_tokens,
    });

    return {
      text,
      provider: "openrouter",
      usage: response.usage
        ? {
            inputTokens: response.usage.prompt_tokens,
            outputTokens: response.usage.completion_tokens,
          }
        : undefined,
    };
  } catch (error) {
    log.error("OpenRouter API error", error);
    throw new Error(
      `OpenRouter API error: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Tool names that must always be available regardless of semantic score. */
const CORE_TOOL_NAMES = new Set([
  "search_memory",
  "send_message",
  "bash",
  "read_file",
  "write_file",
  "edit_file",
]);

/** Extract the last user message text from conversation history. */
function extractLastUserMessage(
  messages: readonly ConversationMessage[],
): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg && msg.role === "user" && typeof msg.content === "string") {
      return msg.content;
    }
  }
  return null;
}

/** Build a filtered OpenAI tools list using semantic routing when available. */
async function buildFilteredTools(
  registry: ToolRegistry,
  lastUserMessage: string | null,
  semanticLimit: number,
): Promise<readonly OpenAITool[]> {
  if (!lastUserMessage) {
    return registry.getOpenAITools();
  }

  let filteredDefs: readonly ToolDefinition[];
  try {
    filteredDefs = await registry.getRelevantToolsForMessage(
      lastUserMessage,
      semanticLimit,
    );
  } catch (err) {
    log.warn("Semantic tool routing failed, using full tool list", { error: String(err) });
    return registry.getOpenAITools();
  }

  // Always include core tools
  const filteredNames = new Set(filteredDefs.map((t) => t.name));
  const allDefs = registry.definitions;
  const coreAdded = allDefs.filter(
    (t) => CORE_TOOL_NAMES.has(t.name) && !filteredNames.has(t.name),
  );

  const finalDefs = [...filteredDefs, ...coreAdded];

  return finalDefs.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }));
}

const SEMANTIC_TOOL_LIMIT = 25;

export async function agenticChat(
  messages: readonly ConversationMessage[],
  options: AgentOptions,
  registry: ToolRegistry,
  maxIterations: number,
  onProgress?: (event: import("./types").ProgressEvent) => void,
): Promise<AgentResponse> {
  const lastUserMessage = extractLastUserMessage(messages);
  const tools = await buildFilteredTools(
    registry,
    lastUserMessage,
    SEMANTIC_TOOL_LIMIT,
  );
  const budget = computeToolResultBudget(DEFAULT_CONTEXT_WINDOW);
  const loopDetector = createLoopDetector();

  // Cap pre-loop history — pin first message (user constraints) + recent context
  const recentMessages =
    messages.length > MAX_AGENTIC_HISTORY
      ? [messages[0]!, ...messages.slice(-(MAX_AGENTIC_HISTORY - 1))]
      : messages;

  let loopMessages: OpenAIMessage[] = toOpenRouterMessages(
    options.systemPrompt,
    recentMessages,
  );
  const preLoopCount = loopMessages.length;

  const agentId = options.agentId ?? "default";

  log.debug("Starting agentic chat (OpenRouter)", {
    model: options.model,
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
        `OpenRouter agentic iteration ${iteration + 1}/${maxIterations}`,
      );

      const requestBody: Record<string, unknown> = {
        model: options.model,
        max_tokens: options.maxOutputTokens ?? 16384,
        messages: loopMessages,
      };
      if (tools.length > 0) {
        requestBody.tools = tools;
        requestBody.tool_choice = "auto";
      }
      const iterReasoning = buildReasoningConfig(options);
      if (iterReasoning) requestBody.reasoning = iterReasoning;

      const response = await retryAsync(() => callOpenRouter(requestBody), {
        label: "openrouter.agenticChat",
        shouldRetry: isRetryableError,
      });

      const choice = response.choices[0];
      if (!choice) {
        log.warn("OpenRouter returned empty choices");
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

      log.info("OpenRouter agentic iteration", {
        iteration: iteration + 1,
        inputTokens: response.usage?.prompt_tokens ?? 0,
        outputTokens: response.usage?.completion_tokens ?? 0,
        messageCount: loopMessages.length,
      });

      if (choice.message.content) {
        textParts.push(choice.message.content);
      }

      if (choice.finish_reason !== "tool_calls") {
        log.info("OpenRouter agentic loop complete", {
          totalIterations: iteration + 1,
          totalInputTokens,
          totalOutputTokens,
          toolUseCount,
        });
        break;
      }

      if (iteration === maxIterations - 1) {
        log.warn("OpenRouter agentic loop hit max iterations", {
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
          log.warn("Tool loop detected (OpenRouter)", {
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
            provider: "openrouter",
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
        log.info("Executing tool (OpenRouter)", {
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
      provider: "openrouter",
      toolUseCount,
      usage: {
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
      },
    };
  } catch (error) {
    log.error("OpenRouter agentic chat error", error);
    throw new Error(
      `OpenRouter agentic error: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
