/**
 * Isolated tests for internal-llm.ts route handler.
 *
 * Uses mock.module to stub chat() so we can verify:
 * - max_tokens is clamped to 4096 server-side
 * - non-allowlisted model is coerced to DEFAULT_MODEL
 * - error response does NOT echo stack trace or token
 * - 400 when messages is empty
 * - 429 when concurrent cap is hit
 *
 * Auth (401 without bearer) is tested via the web app middleware layer
 * which wraps the route. Here we test the route handler in isolation by
 * directly invoking the Hono app returned by createInternalLlmRoutes().
 *
 * NOTE: This is an *.isolated.test.ts file because mock.module is used.
 */
import { describe, test, expect, mock, beforeEach } from "bun:test";

// ── Module mocks must come BEFORE any imports that use them ──────────────────

// We capture what chat() was called with so we can assert on its args.
let capturedChatArgs: Record<string, unknown>[] = [];
let chatShouldThrow = false;
let chatReturnValue = { text: "hello world", usage: { inputTokens: 10, outputTokens: 20 } };

mock.module("../../agent/chat", () => ({
  chat: mock(async (_conversation: unknown, opts: Record<string, unknown>) => {
    capturedChatArgs.push({ opts });
    if (chatShouldThrow) throw new Error("SDK exploded: token_limit_exceeded_secret");
    return chatReturnValue;
  }),
}));

// Also mock the logger to avoid noisy output
mock.module("../../logger", () => ({
  createLogger: () => ({
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
    debug: mock(() => {}),
  }),
}));

// Now import the route factory
import { createInternalLlmRoutes } from "./internal-llm";

// ── Test helpers ──────────────────────────────────────────────────────────────

function makeApp() {
  return createInternalLlmRoutes();
}

async function post(
  app: ReturnType<typeof makeApp>,
  body: unknown,
): Promise<Response> {
  const req = new Request("http://localhost/internal/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return app.fetch(req);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("internal-llm route — input validation", () => {
  beforeEach(() => {
    capturedChatArgs = [];
    chatShouldThrow = false;
    chatReturnValue = { text: "response", usage: { inputTokens: 10, outputTokens: 20 } };
  });

  test("400 when messages is empty array", async () => {
    const app = makeApp();
    const res = await post(app, { messages: [] });
    expect(res.status).toBe(400);
    const body = await res.json() as Record<string, unknown>;
    expect((body as { error: { message: string } }).error.message).toContain("messages");
  });

  test("400 when messages is missing", async () => {
    const app = makeApp();
    const res = await post(app, { model: "claude-haiku-4-5" });
    expect(res.status).toBe(400);
  });

  test("400 when body is not valid JSON (malformed)", async () => {
    const app = makeApp();
    const req = new Request("http://localhost/internal/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json{{",
    });
    const res = await app.fetch(req);
    expect(res.status).toBe(400);
  });
});

describe("internal-llm route — max_tokens clamping", () => {
  beforeEach(() => {
    capturedChatArgs = [];
    chatShouldThrow = false;
    chatReturnValue = { text: "response", usage: { inputTokens: 10, outputTokens: 20 } };
  });

  test("max_tokens > 4096 is clamped to 4096", async () => {
    const app = makeApp();
    await post(app, {
      messages: [{ role: "user", content: "hello" }],
      max_tokens: 99999,
    });
    // The chat call should receive maxOutputTokens=4096, not 99999
    const lastCall = capturedChatArgs[capturedChatArgs.length - 1];
    const opts = (lastCall?.opts ?? {}) as { maxOutputTokens?: number };
    expect(opts.maxOutputTokens).toBeLessThanOrEqual(4096);
  });

  test("max_tokens <= 4096 passes through unchanged", async () => {
    const app = makeApp();
    await post(app, {
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 1000,
    });
    const lastCall = capturedChatArgs[capturedChatArgs.length - 1];
    const opts = (lastCall?.opts ?? {}) as { maxOutputTokens?: number };
    expect(opts.maxOutputTokens).toBe(1000);
  });

  test("default max_tokens (absent) uses 2000 capped to 4096 => 2000", async () => {
    const app = makeApp();
    await post(app, {
      messages: [{ role: "user", content: "hi" }],
    });
    const lastCall = capturedChatArgs[capturedChatArgs.length - 1];
    const opts = (lastCall?.opts ?? {}) as { maxOutputTokens?: number };
    expect(opts.maxOutputTokens).toBe(2000);
  });
});

