import { test, expect, describe } from "bun:test";
import { buildModel, resolveModelMetadata, summarizeUsage } from "./anthropic-direct";

describe("resolveModelMetadata (fail-safe on missing model)", () => {
  test("does not TypeError on undefined — returns conservative default", () => {
    // Regression: a stale persisted SIGE config threaded model=undefined here,
    // and the old `modelId.toLowerCase()` crashed with an opaque TypeError.
    expect(() => resolveModelMetadata(undefined)).not.toThrow();
    const meta = resolveModelMetadata(undefined);
    expect(meta.inputPerMillion).toBe(3);
    expect(meta.outputPerMillion).toBe(15);
    expect(meta.contextWindow).toBe(200_000);
  });

  test("does not TypeError on empty string — returns conservative default", () => {
    expect(() => resolveModelMetadata("")).not.toThrow();
    expect(resolveModelMetadata("").maxTokens).toBe(16_384);
  });

  test("still resolves a known model by longest-prefix", () => {
    const meta = resolveModelMetadata("claude-sonnet-4-6-20260101");
    expect(meta.contextWindow).toBe(1_000_000);
    expect(meta.maxTokens).toBe(64_000);
  });
});

describe("buildModel (never emits an undefined model id)", () => {
  test("falls back to the default Anthropic model id when given undefined", () => {
    const model = buildModel(undefined);
    expect(model.id).toBe("claude-sonnet-4-6");
    expect(model.name).toBe("claude-sonnet-4-6");
    expect(model.id).toBeTruthy();
  });

  test("falls back to the default id when given an empty string", () => {
    expect(buildModel("").id).toBe("claude-sonnet-4-6");
  });

  test("preserves an explicit model id verbatim", () => {
    expect(buildModel("claude-opus-4-8").id).toBe("claude-opus-4-8");
  });
});

describe("summarizeUsage", () => {
  test("surfaces cache-write tokens that the old log dropped", () => {
    // The shape that made inputTokens look like 3: a large prompt billed as a
    // cache WRITE (first time the prefix is seen). `input` is only the uncached
    // remainder; the real volume is in cacheWrite.
    const s = summarizeUsage({
      input: 3,
      output: 32000,
      cacheRead: 0,
      cacheWrite: 6438,
      totalTokens: 38441,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.5 },
    });
    expect(s.inputTokens).toBe(3);
    expect(s.outputTokens).toBe(32000);
    expect(s.cacheReadTokens).toBe(0);
    expect(s.cacheWriteTokens).toBe(6438);
  });

  test("prefers pi-ai's computed cost (which includes cache read + write)", () => {
    const s = summarizeUsage({
      input: 3,
      output: 32000,
      cacheRead: 0,
      cacheWrite: 6438,
      totalTokens: 38441,
      cost: { input: 0, output: 0.48, cacheRead: 0, cacheWrite: 0.024, total: 0.504 },
    });
    // Authoritative total, not the old input+output-only estimate (~$0.48).
    expect(s.costUsd).toBeCloseTo(0.504, 6);
  });

  test("falls back to a FULL estimate (incl. cache) when cost is absent", () => {
    const s = summarizeUsage({
      input: 1000,
      output: 2000,
      cacheRead: 10000,
      cacheWrite: 4000,
      totalTokens: 17000,
      // no `cost` field
    } as unknown as Parameters<typeof summarizeUsage>[0]);
    // input 1000*$3/1M + output 2000*$15/1M + cacheRead 10000*$0.3/1M
    //   + cacheWrite 4000*$3.75/1M
    const expected =
      1000 * (3 / 1_000_000) +
      2000 * (15 / 1_000_000) +
      10000 * (0.3 / 1_000_000) +
      4000 * (3.75 / 1_000_000);
    expect(s.costUsd).toBeCloseTo(expected, 9);
  });

  test("is zero-safe when usage is missing entirely", () => {
    const s = summarizeUsage(undefined);
    expect(s).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
    });
  });
});
