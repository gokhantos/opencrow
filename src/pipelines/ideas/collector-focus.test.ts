import { test, expect, describe } from "bun:test";
import {
  selectFocusCategories,
  buildPainSeedSummary,
  isEchoChamberSignal,
  normalizeCategory,
  META_SUBREDDITS,
  type CategoryStat,
} from "./collector-focus";

// A small distribution: a couple of acute low-rated heads + a broad mid/long tail.
const STATS: readonly CategoryStat[] = [
  { category: "Business", avgRating: 2.2, complaintRatio: 4.0 },
  { category: "Finance", avgRating: 2.5, complaintRatio: 3.0 },
  { category: "Productivity", avgRating: 2.8, complaintRatio: 2.0 },
  { category: "Health & Fitness", avgRating: 3.4, complaintRatio: 1.5 },
  { category: "Education", avgRating: 3.6, complaintRatio: 1.2 },
  { category: "Travel", avgRating: 3.8, complaintRatio: 1.0 },
  { category: "Games", avgRating: 4.0, complaintRatio: 0.8 },
  { category: "Music", avgRating: 4.1, complaintRatio: 0.7 },
  { category: "Photo & Video", avgRating: 4.2, complaintRatio: 0.6 },
  { category: "Weather", avgRating: 4.3, complaintRatio: 0.5 },
];

// ── Lever 1: selectFocusCategories ───────────────────────────────────────────

describe("selectFocusCategories", () => {
  test("keeps the high-opportunity head (lowest rating leads)", () => {
    const out = selectFocusCategories({
      stats: STATS,
      spread: 6,
      highOpportunitySlice: 3,
      rotationSeed: 1,
    });
    // The 3 lowest-rated categories must be the head, in opportunity order.
    expect(out.slice(0, 3)).toEqual(["Business", "Finance", "Productivity"]);
    expect(out).toHaveLength(6);
  });

  test("consecutive runs (different seeds) ROTATE the tail (not identical)", () => {
    const runA = selectFocusCategories({
      stats: STATS,
      spread: 6,
      highOpportunitySlice: 3,
      rotationSeed: 1001,
    });
    const runB = selectFocusCategories({
      stats: STATS,
      spread: 6,
      highOpportunitySlice: 3,
      rotationSeed: 2002,
    });
    // Heads stay (acute pain), but the rotated tail must differ across runs.
    expect(runA.slice(0, 3)).toEqual(runB.slice(0, 3));
    expect(runA.slice(3)).not.toEqual(runB.slice(3));
  });

  test("is deterministic for a fixed seed", () => {
    const a = selectFocusCategories({ stats: STATS, spread: 6, highOpportunitySlice: 3, rotationSeed: 42 });
    const b = selectFocusCategories({ stats: STATS, spread: 6, highOpportunitySlice: 3, rotationSeed: 42 });
    expect(a).toEqual(b);
  });

  test("de-prioritizes recently-anchored categories in the rotated tail", () => {
    // Anchor every tail category EXCEPT one fresh corner; with rotation it should
    // surface the un-anchored one over the penalized ones.
    const anchored = ["Health & Fitness", "Education", "Travel", "Games", "Music", "Photo & Video"];
    const out = selectFocusCategories({
      stats: STATS,
      spread: 4,
      highOpportunitySlice: 3,
      rotationSeed: 7,
      recentlyAnchored: anchored,
    });
    // Weather is the only un-anchored tail category → it must take the 4th slot.
    expect(out).toHaveLength(4);
    expect(out[3]).toBe("Weather");
  });

  test("never exceeds the requested spread and de-dupes by normalized category", () => {
    const dup: readonly CategoryStat[] = [
      { category: "Business", avgRating: 2.2, complaintRatio: 4 },
      { category: "business", avgRating: 2.3, complaintRatio: 3 },
      { category: "Finance", avgRating: 2.5, complaintRatio: 2 },
    ];
    const out = selectFocusCategories({ stats: dup, spread: 5, highOpportunitySlice: 2, rotationSeed: 1 });
    expect(out).toEqual(["Business", "Finance"]);
  });

  test("empty stats or zero spread returns empty", () => {
    expect(selectFocusCategories({ stats: [], spread: 6, highOpportunitySlice: 3, rotationSeed: 1 })).toEqual([]);
    expect(selectFocusCategories({ stats: STATS, spread: 0, highOpportunitySlice: 0, rotationSeed: 1 })).toEqual([]);
  });

  test("normalizeCategory lowercases and trims", () => {
    expect(normalizeCategory("  Business ")).toBe("business");
  });
});

// ── Lever 2: buildPainSeedSummary ────────────────────────────────────────────

