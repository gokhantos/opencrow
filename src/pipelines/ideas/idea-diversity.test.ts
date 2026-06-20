import { describe, expect, test } from "bun:test";
import type { Archetype } from "./giant";
import {
  computeDiversityReport,
  DEFAULT_MAX_BUCKET_SHARE,
  normalizeAnchorFingerprint,
  resolveSeedBuckets,
  selectDiverse,
  selectDiverseBy,
  selectDiverseByKeys,
  selectDiverseBySignals,
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

// ── Signal/seed key derivation: resolveSeedBuckets ───────────────────────────

describe("resolveSeedBuckets — key derivation", () => {
  test("prefers cited supportingSignalIds (lowercased, deduped, prefixed)", () => {
    const c = candidate({
      title: "x",
      supportingSignalIds: ["HN_3", "hn_3", "producthunt_1"],
    });
    expect([...resolveSeedBuckets(c)].sort()).toEqual(["sig:hn_3", "sig:producthunt_1"]);
  });

  test("falls back to normalized trendIntersection fingerprint when no signal ids", () => {
    const c = candidate({
      title: "x",
      trendIntersection: "Trending AI + Pain scheduling + Capability calendar",
    });
    expect(resolveSeedBuckets(c)).toEqual(["anchor:ai calendar scheduling"]);
  });

  test("near-identical anchors collapse to the same fingerprint", () => {
    const a = candidate({ title: "a", trendIntersection: "AI scheduling, calendar" });
    const b = candidate({
      title: "b",
      trendIntersection: "Calendar — AI Scheduling!!!",
    });
    expect(resolveSeedBuckets(a)).toEqual(resolveSeedBuckets(b));
  });

  test("falls back to segment when no signal ids and no anchor", () => {
    const c = candidate({ title: "x", segment: "devtools" });
    expect(resolveSeedBuckets(c)).toEqual(["seg:devtools"]);
  });

  test("returns [] when nothing identifies a seed (unconstrained)", () => {
    expect(resolveSeedBuckets(candidate({ title: "x" }))).toEqual([]);
  });

  test("empty signal-id strings are ignored; falls through to anchor", () => {
    const c = candidate({
      title: "x",
      supportingSignalIds: ["", "   "],
      trendIntersection: "AI calendar",
    });
    expect(resolveSeedBuckets(c)).toEqual(["anchor:ai calendar"]);
  });
});

describe("normalizeAnchorFingerprint", () => {
  test("strips template stop-tokens and 1-char noise, keeps 2-char domain tokens, sorts", () => {
    // Template words (trending/pain/capability) and single-char placeholders
    // (X, Y) drop; the 2-char domain acronym "ai" survives.
    expect(normalizeAnchorFingerprint("Trending AI + Pain X + Capability Y")).toBe("ai");
    expect(normalizeAnchorFingerprint("Trending healthcare and scheduling")).toBe(
      "healthcare scheduling",
    );
  });
  test("all-noise / empty anchor => empty string", () => {
    expect(normalizeAnchorFingerprint("")).toBe("");
    expect(normalizeAnchorFingerprint("the and for")).toBe("");
  });
});

// ── Signal-overlap selector: selectDiverseByKeys / selectDiverseBySignals ─────

describe("selectDiverseByKeys — set-membership overlap cap", () => {
  test("signal-overlap cap defers excess ideas sharing a signal over cap", () => {
    // 6 items, maxIdeas 6 won't engage (pool == slice). Use a pool > slice.
    const items = [
      { id: "a", keys: ["s1"] },
      { id: "b", keys: ["s1"] },
      { id: "c", keys: ["s1"] }, // 3rd s1 -> over cap (cap=ceil(4*0.34)=2)
      { id: "d", keys: ["s1"] }, // 4th s1 -> over cap
      { id: "e", keys: ["s2"] },
      { id: "f", keys: ["s3"] },
    ];
    const kept = selectDiverseByKeys(items, {
      maxIdeas: 4,
      maxKeyShare: 0.34, // cap = ceil(4*0.34) = 2
      resolveKeys: (i) => i.keys,
    });
    expect(kept.length).toBe(4); // anti-starvation: slice size preserved
    // Only 2 of the s1-sharing items admitted under the cap before back-fill;
    // back-fill then adds 2 deferred s1 items to fill the slice -> here e,f admit
    // first by cap, so the kept set is a,b (s1 cap) + e + f.
    const ids = kept.map((k) => k.id);
    expect(ids).toContain("a");
    expect(ids).toContain("b");
    expect(ids).toContain("e");
    expect(ids).toContain("f");
    // c and d (3rd/4th s1) were deferred, not admitted in the capped pass.
    expect(ids).not.toContain("c");
    expect(ids).not.toContain("d");
  });

  test("anti-starvation: back-fills deferred items so output never shrinks", () => {
    // All 5 items share one signal; cap is 2, slice is 4. Back-fill must still
    // reach 4 by re-admitting deferred items.
    const items = Array.from({ length: 5 }, (_, i) => ({ id: `i${i}`, keys: ["only"] }));
    const kept = selectDiverseByKeys(items, {
      maxIdeas: 4,
      maxKeyShare: 0.34,
      resolveKeys: (i) => i.keys,
    });
    expect(kept.length).toBe(4);
    // First-4 input order preserved (deterministic, stable).
    expect(kept.map((k) => k.id)).toEqual(["i0", "i1", "i2", "i3"]);
  });

  test("items with NO keys are unconstrained and admitted in order", () => {
    const items = [
      { id: "a", keys: [] as string[] },
      { id: "b", keys: [] as string[] },
      { id: "c", keys: [] as string[] },
      { id: "d", keys: ["s"] },
      { id: "e", keys: ["s"] },
    ];
    const kept = selectDiverseByKeys(items, {
      maxIdeas: 4,
      maxKeyShare: 0.34, // cap=2 for "s"
      resolveKeys: (i) => i.keys,
    });
    expect(kept.length).toBe(4);
    expect(kept.map((k) => k.id)).toEqual(["a", "b", "c", "d"]);
  });

  test("maxIdeas <= 0 => [] ; pool <= slice => returned whole", () => {
    const items = [{ id: "a", keys: ["s"] }];
    expect(selectDiverseByKeys(items, { maxIdeas: 0, maxKeyShare: 0.5, resolveKeys: (i) => i.keys })).toEqual([]);
    expect(
      selectDiverseByKeys(items, { maxIdeas: 4, maxKeyShare: 0.5, resolveKeys: (i) => i.keys }),
    ).toEqual(items);
  });

  test("does not mutate the input", () => {
    const items = [
      { id: "a", keys: ["s"] },
      { id: "b", keys: ["s"] },
      { id: "c", keys: ["s"] },
    ];
    const snapshot = [...items];
    selectDiverseByKeys(items, { maxIdeas: 2, maxKeyShare: 0.5, resolveKeys: (i) => i.keys });
    expect(items).toEqual(snapshot);
  });
});

describe("selectDiverseBySignals — candidate signal guard", () => {
  function sig(title: string, ids: readonly string[]): GeneratedIdeaCandidate {
    return candidate({ title, supportingSignalIds: ids });
  }

  test("caps a single source signal's share of the kept set (defers reskins)", () => {
    // 6 candidates all citing one seed s1 + a distinct second seed each.
    const cands = [
      sig("a", ["s1", "p1"]),
      sig("b", ["s1", "p2"]),
      sig("c", ["s1", "p3"]),
      sig("d", ["s1", "p4"]),
      sig("e", ["s2", "p5"]),
      sig("f", ["s3", "p6"]),
    ];
    const kept = selectDiverseBySignals(cands, { maxIdeas: 6, maxSignalShare: 0.34 });
    // pool (6) == slice (6) -> returned whole. Use maxIdeas < pool to engage.
    expect(kept.length).toBe(6);

    const kept2 = selectDiverseBySignals(cands, { maxIdeas: 4, maxSignalShare: 0.34 });
    // cap for s1 = ceil(4*0.34)=2 -> at most 2 of a..d (s1) admitted in capped pass.
    const s1count = kept2.filter((c) => (c.supportingSignalIds ?? []).includes("s1")).length;
    expect(kept2.length).toBe(4);
    // s1 share capped at 2 in the capped pass; e (s2) + f (s3) fill the rest.
    expect(s1count).toBeLessThanOrEqual(2);
    expect(kept2.map((c) => c.title)).toContain("e");
    expect(kept2.map((c) => c.title)).toContain("f");
  });

  test("falls back to trendIntersection fingerprint when no signal ids", () => {
    const cands = [
      candidate({ title: "a", trendIntersection: "AI scheduling calendar" }),
      candidate({ title: "b", trendIntersection: "Calendar AI Scheduling" }), // same fp
      candidate({ title: "c", trendIntersection: "AI scheduling calendar" }), // same fp
      candidate({ title: "d", trendIntersection: "fintech invoicing" }),
      candidate({ title: "e", trendIntersection: "healthcare triage" }),
    ];
    const kept = selectDiverseBySignals(cands, { maxIdeas: 4, maxSignalShare: 0.34 });
    expect(kept.length).toBe(4);
    // cap for the shared anchor fp = ceil(4*0.34)=2 -> at most 2 of a,b,c admitted
    // in the capped pass; d + e fill in.
    const sharedFp = kept.filter((c) =>
      normalizeAnchorFingerprint(c.trendIntersection) === "ai calendar scheduling",
    ).length;
    expect(sharedFp).toBeLessThanOrEqual(2);
    expect(kept.map((c) => c.title)).toContain("d");
    expect(kept.map((c) => c.title)).toContain("e");
  });

  test("composes with the archetype guard (apply both, signal after archetype)", () => {
    // 6-candidate POOL, slice 4 (pool > slice so the share caps engage — this
    // mirrors the pipeline wiring, which feeds the guards a pool larger than
    // maxIdeas). 4 share signal s1 across 3 archetypes; 2 are distinct.
    const pool = [
      candidate({ title: "a", archetype: "hair-on-fire", supportingSignalIds: ["s1"] }),
      candidate({ title: "b", archetype: "hard-fact", supportingSignalIds: ["s1"] }),
      candidate({ title: "c", archetype: "future-vision", supportingSignalIds: ["s1"] }),
      candidate({ title: "d", archetype: "hair-on-fire", supportingSignalIds: ["s1"] }),
      candidate({ title: "e", archetype: "hard-fact", supportingSignalIds: ["s2"] }),
      candidate({ title: "f", archetype: "future-vision", supportingSignalIds: ["s3"] }),
    ];
    // Archetype guard (share 0.5, maxIdeas 4 -> cap 2 per archetype) keeps a
    // diverse-by-archetype 4 — but s1 can still dominate (different archetypes).
    const afterArchetype = selectDiverse(pool, {
      maxIdeas: 4,
      maxBucketShare: 0.5,
      bucketBy: "archetype",
    });
    expect(afterArchetype.length).toBe(4);
    // Compose the signal guard over a pool seeded by the archetype picks first,
    // followed by the remaining pool as back-fill — exactly the pipeline wiring.
    const archetypeKept = new Set(afterArchetype);
    const signalPool = [...afterArchetype, ...pool.filter((c) => !archetypeKept.has(c))];
    const afterBoth = selectDiverseBySignals(signalPool, {
      maxIdeas: 4,
      maxSignalShare: 0.34, // s1 capped at ceil(4*0.34)=2
    });
    expect(afterBoth.length).toBe(4); // anti-starvation holds through composition
    const s1count = afterBoth.filter((c) => (c.supportingSignalIds ?? []).includes("s1")).length;
    expect(s1count).toBeLessThanOrEqual(2);
    // The distinct-signal alternatives were pulled in to dilute the s1 monoculture.
    expect(afterBoth.map((c) => c.title)).toContain("e");
    expect(afterBoth.map((c) => c.title)).toContain("f");
  });

  test("anti-starvation: never shrinks below slice even when all share one signal", () => {
    const cands = Array.from({ length: 5 }, (_, i) => sig(`i${i}`, ["only"]));
    const kept = selectDiverseBySignals(cands, { maxIdeas: 4, maxSignalShare: 0.34 });
    expect(kept.length).toBe(4);
  });
});

// ── Report: dominant-signal metrics ──────────────────────────────────────────

describe("computeDiversityReport — dominant signal", () => {
  test("reports dominant source signal + share (membership counts)", () => {
    const cands = [
      candidate({ title: "a", supportingSignalIds: ["s1"] }),
      candidate({ title: "b", supportingSignalIds: ["s1"] }),
      candidate({ title: "c", supportingSignalIds: ["s2"] }),
      candidate({ title: "d", supportingSignalIds: ["s1", "s3"] }),
    ];
    const report = computeDiversityReport(cands);
    expect(report.dominantSignal).toBe("sig:s1"); // in 3 of 4 ideas
    expect(report.dominantSignalShare).toBeCloseTo(3 / 4, 6);
    expect(report.distinctSignals).toBe(3); // s1, s2, s3
  });

  test("empty pool => dominantSignal '' , share 0", () => {
    const report = computeDiversityReport([]);
    expect(report.dominantSignal).toBe("");
    expect(report.dominantSignalShare).toBe(0);
    expect(report.distinctSignals).toBe(0);
  });
});
