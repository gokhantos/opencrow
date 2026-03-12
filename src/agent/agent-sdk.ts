import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
  AgentOptions,
  AgentResponse,
  ConversationMessage,
  ProgressEvent,
} from "./types";
import type { ToolRegistry } from "../tools/registry";
import { createOpenCrowMcpServer } from "./mcp-bridge";
import { createLogger } from "../logger";
import {
  buildPromptWithHistory,
  enrichPromptWithContext,
} from "./prompt-context";
import {
  buildThinkingOptions,
  buildSystemPromptOption,
  buildMcpServers,
  buildDisallowedTools,
  buildSessionOptions,
  buildStderrHandler,
} from "./sdk-options";
import {
  type SdkUsage,
  createEmptyUsage,
  extractUsageFromResult,
} from "./sdk-usage";
import {
  formatToolProgress,
  truncate,
  summarizeThinking,
  MAX_DETAIL_LENGTH,
  MAX_THINKING_SUMMARY,
} from "./sdk-progress";



const log = createLogger("agent-sdk");

/**
 * Wrap an AbortSignal into an AbortController that the SDK expects.
 * If the signal is already aborted, the controller is aborted immediately.
 */
function abortSignalToController(signal: AbortSignal): AbortController {
  const controller = new AbortController();
  if (signal.aborted) {
    controller.abort(signal.reason);
  } else {
    signal.addEventListener("abort", () => controller.abort(signal.reason), {
      once: true,
    });
  }
  return controller;
}

const ALIBABA_DEFAULT_BASE_URL =
  "https://coding-intl.dashscope.aliyuncs.com/apps/anthropic";

/**
 * Capture session_id from the first SDK message that has one.
 */
function captureSessionId(
  message: Record<string, unknown>,
  captured: { done: boolean },
  callback?: (sessionId: string) => void,
): void {
  if (captured.done || !callback) return;
  if ("session_id" in message && message.session_id) {
    captured.done = true;
    callback(message.session_id as string);
  }
}

/**
 * Temporarily swap ANTHROPIC_API_KEY and ANTHROPIC_BASE_URL to Alibaba
 * ModelStudio credentials for the duration of fn(). Restores originals after.
 * Safe because each agent process runs in its own OS process.
 */
export async function withAlibabaEnv<T>(fn: () => Promise<T>): Promise<T> {
  const origKey = process.env.ANTHROPIC_API_KEY;
  const origUrl = process.env.ANTHROPIC_BASE_URL;

  const { getSecret } = await import("../config/secrets");
  const alibabaKey = await getSecret("ALIBABA_API_KEY");
  if (!alibabaKey) {
    throw new Error("ALIBABA_API_KEY is not set");
  }

  const alibabaBaseUrl =
    (await getSecret("ALIBABA_BASE_URL")) ?? ALIBABA_DEFAULT_BASE_URL;

  process.env.ANTHROPIC_API_KEY = alibabaKey;
  process.env.ANTHROPIC_BASE_URL = alibabaBaseUrl;

  try {
    return await fn();
  } finally {
    // Restore originals
    if (origKey !== undefined) {
      process.env.ANTHROPIC_API_KEY = origKey;
    } else {
      delete process.env.ANTHROPIC_API_KEY;
    }
    if (origUrl !== undefined) {
      process.env.ANTHROPIC_BASE_URL = origUrl;
    } else {
      delete process.env.ANTHROPIC_BASE_URL;
    }
  }
}

/**
 * Simple chat — no tools, single turn.
 * Works like CLI: new session or resume existing one.
 */
