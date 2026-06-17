import { test, expect, describe } from "bun:test";
import {
  SEGMENTS,
  SEGMENT_IDS,
  SEGMENT_BY_ID,
  DEFAULT_SEGMENT_ID,
  segmentQuota,
  inferSegment,
  inferSegmentMatch,
  type SegmentId,
} from "./segments";

// ── Taxonomy shape ─────────────────────────────────────────────────────────

describe("SEGMENTS taxonomy", () => {
  test("has one descriptor per id, in the canonical order", () => {
    expect(SEGMENTS.map((s) => s.id)).toEqual([...SEGMENT_IDS]);
  });

  test("every segment has buyer + description + keywords", () => {
    for (const seg of SEGMENTS) {
      expect(seg.label.length).toBeGreaterThan(0);
      expect(seg.buyer.length).toBeGreaterThan(0);
      expect(seg.description.length).toBeGreaterThan(0);
      expect(seg.keywords.length).toBeGreaterThan(0);
    }
  });

  test("ids are unique", () => {
    expect(new Set(SEGMENT_IDS).size).toBe(SEGMENT_IDS.length);
  });

  test("breaks the 100%-consumer-mobile collapse (>= 8 distinct spaces)", () => {
    expect(SEGMENTS.length).toBeGreaterThanOrEqual(8);
    expect(SEGMENT_IDS).toContain("b2b_saas");
    expect(SEGMENT_IDS).toContain("devtools");
    expect(SEGMENT_IDS).toContain("ai_native");
  });

  test("SEGMENT_BY_ID resolves every id", () => {
    for (const id of SEGMENT_IDS) {
      expect(SEGMENT_BY_ID[id].id).toBe(id);
    }
  });

  test("DEFAULT_SEGMENT_ID is a real segment and is consumer (graceful fallback)", () => {
    expect(SEGMENT_IDS).toContain(DEFAULT_SEGMENT_ID);
    expect(DEFAULT_SEGMENT_ID).toBe("consumer");
  });
});

// ── Quota distribution ─────────────────────────────────────────────────────

describe("segmentQuota", () => {
  function total(quotas: readonly { count: number }[]): number {
    return quotas.reduce((sum, q) => sum + q.count, 0);
  }

  test("sums exactly to the target (evenly divisible)", () => {
    const n = SEGMENT_IDS.length;
    const q = segmentQuota(n * 3);
    expect(total(q)).toBe(n * 3);
    for (const item of q) expect(item.count).toBe(3);
  });

  test("sums exactly to the target with a remainder", () => {
    const n = SEGMENT_IDS.length;
    const q = segmentQuota(n * 2 + 3);
    expect(total(q)).toBe(n * 2 + 3);
  });

  test("largest-remainder leftover goes to front segments in taxonomy order", () => {
    // 9 segments, target 11 => base 1 each, 2 leftover to the first two.
    const q = segmentQuota(11);
    expect(total(q)).toBe(11);
    expect(q[0]!.count).toBe(2);
    expect(q[1]!.count).toBe(2);
    expect(q[2]!.count).toBe(1);
    expect(q[q.length - 1]!.count).toBe(1);
  });

  test("is as flat as possible (max - min <= 1)", () => {
    const q = segmentQuota(20);
    const counts = q.map((x) => x.count);
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
  });

  test("target smaller than segment count spreads one-per-segment to the front", () => {
    const q = segmentQuota(3);
    expect(total(q)).toBe(3);
    expect(q.filter((x) => x.count === 1).length).toBe(3);
    expect(q.filter((x) => x.count === 0).length).toBe(SEGMENT_IDS.length - 3);
    // Front-loaded.
    expect(q[0]!.count).toBe(1);
  });

  test("zero target yields all-zero, one entry per segment", () => {
    const q = segmentQuota(0);
    expect(q.length).toBe(SEGMENT_IDS.length);
    expect(total(q)).toBe(0);
  });

  test("negative / fractional targets are clamped + floored", () => {
    expect(total(segmentQuota(-5))).toBe(0);
    expect(total(segmentQuota(7.9))).toBe(7);
  });

  test("respects a restricted segment subset", () => {
    const subset: readonly SegmentId[] = ["devtools", "fintech"];
    const q = segmentQuota(5, subset);
    expect(q.map((x) => x.segmentId)).toEqual(["devtools", "fintech"]);
    expect(total(q)).toBe(5);
    expect(q[0]!.count).toBe(3); // leftover unit to the front
    expect(q[1]!.count).toBe(2);
  });

  test("empty subset falls back to the full taxonomy", () => {
    const q = segmentQuota(SEGMENT_IDS.length, []);
    expect(q.length).toBe(SEGMENT_IDS.length);
    expect(total(q)).toBe(SEGMENT_IDS.length);
  });

  test("is deterministic", () => {
    expect(segmentQuota(13)).toEqual(segmentQuota(13));
  });
});

// ── Inference ──────────────────────────────────────────────────────────────

describe("inferSegment", () => {
  test("tags developer tooling text as devtools", () => {
    expect(inferSegment("A CLI and SDK for debugging your API")).toBe("devtools");
  });

  test("tags money text as fintech", () => {
    expect(inferSegment("Invoice + payment reconciliation for accounting teams")).toBe(
      "fintech",
    );
  });

  test("tags model-first text as ai_native", () => {
    expect(inferSegment("An LLM agent copilot with RAG retrieval")).toBe("ai_native");
  });

  test("tags clinical text as healthcare", () => {
    expect(inferSegment("HIPAA-compliant telehealth for clinic patients")).toBe(
      "healthcare",
    );
  });

  test("tags two-sided text as marketplace", () => {
    expect(inferSegment("A booking marketplace matching supply and demand")).toBe(
      "marketplace",
    );
  });

  test("is case-insensitive", () => {
    expect(inferSegment("KUBERNETES STORAGE PIPELINE")).toBe("infrastructure");
  });

  test("falls back to the default segment on no match", () => {
    expect(inferSegment("zzzzz qqqqq")).toBe(DEFAULT_SEGMENT_ID);
  });

  test("handles empty / nullish input gracefully", () => {
    expect(inferSegment("")).toBe(DEFAULT_SEGMENT_ID);
    // @ts-expect-error exercising the nullish guard
    expect(inferSegment(undefined)).toBe(DEFAULT_SEGMENT_ID);
  });
});

describe("inferSegmentMatch", () => {
  test("returns the hit count as score", () => {
    const m = inferSegmentMatch("ai llm agent");
    expect(m.segmentId).toBe("ai_native");
    expect(m.score).toBeGreaterThanOrEqual(2);
  });

  test("a fallback reports score 0 so callers can distinguish it", () => {
    const m = inferSegmentMatch("nothing relevant here");
    expect(m.segmentId).toBe(DEFAULT_SEGMENT_ID);
    expect(m.score).toBe(0);
  });

  test("ties break toward the earlier taxonomy segment", () => {
    // "team" -> b2b_saas, "developer" -> devtools; both score 1.
    // b2b_saas precedes devtools in SEGMENT_IDS, so it wins the tie.
    const m = inferSegmentMatch("team developer");
    expect(m.score).toBe(1);
    expect(m.segmentId).toBe("b2b_saas");
  });

  test("more hits beat an earlier-but-weaker segment", () => {
    // One consumer keyword vs two devtools keywords -> devtools.
    const m = inferSegmentMatch("personal sdk cli");
    expect(m.segmentId).toBe("devtools");
  });
});
