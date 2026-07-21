import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { getDb, initDb } from "../../store/db";
import { getLatestScan, insertScan, upsertKeywords } from "../../sources/appstore/keyword-store";
import type { KeywordGapProfile } from "../../sources/appstore/keyword-types";
import {
  deleteKeywordVerdict,
  upsertKeywordVerdict,
} from "../../sources/appstore/keyword-verdict-store";
import { collectKeywordGaps } from "./collector-keyword-gaps";
import type { CollectorContext } from "./collectors";

/**
 * Fixed keyword set every test here inserts, so cleanup can always target a
 * known set and repeated `bun run test:integration` runs never leak rows into
 * getTopOpportunities. Distinctive `zzz-gapcol-` prefix + opportunity=1.0 keeps
 * these rows at the very top of the opportunity ordering regardless of other
 * scans already in the shared DB.
 */
const TEST_KEYWORDS: readonly string[] = [
  "zzz-gapcol-high",
  "zzz-gapcol-mid",
  "zzz-gapcol-low",
  "zzz-gapcol-de-store",
  "zzz-gapcol-lowconf",
  "zzz-gapcol-priority-pick",
  "zzz-gapcol-starred",
  "zzz-gapcol-excluded",
  "zzz-gapcol-downweighted",
];

async function cleanup(): Promise<void> {
  const db = getDb();
  await db`DELETE FROM appstore_keyword_verdicts WHERE keyword IN ${db(TEST_KEYWORDS)}`;
  await db`DELETE FROM appstore_keyword_scans WHERE keyword IN ${db(TEST_KEYWORDS)}`;
  await db`DELETE FROM appstore_keywords WHERE keyword IN ${db(TEST_KEYWORDS)}`;
}

function makeScan(overrides: Partial<KeywordGapProfile> & { keyword: string }): KeywordGapProfile {
  const now = Math.floor(Date.now() / 1000);
  return {
    store: "app",
    competitiveness: 20,
    demand: 13,
    incumbentWeakness: 0.8,
    opportunity: 1.0,
    trend: "heating",
    topAppReviews: 11,
    avgRating: 3.4,
    avgAgeDays: 500,
    topApps: [],
    scannedAt: now,
    lowConfidence: false,
    brandNavigational: false,
    ...overrides,
  };
}

function makeCtx(consumed?: ReadonlyMap<string, ReadonlySet<string>>): CollectorContext {
  return {
    consumed: consumed ?? new Map(),
    selected: new Map<string, string[]>(),
  };
}

