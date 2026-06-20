import { describe, expect, test } from "bun:test";
import type { Archetype } from "./giant";
import {
  computeDiversityReport,
  DEFAULT_MAX_BUCKET_SHARE,
  selectDiverse,
  selectDiverseBy,
  UNKNOWN_BUCKET,
} from "./idea-diversity";
import type { GeneratedIdeaCandidate } from "./types";

// ── Test helpers ───────────────────────────────────────────────────────────

/**
 * Minimal {@link GeneratedIdeaCandidate} factory — only the fields the
 * diversity guard reads (archetype, category, qualityScore, title) matter; the
 * rest are neutral placeholders so the object is structurally valid.
 */
function candidate(
  overrides: Partial<GeneratedIdeaCandidate> & { readonly title: string },
): GeneratedIdeaCandidate {
  return {
    summary: "",
    reasoning: "",
    designDescription: "",
    monetizationDetail: "",
    sourceLinks: [],
    sourcesUsed: "",
    category: "general",
    qualityScore: 3,
    targetAudience: "",
    keyFeatures: [],
    revenueModel: "",
    trendIntersection: "",
    ...overrides,
  };
}

function withArchetype(title: string, archetype: Archetype | undefined): GeneratedIdeaCandidate {
  return candidate({ title, ...(archetype !== undefined ? { archetype } : {}) });
}

const EPS = 1e-9;

// ── Metric: entropy ──────────────────────────────────────────────────────────

describe("computeDiversityReport — entropy", () => {
  test("uniform distribution over k buckets => entropy == log2(k)", () => {
    const cands = [
      withArchetype("a", "hair-on-fire"),
      withArchetype("b", "hard-fact"),
      withArchetype("c", "future-vision"),
    ];
    const report = computeDiversityReport(cands, { bucketBy: "archetype" });
    expect(report.distinctArchetypes).toBe(3);
    expect(report.archetypeEntropy).toBeCloseTo(Math.log2(3), 6);
    expect(report.entropy).toBeCloseTo(Math.log2(3), 6);
  });

  test("single bucket => entropy 0", () => {
    const cands = [
      withArchetype("a", "hair-on-fire"),
      withArchetype("b", "hair-on-fire"),
      withArchetype("c", "hair-on-fire"),
    ];
    const report = computeDiversityReport(cands, { bucketBy: "archetype" });
    expect(report.entropy).toBe(0);
    expect(report.archetypeEntropy).toBe(0);
    expect(report.distinctArchetypes).toBe(1);
    expect(report.dominantArchetype).toBe("hair-on-fire");
    expect(report.dominantArchetypeShare).toBe(1);
  });

  test("empty pool => total 0, entropy 0, dominantShare 0, empty labels", () => {
    const report = computeDiversityReport([], { bucketBy: "archetype" });
    expect(report.total).toBe(0);
    expect(report.entropy).toBe(0);
    expect(report.dominantShare).toBe(0);
    expect(report.dominantArchetypeShare).toBe(0);
    expect(report.dominantBucket).toBe("");
    expect(report.dominantArchetype).toBe("");
    expect(report.distinctBuckets).toBe(0);
  });

  test("two-bucket non-uniform entropy matches -Σ p·log2(p)", () => {
    // 3 of one, 1 of another => p = [0.75, 0.25].
    const cands = [
      withArchetype("a", "hair-on-fire"),
      withArchetype("b", "hair-on-fire"),
      withArchetype("c", "hair-on-fire"),
      withArchetype("d", "hard-fact"),
    ];
    const expected = -(0.75 * Math.log2(0.75) + 0.25 * Math.log2(0.25));
    const report = computeDiversityReport(cands, { bucketBy: "archetype" });
    expect(report.archetypeEntropy).toBeCloseTo(expected, 6);
  });
});

// ── Metric: dominance, distinct counts, unknown bucketing ────────────────────

