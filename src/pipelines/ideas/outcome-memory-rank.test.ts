/**
 * Unit tests for outcome-memory-rank.ts — the PURE recall-ranking helpers.
 *
 * Covers:
 *   - rankOutcomes: decay monotonicity (older → lower composite), staleness
 *     penalty applied IFF promptVersion/model differ, halfLifeDays<=0 → rank by
 *     raw relevance (identity decay), stable sort.
 *   - mmrSelectOutcomes: drops a near-duplicate, passthrough at lambda>=1.
 *   - dedupRankedAndCap: dedup by ideaId, fallback to memory text, cap.
 *   - rank-then-cap vs naive first-N: a high-relevance RECENT item arriving LAST
 *     is selected by ranking but dropped by first-N.
 *   - buildRecallQuery: ordering (segments/themes first, category last), dedup.
 */

import { describe, test, expect } from "bun:test";
import {
  buildRecallQuery,
  dedupRankedAndCap,
  mmrSelectOutcomes,
  outcomeTrustTier,
  type RankableOutcome,
  type BlockRankOptions,
  type RankOptions,
  type TrustTierable,
  rankOutcomes,
  selectRankedOutcomes,
  selectTrustRankedOutcomes,
} from "./outcome-memory-rank";

const NOW = 10_000_000;
const DAY = 86_400;

function item(over: {
  memory?: string;
  relevance?: number;
  ideaId?: string | null;
  createdAtSec?: number;
  promptVersion?: string;
  model?: string;
}): RankableOutcome {
  return {
    memory: over.memory ?? "body",
    relevance: over.relevance ?? 1,
    metadata: {
      ideaId: over.ideaId ?? null,
      createdAtSec: over.createdAtSec ?? NOW,
      promptVersion: over.promptVersion ?? "vCurrent",
      model: over.model ?? "modelCurrent",
    },
  };
}

function opts(over: Partial<RankOptions> = {}): RankOptions {
  return {
    now: NOW,
    halfLifeDays: 45,
    stalePromptPenalty: 0.6,
    currentPromptVersion: "vCurrent",
    currentModel: "modelCurrent",
    ...over,
  };
}

describe("rankOutcomes — temporal decay", () => {
  test("older items get a LOWER composite than identical-relevance recent items", () => {
    const recent = item({ memory: "recent", relevance: 1, createdAtSec: NOW });
    const old = item({ memory: "old", relevance: 1, createdAtSec: NOW - 90 * DAY });
    const ranked = rankOutcomes([old, recent], opts({ halfLifeDays: 45 }));
    expect(ranked[0]!.item.memory).toBe("recent");
    expect(ranked[1]!.item.memory).toBe("old");
    expect(ranked[0]!.composite).toBeGreaterThan(ranked[1]!.composite);
  });

  test("composite decays monotonically with age across several items", () => {
    const items = [0, 30, 60, 120].map((days) =>
      item({ memory: `d${days}`, relevance: 1, createdAtSec: NOW - days * DAY }),
    );
    const ranked = rankOutcomes(items, opts({ halfLifeDays: 45 }));
    const composites = ranked.map((r) => r.composite);
    for (let i = 1; i < composites.length; i++) {
      expect(composites[i]!).toBeLessThan(composites[i - 1]!);
    }
  });

  test("halfLifeDays<=0 → decay is identity, composite collapses to relevance order", () => {
    // Old item has HIGHER relevance — with no decay it must rank first.
    const old = item({ memory: "old-hi", relevance: 0.9, createdAtSec: NOW - 365 * DAY });
    const recent = item({ memory: "recent-lo", relevance: 0.5, createdAtSec: NOW });
    const ranked = rankOutcomes([recent, old], opts({ halfLifeDays: 0 }));
    expect(ranked[0]!.item.memory).toBe("old-hi");
    expect(ranked[0]!.composite).toBe(0.9);
    expect(ranked[1]!.composite).toBe(0.5);
  });
});

