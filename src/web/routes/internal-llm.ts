/**
 * Internal OpenAI-compatible LLM endpoint.
 *
 * Lets in-network sidecars (e.g. the mem0 service) reuse OpenCrow's existing
 * Anthropic access — the Claude Agent SDK authenticated via the Claude Code
 * OAuth token — instead of requiring a separate hosted API key or a local model.
 *
 * Exposes `POST /internal/v1/chat/completions` shaped like the OpenAI Chat
 * Completions API. Plain completions map straight to `chat()`. OpenAI-style
 * `tools` (function calling, used by mem0's graph relation extraction) are
 * handled with a prompt-based shim: the tool schemas are described to the model
 * and its JSON reply is reshaped back into OpenAI `tool_calls`.
 *
 * Auth: Bearer OPENCROW_INTERNAL_TOKEN (enforced by the mount in app.ts).
 */
import { Hono } from "hono";
import { chat } from "../../agent/chat";
import type { AiProvider, ConversationMessage } from "../../agent/types";
import { createLogger } from "../../logger";

const log = createLogger("internal-llm");

const DEFAULT_MODEL = process.env.OPENCROW_INTERNAL_LLM_MODEL ?? "claude-haiku-4-5-20251001";
const DEFAULT_PROVIDER = (process.env.OPENCROW_INTERNAL_LLM_PROVIDER ?? "agent-sdk") as AiProvider;

/**
 * Hard server-side ceiling on output tokens. The internal proxy shares the
 * dashboard port and any tailnet client holding OPENCROW_INTERNAL_TOKEN can call
 * it, so caller-supplied max_tokens is clamped to this value regardless.
 */
const INTERNAL_MAX_TOKENS = 4096;

/**
 * Only cheap haiku variants are reachable through this proxy. Any other model id
 * (including other claude-* models) is coerced to DEFAULT_MODEL to prevent a
 * tailnet client from running uncapped expensive models on OpenCrow's credentials.
 */
const INTERNAL_MODEL_ALLOWLIST: ReadonlySet<string> = new Set([
  "claude-haiku-4-5-20251001",
  "claude-haiku-4-5",
]);

/** In-flight request cap to blunt burst abuse against the shared LLM credential. */
const MAX_IN_FLIGHT = 4;
let inFlight = 0;

interface OpenAiMessage {
  readonly role: string;
  readonly content: string | null;
}

interface OpenAiTool {
  readonly type?: string;
  readonly function?: {
    readonly name: string;
    readonly description?: string;
    readonly parameters?: unknown;
  };
}

interface CompletionsBody {
  readonly model?: string;
  readonly messages?: readonly OpenAiMessage[];
  readonly max_tokens?: number;
  readonly tools?: readonly OpenAiTool[];
  readonly response_format?: { readonly type?: string };
}

/** Split an OpenAI message list into a system prompt + user/assistant turns. */
function splitMessages(messages: readonly OpenAiMessage[]): {
  systemPrompt: string;
  conversation: ConversationMessage[];
} {
  const systemParts: string[] = [];
  const conversation: ConversationMessage[] = [];
  const ts = Math.floor(Date.now() / 1000);
  for (const m of messages) {
    const content = m.content ?? "";
    if (m.role === "system") {
      systemParts.push(content);
    } else if (m.role === "assistant") {
      conversation.push({ role: "assistant", content, timestamp: ts });
    } else {
      // user / tool / function → treat as user input
      conversation.push({ role: "user", content, timestamp: ts });
    }
  }
  return { systemPrompt: systemParts.join("\n\n"), conversation };
}

/** Strip markdown fences / prose and return the first JSON value as a string. */
function stripToJson(text: string): string {
  const parsed = parseLenientJson(text);
  return parsed === undefined ? text.trim() : JSON.stringify(parsed);
}

