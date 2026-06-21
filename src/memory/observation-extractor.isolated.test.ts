/**
 * Isolated test: the observation extractor must take its provider + model from
 * the `signal.observations` model-route, NOT a hardcoded literal.
 *
 * Isolated-lane gotcha: every *.isolated.test.ts runs in ONE process and
 * `mock.module` registrations LEAK across files. `chat-timeout.isolated.test.ts`
 * exercises the REAL `chat()`, so mocking `../agent/chat` here would clobber it.
 * Instead we mock the NARROWEST non-overlapping deps:
 *   - `../store/model-routing` — the route source (what we're asserting flows through)
 *   - `../agent/opencode` — the provider client the REAL `chat()`
 *     dispatches to for the routed provider ("opencode"). chat-timeout only mocks
 *     anthropic/openrouter/alibaba/agent-sdk, so there is no collision.
 * The stub returns no `usage`, so chat()'s persistUsage never touches the DB.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { AgentOptions } from "../agent/types";

let lastChatOpts: AgentOptions | undefined;

const opencodeStub = mock(async (_messages: unknown, options: AgentOptions) => {
  lastChatOpts = options;
  return { text: "[]", provider: "opencode" as const };
});

mock.module("../store/model-routing", () => ({
  getModelRoute: mock(async () => ({ provider: "opencode", model: "deepseek-v4-flash" })),
}));
mock.module("../agent/opencode", () => ({ chat: opencodeStub, agenticChat: opencodeStub }));

afterAll(() => {
  mock.restore();
});

describe("observation extractor model routing", () => {
  beforeEach(() => {
    opencodeStub.mockClear();
    lastChatOpts = undefined;
  });

  test("passes provider+model from the route into chat()", async () => {
    const { extractObservations } = await import("./observation-extractor");

    await extractObservations({
      agentId: "a",
      channel: "telegram",
      chatId: "c",
      messages: [{ role: "user", content: "hello, here is a durable preference" }],
    });

    expect(opencodeStub).toHaveBeenCalled();
    expect(lastChatOpts?.provider).toBe("opencode");
    expect(lastChatOpts?.model).toBe("deepseek-v4-flash");
  });

  test("an explicit params.model overrides the route model (provider still from route)", async () => {
    const { extractObservations } = await import("./observation-extractor");

    await extractObservations({
      agentId: "a",
      channel: "telegram",
      chatId: "c",
      messages: [{ role: "user", content: "hello" }],
      model: "explicit-override-model",
    });

    expect(lastChatOpts?.model).toBe("explicit-override-model");
    expect(lastChatOpts?.provider).toBe("opencode");
  });
});
