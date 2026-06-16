/**
 * Real (non-tautological) coverage for the agent-sdk chat / agenticChat
 * request builders.
 *
 * These tests mock the Claude Agent SDK `query()` so NO real subprocess is
 * spawned, and mock `./prompt-context` so prompt enrichment does not touch the
 * database. We then assert on the EXACT request that agent-sdk builds and on
 * how it maps the SDK's streamed result back into an AgentResponse.
 */
import { describe, it, expect, beforeEach, mock } from "bun:test";
import { buildPromptWithHistory, lastUserMessage } from "./prompt-context";
import type { AgentOptions, ConversationMessage } from "./types";

// ── SDK mock ────────────────────────────────────────────────────────────────
// Captures every query() invocation so we can inspect the built request, and
// yields a scripted async stream of SDK messages.

interface QueryCall {
  readonly prompt: string;
  readonly options: Record<string, unknown>;
}

const queryCalls: QueryCall[] = [];
let scriptedMessages: ReadonlyArray<Record<string, unknown>> = [];

function setScriptedResult(text: string): void {
  scriptedMessages = [
    { type: "result", subtype: "success", result: text, session_id: "sess-1" },
  ];
}

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: (request: QueryCall) => {
    queryCalls.push(request);
    return (async function* () {
      for (const message of scriptedMessages) {
        yield message;
      }
    })();
  },
  // agenticChat builds an in-process MCP server; return an opaque stub.
  createSdkMcpServer: (config: unknown) => ({ __mock: "mcp-server", config }),
  tool: (name: string, description: string, schema: unknown, handler: unknown) => ({
    name,
    description,
    schema,
    handler,
  }),
}));

// ── prompt-context mock ─────────────────────────────────────────────────────
// Keep the REAL history-building logic (so the request reflects it) but make
// enrichment a pure passthrough — no DB access for user preferences.

mock.module("./prompt-context", () => ({
  MAX_HISTORY_IN_PROMPT: 50,
  buildPromptWithHistory,
  lastUserMessage,
  enrichPromptWithContext: async (prompt: string) => prompt,
}));

// Import AFTER the mocks are registered so agent-sdk binds to them.
const { chat, agenticChat } = await import("./agent-sdk");

beforeEach(() => {
  queryCalls.length = 0;
  setScriptedResult("default response");
});

const baseOptions: AgentOptions = {
  systemPrompt: "You are a helpful assistant.",
  model: "test-model",
};

function userMsg(content: string, ts = 1_000): ConversationMessage {
  return { role: "user", content, timestamp: ts };
}

// ── chat ────────────────────────────────────────────────────────────────────

