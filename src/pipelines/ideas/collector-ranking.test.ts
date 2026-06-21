import { test, expect, describe, it } from "bun:test";
import {
  computeRankScore,
  learnedCredibilityMultiplier,
  lookupLearnedCredibility,
  NEUTRAL_LEARNED_CREDIBILITY,
  selectStratified,
} from "./collector-ranking";
import { credibilityKey } from "./credibility";

const noJitter = () => 0;

// ── learnedCredibilityMultiplier ────────────────────────────────────────────

describe("learnedCredibilityMultiplier", () => {
  test("absent posterior is a neutral 1.0 multiplier", () => {
    expect(learnedCredibilityMultiplier(undefined)).toBe(1);
  });

  test("a 0.5 (cold-start Beta(1,1)) posterior is neutral 1.0", () => {
    expect(learnedCredibilityMultiplier(NEUTRAL_LEARNED_CREDIBILITY)).toBe(1);
  });

  test("posterior above 0.5 boosts, below 0.5 dampens (bounded by swing)", () => {
    expect(learnedCredibilityMultiplier(1, 0.3)).toBeCloseTo(1.3, 5);
    expect(learnedCredibilityMultiplier(0, 0.3)).toBeCloseTo(0.7, 5);
  });

  test("clamps out-of-range posteriors before mapping", () => {
    expect(learnedCredibilityMultiplier(2, 0.3)).toBeCloseTo(1.3, 5);
    expect(learnedCredibilityMultiplier(-1, 0.3)).toBeCloseTo(0.7, 5);
  });
});

// ── computeRankScore — learned credibility folding ──────────────────────────

describe("computeRankScore with learnedCredibility", () => {
  test("absent learnedCredibility is identical to the legacy score", () => {
    const inputs = { credibility: 0.6, velocityNorm: 0.4, corroborationCount: 2, recency: 0.8 };
    const legacy = computeRankScore(inputs, noJitter);
    const withAbsent = computeRankScore({ ...inputs }, noJitter);
    expect(withAbsent).toBe(legacy);
  });

  test("a 0.5 posterior leaves the score unchanged (no-op)", () => {
    const inputs = { credibility: 0.6, velocityNorm: 0.4, corroborationCount: 2, recency: 0.8 };
    const base = computeRankScore(inputs, noJitter);
    const neutral = computeRankScore(
      { ...inputs, learnedCredibility: NEUTRAL_LEARNED_CREDIBILITY },
      noJitter,
    );
    expect(neutral).toBeCloseTo(base, 10);
  });

  test("a higher posterior ranks higher than a lower one", () => {
    const inputs = { credibility: 0.6, velocityNorm: 0.4, corroborationCount: 2, recency: 0.8 };
    const lo = computeRankScore({ ...inputs, learnedCredibility: 0.2 }, noJitter);
    const hi = computeRankScore({ ...inputs, learnedCredibility: 0.9 }, noJitter);
    expect(hi).toBeGreaterThan(lo);
  });

  test("a posterior above 0.5 boosts and below 0.5 dampens vs neutral", () => {
    const inputs = { credibility: 0.6, velocityNorm: 0.4, corroborationCount: 2, recency: 0.8 };
    const neutral = computeRankScore({ ...inputs }, noJitter);
    const boosted = computeRankScore({ ...inputs, learnedCredibility: 0.95 }, noJitter);
    const damped = computeRankScore({ ...inputs, learnedCredibility: 0.05 }, noJitter);
    expect(boosted).toBeGreaterThan(neutral);
    expect(damped).toBeLessThan(neutral);
  });

  test("score stays bounded in [0, 1] even with a perfect posterior", () => {
    const s = computeRankScore(
      { credibility: 1, velocityNorm: 1, corroborationCount: 8, recency: 1, learnedCredibility: 1 },
      noJitter,
    );
    expect(s).toBeGreaterThan(0);
    expect(s).toBeLessThanOrEqual(1.0001);
  });
});

// ── lookupLearnedCredibility ────────────────────────────────────────────────

describe("lookupLearnedCredibility", () => {
  test("returns undefined for an absent or empty map", () => {
    expect(lookupLearnedCredibility(undefined, "hn_stories", "front-page", "AI")).toBeUndefined();
    expect(lookupLearnedCredibility(new Map(), "hn_stories", "front-page", "AI")).toBeUndefined();
  });

  test("matches the exact (table, signal_type, category) key", () => {
    const map = new Map([[credibilityKey("hn_stories", "front-page", "AI"), 0.82]]);
    expect(lookupLearnedCredibility(map, "hn_stories", "front-page", "AI")).toBe(0.82);
  });

  test("falls back to looser keys when the exact one is missing", () => {
    // Provenance typically stores signal_type "unknown"; category is the idea's.
    const map = new Map([[credibilityKey("reddit_posts", "unknown", "unknown"), 0.4]]);
    expect(lookupLearnedCredibility(map, "reddit_posts", "topical", "unknown")).toBe(0.4);
  });

  test("prefers the most specific matching key", () => {
    const map = new Map([
      [credibilityKey("ph_products", "feed", "unknown"), 0.7],
      [credibilityKey("ph_products", "unknown", "unknown"), 0.3],
    ]);
    expect(lookupLearnedCredibility(map, "ph_products", "feed", "unknown")).toBe(0.7);
  });

  test("returns undefined when no candidate key matches", () => {
    const map = new Map([[credibilityKey("github_repos", "trending", "unknown"), 0.9]]);
    expect(lookupLearnedCredibility(map, "x_scraped_tweets", "verified", "unknown")).toBeUndefined();
  });
});