describe("rankOutcomes — staleness penalty", () => {
  test("penalty applied IFF promptVersion OR model differs from current", () => {
    const fresh = item({ memory: "fresh", relevance: 1 });
    const stalePrompt = item({ memory: "stale-prompt", relevance: 1, promptVersion: "vOld" });
    const staleModel = item({ memory: "stale-model", relevance: 1, model: "modelOld" });
    const ranked = rankOutcomes(
      [fresh, stalePrompt, staleModel],
      opts({ halfLifeDays: 0, stalePromptPenalty: 0.5 }),
    );
    const byMem = new Map(ranked.map((r) => [r.item.memory, r.composite]));
    expect(byMem.get("fresh")).toBe(1);
    expect(byMem.get("stale-prompt")).toBe(0.5);
    expect(byMem.get("stale-model")).toBe(0.5);
  });

  test("stalePromptPenalty=1 → no penalty (fresh and stale tie on composite)", () => {
    const fresh = item({ memory: "fresh", relevance: 1 });
    const stale = item({ memory: "stale", relevance: 1, promptVersion: "vOld" });
    const ranked = rankOutcomes([fresh, stale], opts({ halfLifeDays: 0, stalePromptPenalty: 1 }));
    expect(ranked[0]!.composite).toBe(ranked[1]!.composite);
  });
});

describe("rankOutcomes — stable sort", () => {
  test("ties keep input order", () => {
    const a = item({ memory: "a", relevance: 1 });
    const b = item({ memory: "b", relevance: 1 });
    const c = item({ memory: "c", relevance: 1 });
    const ranked = rankOutcomes([a, b, c], opts({ halfLifeDays: 0 }));
    expect(ranked.map((r) => r.item.memory)).toEqual(["a", "b", "c"]);
  });
});

describe("dedupRankedAndCap", () => {
  test("dedups by ideaId, keeping the first (highest-ranked) occurrence", () => {
    const ranked = rankOutcomes(
      [
        item({ memory: "first", ideaId: "x", relevance: 0.9 }),
        item({ memory: "dup", ideaId: "x", relevance: 0.8 }),
        item({ memory: "other", ideaId: "y", relevance: 0.7 }),
      ],
      opts({ halfLifeDays: 0 }),
    );
    const out = dedupRankedAndCap(ranked, 10);
    expect(out.map((i) => i.memory)).toEqual(["first", "other"]);
  });

  test("falls back to memory text when ideaId is null", () => {
    const ranked = rankOutcomes(
      [
        item({ memory: "same", ideaId: null, relevance: 0.9 }),
        item({ memory: "same", ideaId: null, relevance: 0.8 }),
      ],
      opts({ halfLifeDays: 0 }),
    );
    expect(dedupRankedAndCap(ranked, 10)).toHaveLength(1);
  });

  test("caps to the requested length", () => {
    const ranked = rankOutcomes(
      ["a", "b", "c", "d"].map((m, i) => item({ memory: m, ideaId: m, relevance: 1 - i / 10 })),
      opts({ halfLifeDays: 0 }),
    );
    expect(dedupRankedAndCap(ranked, 2)).toHaveLength(2);
  });
});

describe("mmrSelectOutcomes", () => {
  test("lambda>=1 → passthrough (truncated to cap, order preserved)", () => {
    const items = [
      item({ memory: "alpha beta gamma" }),
      item({ memory: "alpha beta gamma" }),
      item({ memory: "delta epsilon zeta" }),
    ];
    expect(mmrSelectOutcomes(items, 1, 3).map((i) => i.memory)).toEqual(items.map((i) => i.memory));
  });

  test("single item → passthrough", () => {
    const items = [item({ memory: "solo" })];
    expect(mmrSelectOutcomes(items, 0.5, 5)).toEqual(items);
  });

  test("drops a near-duplicate bullet in favor of a diverse one", () => {
    // index 0 leads; index 1 is a near-duplicate of 0; index 2 is diverse.
    const items = [
      item({ memory: "fintech compliance automation tooling" }),
      item({ memory: "fintech compliance automation tooling" }),
      item({ memory: "healthcare scheduling patient intake software" }),
    ];
    const picked = mmrSelectOutcomes(items, 0.5, 2);
    expect(picked).toHaveLength(2);
    expect(picked[0]!.memory).toBe("fintech compliance automation tooling");
    // The diverse item beats the duplicate for the second slot.
    expect(picked[1]!.memory).toBe("healthcare scheduling patient intake software");
  });
});