export async function chat(
  messages: readonly ConversationMessage[],
  options: AgentOptions,
): Promise<AgentResponse> {
  const prompt = buildPromptWithHistory(messages);
  const enrichedPrompt = await enrichPromptWithContext(
    prompt,
    options.sdkSessionId,
  );

  log.debug("Agent SDK chat", {
    model: options.model,
    resuming: Boolean(options.sdkSessionId),
    hasCrossSessionContext: options.sdkSessionId !== undefined,
  });

  try {
    let resultText = "";
    const sessionCapture = { done: false };
    let usage: SdkUsage = createEmptyUsage();

    const abortController = options.abortSignal
      ? abortSignalToController(options.abortSignal)
      : undefined;

    const agentId = options.agentId ?? "default";

    for await (const message of query({
      prompt: enrichedPrompt,
      options: {
        model: options.model,
        systemPrompt: buildSystemPromptOption(options.systemPrompt),
        cwd: options.cwd ?? process.cwd(),
        maxTurns: 1,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        stderr: buildStderrHandler(agentId),
        ...buildThinkingOptions(options),
        ...buildSessionOptions(),
        ...(abortController ? { abortController } : {}),
        ...(options.sdkHooks ? { hooks: options.sdkHooks } : {}),
        ...(options.sdkSessionId ? { resume: options.sdkSessionId } : {}),
      },
    })) {
      captureSessionId(
        message as Record<string, unknown>,
        sessionCapture,
        options.onSdkSessionId,
      );

      if (message.type === "result") {
        usage = extractUsageFromResult(
          message as Record<string, unknown>,
          usage,
        );

        if (message.subtype === "success") {
          resultText = message.result;
        }
      }
    }

    log.info("Agent SDK chat complete", {
      model: options.model,
      resultLength: resultText.length,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      costUsd: usage.costUsd,
    });

    return {
      text: resultText,
      provider: "agent-sdk",
      usage: { ...usage },
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log.error("Agent SDK chat error", { error: msg });
    throw new Error(`Agent SDK error: ${msg}`);
  }
}

interface QueryRunState {
  readonly resultText: string;
  readonly lastAssistantText: string;
  readonly toolUseCount: number;
  readonly sessionId: string | undefined;
  readonly usage: SdkUsage;
}

/**
 * Run a single SDK query() call and collect results.
 * Returns the accumulated state so the caller can decide to continue.
 */
async function runQuery(
  prompt: string,
  options: AgentOptions,
  maxTurns: number,
  opencrowMcp: ReturnType<typeof createOpenCrowMcpServer>,
  agentId: string,
  sessionId: string | undefined,
  prev: QueryRunState,
  onProgress?: (event: ProgressEvent) => void,
): Promise<QueryRunState> {
  const enrichedPrompt = await enrichPromptWithContext(prompt, sessionId);

  let resultText = "";
  let lastAssistantText = prev.lastAssistantText;
  let toolUseCount = prev.toolUseCount;
  const pendingToolNames: string[] = [];
  let capturedSessionId = sessionId;
  const sessionCapture = { done: Boolean(sessionId) };
  let usage = prev.usage;

  const abortController = options.abortSignal
    ? abortSignalToController(options.abortSignal)
    : undefined;

  for await (const message of query({
    prompt: enrichedPrompt,
    options: {
      model: options.model,
      systemPrompt: buildSystemPromptOption(options.systemPrompt),
      cwd: options.cwd ?? process.cwd(),
      maxTurns,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      mcpServers: buildMcpServers(options, opencrowMcp),
      disallowedTools: buildDisallowedTools(options),
      stderr: buildStderrHandler(agentId),
      ...buildThinkingOptions(options),
      ...buildSessionOptions(),
      ...(abortController ? { abortController } : {}),
      ...(options.sdkHooks ? { hooks: options.sdkHooks } : {}),
      ...(sessionId ? { resume: sessionId } : {}),
    },
  })) {
    // Capture session ID for resume
    if (!sessionCapture.done) {
      const msg = message as Record<string, unknown>;
      if ("session_id" in msg && msg.session_id) {
        sessionCapture.done = true;
        capturedSessionId = msg.session_id as string;
        options.onSdkSessionId?.(capturedSessionId);
      }
    }

    // Track tool usage and emit progress from assistant messages
    if (message.type === "assistant") {
      const msg = message as Record<string, unknown>;
      const content = (msg.message as Record<string, unknown>)?.content as
        | ReadonlyArray<Record<string, unknown>>
        | undefined;
      if (content) {
        let hasToolUseInMessage = false;
        for (const block of content) {
          if (block.type === "thinking" && block.thinking) {
            onProgress?.({
              type: "thinking",
              agentId,
              summary: summarizeThinking(String(block.thinking)),
            });
          } else if (block.type === "text" && block.text) {
            lastAssistantText = String(block.text);
            onProgress?.({
              type: "text_output",
              agentId,
              preview: truncate(lastAssistantText, MAX_THINKING_SUMMARY),
            });
          } else if (block.type === "tool_use") {
            hasToolUseInMessage = true;
            toolUseCount++;
            const toolName = block.name as string;
            pendingToolNames.push(toolName);
            const toolInput = (block.input as Record<string, unknown>) ?? {};
            const display = formatToolProgress(toolName, toolInput);
            onProgress?.({ type: "tool_start", agentId, tool: display });
          }
        }
        // Text in a message that also contains tool_use is planning/reasoning
        // text, not a final user-facing response — clear it so auto-continuation
        // can kick in and request a proper summary.
        if (hasToolUseInMessage) {
          lastAssistantText = "";
        }
      }
    }

    if (message.type === "tool_use_summary") {
      const msg = message as Record<string, unknown>;
      onProgress?.({
        type: "tool_done",
        agentId,
        tool: truncate(String(msg.summary ?? ""), MAX_THINKING_SUMMARY),
        result: truncate(String(msg.summary ?? ""), MAX_DETAIL_LENGTH),
      });
    }

    if (message.type === "user") {
      const msg = message as Record<string, unknown>;
      const userContent = (msg.message as Record<string, unknown>)?.content as
        | ReadonlyArray<Record<string, unknown>>
        | undefined;
      if (userContent) {
        for (const block of userContent) {
          if (block.type === "tool_result") {
            const isErr = block.is_error === true;
            const resultContent = block.content;
            let resultStr = "";
            if (typeof resultContent === "string") {
              resultStr = resultContent;
            } else if (Array.isArray(resultContent)) {
              const textBlock = resultContent.find(
                (b: Record<string, unknown>) => b.type === "text",
              );
              if (textBlock)
                resultStr = String(
                  (textBlock as Record<string, unknown>).text ?? "",
                );
            }
            const matchedToolName = pendingToolNames.shift() ?? "unknown";
            onProgress?.({
              type: "tool_done",
              agentId,
              tool: matchedToolName,
              result: truncate(resultStr, MAX_DETAIL_LENGTH),
              isError: isErr,
            });
          }
        }
      }
    }

    if (
      message.type === "system" &&
      (message as Record<string, unknown>).subtype === "task_started"
    ) {
      const msg = message as Record<string, unknown>;
      onProgress?.({
        type: "subagent_start",
        agentId,
        childAgent: truncate(String(msg.description ?? "agent"), 40),
        task: truncate(String(msg.description ?? ""), MAX_DETAIL_LENGTH),
      });
    }

    if (
      message.type === "system" &&
      (message as Record<string, unknown>).subtype === "task_notification"
    ) {
      const msg = message as Record<string, unknown>;
      onProgress?.({
        type: "subagent_done",
        agentId,
        childAgent: truncate(String(msg.summary ?? "agent"), 40),
      });
    }

    if (message.type === "result") {
      usage = extractUsageFromResult(message as Record<string, unknown>, usage);

      if (message.subtype === "success") {
        resultText = message.result;
        // Don't emit "complete" here — agenticChat emits it once after
        // all auto-continuations finish to avoid premature "Done" in the log.
      }
    }
  }

  return {
    resultText,
    lastAssistantText,
    toolUseCount,
    sessionId: capturedSessionId,
    usage,
  };
}

/**
 * Agentic chat — with tools via in-process MCP server.
 * Auto-continues when the agent exits mid-task with no text response.
 */
export async function agenticChat(
  messages: readonly ConversationMessage[],
  options: AgentOptions,
  registry: ToolRegistry,
  maxIterations: number,
  onProgress?: (event: ProgressEvent) => void,
): Promise<AgentResponse> {
  const prompt = buildPromptWithHistory(messages);
  const agentId = options.agentId ?? "default";
  const opencrowMcp = createOpenCrowMcpServer(registry);

  log.debug("Agent SDK agentic chat", {
    model: options.model,
    maxTurns: maxIterations,
    resuming: Boolean(options.sdkSessionId),
  });

  try {
    let state: QueryRunState = {
      resultText: "",
      lastAssistantText: "",
      toolUseCount: 0,
      sessionId: options.sdkSessionId,
      usage: createEmptyUsage(),
    };

    // Initial query
    state = await runQuery(
      prompt,
      options,
      maxIterations,
      opencrowMcp,
      agentId,
      state.sessionId,
      state,
      onProgress,
    );

    // Auto-continue: if agent exited with tool work but no text response,
    // resume the session asking for a summary.
    const MAX_CONTINUATIONS = 5;
    const abortSignal = options.abortSignal;
    let continues = 0;
    while (
      !state.resultText.trim() &&
      !state.lastAssistantText.trim() &&
      state.toolUseCount > 0 &&
      state.sessionId &&
      !abortSignal?.aborted &&
      continues < MAX_CONTINUATIONS
    ) {
      continues++;
      log.info("Auto-continuing (empty result after tool use)", {
        attempt: continues,
        toolUseCount: state.toolUseCount,
        sessionId: state.sessionId,
      });

      // First attempt: gentle continue. After that: explicitly ask for summary.
      const continuePrompt =
        continues <= 1
          ? "Continue"
          : "Please provide a brief summary of what you've done and the results.";

      state = await runQuery(
        continuePrompt,
        options,
        maxIterations,
        opencrowMcp,
        agentId,
        state.sessionId,
        state,
        onProgress,
      );
    }

    // Fall back to last assistant text if result is still empty
    const finalText = state.resultText || state.lastAssistantText;

    // Emit "complete" once — after all auto-continuations are done
    onProgress?.({
      type: "complete",
      agentId,
      durationMs: 0,
      toolUseCount: state.toolUseCount,
    });

    log.info("Agent SDK agentic chat complete", {
      model: options.model,
      resultLength: finalText.length,
      usedFallback: !state.resultText && !!state.lastAssistantText,
      autoContinues: continues,
      toolUseCount: state.toolUseCount,
    });

    return {
      text: finalText,
      provider: "agent-sdk",
      toolUseCount: state.toolUseCount,
      usage: { ...state.usage },
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;
    log.error("Agent SDK agentic chat error", {
      agentId,
      model: options.model,
      provider: options.provider ?? "agent-sdk",
      error: msg,
      stack,
    });
    throw new Error(`Agent SDK agentic error: ${msg}`);
  }
}

// Re-export internal functions for backward compatibility with tests
export { formatToolProgress, truncate, summarizeThinking, shortenPath } from "./sdk-progress";
export { buildThinkingOptions, buildSystemPromptOption, buildDisallowedTools, buildSessionOptions } from "./sdk-options";
export { buildPromptWithHistory, lastUserMessage } from "./prompt-context";