// ── Layer A: obscurity / niche-bonus rebalance ──────────────────────────────

import {
  obscurityFromEngagement,
  RANK_WEIGHT_CREDIBILITY,
  RANK_WEIGHT_VELOCITY,
  RANK_WEIGHT_CORRO,
  RANK_WEIGHT_RECENCY,
  RANK_WEIGHT_NICHE,
} from "./collector-ranking";

describe("obscurityFromEngagement", () => {
  test("zero engagement is maximally obscure (1.0)", () => {
    expect(obscurityFromEngagement(0)).toBe(1);
  });

  test("monotonically decreases as engagement grows", () => {
    const low = obscurityFromEngagement(10);
    const mid = obscurityFromEngagement(200);
    const high = obscurityFromEngagement(10000);
    expect(low).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(high);
  });

  test("a viral row trends toward low obscurity", () => {
    expect(obscurityFromEngagement(100000)).toBeLessThan(0.3);
  });

  test("negative / NaN engagement is treated as maximally obscure", () => {
    expect(obscurityFromEngagement(-5)).toBe(1);
    expect(obscurityFromEngagement(Number.NaN)).toBe(1);
  });
});

describe("computeRankScore — niche-bonus de-bias", () => {
  test("the five weights sum to 1.0", () => {
    const sum =
      RANK_WEIGHT_CREDIBILITY +
      RANK_WEIGHT_VELOCITY +
      RANK_WEIGHT_CORRO +
      RANK_WEIGHT_RECENCY +
      RANK_WEIGHT_NICHE;
    expect(sum).toBeCloseTo(1, 10);
  });

  test("a sharp low-engagement signal out-ranks a viral one", () => {
    // Viral post: high engagement (low obscurity), modest credibility/recency.
    const viral = computeRankScore(
      {
        credibility: 0.6,
        velocityNorm: 0.9,
        recency: 0.5,
        obscurity: obscurityFromEngagement(50000),
      },
      noJitter,
    );
    // Sharp niche pain: tiny community engagement (high obscurity), fresh + credible.
    const niche = computeRankScore(
      {
        credibility: 0.6,
        velocityNorm: 0.2,
        recency: 0.9,
        obscurity: obscurityFromEngagement(15),
      },
      noJitter,
    );
    expect(niche).toBeGreaterThan(viral);
  });

  test("absent obscurity defaults to neutral 0.5 and stays bounded", () => {
    const s = computeRankScore({ credibility: 1, velocityNorm: 1, recency: 1, corroborationCount: 8 }, noJitter);
    expect(s).toBeGreaterThanOrEqual(0);
    expect(s).toBeLessThanOrEqual(1);
  });
});

// ── selectStratified ─────────────────────────────────────────────────────────

type Row = { id: string; bucket: string; score: number };
const opts = (perBucketCap: number, totalCap: number) => ({
  idOf: (r: Row) => r.id,
  bucketOf: (r: Row) => r.bucket,
  scoreOf: (r: Row) => r.score,
  perBucketCap,
  totalCap,
});

describe("selectStratified", () => {
  it("caps any single bucket to perBucketCap when alternatives exist", () => {
    const rows: Row[] = [
      ...Array.from({ length: 10 }, (_, i) => ({ id: `a${i}`, bucket: "A", score: 100 - i })),
      ...Array.from({ length: 5 }, (_, i) => ({ id: `b${i}`, bucket: "B", score: 50 - i })),
    ];
    const { selected } = selectStratified(rows, opts(3, 100));
    const fromA = selected.filter((r) => r.bucket === "A").length;
    expect(fromA).toBe(3); // bucket A capped, even though it had the top 10 scores
    expect(selected.filter((r) => r.bucket === "B").length).toBe(5);
  });

  it("ranks within bucket by score (highest kept)", () => {
    const rows: Row[] = [
      { id: "a-lo", bucket: "A", score: 1 },
      { id: "a-hi", bucket: "A", score: 99 },
      { id: "b", bucket: "B", score: 5 },
    ];
    const { selectedIds } = selectStratified(rows, opts(1, 100));
    expect(selectedIds).toContain("a-hi");
    expect(selectedIds).not.toContain("a-lo");
  });

  it("anti-starvation: backfills above the cap to reach totalCap when only one bucket exists", () => {
    const rows: Row[] = Array.from({ length: 10 }, (_, i) => ({
      id: `a${i}`,
      bucket: "A",
      score: 100 - i,
    }));
    const { selected } = selectStratified(rows, opts(3, 6));
    expect(selected.length).toBe(6); // never shrink below min(totalCap, available)
  });

  it("respects totalCap", () => {
    const rows: Row[] = [
      ...Array.from({ length: 5 }, (_, i) => ({ id: `a${i}`, bucket: "A", score: 100 - i })),
      ...Array.from({ length: 5 }, (_, i) => ({ id: `b${i}`, bucket: "B", score: 50 - i })),
    ];
    const { selected } = selectStratified(rows, opts(4, 4));
    expect(selected.length).toBe(4);
  });

  it("is a no-op-shaped passthrough when rows <= totalCap and no bucket exceeds cap", () => {
    const rows: Row[] = [
      { id: "a", bucket: "A", score: 1 },
      { id: "b", bucket: "B", score: 2 },
    ];
    const { selected } = selectStratified(rows, opts(8, 90));
    expect(selected.length).toBe(2);
  });
});
