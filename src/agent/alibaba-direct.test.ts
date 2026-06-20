import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chat } from "./alibaba-direct";
import type { AgentOptions } from "./types";

// Unit lane: no DB is initialized here, so getSecret() falls through to
// process.env. We set ALIBABA_API_KEY via env and stub globalThis.fetch to
// capture the outgoing request body without any module mocking.

const realFetch = globalThis.fetch;
const realKey = process.env.ALIBABA_API_KEY;
const realBaseUrl = process.env.ALIBABA_BASE_URL;

let capturedBody: Record<string, unknown> | undefined;

function stubFetch(): void {
  capturedBody = undefined;
  globalThis.fetch = (async (
    _input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(
      JSON.stringify({
        choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof globalThis.fetch;
}

function baseOptions(overrides: Partial<AgentOptions> = {}): AgentOptions {
  return {
    systemPrompt: "system",
    model: "glm-5.2",
    ...overrides,
  };
}

describe("alibaba-direct chat thinking-disable", () => {
  beforeEach(() => {
    process.env.ALIBABA_API_KEY = "test-key";
    // Leave ALIBABA_BASE_URL unset so it resolves to the default token-plan host.
    delete process.env.ALIBABA_BASE_URL;
    stubFetch();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    if (realKey === undefined) delete process.env.ALIBABA_API_KEY;
    else process.env.ALIBABA_API_KEY = realKey;
    if (realBaseUrl === undefined) delete process.env.ALIBABA_BASE_URL;
    else process.env.ALIBABA_BASE_URL = realBaseUrl;
  });

  test("disables thinking by default (reasoning unset)", async () => {
    await chat([{ role: "user", content: "hi", timestamp: 0 }], baseOptions());

    expect(capturedBody).toBeDefined();
    expect(capturedBody?.thinking).toEqual({ type: "disabled" });
    // Belt-and-suspenders for qwen models which honor enable_thinking instead.
    expect(capturedBody?.enable_thinking).toBe(false);
  });

  test("disables thinking when reasoning is explicitly false", async () => {
    await chat([{ role: "user", content: "hi", timestamp: 0 }], baseOptions({ reasoning: false }));

    expect(capturedBody?.thinking).toEqual({ type: "disabled" });
    expect(capturedBody?.enable_thinking).toBe(false);
  });

  test("leaves thinking ON when reasoning is true", async () => {
    await chat([{ role: "user", content: "hi", timestamp: 0 }], baseOptions({ reasoning: true }));

    expect(capturedBody).toBeDefined();
    expect(capturedBody?.thinking).toBeUndefined();
    expect(capturedBody?.enable_thinking).toBeUndefined();
  });
});
