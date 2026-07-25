import { beforeEach, describe, expect, it, mock } from "bun:test";
import { DEFAULT_RETIREMENT_RULES } from "./keyword-retirement";
import type { RetirementCandidateRow, ZoneDerivationRow } from "./keyword-store";

// `keyword-hygiene.ts` imports EXACTLY these `./keyword-store` exports — every
// mock factory below must return all of them, or the import fails with a hard
// ESM "export not found" SyntaxError rather than a silent `undefined` (same
// discipline as keyword-autocomplete.isolated.test.ts's mock base).
interface StoreMockState {
  retirementCandidates: readonly RetirementCandidateRow[];
  zoneRows: readonly ZoneDerivationRow[];
  scannedAppNames: readonly string[];
  retiredEntries: Array<{ keyword: string; reason: string }>;
  retiredAt: number | null;
  checkedKeywords: readonly string[];
  checkedAt: number | null;
  zoneWrites: Array<{ keyword: string; zone: string | null; confidence: number | null }>;
  zoneWrittenAt: number | null;
}

let state: StoreMockState;

function candidate(overrides: Partial<RetirementCandidateRow> = {}): RetirementCandidateRow {
  return {
    keyword: "budget planner",
    source: "autocomplete",
    fieldSize: 20,
    exactBrandTitleCount: 1,
    rankOneExactBrandTitle: false,
    rankOneReviewShare: 0.01,
    demand: 0,
    topAppReviews: 10,
    scanCount: 5,
    hasSignatureHit: false,
    ...overrides,
  };
}

function installStoreMock(): void {
  mock.module("./keyword-store", () => ({
    selectRetirementCandidateRows: async (limit: number) =>
      state.retirementCandidates.slice(0, limit),
    selectZoneDerivationRows: async (limit: number) => state.zoneRows.slice(0, limit),
    getScannedAppNames: async () => state.scannedAppNames,
    retireKeywords: async (entries: readonly { keyword: string; reason: string }[], at: number) => {
      state.retiredEntries = [...entries];
      state.retiredAt = at;
      return entries.length;
    },
    markRetirementChecked: async (keywords: readonly string[], at: number) => {
      state.checkedKeywords = [...keywords];
      state.checkedAt = at;
    },
    applyDerivedZones: async (
      writes: readonly { keyword: string; zone: string | null; confidence: number | null }[],
      at: number,
    ) => {
      state.zoneWrites = [...writes];
      state.zoneWrittenAt = at;
      return writes.length;
    },
  }));
}

beforeEach(() => {
  state = {
    retirementCandidates: [],
    zoneRows: [],
    scannedAppNames: [],
    retiredEntries: [],
    retiredAt: null,
    checkedKeywords: [],
    checkedAt: null,
    zoneWrites: [],
    zoneWrittenAt: null,
  };
  installStoreMock();
});

const NOW = 1_800_000_000;