describe("rank-then-cap vs naive first-N", () => {
  test("a high-relevance recent item arriving LAST survives ranking but not first-N", () => {
    // Upstream order: three low-relevance items, then the best one LAST.
    const arrival = [
      item({ memory: "low-1", ideaId: "1", relevance: 0.2, createdAtSec: NOW - 5 * DAY }),
      item({ memory: "low-2", ideaId: "2", relevance: 0.2, createdAtSec: NOW - 5 * DAY }),
      item({ memory: "low-3", ideaId: "3", relevance: 0.2, createdAtSec: NOW - 5 * DAY }),
      item({ memory: "best", ideaId: "4", relevance: 0.95, createdAtSec: NOW }),
    ];
    // Naive first-N (cap 1) on arrival order picks "low-1".
    const naiveFirst = arrival[0]!.memory;
    expect(naiveFirst).toBe("low-1");

    // Rank → dedup → cap (1) picks "best".
    const ranked = rankOutcomes(arrival, opts({ halfLifeDays: 45 }));
    const out = dedupRankedAndCap(ranked, 1);
    expect(out).toHaveLength(1);
    expect(out[0]!.memory).toBe("best");
  });
});

describe("buildRecallQuery", () => {
  test("orders segments/themes first, category last; dedups case-insensitively", () => {
    const q = buildRecallQuery({
      painThemes: ["slow onboarding", "billing errors"],
      trendingCategories: ["fintech", "Fintech"],
      targetSegments: ["healthcare"],
      category: "consumer",
    });
    expect(q).toBe("healthcare, slow onboarding, billing errors, fintech, consumer");
  });

  test("empty / missing inputs are dropped; empty everything → empty string", () => {
    expect(buildRecallQuery({})).toBe("");
    expect(buildRecallQuery({ painThemes: ["  ", ""], category: null })).toBe("");
    expect(buildRecallQuery({ category: "saas" })).toBe("saas");
  });
});

// ── Helpers shared by GAP 3 / GAP 4 tests ────────────────────────────────────

/** RankableOutcome with a verdictSource for trust-tier tests. */
interface TrustableItem extends RankableOutcome, TrustTierable {
  readonly metadata: RankableOutcome["metadata"] & { readonly verdictSource: string };
}

function trustItem(over: {
  memory?: string;
  relevance?: number;
  ideaId?: string | null;
  createdAtSec?: number;
  promptVersion?: string;
  model?: string;
  verdictSource?: string;
}): TrustableItem {
  return {
    memory: over.memory ?? "body",
    relevance: over.relevance ?? 1,
    metadata: {
      ideaId: over.ideaId ?? null,
      createdAtSec: over.createdAtSec ?? NOW,
      promptVersion: over.promptVersion ?? "vCurrent",
      model: over.model ?? "modelCurrent",
      verdictSource: over.verdictSource ?? "proxy:high-giant",
    },
  };
}

/** Default BlockRankOptions with no decay, no staleness penalty, no MMR diversification. */
function blockOpts(over: Partial<BlockRankOptions> = {}): BlockRankOptions {
  return {
    now: NOW,
    halfLifeDays: 45,
    stalePromptPenalty: 0.6,
    currentPromptVersion: "vCurrent",
    currentModel: "modelCurrent",
    mmrLambda: 0.5,
    ...over,
  };
}

// ── GAP 3: selectTrustRankedOutcomes / selectRankedOutcomes composite ─────────

describe("selectRankedOutcomes — rank→dedup→MMR→cap composite", () => {
  test("selects the highest-composite item up to cap", () => {
    const items = [
      item({ memory: "low", ideaId: "1", relevance: 0.2, createdAtSec: NOW - 90 * DAY }),
      item({ memory: "high", ideaId: "2", relevance: 0.95, createdAtSec: NOW }),
    ];
    const result = selectRankedOutcomes(items, 1, blockOpts({ mmrLambda: 1 }));
    expect(result).toHaveLength(1);
    expect(result[0]!.memory).toBe("high");
  });

  test("dedup runs after rank so the higher-relevance duplicate wins", () => {
    const items = [
      item({ memory: "dup-a", ideaId: "same", relevance: 0.9 }),
      item({ memory: "dup-b", ideaId: "same", relevance: 0.5 }),
      item({ memory: "other", ideaId: "other", relevance: 0.3 }),
    ];
    const result = selectRankedOutcomes(items, 3, blockOpts({ halfLifeDays: 0, mmrLambda: 1 }));
    // "dup-b" is dropped; "dup-a" kept as the higher-ranked duplicate.
    expect(result.map((i) => i.memory)).not.toContain("dup-b");
    expect(result.map((i) => i.memory)).toContain("dup-a");
  });

  test("MMR promotes diverse items over near-duplicates", () => {
    const items = [
      item({ memory: "fintech compliance automation tooling" }),
      item({ memory: "fintech compliance automation tooling" }),
      item({ memory: "healthcare scheduling patient intake" }),
    ];
    // lambda=0.5: diversity matters; the near-dup should be displaced by the diverse item.
    const result = selectRankedOutcomes(items, 2, blockOpts({ halfLifeDays: 0, mmrLambda: 0.5 }));
    expect(result).toHaveLength(2);
    expect(result[0]!.memory).toBe("fintech compliance automation tooling");
    expect(result[1]!.memory).toBe("healthcare scheduling patient intake");
  });

  test("cap is respected even when more items survive dedup", () => {
    const items = [
      item({ memory: "a", ideaId: "1", relevance: 0.9 }),
      item({ memory: "b", ideaId: "2", relevance: 0.8 }),
      item({ memory: "c", ideaId: "3", relevance: 0.7 }),
    ];
    expect(selectRankedOutcomes(items, 2, blockOpts({ halfLifeDays: 0, mmrLambda: 1 }))).toHaveLength(2);
  });
});