describe("buildPainSeedSummary", () => {
  const themes = [
    {
      name: "Sync conflicts lose edits",
      description: "Users report concurrent edits silently overwriting each other",
      frequency: "very_common" as const,
      affectedApps: ["AppA", "AppB", "AppC", "AppD"],
    },
    {
      name: "Opaque subscription billing",
      description: "Surprise charges with no cancellation path",
      frequency: "common" as const,
      affectedApps: ["AppE"],
    },
  ];

  test("leads with specific pain themes ahead of the category aggregate", () => {
    const out = buildPainSeedSummary(themes, "=== BUSINESS (340 complaints) ===");
    const themeIdx = out.indexOf("Sync conflicts lose edits");
    const catIdx = out.indexOf("=== BUSINESS");
    expect(themeIdx).toBeGreaterThanOrEqual(0);
    expect(catIdx).toBeGreaterThan(themeIdx);
    expect(out).toContain("PRIMARY pain seed");
    expect(out).toContain("BACKGROUND context only");
  });

  test("caps affected apps to 3 in the rendered theme line", () => {
    const out = buildPainSeedSummary(themes, "");
    expect(out).toContain("seen in: AppA, AppB, AppC");
    expect(out).not.toContain("AppD");
  });

  test("falls back to the raw category summary when no themes", () => {
    expect(buildPainSeedSummary([], "raw category summary")).toBe("raw category summary");
  });

  test("respects the maxThemes cap", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      name: `theme-${i}`,
      description: "d",
      frequency: "emerging" as const,
      affectedApps: [],
    }));
    const out = buildPainSeedSummary(many, "", 5);
    expect(out).toContain("theme-4");
    expect(out).not.toContain("theme-5");
  });
});

// ── Lever 3: isEchoChamberSignal ─────────────────────────────────────────────

describe("isEchoChamberSignal", () => {
  test("flags curated meta subreddits (case-insensitive)", () => {
    expect(isEchoChamberSignal({ subreddit: "vibecoding" })).toBe(true);
    expect(isEchoChamberSignal({ subreddit: "ClaudeCode" })).toBe(true);
    expect(isEchoChamberSignal({ subreddit: "SaaS" })).toBe(true);
  });

  test("does NOT flag a genuine end-user subreddit", () => {
    expect(isEchoChamberSignal({ subreddit: "smallbusiness" })).toBe(false);
    expect(isEchoChamberSignal({ subreddit: "fitness" })).toBe(false);
  });

  test("flags generic AI-agent/LLM-framework phrases in tag or text", () => {
    expect(isEchoChamberSignal({ tag: "ai-agent llm", text: "An agent framework" })).toBe(true);
    expect(isEchoChamberSignal({ text: "the first agent-native runtime" })).toBe(true);
    expect(isEchoChamberSignal({ text: "model context protocol server" })).toBe(true);
  });

  test("does NOT flag a real product signal", () => {
    expect(isEchoChamberSignal({ subreddit: "personalfinance", text: "Budget tracker for freelancers" })).toBe(false);
    expect(isEchoChamberSignal({ tag: "fitness health", text: "Sleep tracking watch app" })).toBe(false);
  });

  test("empty input is not echo chamber", () => {
    expect(isEchoChamberSignal({})).toBe(false);
    expect(isEchoChamberSignal({ subreddit: null, tag: null, text: null })).toBe(false);
  });

  test("META_SUBREDDITS is non-trivial and lowercased", () => {
    expect(META_SUBREDDITS.size).toBeGreaterThan(10);
    for (const s of META_SUBREDDITS) expect(s).toBe(s.toLowerCase());
  });

  // Mirrors the scanCapabilities scoring branch: a meta candidate's score is
  // multiplied by echoChamberFactor (REDUCED, not eliminated) so it drops in
  // rank but still appears. This pins the lever-3 ordering effect without a DB.
  test("down-weight (factor 0.5) reorders rank yet keeps meta signals present", () => {
    const factor = 0.5;
    const candidates = [
      { id: "meta-hi", baseScore: 1.0, ec: { tag: "ai-agent", text: "agent framework" } },
      { id: "real-mid", baseScore: 0.8, ec: { subreddit: "personalfinance", text: "budget app" } },
      { id: "meta-mid", baseScore: 0.7, ec: { subreddit: "vibecoding" } },
      { id: "real-lo", baseScore: 0.4, ec: { subreddit: "smallbusiness", text: "invoicing tool" } },
    ];
    const score = (c: (typeof candidates)[number]): number =>
      isEchoChamberSignal(c.ec) ? c.baseScore * factor : c.baseScore;
    const ranked = [...candidates].sort((a, b) => score(b) - score(a)).map((c) => c.id);
    // Before: meta-hi (1.0) would lead. After down-weight (0.5) it falls to 0.5,
    // so the real signal (0.8) leads and the meta signal drops but stays in the pool.
    expect(ranked[0]).toBe("real-mid");
    expect(ranked).toContain("meta-hi"); // reduced, not removed
    expect(score(candidates[0]!)).toBeCloseTo(0.5, 10);
  });
});

