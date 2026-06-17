import { describe, expect, test } from "bun:test";
import {
  IMPORTANCE_ORDER,
  SIGNAL_SOURCE_KINDS,
  buildRankingPayload,
  enrichSignals,
  importanceRank,
  isSignalKind,
  meetsImportanceFloor,
  type EnrichmentGates,
  type EnrichSignalItem,
} from "./signal-enrichment";
import type { SignalFacets } from "./signal-facets";
import type { MemorySourceKind } from "./types";

const FACETS: SignalFacets = {
  problemType: "manual reconciliation",
  targetAudience: "bookkeepers",
  jtbd: "close books",
  sentiment: "negative",
  entities: ["QuickBooks"],
  importance: "high",
  relevanceToIdeas: 0.85,
  category: "fintech",
};

const GATES_ON: EnrichmentGates = { signalFacets: true, signalRanking: true };
const GATES_FACETS_ONLY: EnrichmentGates = {
  signalFacets: true,
  signalRanking: false,
};
const GATES_OFF: EnrichmentGates = { signalFacets: false, signalRanking: false };

describe("isSignalKind", () => {
  test("scraped-signal kinds are signals", () => {
    const signalKinds: MemorySourceKind[] = [
      "x_post",
      "reddit_post",
      "hackernews_story",
      "github_repo",
      "producthunt_product",
      "reuters_news",
      "appstore_review",
      "playstore_app",
    ];
    for (const kind of signalKinds) {
      expect(isSignalKind(kind)).toBe(true);
    }
  });

  test("conversation/observation/idea/note/document are NOT signals", () => {
    const nonSignals: MemorySourceKind[] = [
      "conversation",
      "observation",
      "idea",
      "note",
      "document",
    ];
    for (const kind of nonSignals) {
      expect(isSignalKind(kind)).toBe(false);
    }
  });

  test("SIGNAL_SOURCE_KINDS excludes all non-signal kinds", () => {
    expect(SIGNAL_SOURCE_KINDS).not.toContain("conversation");
    expect(SIGNAL_SOURCE_KINDS).not.toContain("observation");
    expect(SIGNAL_SOURCE_KINDS).not.toContain("idea");
    expect(SIGNAL_SOURCE_KINDS).toContain("reddit_post");
  });
});

describe("importanceRank", () => {
  test("orders noise < low < medium < high", () => {
    expect(importanceRank("noise")).toBe(0);
    expect(importanceRank("low")).toBe(1);
    expect(importanceRank("medium")).toBe(2);
    expect(importanceRank("high")).toBe(3);
  });

  test("IMPORTANCE_ORDER is monotonically ranked", () => {
    for (let i = 1; i < IMPORTANCE_ORDER.length; i++) {
      expect(importanceRank(IMPORTANCE_ORDER[i]!)).toBeGreaterThan(
        importanceRank(IMPORTANCE_ORDER[i - 1]!),
      );
    }
  });
});

describe("meetsImportanceFloor", () => {
  test("default 'low' floor filters out noise but keeps low+", () => {
    expect(meetsImportanceFloor("noise", "low")).toBe(false);
    expect(meetsImportanceFloor("low", "low")).toBe(true);
    expect(meetsImportanceFloor("medium", "low")).toBe(true);
    expect(meetsImportanceFloor("high", "low")).toBe(true);
  });

  test("'high' floor only keeps high", () => {
    expect(meetsImportanceFloor("medium", "high")).toBe(false);
    expect(meetsImportanceFloor("high", "high")).toBe(true);
  });

  test("'noise' floor keeps everything", () => {
    for (const bucket of IMPORTANCE_ORDER) {
      expect(meetsImportanceFloor(bucket, "noise")).toBe(true);
    }
  });
});

describe("buildRankingPayload", () => {
  test("returns empty object for null facets", () => {
    expect(buildRankingPayload(null)).toEqual({});
  });

  test("flattens importance/relevance/category to filterable keys", () => {
    expect(buildRankingPayload(FACETS)).toEqual({
      signalImportance: "high",
      signalImportanceRank: 3,
      signalRelevance: 0.85,
      signalCategory: "fintech",
    });
  });

  test("omits signalCategory when category is empty", () => {
    const payload = buildRankingPayload({ ...FACETS, category: "" });
    expect(payload.signalCategory).toBeUndefined();
    expect(payload.signalImportance).toBe("high");
  });
});