describe("selectTrustRankedOutcomes — gold/reprobe before proxy, proxyAvoidCap", () => {
  test("gold and reprobe items sort ahead of proxy after MMR reordering", () => {
    // Arrival order: proxy first, then gold, then reprobe.
    // The trust sort must float gold/reprobe above proxy regardless of MMR position.
    const items: readonly TrustableItem[] = [
      trustItem({ memory: "proxy-avoid", ideaId: "p1", relevance: 0.95, verdictSource: "proxy:a" }),
      trustItem({ memory: "gold-avoid", ideaId: "g1", relevance: 0.5, verdictSource: "human" }),
      trustItem({ memory: "reprobe-avoid", ideaId: "r1", relevance: 0.4, verdictSource: "reprobe:decayed" }),
    ];

    const result = selectTrustRankedOutcomes(items, 3, blockOpts({ halfLifeDays: 0, mmrLambda: 1 }), Infinity);

    const memories = result.map((i) => i.memory);
    const goldPos = memories.indexOf("gold-avoid");
    const reprobePos = memories.indexOf("reprobe-avoid");
    const proxyPos = memories.indexOf("proxy-avoid");

    expect(goldPos).toBeGreaterThan(-1);
    expect(reprobePos).toBeGreaterThan(-1);
    expect(proxyPos).toBeGreaterThan(-1);

    // gold and reprobe must appear BEFORE proxy.
    expect(goldPos).toBeLessThan(proxyPos);
    expect(reprobePos).toBeLessThan(proxyPos);
  });

  test("proxyAvoidCap limits proxy-tier items in the composite output", () => {
    // 1 gold + 3 proxy items; cap=10 to ensure all could fit;
    // proxyAvoidCap=1 must restrict proxy survivors to 1.
    const items: readonly TrustableItem[] = [
      trustItem({ memory: "gold", ideaId: "g1", relevance: 0.9, verdictSource: "human" }),
      trustItem({ memory: "proxy-1", ideaId: "p1", relevance: 0.8, verdictSource: "proxy:a" }),
      trustItem({ memory: "proxy-2", ideaId: "p2", relevance: 0.7, verdictSource: "proxy:b" }),
      trustItem({ memory: "proxy-3", ideaId: "p3", relevance: 0.6, verdictSource: "proxy:c" }),
    ];

    const result = selectTrustRankedOutcomes(
      items,
      10, // cap big enough — proxyAvoidCap is the binding constraint for proxy
      blockOpts({ halfLifeDays: 0, mmrLambda: 1 }),
      1, // proxyAvoidCap=1
    );

    // Gold must survive.
    expect(result.map((i) => i.memory)).toContain("gold");
    // Exactly one proxy item survives.
    const proxyCount = result.filter((i) => outcomeTrustTier(i.metadata.verdictSource) === "proxy").length;
    expect(proxyCount).toBe(1);
  });

  test("proxyAvoidCap=0 drops all proxy items but keeps gold/reprobe", () => {
    const items: readonly TrustableItem[] = [
      trustItem({ memory: "reprobe-win", ideaId: "r1", verdictSource: "reprobe:grew" }),
      trustItem({ memory: "proxy-win", ideaId: "p1", verdictSource: "proxy:high-giant" }),
    ];

    const result = selectTrustRankedOutcomes(items, 10, blockOpts({ halfLifeDays: 0, mmrLambda: 1 }), 0);

    expect(result.map((i) => i.memory)).toContain("reprobe-win");
    expect(result.map((i) => i.memory)).not.toContain("proxy-win");
  });

  test("proxyAvoidCap=Infinity admits all proxy items (disable constraint)", () => {
    const items: readonly TrustableItem[] = [
      trustItem({ memory: "p1", ideaId: "1", verdictSource: "proxy:a" }),
      trustItem({ memory: "p2", ideaId: "2", verdictSource: "proxy:b" }),
      trustItem({ memory: "p3", ideaId: "3", verdictSource: "proxy:c" }),
    ];

    const result = selectTrustRankedOutcomes(items, 10, blockOpts({ halfLifeDays: 0, mmrLambda: 1 }), Infinity);
    expect(result).toHaveLength(3);
  });
});