// ── Task 5 regression: focusRotation pain-pick wiring ────────────────────────
// Verifies that the selectFocusCategories helper (wired via seedDiversity.focusRotation
// in pipeline.ts) prevents the pain-pick from collapsing into a monoculture.
// Two properties must hold:
//   1. HIGH-OPPORTUNITY HEAD is STABLE across seeds (no monoculture of a lucky tail).
//   2. ROTATED TAIL differs between runs with distinct seeds (no anchored monoculture).

describe("focusRotation regression — pain-pick non-monoculture", () => {
  // A distribution that mirrors real production shape: 2 clearly acute categories,
  // followed by a long mid-tail of reasonable-but-not-great ones.
  const PROD_LIKE_STATS: readonly CategoryStat[] = [
    { category: "Navigation", avgRating: 2.1, complaintRatio: 5.0 },
    { category: "Health & Fitness", avgRating: 2.6, complaintRatio: 3.5 },
    { category: "Finance", avgRating: 3.1, complaintRatio: 2.0 },
    { category: "Business", avgRating: 3.3, complaintRatio: 1.8 },
    { category: "Education", avgRating: 3.5, complaintRatio: 1.5 },
    { category: "Travel", avgRating: 3.7, complaintRatio: 1.2 },
    { category: "Productivity", avgRating: 3.8, complaintRatio: 1.1 },
    { category: "Food & Drink", avgRating: 3.9, complaintRatio: 1.0 },
    { category: "Entertainment", avgRating: 4.0, complaintRatio: 0.9 },
    { category: "Sports", avgRating: 4.1, complaintRatio: 0.8 },
    { category: "Lifestyle", avgRating: 4.2, complaintRatio: 0.7 },
    { category: "Photo & Video", avgRating: 4.3, complaintRatio: 0.6 },
  ];

  test("high-opportunity head is stable regardless of rotation seed", () => {
    // The 2-category head (lowest-rated) must be identical no matter which seed
    // the run uses — acuteness is objective, not luck of the draw.
    const seeds = [1, 42, 999, 1_000_001];
    const heads = seeds.map(
      (seed) =>
        selectFocusCategories({
          stats: PROD_LIKE_STATS,
          spread: 6,
          highOpportunitySlice: 2,
          rotationSeed: seed,
        }).slice(0, 2),
    );
    for (const head of heads) {
      expect(head).toEqual(["Navigation", "Health & Fitness"]);
    }
  });

  test("rotated tail differs across distinct run seeds (no monoculture)", () => {
    // With 10 tail candidates and spread=6 (4 tail slots), the probability of two
    // independent runs choosing the same 4 by chance is negligible — if they
    // always match, focusRotation is broken/unwired.
    const pickTail = (seed: number): readonly string[] =>
      selectFocusCategories({
        stats: PROD_LIKE_STATS,
        spread: 6,
        highOpportunitySlice: 2,
        rotationSeed: seed,
      }).slice(2);

    const tailA = pickTail(100);
    const tailB = pickTail(200);
    const tailC = pickTail(300);

    // At least one pair of runs must differ in their tail selection.
    const allIdentical =
      JSON.stringify(tailA) === JSON.stringify(tailB) &&
      JSON.stringify(tailB) === JSON.stringify(tailC);
    expect(allIdentical).toBe(false);
  });

  test("all-head spread (spread === highOpportunitySlice) is stable — no tail to rotate", () => {
    // When the spread equals the head slice, every slot is a high-opportunity pick.
    // The result must be purely opportunity-ordered, identical across seeds.
    const base = selectFocusCategories({
      stats: PROD_LIKE_STATS,
      spread: 2,
      highOpportunitySlice: 2,
      rotationSeed: 1,
    });
    const other = selectFocusCategories({
      stats: PROD_LIKE_STATS,
      spread: 2,
      highOpportunitySlice: 2,
      rotationSeed: 9_999_999,
    });
    expect(base).toEqual(["Navigation", "Health & Fitness"]);
    expect(base).toEqual(other);
  });

  test("recentlyAnchored pushes saturated categories out of the rotated tail", () => {
    // Anchor 9 of the 10 tail categories — only "Sports" is fresh.
    // The 3-slot result (2 head + 1 tail) must include "Sports".
    const anchored = [
      "Finance",
      "Business",
      "Education",
      "Travel",
      "Productivity",
      "Food & Drink",
      "Entertainment",
      "Lifestyle",
      "Photo & Video",
    ];
    const out = selectFocusCategories({
      stats: PROD_LIKE_STATS,
      spread: 3,
      highOpportunitySlice: 2,
      rotationSeed: 7,
      recentlyAnchored: anchored,
    });
    // Head: Navigation + Health & Fitness; tail: Sports (the only un-anchored one).
    expect(out).toEqual(["Navigation", "Health & Fitness", "Sports"]);
  });
});
