import {
  chat as chatOpenRouter,
  agenticChat as agenticChatOpenRouter,
} from "./openrouter";
import {
  chat as chatAgentSdk,
  agenticChat as agenticChatAgentSdk,
  withAlibabaEnv,
} from "./agent-sdk";
import { chat as chatAlibabaDirect } from "./alibaba-direct";
import { chat as chatAnthropicDirect } from "./anthropic-direct";
import type { AgentOptions, AgentResponse, ConversationMessage } from "./types";
import { recordTokenUsage } from "../store/token-usage";
import { createLogger } from "../logger";
import { createCallDeadline, LlmCallTimeoutError } from "./llm-timeout";

const log = createLogger("agent");

function persistUsage(response: AgentResponse, options: AgentOptions): void {
  if (!response.usage) return;

  const ctx = options.usageContext;
  recordTokenUsage({
    id: crypto.randomUUID(),
    agentId: options.agentId ?? "default",
    model: options.model,
    provider: response.provider,
    channel: ctx?.channel ?? "",
    chatId: ctx?.chatId ?? "",
    source: ctx?.source ?? "message",
    inputTokens: response.usage.inputTokens,
    outputTokens: response.usage.outputTokens,
    cacheReadTokens: response.usage.cacheReadTokens ?? 0,
    cacheCreationTokens: response.usage.cacheCreationTokens ?? 0,
    costUsd: response.usage.costUsd ?? 0,
    durationMs: response.usage.durationMs ?? 0,
    toolUseCount: response.toolUseCount ?? 0,
    createdAt: Math.floor(Date.now() / 1000),
  }).catch((err) => log.error("Failed to record token usage", { error: err }));
}

/**
 * Public entry point for every LLM call.
 *
 * Wraps the provider dispatch with a per-call timeout (see ./llm-timeout): the
 * caller's AbortSignal (if any) is combined with an internal deadline so a hung
 * provider request can't wedge the caller indefinitely. On timeout we throw a
 * typed {@link LlmCallTimeoutError} so existing per-step/per-agent error
 * handling treats it as a normal failure instead of hanging.
 */
export async function chat(
  messages: readonly ConversationMessage[],
  options: AgentOptions,
): Promise<AgentResponse> {
  const deadline = createCallDeadline(options.abortSignal, options.callTimeoutMs);
  const dispatchOptions: AgentOptions = {
    ...options,
    abortSignal: deadline.signal,
  };

  try {
    return await dispatchChat(messages, dispatchOptions);
  } catch (error) {
    // If our deadline fired, surface a clear typed timeout regardless of how
    // the underlying provider reported the abort (DOMException, generic Error,
    // wrapped "Agent SDK error: …", etc.).
    if (deadline.timedOut()) {
      log.warn("LLM call timed out", {
        agentId: options.agentId,
        model: options.model,
        timeoutMs: deadline.timeoutMs,
      });
      throw new LlmCallTimeoutError(deadline.timeoutMs);
    }
    throw error;
  } finally {
    deadline.clear();
  }
}

async function dispatchChat(
  messages: readonly ConversationMessage[],
  options: AgentOptions,
): Promise<AgentResponse> {
  const requestedProvider = options.provider ?? "anthropic";
  // Anthropic direct (pi-ai) doesn't support tools — fall back to agent-sdk for agentic calls
  const provider =
    requestedProvider === "anthropic" && options.toolsEnabled && options.toolRegistry
      ? "agent-sdk"
      : requestedProvider;
  const maxIterations = options.maxToolIterations ?? 100;

  let response: AgentResponse;

  if (provider === "openrouter") {
    if (options.toolsEnabled && options.toolRegistry) {
      log.debug("Routing to agentic OpenRouter (tools enabled)", {
        agentId: options.agentId,
        model: options.model,
      });
      response = await agenticChatOpenRouter(
        messages,
        options,
        options.toolRegistry,
        maxIterations,
        options.onProgress,
      );
    } else {
      log.debug("Routing to OpenRouter", {
        agentId: options.agentId,
        model: options.model,
      });
      response = await chatOpenRouter(messages, options);
    }
  } else if (provider === "agent-sdk") {
    if (options.toolsEnabled && options.toolRegistry) {
      log.debug("Routing to agentic Agent SDK (tools enabled)", {
        agentId: options.agentId,
        model: options.model,
      });
      response = await agenticChatAgentSdk(
        messages,
        options,
        options.toolRegistry,
        maxIterations,
        options.onProgress,
      );
    } else {
      log.debug("Routing to Agent SDK", {
        agentId: options.agentId,
        model: options.model,
      });
      response = await chatAgentSdk(messages, options);
    }
  } else if (provider === "alibaba") {
    if (options.toolsEnabled && options.toolRegistry) {
      // Agentic Alibaba calls still route through Agent SDK with env shim
      log.debug("Routing to agentic Alibaba ModelStudio (tools enabled)", {
        agentId: options.agentId,
        model: options.model,
      });
      response = await withAlibabaEnv(() =>
        agenticChatAgentSdk(
          messages,
          options,
          options.toolRegistry!,
          maxIterations,
          options.onProgress,
        ),
      );
      // Tag as alibaba provider in the response
      response = { ...response, provider: "alibaba" as const };
    } else {
      // Non-agentic Alibaba calls use direct HTTP to the OpenAI-compatible endpoint
      log.debug("Routing to Alibaba direct (no tools)", {
        agentId: options.agentId,
        model: options.model,
      });
      response = await chatAlibabaDirect(messages, options);
    }
  } else if (provider === "anthropic") {
    log.debug("Routing to Anthropic direct", {
      agentId: options.agentId,
      model: options.model,
    });
    response = await chatAnthropicDirect(messages, options);
  } else {
    throw new Error(`Unknown AI provider: ${provider}`);
  }

  persistUsage(response, options);
  return response;
}