describe("runRetirementPass", () => {
  it("no-ops on a non-positive batch size without touching the store", async () => {
    state.retirementCandidates = [candidate()];
    const { runRetirementPass } = await import("./keyword-hygiene");
    const result = await runRetirementPass({
      batchSize: 0,
      rules: DEFAULT_RETIREMENT_RULES,
      nowSeconds: NOW,
    });
    expect(result).toEqual({ evaluated: 0, retired: 0, byReason: {} });
    expect(state.checkedKeywords).toEqual([]);
  });

  it("no-ops when nothing is due", async () => {
    const { runRetirementPass } = await import("./keyword-hygiene");
    const result = await runRetirementPass({
      batchSize: 100,
      rules: DEFAULT_RETIREMENT_RULES,
      nowSeconds: NOW,
    });
    expect(result.evaluated).toBe(0);
    expect(state.retiredEntries).toEqual([]);
  });

  it("retires structural junk and records the reason", async () => {
    state.retirementCandidates = [candidate({ keyword: "التحفة", source: "mined" })];
    const { runRetirementPass } = await import("./keyword-hygiene");
    const result = await runRetirementPass({
      batchSize: 100,
      rules: DEFAULT_RETIREMENT_RULES,
      nowSeconds: NOW,
    });
    expect(state.retiredEntries).toEqual([{ keyword: "التحفة", reason: "structural-junk" }]);
    expect(state.retiredAt).toBe(NOW);
    expect(result).toEqual({ evaluated: 1, retired: 1, byReason: { "structural-junk": 1 } });
  });

  it("retires a brand-dominated SERP shape", async () => {
    state.retirementCandidates = [
      candidate({
        keyword: "netgear",
        source: "mined",
        fieldSize: 14,
        exactBrandTitleCount: 7,
        rankOneExactBrandTitle: true,
        rankOneReviewShare: 0.6,
      }),
    ];
    const { runRetirementPass } = await import("./keyword-hygiene");
    await runRetirementPass({ batchSize: 100, rules: DEFAULT_RETIREMENT_RULES, nowSeconds: NOW });
    expect(state.retiredEntries).toEqual([{ keyword: "netgear", reason: "brand-serp-shape" }]);
  });

  it("uses the scanned-app-name pool to build the brand-segment set for the lexical rule", async () => {
    state.scannedAppNames = ["Duolingo: Language Lessons"];
    state.retirementCandidates = [candidate({ keyword: "duolingo", source: "autocomplete" })];
    const { runRetirementPass } = await import("./keyword-hygiene");
    await runRetirementPass({ batchSize: 100, rules: DEFAULT_RETIREMENT_RULES, nowSeconds: NOW });
    expect(state.retiredEntries).toEqual([{ keyword: "duolingo", reason: "brand-lexical" }]);
  });

  it("passes a null SERP shape through when the keyword has never been scanned", async () => {
    // fieldSize 0 must not be read as "a field of 0 apps, all brand titles".
    state.retirementCandidates = [
      candidate({
        keyword: "unscanned phrase",
        fieldSize: 0,
        exactBrandTitleCount: 0,
        rankOneExactBrandTitle: true,
        rankOneReviewShare: 1,
      }),
    ];
    const { runRetirementPass } = await import("./keyword-hygiene");
    const result = await runRetirementPass({
      batchSize: 100,
      rules: DEFAULT_RETIREMENT_RULES,
      nowSeconds: NOW,
    });
    expect(state.retiredEntries).toEqual([]);
    expect(result.evaluated).toBe(1);
  });

  it("exempts a keyword on the signature-hit watchlist from every rule", async () => {
    state.retirementCandidates = [
      candidate({ keyword: "التحفة", source: "mined", hasSignatureHit: true }),
    ];
    const { runRetirementPass } = await import("./keyword-hygiene");
    await runRetirementPass({ batchSize: 100, rules: DEFAULT_RETIREMENT_RULES, nowSeconds: NOW });
    expect(state.retiredEntries).toEqual([]);
  });

  it("stamps the cursor on EVERY evaluated keyword, retired or not", async () => {
    state.retirementCandidates = [
      candidate({ keyword: "التحفة", source: "mined" }),
      candidate({ keyword: "budget planner" }),
    ];
    const { runRetirementPass } = await import("./keyword-hygiene");
    await runRetirementPass({ batchSize: 100, rules: DEFAULT_RETIREMENT_RULES, nowSeconds: NOW });
    expect(state.retiredEntries.map((e) => e.keyword)).toEqual(["التحفة"]);
    expect(state.checkedKeywords).toEqual(["التحفة", "budget planner"]);
    expect(state.checkedAt).toBe(NOW);
  });

  it("does NOT retire a weak-score keyword under the default rules", async () => {
    // The exact shape the BROKEN scoring model gives the owner's own shipped
    // niches: demand 0, tiny incumbents, many scans. Nothing may fire.
    state.retirementCandidates = [
      candidate({ keyword: "card grading", demand: 0, topAppReviews: 120, scanCount: 9 }),
      candidate({ keyword: "shorts blocker", demand: 0, topAppReviews: 40, scanCount: 9 }),
      candidate({ keyword: "stock analysis", demand: 0.4, topAppReviews: 500, scanCount: 9 }),
    ];
    const { runRetirementPass } = await import("./keyword-hygiene");
    const result = await runRetirementPass({
      batchSize: 100,
      rules: DEFAULT_RETIREMENT_RULES,
      nowSeconds: NOW,
    });
    expect(state.retiredEntries).toEqual([]);
    expect(result).toEqual({ evaluated: 3, retired: 0, byReason: {} });
  });

  it("retires them once the score-based rule is explicitly enabled — the tripwire", async () => {
    state.retirementCandidates = [
      candidate({ keyword: "card grading", demand: 0, topAppReviews: 120, scanCount: 9 }),
    ];
    const { runRetirementPass } = await import("./keyword-hygiene");
    await runRetirementPass({
      batchSize: 100,
      rules: { ...DEFAULT_RETIREMENT_RULES, scoreBased: true },
      nowSeconds: NOW,
    });
    expect(state.retiredEntries).toEqual([{ keyword: "card grading", reason: "score-based" }]);
  });

  it("respects the batch size", async () => {
    state.retirementCandidates = [
      candidate({ keyword: "التحفة", source: "mined" }),
      candidate({ keyword: "мама", source: "mined" }),
    ];
    const { runRetirementPass } = await import("./keyword-hygiene");
    const result = await runRetirementPass({
      batchSize: 1,
      rules: DEFAULT_RETIREMENT_RULES,
      nowSeconds: NOW,
    });
    expect(result.evaluated).toBe(1);
  });
});

