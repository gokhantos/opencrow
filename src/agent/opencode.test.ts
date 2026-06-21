import { test, expect, describe, afterEach, beforeEach } from "bun:test";
import { chat, agenticChat } from "./opencode";
import type { AgentOptions, ConversationMessage } from "./types";
import type { ToolRegistry } from "../tools/registry";

// ─── Test scaffolding ────────────────────────────────────────────────────────
// These tests never hit the network: globalThis.fetch is replaced with a stub
// that records the outgoing request and returns a canned OpenAI-compatible body.
// The API key is provided via process.env — getSecret() falls back to env when
// the DB lookup fails (which it does in the unit lane, no DB).

const realFetch = globalThis.fetch;
const realKey = process.env.OPENCODE_API_KEY;
const realBaseUrl = process.env.OPENCODE_BASE_URL;

interface CapturedRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function stubFetch(
  responseBody: unknown,
  capture: { last?: CapturedRequest },
  status = 200,
): void {
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = typeof input === "string" ? input : input.toString();
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = init?.body
      ? (JSON.parse(init.body as string) as Record<string, unknown>)
      : {};
    capture.last = { url, headers, body };
    return new Response(JSON.stringify(responseBody), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

const baseOptions: AgentOptions = {
  systemPrompt: "You are a test assistant.",
  model: "deepseek-v4-flash",
};

const userMessages: readonly ConversationMessage[] = [
  { role: "user", content: "Hello there", timestamp: 0 },
];

beforeEach(() => {
  process.env.OPENCODE_API_KEY = "test-key-123";
  delete process.env.OPENCODE_BASE_URL;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (realKey === undefined) delete process.env.OPENCODE_API_KEY;
  else process.env.OPENCODE_API_KEY = realKey;
  if (realBaseUrl === undefined) delete process.env.OPENCODE_BASE_URL;
  else process.env.OPENCODE_BASE_URL = realBaseUrl;
});

// ─── chat() ──────────────────────────────────────────────────────────────────

describe("opencode chat()", () => {
  test("sends model, messages and bearer auth to the Zen endpoint", async () => {
    const capture: { last?: CapturedRequest } = {};
    stubFetch(
      {
        choices: [
          { message: { role: "assistant", content: "Hi!" }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 3 },
      },
      capture,
    );

    const res = await chat(userMessages, baseOptions);

    expect(res.text).toBe("Hi!");
    expect(res.provider).toBe("opencode");
    expect(res.usage).toEqual({ inputTokens: 10, outputTokens: 3 });

    const req = capture.last!;
    expect(req.url).toBe("https://opencode.ai/zen/go/v1/chat/completions");
    expect(req.headers.Authorization).toBe("Bearer test-key-123");
    expect(req.body.model).toBe("deepseek-v4-flash");
    const messages = req.body.messages as Array<{ role: string; content: string }>;
    expect(messages[0]).toEqual({
      role: "system",
      content: "You are a test assistant.",
    });
    expect(messages[1]).toEqual({ role: "user", content: "Hello there" });
    // Plain chat must NOT advertise tools.
    expect(req.body.tools).toBeUndefined();
  });

  test("defaults the model when none is provided", async () => {
    const capture: { last?: CapturedRequest } = {};
    stubFetch(
      {
        choices: [
          { message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
        ],
      },
      capture,
    );

    await chat(userMessages, { ...baseOptions, model: "" });

    expect(capture.last!.body.model).toBe("deepseek-v4-flash");
  });

  test("strips <think> reasoning blocks from the response", async () => {
    const capture: { last?: CapturedRequest } = {};
    stubFetch(
      {
        choices: [
          {
            message: {
              role: "assistant",
              content: "<think>reasoning here</think>Final answer",
            },
            finish_reason: "stop",
          },
        ],
      },
      capture,
    );

    const res = await chat(userMessages, baseOptions);
    expect(res.text).toBe("Final answer");
  });

  test("honours an OPENCODE_BASE_URL override (base form)", async () => {
    process.env.OPENCODE_BASE_URL = "https://proxy.example.com/v1";
    const capture: { last?: CapturedRequest } = {};
    stubFetch(
      {
        choices: [
          { message: { role: "assistant", content: "x" }, finish_reason: "stop" },
        ],
      },
      capture,
    );

    await chat(userMessages, baseOptions);
    expect(capture.last!.url).toBe(
      "https://proxy.example.com/v1/chat/completions",
    );
  });

  test("rejects an OPENCODE_BASE_URL with a non-http(s) scheme", async () => {
    process.env.OPENCODE_BASE_URL = "file:///etc/passwd";
    globalThis.fetch = (async () => {
      throw new Error("network must not be called");
    }) as unknown as typeof fetch;
    await expect(chat(userMessages, baseOptions)).rejects.toThrow(
      /http\(s\) scheme/,
    );
  });

  test("rejects an OPENCODE_BASE_URL with embedded credentials", async () => {
    process.env.OPENCODE_BASE_URL = "https://user:pass@evil.example.com/v1";
    globalThis.fetch = (async () => {
      throw new Error("network must not be called");
    }) as unknown as typeof fetch;
    await expect(chat(userMessages, baseOptions)).rejects.toThrow(
      /embedded credentials/,
    );
  });

  test("throws a clear error when the API key is missing", async () => {
    delete process.env.OPENCODE_API_KEY;
    // fetch should never be reached; make it explode if it is.
    globalThis.fetch = (async () => {
      throw new Error("network must not be called");
    }) as unknown as typeof fetch;

    await expect(chat(userMessages, baseOptions)).rejects.toThrow(
      /OPENCODE_API_KEY is not set/,
    );
  });

  test("wraps non-2xx responses in a descriptive error", async () => {
    const capture: { last?: CapturedRequest } = {};
    stubFetch({ error: { message: "model not found" } }, capture, 404);

    await expect(chat(userMessages, baseOptions)).rejects.toThrow(
      /model not found/,
    );
  });
});

// ─── agenticChat() ───────────────────────────────────────────────────────────

function makeRegistry(
  toolResult: string,
  recordedCalls: Array<{ name: string; input: Record<string, unknown> }>,
): ToolRegistry {
  return {
    getOpenAITools: () => [
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Get weather",
          parameters: { type: "object", properties: {} },
        },
      },
    ],
    executeTool: async (name: string, input: Record<string, unknown>) => {
      recordedCalls.push({ name, input });
      return { output: toolResult, isError: false };
    },
  } as unknown as ToolRegistry;
}

describe("opencode agenticChat()", () => {
  test("advertises tools, executes a tool_call, then returns final text", async () => {
    const recordedCalls: Array<{ name: string; input: Record<string, unknown> }> =
      [];
    const registry = makeRegistry("sunny, 25C", recordedCalls);

    // First response: a tool call. Second response: final text.
    const responses = [
      {
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: {
                    name: "get_weather",
                    arguments: JSON.stringify({ city: "Paris" }),
                  },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 20, completion_tokens: 5 },
      },
      {
        choices: [
          {
            message: { role: "assistant", content: "It is sunny and 25C." },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 30, completion_tokens: 8 },
      },
    ];

    const captured: CapturedRequest[] = [];
    let call = 0;
    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = typeof input === "string" ? input : input.toString();
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const body = init?.body
        ? (JSON.parse(init.body as string) as Record<string, unknown>)
        : {};
      captured.push({ url, headers, body });
      const responseBody = responses[call] ?? responses[responses.length - 1];
      call += 1;
      return new Response(JSON.stringify(responseBody), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const res = await agenticChat(userMessages, baseOptions, registry, 5);

    expect(res.provider).toBe("opencode");
    expect(res.text).toContain("It is sunny and 25C.");
    expect(res.toolUseCount).toBe(1);
    expect(res.usage).toEqual({ inputTokens: 50, outputTokens: 13 });

    // The tool was executed with the parsed arguments.
    expect(recordedCalls).toEqual([
      { name: "get_weather", input: { city: "Paris" } },
    ]);

    // The first request advertised tools + tool_choice; the loop made 2 calls.
    expect(captured.length).toBe(2);
    expect(captured[0]!.body.tools).toBeDefined();
    expect(captured[0]!.body.tool_choice).toBe("auto");
    expect(captured[0]!.headers.Authorization).toBe("Bearer test-key-123");

    // Second request carries the tool result back as a tool-role message.
    const secondMessages = captured[1]!.body.messages as Array<{
      role: string;
      content?: string;
      tool_call_id?: string;
    }>;
    const toolMsg = secondMessages.find((m) => m.role === "tool");
    expect(toolMsg?.tool_call_id).toBe("call_1");
    expect(toolMsg?.content).toBe("sunny, 25C");
  });

  test("throws a clear error when the API key is missing", async () => {
    delete process.env.OPENCODE_API_KEY;
    const registry = makeRegistry("x", []);
    globalThis.fetch = (async () => {
      throw new Error("network must not be called");
    }) as unknown as typeof fetch;

    await expect(
      agenticChat(userMessages, baseOptions, registry, 3),
    ).rejects.toThrow(/OPENCODE_API_KEY is not set/);
  });
});