/** Strip markdown fences and parse the first JSON value in a string. */
function parseLenientJson(text: string): unknown {
  const cleaned = text
    .replace(/^```(?:json)?/gim, "")
    .replace(/```$/gim, "")
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.search(/[[{]/);
    if (start === -1) return undefined;
    const end = Math.max(cleaned.lastIndexOf("]"), cleaned.lastIndexOf("}"));
    if (end <= start) return undefined;
    try {
      return JSON.parse(cleaned.slice(start, end + 1));
    } catch {
      return undefined;
    }
  }
}

function buildToolInstruction(tools: readonly OpenAiTool[]): string {
  const specs = tools
    .filter((t) => t.function)
    .map((t) => ({
      name: t.function!.name,
      description: t.function!.description ?? "",
      parameters: t.function!.parameters ?? {},
    }));
  return [
    "You can call the following functions. Decide which call(s) the input requires.",
    JSON.stringify(specs, null, 2),
    'Respond with ONLY a JSON array of calls, each shaped {"name": "<function>", "arguments": { ... }}.',
    "Return [] if no call applies. Output JSON only — no prose, no markdown fences.",
  ].join("\n\n");
}

interface ToolCall {
  readonly id: string;
  readonly type: "function";
  readonly function: { readonly name: string; readonly arguments: string };
}

/** Reshape the model's JSON reply into OpenAI tool_calls. */
function toToolCalls(parsed: unknown): ToolCall[] {
  const arr = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
  const calls: ToolCall[] = [];
  arr.forEach((raw, i) => {
    if (!raw || typeof raw !== "object") return;
    const obj = raw as Record<string, unknown>;
    const name = typeof obj.name === "string" ? obj.name : undefined;
    if (!name) return;
    const args = obj.arguments ?? {};
    calls.push({
      id: `call_${i}`,
      type: "function",
      function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) },
    });
  });
  return calls;
}

export function createInternalLlmRoutes(): Hono {
  const app = new Hono();

  app.post("/internal/v1/chat/completions", async (c) => {
    // Concurrency cap: reject bursts before doing any work. Accounting is released
    // in the finally block below.
    if (inFlight >= MAX_IN_FLIGHT) {
      return c.json({ error: { message: "too many concurrent requests" } }, 429);
    }
    inFlight++;

    try {
      let body: CompletionsBody;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: { message: "invalid JSON body" } }, 400);
      }

      const messages = body.messages ?? [];
      if (messages.length === 0) {
        return c.json({ error: { message: "messages is required" } }, 400);
      }

      const { systemPrompt, conversation } = splitMessages(messages);
      const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
      const jsonMode = body.response_format?.type === "json_object";
      const finalSystem =
        (systemPrompt || "You are a precise assistant.") +
        (hasTools ? `\n\n${buildToolInstruction(body.tools!)}` : "") +
        (jsonMode && !hasTools
          ? "\n\nOutput raw JSON only — no markdown code fences, no prose."
          : "");

      // Hard-cap output tokens and restrict the model to the haiku allowlist.
      const maxOutputTokens = Math.min(body.max_tokens ?? 2000, INTERNAL_MAX_TOKENS);
      const model =
        body.model && INTERNAL_MODEL_ALLOWLIST.has(body.model) ? body.model : DEFAULT_MODEL;

      let text: string;
      let usage: { inputTokens: number; outputTokens: number } | undefined;
      try {
        const res = await chat(conversation, {
          systemPrompt: finalSystem,
          model,
          provider: DEFAULT_PROVIDER,
          maxOutputTokens,
          rawSystemPrompt: true,
          usageContext: { channel: "internal", chatId: "mem0", source: "subagent" },
        });
        text = res.text;
        usage = res.usage;
      } catch (err) {
        // Log the detail server-side only; never echo err.message/stack/token
        // back to the (tailnet) caller.
        log.error("internal completion failed", { err });
        return c.json({ error: { message: "internal completion failed" } }, 502);
      }

      const created = Math.floor(Date.now() / 1000);
      const base = {
        id: `chatcmpl-${created}`,
        object: "chat.completion",
        created,
        model: DEFAULT_MODEL,
        usage: {
          prompt_tokens: usage?.inputTokens ?? 0,
          completion_tokens: usage?.outputTokens ?? 0,
          total_tokens: (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0),
        },
      };

      if (hasTools) {
        const toolCalls = toToolCalls(parseLenientJson(text));
        return c.json({
          ...base,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: null, tool_calls: toolCalls },
              finish_reason: "tool_calls",
            },
          ],
        });
      }

      return c.json({
        ...base,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: jsonMode ? stripToJson(text) : text },
            finish_reason: "stop",
          },
        ],
      });
    } finally {
      inFlight--;
    }
  });

  return app;
}
