/**
 * Unit coverage for the per-call LLM timeout helper.
 *
 * Pins the boundary behavior that keeps autonomous SIGE sessions from wedging:
 * the deadline must fire after the configured timeout, combine with an external
 * signal, and be clearable without leaking a late abort.
 */
import { afterEach, describe, expect, it } from "bun:test";
import {
  createCallDeadline,
  DEFAULT_LLM_CALL_TIMEOUT_MS,
  LlmCallTimeoutError,
  resolveLlmCallTimeoutMs,
} from "./llm-timeout";

const origEnv = process.env.LLM_CALL_TIMEOUT_MS;

afterEach(() => {
  if (origEnv === undefined) {
    delete process.env.LLM_CALL_TIMEOUT_MS;
  } else {
    process.env.LLM_CALL_TIMEOUT_MS = origEnv;
  }
});

describe("resolveLlmCallTimeoutMs", () => {
  it("uses the explicit value when valid", () => {
    expect(resolveLlmCallTimeoutMs(5_000)).toBe(5_000);
  });

  it("falls back to the env var when no explicit value", () => {
    process.env.LLM_CALL_TIMEOUT_MS = "12345";
    expect(resolveLlmCallTimeoutMs()).toBe(12_345);
  });

  it("prefers explicit over env", () => {
    process.env.LLM_CALL_TIMEOUT_MS = "12345";
    expect(resolveLlmCallTimeoutMs(7_000)).toBe(7_000);
  });

  it("falls back to the default for non-positive / non-finite input", () => {
    delete process.env.LLM_CALL_TIMEOUT_MS;
    expect(resolveLlmCallTimeoutMs(0)).toBe(DEFAULT_LLM_CALL_TIMEOUT_MS);
    expect(resolveLlmCallTimeoutMs(-1)).toBe(DEFAULT_LLM_CALL_TIMEOUT_MS);
    expect(resolveLlmCallTimeoutMs(Number.NaN)).toBe(DEFAULT_LLM_CALL_TIMEOUT_MS);
    expect(resolveLlmCallTimeoutMs()).toBe(DEFAULT_LLM_CALL_TIMEOUT_MS);
  });

  it("clamps below the minimum", () => {
    expect(resolveLlmCallTimeoutMs(10)).toBeGreaterThanOrEqual(1_000);
  });
});

describe("createCallDeadline", () => {
  it("fires the timeout after the configured interval and reports timedOut()", async () => {
    const deadline = createCallDeadline(undefined, 1_000 /* clamped min */);
    expect(deadline.signal.aborted).toBe(false);

    const aborted = new Promise<void>((resolve) => {
      deadline.signal.addEventListener("abort", () => resolve(), { once: true });
    });
    await aborted;

    expect(deadline.signal.aborted).toBe(true);
    expect(deadline.timedOut()).toBe(true);
    expect(deadline.signal.reason).toBeInstanceOf(LlmCallTimeoutError);
    deadline.clear();
  });

  it("aborts immediately when the external signal aborts (not a timeout)", () => {
    const external = new AbortController();
    const deadline = createCallDeadline(external.signal, 60_000);
    expect(deadline.signal.aborted).toBe(false);

    external.abort(new Error("external cancel"));

    expect(deadline.signal.aborted).toBe(true);
    expect(deadline.timedOut()).toBe(false);
    deadline.clear();
  });

  it("does not fire after clear()", async () => {
    const deadline = createCallDeadline(undefined, 1_000);
    deadline.clear();
    // Wait past the deadline window; the cleared timer must not abort.
    await new Promise((r) => setTimeout(r, 1_200));
    expect(deadline.signal.aborted).toBe(false);
    expect(deadline.timedOut()).toBe(false);
  });
});
