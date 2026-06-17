import { test, expect, describe } from "bun:test";
import { prioritizeByRanking } from "./synthesizer";
import type { SearchResult, MemorySourceKind } from "../../memory/types";
import type { SignalFacets, SignalImportance } from "../../memory/signal-facets";
import {
  neutralSignalCalibration,
  computeSignalCalibration,
  type SignalCalibration,
} from "./signal-calibration";

// ── Fixtures ───────────────────────────────────────────────────────────────

/** Minimal SearchResult — prioritizeByRanking only reads source.id + score. */
function hit(
  id: string,
  score: number,
  kind: MemorySourceKind = "hackernews_story",
): SearchResult {
  return {
    chunk: {
      id: `${id}-chunk`,
      sourceId: id,
      content: `content ${id}`,
      chunkIndex: 0,
      tokenCount: 1,
      createdAt: 0,
    },
    score,
    source: {
      id,
      kind,
      agentId: "shared",
      channel: null,
      chatId: null,
      metadata: {},
      createdAt: 0,
    },
  };
}

function facet(
  importance: SignalImportance,
  relevanceToIdeas: number,
): Pick<SignalFacets, "importance" | "relevanceToIdeas"> {
  return { importance, relevanceToIdeas };
}

const NEUTRAL = neutralSignalCalibration();

// A calibration where "high" is validated-heavy (boost) and "low" is
// failure-heavy (attenuate). Built from labeled rows so it's realistic.
const SKEWED: SignalCalibration = computeSignalCalibration([
  { importance: "high", success: true },
  { importance: "high", success: true },
  { importance: "high", success: true },
  { importance: "high", success: true },
  { importance: "low", success: false },
  { importance: "low", success: false },
  { importance: "low", success: false },
  { importance: "low", success: false },
]);

// ── Importance-floor filtering ───────────────────────────────────────────────

describe("prioritizeByRanking — importance floor", () => {
  test("drops hits with KNOWN importance below the floor", () => {
    const hits = [hit("a", 0.9), hit("b", 0.8)];
    const facets = new Map([
      ["a", facet("noise", 0.5)],
      ["b", facet("medium", 0.5)],
    ]);

    const out = prioritizeByRanking(hits, facets, "low", NEUTRAL);

    // noise < low → "a" dropped; "b" (medium) kept.
    expect(out.map((h) => h.source.id)).toEqual(["b"]);
  });

  test("keeps un-ranked hits (no facet row) regardless of floor", () => {
    const hits = [hit("ranked", 0.9), hit("unranked", 0.4)];
    const facets = new Map([["ranked", facet("noise", 0.5)]]);

    // floor "low" drops the noise hit but the un-ranked one survives.
    const out = prioritizeByRanking(hits, facets, "low", NEUTRAL);

    expect(out.map((h) => h.source.id)).toEqual(["unranked"]);
  });

  test("default-floor 'low' keeps low/medium/high, drops only noise", () => {
    const hits = [
      hit("n", 0.9),
      hit("l", 0.9),
      hit("m", 0.9),
      hit("h", 0.9),
    ];
    const facets = new Map([
      ["n", facet("noise", 0.5)],
      ["l", facet("low", 0.5)],
      ["m", facet("medium", 0.5)],
      ["h", facet("high", 0.5)],
    ]);

    const out = prioritizeByRanking(hits, facets, "low", NEUTRAL);

    expect(new Set(out.map((h) => h.source.id))).toEqual(
      new Set(["l", "m", "h"]),
    );
  });

  test("high floor keeps only high-importance signals", () => {
    const hits = [hit("m", 0.9), hit("h", 0.5)];
    const facets = new Map([
      ["m", facet("medium", 0.9)],
      ["h", facet("high", 0.9)],
    ]);

    const out = prioritizeByRanking(hits, facets, "high", NEUTRAL);

    expect(out.map((h) => h.source.id)).toEqual(["h"]);
  });
});

// ── Calibration boost / re-ordering ──────────────────────────────────────────

describe("prioritizeByRanking — calibration boost", () => {
  test("neutral calibration preserves cosine ordering", () => {
    const hits = [hit("low-cos", 0.4), hit("high-cos", 0.9)];
    const facets = new Map([
      ["low-cos", facet("high", 0.5)],
      ["high-cos", facet("high", 0.5)],
    ]);

    const out = prioritizeByRanking(hits, facets, "noise", NEUTRAL);

    // Equal relevance + neutral weights → cosine decides; high-cos first.
    expect(out.map((h) => h.source.id)).toEqual(["high-cos", "low-cos"]);
  });

  test("a validated bucket floats above a higher-cosine attenuated bucket", () => {
    // "lo" has higher cosine but low (failure-heavy) bucket; "hi" lower cosine
    // but high (validated) bucket + max relevance. The calibrated blend should
    // lift "hi" above "lo".
    const hits = [hit("lo", 0.85), hit("hi", 0.6)];
    const facets = new Map([
      ["lo", facet("low", 0.5)],
      ["hi", facet("high", 1.0)],
    ]);

    const out = prioritizeByRanking(hits, facets, "noise", SKEWED);

    expect(out.map((h) => h.source.id)).toEqual(["hi", "lo"]);
  });

  test("un-ranked hits keep their raw cosine in the blend ordering", () => {
    const hits = [hit("ranked-weak", 0.5), hit("unranked-strong", 0.95)];
    const facets = new Map([["ranked-weak", facet("low", 0.1)]]);

    const out = prioritizeByRanking(hits, facets, "noise", SKEWED);

    // The un-ranked strong-cosine hit outranks the attenuated low-relevance one.
    expect(out[0]?.source.id).toBe("unranked-strong");
  });
});

// ── Stability + edge cases ───────────────────────────────────────────────────

describe("prioritizeByRanking — stability & edges", () => {
  test("equal rank scores preserve input order (stable)", () => {
    const hits = [hit("first", 0.7), hit("second", 0.7)];
    const facets = new Map([
      ["first", facet("medium", 0.5)],
      ["second", facet("medium", 0.5)],
    ]);

    const out = prioritizeByRanking(hits, facets, "noise", NEUTRAL);

    expect(out.map((h) => h.source.id)).toEqual(["first", "second"]);
  });

  test("empty input → empty output", () => {
    expect(prioritizeByRanking([], new Map(), "low", NEUTRAL)).toEqual([]);
  });

  test("all-below-floor → empty (caller decides whether to keep cosine order)", () => {
    const hits = [hit("a", 0.9), hit("b", 0.8)];
    const facets = new Map([
      ["a", facet("noise", 0.9)],
      ["b", facet("noise", 0.9)],
    ]);

    expect(prioritizeByRanking(hits, facets, "low", NEUTRAL)).toEqual([]);
  });

  test("missing score is treated as 0 (no throw)", () => {
    const noScore = { ...hit("x", 0), score: undefined as unknown as number };
    const out = prioritizeByRanking([noScore], new Map(), "low", NEUTRAL);
    expect(out.map((h) => h.source.id)).toEqual(["x"]);
  });
});
