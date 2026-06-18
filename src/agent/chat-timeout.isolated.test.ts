/**
 * Isolated coverage proving the per-call LLM timeout actually fires.
 *
 * This is the headline regression guard: a provider whose request never
 * resolves must cause chat() to REJECT with a typed timeout instead of hanging
 * forever (the bug that wedged autonomous SIGE sessions). Uses mock.module to
 * replace the providers with a hang/echo stub — no real HTTP, no DB.
 *
 * Lane: isolated (own process) because it uses mock.module.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { AgentOptions, ConversationMessage } from "./types";

// Records the signal the provider received so we can assert chat() passed the
// combined (timeout + external) signal down to the provider layer.
let lastSeenSignal: AbortSignal | undefined;

/** A provider that never resolves on its own — it only settles when its signal
 *  aborts, mirroring a hung HTTP request that honors AbortSignal. */
function hangingProvider(_messages: unknown, options: AgentOptions) {
  lastSeenSignal = options.abortSignal;
  return new Promise((_resolve, reject) => {
    const signal = options.abortSignal;
    if (!signal) return; // would hang forever — only used in the no-signal path
    if (signal.aborted) {
      reject(signal.reason ?? new Error("aborted"));
      return;
    }
    signal.addEventListener(
      "abort",
      () => reject(signal.reason ?? new Error("aborted")),
      { once: true },
    );
  });
}

mock.module("./anthropic-direct", () => ({ chat: hangingProvider }));
mock.module("./openrouter", () => ({
  chat: hangingProvider,
  agenticChat: hangingProvider,
}));
mock.module("./alibaba-direct", () => ({ chat: hangingProvider }));
mock.module("./agent-sdk", () => ({
  chat: hangingProvider,
  agenticChat: hangingProvider,
  withAlibabaEnv: (fn: () => Promise<unknown>) => fn(),
}));
// Avoid any DB access from usage persistence.
mock.module("../store/token-usage", () => ({
  recordTokenUsage: async () => {},
}));

const { chat } = await import("./chat");
const { LlmCallTimeoutError } = await import("./llm-timeout");

const baseOptions: AgentOptions = {
  systemPrompt: "sys",
  model: "test-model",
  provider: "anthropic",
};

function userMsg(content: string): ConversationMessage {
  return { role: "user", content, timestamp: 1_000 };
}

beforeEach(() => {
  lastSeenSignal = undefined;
});

afterEach(() => {
  delete process.env.LLM_CALL_TIMEOUT_MS;
});

describe("chat() per-call timeout", () => {
  it("rejects with LlmCallTimeoutError when the provider request never resolves", async () => {
    const start = Date.now();
    await expect(
      chat([userMsg("hi")], { ...baseOptions, callTimeoutMs: 1_000 }),
    ).rejects.toBeInstanceOf(LlmCallTimeoutError);
    // It rejected because of the deadline, not instantly.
    expect(Date.now() - start).toBeGreaterThanOrEqual(900);
  });

  it("passes a combined abort signal down to the provider", async () => {
    await expect(
      chat([userMsg("hi")], { ...baseOptions, callTimeoutMs: 1_000 }),
    ).rejects.toBeInstanceOf(LlmCallTimeoutError);
    expect(lastSeenSignal).toBeDefined();
    expect(lastSeenSignal?.aborted).toBe(true);
  });

  it("an external abort still cancels the call (not reported as a timeout)", async () => {
    const external = new AbortController();
    const promise = chat([userMsg("hi")], {
      ...baseOptions,
      callTimeoutMs: 60_000,
      abortSignal: external.signal,
    });
    external.abort(new Error("caller cancelled"));
    // The provider rejects with the external reason; chat() does not relabel it
    // as a timeout because the deadline did not fire.
    await expect(promise).rejects.not.toBeInstanceOf(LlmCallTimeoutError);
  });
});