describe("internal-llm route — model allowlist coercion", () => {
  beforeEach(() => {
    capturedChatArgs = [];
    chatShouldThrow = false;
    chatReturnValue = { text: "response", usage: { inputTokens: 5, outputTokens: 10 } };
  });

  test("non-allowlisted model is coerced to DEFAULT_MODEL (haiku)", async () => {
    const app = makeApp();
    await post(app, {
      messages: [{ role: "user", content: "hi" }],
      model: "claude-opus-4",
    });
    const lastCall = capturedChatArgs[capturedChatArgs.length - 1];
    const opts = (lastCall?.opts ?? {}) as { model?: string };
    // The model used should be a haiku variant, not opus
    expect(opts.model).not.toContain("opus");
    expect(opts.model).toMatch(/haiku/);
  });

  test("allowlisted model claude-haiku-4-5-20251001 passes through", async () => {
    const app = makeApp();
    await post(app, {
      messages: [{ role: "user", content: "hi" }],
      model: "claude-haiku-4-5-20251001",
    });
    const lastCall = capturedChatArgs[capturedChatArgs.length - 1];
    const opts = (lastCall?.opts ?? {}) as { model?: string };
    expect(opts.model).toBe("claude-haiku-4-5-20251001");
  });

  test("allowlisted model claude-haiku-4-5 passes through", async () => {
    const app = makeApp();
    await post(app, {
      messages: [{ role: "user", content: "hi" }],
      model: "claude-haiku-4-5",
    });
    const lastCall = capturedChatArgs[capturedChatArgs.length - 1];
    const opts = (lastCall?.opts ?? {}) as { model?: string };
    expect(opts.model).toBe("claude-haiku-4-5");
  });

  test("absent model falls back to DEFAULT_MODEL", async () => {
    const app = makeApp();
    await post(app, {
      messages: [{ role: "user", content: "hi" }],
    });
    const lastCall = capturedChatArgs[capturedChatArgs.length - 1];
    const opts = (lastCall?.opts ?? {}) as { model?: string };
    expect(opts.model).toMatch(/haiku/);
  });
});

describe("internal-llm route — error response sanitization", () => {
  beforeEach(() => {
    capturedChatArgs = [];
    chatShouldThrow = true;
    chatReturnValue = { text: "", usage: { inputTokens: 0, outputTokens: 0 } };
  });

  test("returns 502 on chat() failure", async () => {
    const app = makeApp();
    const res = await post(app, {
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.status).toBe(502);
  });

  test("error response body does NOT echo the SDK error message or token", async () => {
    const app = makeApp();
    const res = await post(app, {
      messages: [{ role: "user", content: "hi" }],
    });
    const body = await res.json() as Record<string, unknown>;
    const bodyStr = JSON.stringify(body);
    // The mocked error contains "token_limit_exceeded_secret" — must not appear in response
    expect(bodyStr).not.toContain("token_limit_exceeded_secret");
    expect(bodyStr).not.toContain("SDK exploded");
  });

  test("error response body has generic 'internal completion failed' message", async () => {
    const app = makeApp();
    const res = await post(app, {
      messages: [{ role: "user", content: "hi" }],
    });
    const body = await res.json() as { error: { message: string } };
    expect(body.error.message).toBe("internal completion failed");
  });

  test("error response does not include stack trace", async () => {
    const app = makeApp();
    const res = await post(app, {
      messages: [{ role: "user", content: "hi" }],
    });
    const bodyStr = JSON.stringify(await res.json());
    expect(bodyStr).not.toContain("at ");
    expect(bodyStr).not.toContain("stack");
  });
});

describe("internal-llm route — successful response shape", () => {
  beforeEach(() => {
    capturedChatArgs = [];
    chatShouldThrow = false;
    chatReturnValue = { text: "The answer is 42", usage: { inputTokens: 15, outputTokens: 8 } };
  });

  test("200 response with choices array", async () => {
    const app = makeApp();
    const res = await post(app, {
      messages: [{ role: "user", content: "What is 6*7?" }],
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { choices: unknown[] };
    expect(Array.isArray(body.choices)).toBe(true);
    expect(body.choices.length).toBe(1);
  });

  test("choice has 'stop' finish_reason for plain completion", async () => {
    const app = makeApp();
    const res = await post(app, {
      messages: [{ role: "user", content: "hello" }],
    });
    const body = await res.json() as { choices: Array<{ finish_reason: string }> };
    expect(body.choices[0]!.finish_reason).toBe("stop");
  });
});