describe("runZoneDerivationPass", () => {
  it("no-ops on a non-positive batch size", async () => {
    state.zoneRows = [{ keyword: "a", genres: ["Finance"] }];
    const { runZoneDerivationPass } = await import("./keyword-hygiene");
    const result = await runZoneDerivationPass({ batchSize: 0, nowSeconds: NOW });
    expect(result).toEqual({ evaluated: 0, classified: 0, unclassified: 0 });
    expect(state.zoneWrites).toEqual([]);
  });

  it("writes a confident derived zone with its confidence", async () => {
    state.zoneRows = [
      { keyword: "crypto tracker", genres: ["Finance", "Finance", "Finance", "Utilities"] },
    ];
    const { runZoneDerivationPass } = await import("./keyword-hygiene");
    const result = await runZoneDerivationPass({ batchSize: 100, nowSeconds: NOW });
    expect(state.zoneWrites).toEqual([
      { keyword: "crypto tracker", zone: "finance", confidence: 0.75 },
    ]);
    expect(state.zoneWrittenAt).toBe(NOW);
    expect(result).toEqual({ evaluated: 1, classified: 1, unclassified: 0 });
  });

  it("writes NULL — never a default zone — when there are no incumbent genres", async () => {
    state.zoneRows = [{ keyword: "mystery phrase", genres: [] }];
    const { runZoneDerivationPass } = await import("./keyword-hygiene");
    const result = await runZoneDerivationPass({ batchSize: 100, nowSeconds: NOW });
    expect(state.zoneWrites).toEqual([
      { keyword: "mystery phrase", zone: null, confidence: null },
    ]);
    expect(result).toEqual({ evaluated: 1, classified: 0, unclassified: 1 });
  });

  it("writes NULL when the incumbents disagree below the confidence floor", async () => {
    state.zoneRows = [
      { keyword: "split field", genres: ["Finance", "Travel", "Sports", "Medical"] },
    ];
    const { runZoneDerivationPass } = await import("./keyword-hygiene");
    await runZoneDerivationPass({ batchSize: 100, nowSeconds: NOW });
    expect(state.zoneWrites).toEqual([{ keyword: "split field", zone: null, confidence: null }]);
  });

  it("still stamps a write for unclassifiable keywords so the cursor advances", async () => {
    state.zoneRows = [
      { keyword: "a", genres: [] },
      { keyword: "b", genres: ["Finance", "Finance", "Finance"] },
      { keyword: "c", genres: ["Weather", "Weather", "Weather"] },
    ];
    const { runZoneDerivationPass } = await import("./keyword-hygiene");
    const result = await runZoneDerivationPass({ batchSize: 100, nowSeconds: NOW });
    expect(state.zoneWrites.map((w) => w.keyword)).toEqual(["a", "b", "c"]);
    expect(result).toEqual({ evaluated: 3, classified: 1, unclassified: 2 });
  });
});
