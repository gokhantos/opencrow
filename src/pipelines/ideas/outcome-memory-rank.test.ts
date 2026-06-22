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
  type RankableOutcome,
  type RankOptions,
  rankOutcomes,
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