describe("chat (Agent SDK request builder)", () => {
  it("returns the success result text from the SDK stream", async () => {
    setScriptedResult("hello from the model");
    const res = await chat([userMsg("Hi")], baseOptions);
    expect(res.text).toBe("hello from the model");
    expect(res.provider).toBe("agent-sdk");
  });

  it("forwards the configured model and uses maxTurns:1 for a single-shot chat", async () => {
    await chat([userMsg("Hi")], { ...baseOptions, model: "claude-test-9" });
    expect(queryCalls).toHaveLength(1);
    expect(queryCalls[0]!.options.model).toBe("claude-test-9");
    expect(queryCalls[0]!.options.maxTurns).toBe(1);
    expect(queryCalls[0]!.options.permissionMode).toBe("bypassPermissions");
  });

  it("passes the raw system prompt through unchanged when rawSystemPrompt is set", async () => {
    await chat([userMsg("Hi")], {
      ...baseOptions,
      rawSystemPrompt: true,
      systemPrompt: "RAW-SYSTEM",
    });
    expect(queryCalls[0]!.options.systemPrompt).toBe("RAW-SYSTEM");
  });

  it("builds the prompt from the single user message", async () => {
    await chat([userMsg("What is the weather?")], baseOptions);
    expect(queryCalls[0]!.prompt).toBe("What is the weather?");
  });

  it("includes conversation history in the prompt for multi-message inputs", async () => {
    const messages: ConversationMessage[] = [
      { role: "user", content: "First message", timestamp: 1 },
      { role: "assistant", content: "First response", timestamp: 2 },
      { role: "user", content: "Second message", timestamp: 3 },
    ];
    await chat(messages, baseOptions);
    const prompt = queryCalls[0]!.prompt;
    expect(prompt).toContain("<conversation_history>");
    expect(prompt).toContain("First message");
    expect(prompt).toContain("[assistant]: First response");
    // The final (current) user message comes after the history block.
    expect(prompt.endsWith("Second message")).toBe(true);
  });

  it("resumes a session when sdkSessionId is provided", async () => {
    await chat([userMsg("Hi")], { ...baseOptions, sdkSessionId: "resume-me" });
    expect(queryCalls[0]!.options.resume).toBe("resume-me");
  });

  it("omits resume when no session id is given", async () => {
    await chat([userMsg("Hi")], baseOptions);
    expect("resume" in queryCalls[0]!.options).toBe(false);
  });

  it("falls back to the last assistant text when no success result is emitted", async () => {
    scriptedMessages = [
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "assistant-only text" }] },
      },
    ];
    const res = await chat([userMsg("Hi")], baseOptions);
    expect(res.text).toBe("assistant-only text");
  });

  it("wraps SDK stream failures in an Agent SDK error when nothing was produced", async () => {
    scriptedMessages = [];
    // Force the generator to throw before any usable text.
    mock.module("@anthropic-ai/claude-agent-sdk", () => ({
      query: (request: QueryCall) => {
        queryCalls.push(request);
        return (async function* () {
          throw new Error("subprocess exploded");
          // eslint-disable-next-line no-unreachable
          yield {} as Record<string, unknown>;
        })();
      },
      createSdkMcpServer: (config: unknown) => ({ __mock: "mcp-server", config }),
      tool: () => ({}),
    }));
    const { chat: chat2 } = await import("./agent-sdk");
    await expect(chat2([userMsg("Hi")], baseOptions)).rejects.toThrow(/Agent SDK error/);

    // Restore the well-behaved mock for subsequent tests.
    mock.module("@anthropic-ai/claude-agent-sdk", () => ({
      query: (request: QueryCall) => {
        queryCalls.push(request);
        return (async function* () {
          for (const message of scriptedMessages) {
            yield message;
          }
        })();
      },
      createSdkMcpServer: (config: unknown) => ({ __mock: "mcp-server", config }),
      tool: () => ({}),
    }));
  });
});

// ── agenticChat ───────────────────────────────────────────────────────────

describe("agenticChat (Agent SDK request builder)", () => {
  const emptyRegistry = { definitions: [] } as unknown as import("../tools/registry").ToolRegistry;

  beforeEach(() => {
    setScriptedResult("agentic done");
  });

  it("forwards the model and uses maxIterations as maxTurns", async () => {
    await agenticChat([userMsg("Do the task")], { ...baseOptions, model: "agentic-model" }, emptyRegistry, 7);
    expect(queryCalls.length).toBeGreaterThanOrEqual(1);
    expect(queryCalls[0]!.options.model).toBe("agentic-model");
    expect(queryCalls[0]!.options.maxTurns).toBe(7);
  });

  it("returns the success result text", async () => {
    setScriptedResult("the agentic answer");
    const res = await agenticChat([userMsg("Go")], baseOptions, emptyRegistry, 5);
    expect(res.text).toBe("the agentic answer");
    expect(res.provider).toBe("agent-sdk");
  });

  it("attaches an in-process MCP server to the request", async () => {
    await agenticChat([userMsg("Go")], baseOptions, emptyRegistry, 5);
    expect(queryCalls[0]!.options.mcpServers).toBeDefined();
  });
});