// ── GAP 4: no-op default contract ────────────────────────────────────────────

describe("selectRankedOutcomes — no-op defaults preserve input order", () => {
  // At halfLifeDays=0, stalePromptPenalty=1, mmrLambda=1:
  // - decay is identity → composite equals raw relevance
  // - stale penalty is 1 (no penalty) → composite equals relevance for all
  // - MMR lambda=1 → passthrough (no diversification)
  // Therefore the composite sort equals the relevance sort and, if relevance
  // is uniform (all ties), input order is preserved exactly (stable sort).
  // This proves "new behavior only activates at non-default knobs."

  test("uniform relevance with no-op knobs preserves input order", () => {
    const input = [
      item({ memory: "first",  ideaId: "1", relevance: 1 }),
      item({ memory: "second", ideaId: "2", relevance: 1 }),
      item({ memory: "third",  ideaId: "3", relevance: 1 }),
    ];

    const noOpOpts: BlockRankOptions = {
      now: NOW,
      halfLifeDays: 0,      // decay = identity
      stalePromptPenalty: 1, // no staleness penalty
      mmrLambda: 1,         // MMR passthrough
      currentPromptVersion: "vCurrent",
      currentModel: "modelCurrent",
    };

    const result = selectRankedOutcomes(input, input.length, noOpOpts);
    expect(result.map((i) => i.memory)).toEqual(["first", "second", "third"]);
  });

  test("no-op knobs: ranked order equals raw relevance order (not arrival order) when relevance differs", () => {
    // Input arrives low-to-high relevance; no-op knobs should still rank by relevance (desc).
    const input = [
      item({ memory: "low",  ideaId: "1", relevance: 0.2 }),
      item({ memory: "mid",  ideaId: "2", relevance: 0.5 }),
      item({ memory: "high", ideaId: "3", relevance: 0.9 }),
    ];

    const noOpOpts: BlockRankOptions = {
      now: NOW,
      halfLifeDays: 0,
      stalePromptPenalty: 1,
      mmrLambda: 1,
      currentPromptVersion: "vCurrent",
      currentModel: "modelCurrent",
    };

    const result = selectRankedOutcomes(input, input.length, noOpOpts);
    expect(result.map((i) => i.memory)).toEqual(["high", "mid", "low"]);
  });

  test("no-op knobs vs explicit decay: result differs when halfLifeDays > 0", () => {
    // This is the complementary proof: non-default knobs DO change the result.
    // A very old item with high relevance beats a recent item with low relevance
    // under no-op decay, but loses under temporal decay.
    const oldHighRelevance = item({ memory: "old-high", ideaId: "1", relevance: 0.9, createdAtSec: NOW - 365 * DAY });
    const recentLowRelevance = item({ memory: "recent-low", ideaId: "2", relevance: 0.1, createdAtSec: NOW });

    const noOp: BlockRankOptions = { now: NOW, halfLifeDays: 0, stalePromptPenalty: 1, mmrLambda: 1, currentPromptVersion: "vCurrent", currentModel: "modelCurrent" };
    const withDecay: BlockRankOptions = { ...noOp, halfLifeDays: 45 };

    const noOpResult = selectRankedOutcomes([oldHighRelevance, recentLowRelevance], 2, noOp);
    const decayResult = selectRankedOutcomes([oldHighRelevance, recentLowRelevance], 2, withDecay);

    // No-op: old-high wins (pure relevance).
    expect(noOpResult[0]!.memory).toBe("old-high");
    // With decay: recent-low can win because the old item's composite is crushed.
    expect(decayResult[0]!.memory).toBe("recent-low");
  });
});