describe("computeDiversityReport — distribution", () => {
  test("dominant bucket + share + counts are correct", () => {
    const cands = [
      withArchetype("a", "hair-on-fire"),
      withArchetype("b", "hair-on-fire"),
      withArchetype("c", "hair-on-fire"),
      withArchetype("d", "hard-fact"),
    ];
    const report = computeDiversityReport(cands, { bucketBy: "archetype" });
    expect(report.total).toBe(4);
    expect(report.dominantBucket).toBe("hair-on-fire");
    expect(report.dominantShare).toBeCloseTo(0.75, EPS);
    expect(report.counts["hair-on-fire"]).toBe(3);
    expect(report.counts["hard-fact"]).toBe(1);
    expect(report.distinctBuckets).toBe(2);
  });

  test("undefined archetype buckets as UNKNOWN_BUCKET", () => {
    const cands = [
      withArchetype("a", "hair-on-fire"),
      withArchetype("b", undefined),
      withArchetype("c", undefined),
    ];
    const report = computeDiversityReport(cands, { bucketBy: "archetype" });
    expect(report.counts[UNKNOWN_BUCKET]).toBe(2);
    expect(report.dominantArchetype).toBe(UNKNOWN_BUCKET);
    expect(report.dominantArchetypeShare).toBeCloseTo(2 / 3, EPS);
  });

  test("all-unknown archetype => one bucket, entropy 0", () => {
    const cands = [
      withArchetype("a", undefined),
      withArchetype("b", undefined),
      withArchetype("c", undefined),
    ];
    const report = computeDiversityReport(cands, { bucketBy: "archetype" });
    expect(report.distinctArchetypes).toBe(1);
    expect(report.archetypeEntropy).toBe(0);
    expect(report.dominantArchetype).toBe(UNKNOWN_BUCKET);
  });

  test("bucketBy category drives chosen-bucket fields; archetype metrics still present", () => {
    const cands = [
      candidate({ title: "a", category: "fintech", archetype: "hair-on-fire" }),
      candidate({ title: "b", category: "fintech", archetype: "hard-fact" }),
      candidate({ title: "c", category: "health", archetype: "hard-fact" }),
    ];
    const report = computeDiversityReport(cands, { bucketBy: "category" });
    expect(report.bucketBy).toBe("category");
    expect(report.dominantBucket).toBe("fintech");
    expect(report.counts.fintech).toBe(2);
    // archetype metrics computed regardless of bucketBy
    expect(report.distinctArchetypes).toBe(2);
    expect(report.dominantArchetype).toBe("hard-fact");
  });

  test("resolveBucket override drives the chosen distribution", () => {
    const cands = [candidate({ title: "alpha" }), candidate({ title: "beta" })];
    // Custom resolver: bucket by first letter of title.
    const report = computeDiversityReport(cands, {
      bucketBy: "category",
      resolveBucket: (c) => c.title.charAt(0),
    });
    expect(report.distinctBuckets).toBe(2);
    expect(report.counts.a).toBe(1);
    expect(report.counts.b).toBe(1);
  });
});

// ── Selector: capping + quality order ────────────────────────────────────────

describe("selectDiverse — capping", () => {
  test("dominant archetype is capped to ~maxBucketShare when alternatives exist", () => {
    // 6 hair-on-fire + 4 hard-fact, maxIdeas 6, share 0.5 => cap 3 per bucket.
    const cands = [
      ...Array.from({ length: 6 }, (_, i) =>
        candidate({ title: `hof-${i}`, archetype: "hair-on-fire", qualityScore: 5 - i * 0.1 }),
      ),
      ...Array.from({ length: 4 }, (_, i) =>
        candidate({ title: `hf-${i}`, archetype: "hard-fact", qualityScore: 4 - i * 0.1 }),
      ),
    ];
    const selected = selectDiverse(cands, {
      maxIdeas: 6,
      maxBucketShare: 0.5,
      bucketBy: "archetype",
    });
    expect(selected.length).toBe(6);
    const hof = selected.filter((c) => c.archetype === "hair-on-fire");
    expect(hof.length).toBeLessThanOrEqual(3);
    // and the alternative bucket got slots
    const hf = selected.filter((c) => c.archetype === "hard-fact");
    expect(hf.length).toBeGreaterThanOrEqual(3);
  });

  test("quality (input) order is respected within a bucket's cap", () => {
    const cands = [
      candidate({ title: "hof-best", archetype: "hair-on-fire", qualityScore: 5 }),
      candidate({ title: "hof-mid", archetype: "hair-on-fire", qualityScore: 4 }),
      candidate({ title: "hof-low", archetype: "hair-on-fire", qualityScore: 3 }),
      candidate({ title: "hf-1", archetype: "hard-fact", qualityScore: 2 }),
    ];
    // maxIdeas 4, share 0.5 => cap 2 for hair-on-fire.
    const selected = selectDiverse(cands, {
      maxIdeas: 4,
      maxBucketShare: 0.5,
      bucketBy: "archetype",
    });
    const hofTitles = selected.filter((c) => c.archetype === "hair-on-fire").map((c) => c.title);
    // The two ADMITTED-under-cap hof entries must be the two highest-quality.
    expect(hofTitles.slice(0, 2)).toEqual(["hof-best", "hof-mid"]);
  });
});

// ── Selector: anti-starvation invariant ──────────────────────────────────────

