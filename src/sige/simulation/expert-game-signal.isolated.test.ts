/**
 * Isolated test: the SIGE agent-task runner threads the session AbortSignal all
 * the way into the chat() call.
 *
 * This is the second half of the wedge fix. The per-call timeout in chat()
 * guards every call; this proves the SESSION signal (carrying the wall-clock)
 * actually reaches runSingleAgent -> chat(), so an external/wall-clock abort can
 * cancel an in-flight strategic-agent request.
 *
 * We drive runSingleAgent through the exported Round-1 entry point
 * generateDivergentCandidates and capture the AgentOptions chat() receives.
 *
 * Lane: isolated (own process) because it uses mock.module.
 */
import { describe, test, expect, mock, beforeEach } from "bun:test";
import type { AgentOptions } from "../../agent/types";

// ── Module mocks — must come before importing the unit under test ─────────────

const capturedChatOptions: AgentOptions[] = [];

mock.module("../../agent/chat", () => ({
  chat: mock(async (_messages: unknown, options: AgentOptions) => {
    capturedChatOptions.push(options);
    return {
      text: JSON.stringify({ ideas: [{ title: "Idea A", description: "desc" }] }),
      provider: "anthropic" as const,
    };
  }),
}));

// Graph view is irrelevant here — return empty context, no DB / Mem0.
mock.module("../knowledge/graph-query", () => ({
  getFilteredGraphView: mock(async () => ({})),
  graphViewToPromptContext: mock(() => ""),
}));

// Provide exactly one strategic-agent definition and passthrough helpers so the
// Round-1 path runs a single agent and parses its JSON ideas.
const fakeDef = {
  role: "explorer",
  name: "Explorer",
  defaultKnowledgeFilter: undefined,
};

mock.module("../strategic-agents", () => ({
  getAllDefinitions: mock(() => [fakeDef]),
  buildStrategicPrompt: mock(() => "SYSTEM PROMPT"),
  parseAgentAction: mock(
    (text: string, round: number, agentId: string, role: string) => ({
      role,
      agentId,
      actionType: "propose",
      content: text,
      confidence: 1,
      round,
    }),
  ),
  DIVERGENT_PERSONA_ROLES: ["explorer"],
}));

// Mem0Client is constructed but never used (graph-query is mocked).
mock.module("../knowledge/mem0-client", () => ({
  Mem0Client: class {
    constructor(_opts: unknown) {}
  },
}));

const { generateDivergentCandidates } = await import("./expert-game");

beforeEach(() => {
  capturedChatOptions.length = 0;
});

describe("runSingleAgent signal threading (via generateDivergentCandidates)", () => {
  test("forwards the session signal as abortSignal into chat()", async () => {
    const controller = new AbortController();

    await generateDivergentCandidates({
      sessionId: "sess-1",
      userId: "user-1",
      roles: ["explorer"],
      signal: controller.signal,
    });

    expect(capturedChatOptions.length).toBeGreaterThanOrEqual(1);
    const opts = capturedChatOptions[0]!;
    expect(opts.abortSignal).toBeDefined();
    // Aborting the session signal is observable on the signal chat received.
    expect(opts.abortSignal?.aborted).toBe(false);
    controller.abort();
    expect(opts.abortSignal?.aborted).toBe(true);
  });

  test("omits abortSignal when no session signal is supplied", async () => {
    await generateDivergentCandidates({
      sessionId: "sess-2",
      userId: "user-1",
      roles: ["explorer"],
    });

    expect(capturedChatOptions.length).toBeGreaterThanOrEqual(1);
    expect(capturedChatOptions[0]!.abortSignal).toBeUndefined();
  });
});