describe("collectKeywordGaps (integration)", () => {
  beforeAll(async () => {
    await initDb(process.env.DATABASE_URL);
    await cleanup();
  });

  afterEach(async () => {
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
  });

  it("returns above-threshold seeds newest-scored first and records their KEYWORDS in ctx.selected", async () => {
    await upsertKeywords([
      { keyword: "zzz-gapcol-high", genreZone: "zzz-gapcol", source: "seed" },
      { keyword: "zzz-gapcol-mid", genreZone: "zzz-gapcol", source: "seed" },
      { keyword: "zzz-gapcol-low", genreZone: "zzz-gapcol", source: "seed" },
    ]);
    await insertScan(makeScan({ keyword: "zzz-gapcol-high", opportunity: 1.0 }));
    await insertScan(makeScan({ keyword: "zzz-gapcol-mid", opportunity: 0.98 }));
    // Below the minOpportunity threshold — must be filtered out.
    await insertScan(makeScan({ keyword: "zzz-gapcol-low", opportunity: 0.2 }));

    const ctx = makeCtx();
    const seeds = await collectKeywordGaps(ctx, { limit: 500, minOpportunity: 0.5 });

    const mine = seeds.filter((s) => TEST_KEYWORDS.includes(s.keyword));
    expect(mine.map((s) => s.keyword)).toEqual(["zzz-gapcol-high", "zzz-gapcol-mid"]);
    expect(mine.every((s) => s.store === "appstore")).toBe(true);
    expect(mine.every((s) => s.signalType === "keyword_gap")).toBe(true);
    expect(mine.some((s) => s.keyword === "zzz-gapcol-low")).toBe(false);

    // ctx.selected is populated under the scans table with the selected KEYWORDS
    // (not scan row ids) — this is the dedup unit that makes cross-run
    // consumption actually work, since getTopOpportunities returns the newest
    // scan row per keyword and a fresh row id is minted on every scan cycle.
    const selectedKeywords = ctx.selected.get("appstore_keyword_scans") ?? [];
    expect(selectedKeywords).toContain("zzz-gapcol-high");
    expect(selectedKeywords).toContain("zzz-gapcol-mid");
    // The below-threshold keyword is NOT recorded.
    expect(selectedKeywords).not.toContain("zzz-gapcol-low");

    // sourceId still carries the scan row id (audit/whitespace trail) even
    // though it is no longer the dedup key.
    const highId = String((await getLatestScan("zzz-gapcol-high"))?.id);
    const midId = String((await getLatestScan("zzz-gapcol-mid"))?.id);
    const mineBySourceId = mine.map((s) => s.sourceId);
    expect(mineBySourceId).toContain(highId);
    expect(mineBySourceId).toContain(midId);
  });

  it("excludes gaps whose KEYWORD is already consumed, even under a fresh scan row id", async () => {
    await upsertKeywords([
      { keyword: "zzz-gapcol-high", genreZone: "zzz-gapcol", source: "seed" },
      { keyword: "zzz-gapcol-mid", genreZone: "zzz-gapcol", source: "seed" },
    ]);
    // Insert an OLD scan for "high" first, then a NEWER one — getTopOpportunities
    // returns the newest row per keyword, so its id differs from whatever a
    // prior run might have recorded. Dedup must still catch it because it keys
    // on the keyword, not the (now-stale) row id.
    await insertScan(makeScan({ keyword: "zzz-gapcol-high", opportunity: 0.9 }));
    await insertScan(makeScan({ keyword: "zzz-gapcol-high", opportunity: 1.0 }));
    await insertScan(makeScan({ keyword: "zzz-gapcol-mid", opportunity: 0.99 }));

    const ctx = makeCtx(
      new Map([["appstore_keyword_scans", new Set(["zzz-gapcol-high"])]]),
    );

    const seeds = await collectKeywordGaps(ctx, { limit: 500, minOpportunity: 0.5 });
    const mine = seeds.filter((s) => TEST_KEYWORDS.includes(s.keyword));

    expect(mine.map((s) => s.keyword)).toEqual(["zzz-gapcol-mid"]);
    expect(mine.some((s) => s.keyword === "zzz-gapcol-high")).toBe(false);

    const selectedKeywords = ctx.selected.get("appstore_keyword_scans") ?? [];
    expect(selectedKeywords).toContain("zzz-gapcol-mid");
    expect(selectedKeywords).not.toContain("zzz-gapcol-high");
  });

  // Batch F, F1: collectKeywordGaps hardcodes store:'app' + excludeLowConfidence
  // on its auto-selected fetch.
  it("excludes a DE-storefront scan and a low_confidence scan from auto-selected seeds", async () => {
    await upsertKeywords([
      { keyword: "zzz-gapcol-de-store", genreZone: "zzz-gapcol", source: "seed" },
      { keyword: "zzz-gapcol-lowconf", genreZone: "zzz-gapcol", source: "seed" },
    ]);
    await insertScan(makeScan({ keyword: "zzz-gapcol-de-store", store: "DE", opportunity: 1.0 }));
    await insertScan(makeScan({ keyword: "zzz-gapcol-lowconf", lowConfidence: true, opportunity: 1.0 }));

    const ctx = makeCtx();
    const seeds = await collectKeywordGaps(ctx, { limit: 500, minOpportunity: 0.5 });
    const keywords = seeds.map((s) => s.keyword);

    expect(keywords).not.toContain("zzz-gapcol-de-store");
    expect(keywords).not.toContain("zzz-gapcol-lowconf");
  });

  // Batch F, F3: explicit `seedKeywords` are drawn AHEAD of auto-selection,
  // bypassing the opportunity threshold.
  it("draws seedKeywords as priority seeds, bypassing the minOpportunity threshold", async () => {
    await upsertKeywords([
      { keyword: "zzz-gapcol-priority-pick", genreZone: "zzz-gapcol", source: "seed" },
    ]);
    // Below minOpportunity — would never auto-select, but it's an EXPLICIT pick.
    await insertScan(makeScan({ keyword: "zzz-gapcol-priority-pick", opportunity: 0.01 }));

    const ctx = makeCtx();
    const seeds = await collectKeywordGaps(ctx, {
      limit: 500,
      minOpportunity: 0.9,
      seedKeywords: ["zzz-gapcol-priority-pick"],
    });

    expect(seeds.map((s) => s.keyword)).toContain("zzz-gapcol-priority-pick");
  });

  // Batch F, F5 leg 3: the server-side starred watchlist is auto-pulled as
  // priority seeds; a human dismissed/killed verdict hard-excludes; a
  // pipeline dismissed verdict only soft-downweights (still included).
  describe("keyword-verdict integration (Batch F, F5)", () => {
    afterEach(async () => {
      await deleteKeywordVerdict("zzz-gapcol-starred", "human");
      await deleteKeywordVerdict("zzz-gapcol-excluded", "human");
      await deleteKeywordVerdict("zzz-gapcol-downweighted", "pipeline");
    });

    it("auto-pulls a starred keyword as a priority seed even below minOpportunity", async () => {
      await upsertKeywords([
        { keyword: "zzz-gapcol-starred", genreZone: "zzz-gapcol", source: "seed" },
      ]);
      await insertScan(makeScan({ keyword: "zzz-gapcol-starred", opportunity: 0.01 }));
      await upsertKeywordVerdict({
        keyword: "zzz-gapcol-starred",
        verdict: "starred",
        source: "human",
      });

      const ctx = makeCtx();
      const seeds = await collectKeywordGaps(ctx, { limit: 500, minOpportunity: 0.9 });

      expect(seeds.map((s) => s.keyword)).toContain("zzz-gapcol-starred");
    });

    it("hard-excludes a human-dismissed keyword from auto-selection", async () => {
      await upsertKeywords([
        { keyword: "zzz-gapcol-excluded", genreZone: "zzz-gapcol", source: "seed" },
      ]);
      await insertScan(makeScan({ keyword: "zzz-gapcol-excluded", opportunity: 1.0 }));
      await upsertKeywordVerdict({
        keyword: "zzz-gapcol-excluded",
        verdict: "dismissed",
        source: "human",
      });

      const ctx = makeCtx();
      const seeds = await collectKeywordGaps(ctx, { limit: 500, minOpportunity: 0.5 });

      expect(seeds.map((s) => s.keyword)).not.toContain("zzz-gapcol-excluded");
    });

    it("still includes a pipeline-dismissed (soft-downweighted) keyword", async () => {
      await upsertKeywords([
        { keyword: "zzz-gapcol-downweighted", genreZone: "zzz-gapcol", source: "seed" },
      ]);
      await insertScan(makeScan({ keyword: "zzz-gapcol-downweighted", opportunity: 1.0 }));
      await upsertKeywordVerdict({
        keyword: "zzz-gapcol-downweighted",
        verdict: "dismissed",
        source: "pipeline",
      });

      const ctx = makeCtx();
      const seeds = await collectKeywordGaps(ctx, { limit: 500, minOpportunity: 0.5 });

      // Soft downweight — still eligible, unlike the hard-excluded case above.
      expect(seeds.map((s) => s.keyword)).toContain("zzz-gapcol-downweighted");
    });
  });
});