describe("selectDiverse — anti-starvation", () => {
  test("all one archetype, pool 8 > maxIdeas 5 => output length exactly 5", () => {
    const cands = Array.from({ length: 8 }, (_, i) =>
      candidate({ title: `x-${i}`, archetype: "future-vision", qualityScore: 5 - i * 0.1 }),
    );
    const selected = selectDiverse(cands, {
      maxIdeas: 5,
      maxBucketShare: 0.5,
      bucketBy: "archetype",
    });
    expect(selected.length).toBe(5);
    // back-fill preserves quality order
    expect(selected.map((c) => c.title)).toEqual(["x-0", "x-1", "x-2", "x-3", "x-4"]);
  });

  test("pool smaller than maxIdeas => returns whole pool (no padding, no constraint)", () => {
    const cands = [
      candidate({ title: "a", archetype: "hair-on-fire" }),
      candidate({ title: "b", archetype: "hair-on-fire" }),
      candidate({ title: "c", archetype: "hair-on-fire" }),
    ];
    const selected = selectDiverse(cands, {
      maxIdeas: 5,
      maxBucketShare: 0.5,
      bucketBy: "archetype",
    });
    expect(selected.length).toBe(3);
    expect(selected).toEqual(cands);
  });

  test("maxIdeas <= 0 => empty", () => {
    const cands = [candidate({ title: "a" }), candidate({ title: "b" })];
    expect(selectDiverse(cands, { maxIdeas: 0, maxBucketShare: 0.5, bucketBy: "archetype" })).toEqual(
      [],
    );
    expect(
      selectDiverse(cands, { maxIdeas: -3, maxBucketShare: 0.5, bucketBy: "archetype" }),
    ).toEqual([]);
  });

  test("single candidate => that candidate", () => {
    const only = candidate({ title: "solo", archetype: "hard-fact" });
    const selected = selectDiverse([only], {
      maxIdeas: 5,
      maxBucketShare: 0.5,
      bucketBy: "archetype",
    });
    expect(selected).toEqual([only]);
  });

  test("empty pool => empty", () => {
    expect(selectDiverse([], { maxIdeas: 5, maxBucketShare: 0.5, bucketBy: "archetype" })).toEqual(
      [],
    );
  });

  test("NaN maxBucketShare falls back to default share (no crash, still caps)", () => {
    const cands = [
      ...Array.from({ length: 6 }, (_, i) =>
        candidate({ title: `hof-${i}`, archetype: "hair-on-fire" }),
      ),
      ...Array.from({ length: 4 }, (_, i) =>
        candidate({ title: `hf-${i}`, archetype: "hard-fact" }),
      ),
    ];
    const selected = selectDiverse(cands, {
      maxIdeas: 6,
      maxBucketShare: Number.NaN,
      bucketBy: "archetype",
    });
    expect(selected.length).toBe(6);
    // default share 0.5 => cap 3 for the dominant bucket
    expect(selected.filter((c) => c.archetype === "hair-on-fire").length).toBeLessThanOrEqual(
      Math.ceil(6 * DEFAULT_MAX_BUCKET_SHARE),
    );
  });
});

// ── Generic selectDiverseBy (the SIGE path) ──────────────────────────────────

describe("selectDiverseBy — generic resolver (SIGE path)", () => {
  interface FakeScored {
    readonly id: string;
    readonly segment: string;
  }

  test("caps the dominant bucket via a custom resolver", () => {
    const items: FakeScored[] = [
      ...Array.from({ length: 6 }, (_, i) => ({ id: `b2b-${i}`, segment: "b2b_saas" })),
      ...Array.from({ length: 4 }, (_, i) => ({ id: `cons-${i}`, segment: "consumer" })),
    ];
    const selected = selectDiverseBy(items, {
      maxIdeas: 6,
      maxBucketShare: 0.5,
      resolveBucket: (it) => it.segment,
    });
    expect(selected.length).toBe(6);
    expect(selected.filter((it) => it.segment === "b2b_saas").length).toBeLessThanOrEqual(3);
  });

  test("anti-starvation holds for the generic path (all one bucket)", () => {
    const items: FakeScored[] = Array.from({ length: 7 }, (_, i) => ({
      id: `x-${i}`,
      segment: "devtools",
    }));
    const selected = selectDiverseBy(items, {
      maxIdeas: 5,
      maxBucketShare: 0.5,
      resolveBucket: (it) => it.segment,
    });
    expect(selected.length).toBe(5);
    expect(selected.map((it) => it.id)).toEqual(["x-0", "x-1", "x-2", "x-3", "x-4"]);
  });
});

// ── Immutability ─────────────────────────────────────────────────────────────

describe("immutability", () => {
  test("selectDiverse does not mutate the input array", () => {
    const cands = [
      candidate({ title: "a", archetype: "hair-on-fire" }),
      candidate({ title: "b", archetype: "hair-on-fire" }),
      candidate({ title: "c", archetype: "hard-fact" }),
    ];
    const snapshot = [...cands];
    selectDiverse(cands, { maxIdeas: 2, maxBucketShare: 0.5, bucketBy: "archetype" });
    expect(cands).toEqual(snapshot);
  });
});
