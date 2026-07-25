/**
 * Unit tests for the human keyword-verdict route validation schemas
 * (`POST/DELETE /api/appstore/verdicts/:keyword`).
 *
 * Lane: *.test.ts — run with `bun run test:unit` (no DB).
 */
import { describe, it, expect } from "bun:test";
import { verdictBodySchema, verdictKeywordParamSchema } from "./appstore";

describe("verdictKeywordParamSchema", () => {
  it("accepts a trimmed non-empty keyword", () => {
    const parsed = verdictKeywordParamSchema.safeParse("meal planner app");
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toBe("meal planner app");
  });

  it("trims surrounding whitespace", () => {
    const parsed = verdictKeywordParamSchema.safeParse("  habit tracker  ");
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toBe("habit tracker");
  });

  it("rejects an empty string", () => {
    const parsed = verdictKeywordParamSchema.safeParse("");
    expect(parsed.success).toBe(false);
  });

  it("rejects a whitespace-only string", () => {
    const parsed = verdictKeywordParamSchema.safeParse("   ");
    expect(parsed.success).toBe(false);
  });

  it("rejects a keyword longer than 200 chars", () => {
    const parsed = verdictKeywordParamSchema.safeParse("a".repeat(201));
    expect(parsed.success).toBe(false);
  });

  it("accepts a keyword exactly at the 200-char ceiling", () => {
    const parsed = verdictKeywordParamSchema.safeParse("a".repeat(200));
    expect(parsed.success).toBe(true);
  });
});

describe("verdictBodySchema", () => {
  it("accepts each valid human verdict without a note", () => {
    for (const verdict of ["starred", "dismissed", "validated", "killed"] as const) {
      const parsed = verdictBodySchema.safeParse({ verdict });
      expect(parsed.success).toBe(true);
      if (parsed.success) expect(parsed.data).toEqual({ verdict });
    }
  });

  it("accepts a verdict with an optional note", () => {
    const parsed = verdictBodySchema.safeParse({ verdict: "killed", note: "duplicate of X" });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.note).toBe("duplicate of X");
  });

  it("rejects an unknown verdict", () => {
    const parsed = verdictBodySchema.safeParse({ verdict: "archived" });
    expect(parsed.success).toBe(false);
  });

  it("rejects a missing verdict", () => {
    const parsed = verdictBodySchema.safeParse({ note: "no verdict" });
    expect(parsed.success).toBe(false);
  });

  it("rejects an empty-string note", () => {
    const parsed = verdictBodySchema.safeParse({ verdict: "killed", note: "" });
    expect(parsed.success).toBe(false);
  });

  it("rejects a note over 2000 chars", () => {
    const parsed = verdictBodySchema.safeParse({ verdict: "killed", note: "a".repeat(2001) });
    expect(parsed.success).toBe(false);
  });
});