describe("enrichSignals", () => {
  const items: readonly EnrichSignalItem[] = [
    { id: "a", kind: "reddit_post", text: "a painful problem" },
    { id: "b", kind: "conversation", text: "hi there" },
    { id: "c", kind: "x_post", text: "" },
  ];

  test("returns empty payloads/null facets when signalFacets gate is off", async () => {
    let extractCalled = false;
    const { payloads, facets } = await enrichSignals(items, {
      gates: GATES_OFF,
      extractBatch: async (batch) => {
        extractCalled = true;
        return new Map(batch.map((i) => [i.id, FACETS]));
      },
      persist: async () => null,
    });

    expect(extractCalled).toBe(false);
    expect(facets.get("a")).toBeNull();
    expect(payloads.get("a")).toEqual({});
    // Every input id present.
    expect([...facets.keys()].sort()).toEqual(["a", "b", "c"]);
  });

  test("only signal kinds with non-empty text reach the extractor", async () => {
    const seen: string[] = [];
    await enrichSignals(items, {
      gates: GATES_ON,
      extractBatch: async (batch) => {
        for (const i of batch) seen.push(i.id);
        return new Map(batch.map((i) => [i.id, FACETS]));
      },
      persist: async () => "row-id",
    });
    // "b" is a conversation, "c" has empty text — both excluded.
    expect(seen).toEqual(["a"]);
  });

  test("ranking payload present when signalRanking is on", async () => {
    const persisted: Array<{ rankModel?: string; signalType?: string }> = [];
    const { payloads } = await enrichSignals(
      [{ id: "a", kind: "reddit_post", text: "x" }],
      {
        gates: GATES_ON,
        extractBatch: async (batch) =>
          new Map(batch.map((i) => [i.id, FACETS])),
        persist: async (p) => {
          persisted.push({ rankModel: p.rankModel, signalType: p.signalType });
          return "row-id";
        },
      },
    );

    expect(payloads.get("a")).toEqual({
      signalImportance: "high",
      signalImportanceRank: 3,
      signalRelevance: 0.85,
      signalCategory: "fintech",
    });
    expect(persisted[0]?.signalType).toBe("reddit_post");
    expect(persisted[0]?.rankModel).toBeTruthy();
  });

  test("ranking payload empty when only signalFacets is on (extraction without rank fields)", async () => {
    const persisted: Array<{ rankModel?: string }> = [];
    const { payloads, facets } = await enrichSignals(
      [{ id: "a", kind: "reddit_post", text: "x" }],
      {
        gates: GATES_FACETS_ONLY,
        extractBatch: async (batch) =>
          new Map(batch.map((i) => [i.id, FACETS])),
        persist: async (p) => {
          persisted.push({ rankModel: p.rankModel });
          return "row-id";
        },
      },
    );

    // Facets still extracted, but no filterable ranking payload exposed.
    expect(facets.get("a")).toEqual(FACETS);
    expect(payloads.get("a")).toEqual({});
    // rank_model is only stamped when ranking is on.
    expect(persisted[0]?.rankModel).toBeUndefined();
  });

  test("a thrown extractor degrades to null facets / empty payloads", async () => {
    const { payloads, facets } = await enrichSignals(
      [{ id: "a", kind: "reddit_post", text: "x" }],
      {
        gates: GATES_ON,
        extractBatch: async () => {
          throw new Error("model down");
        },
        persist: async () => "row-id",
      },
    );
    expect(facets.get("a")).toBeNull();
    expect(payloads.get("a")).toEqual({});
  });

  test("respects the engagement pre-filter threshold", async () => {
    const seen: string[] = [];
    await enrichSignals(
      [
        { id: "lo", kind: "reddit_post", text: "x", signals: { engagement: 1 } },
        {
          id: "hi",
          kind: "reddit_post",
          text: "x",
          signals: { engagement: 100 },
        },
      ],
      {
        gates: GATES_ON,
        thresholds: { minEngagement: 50 },
        extractBatch: async (batch) => {
          for (const i of batch) seen.push(i.id);
          return new Map(batch.map((i) => [i.id, FACETS]));
        },
        persist: async () => "row-id",
      },
    );
    expect(seen).toEqual(["hi"]);
  });
});
