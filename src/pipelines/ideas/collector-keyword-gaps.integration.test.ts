import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { getDb, initDb } from "../../store/db";
import { getLatestScan, insertScan, upsertKeywords } from "../../sources/appstore/keyword-store";
import type { KeywordGapProfile } from "../../sources/appstore/keyword-types";
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
];

async function cleanup(): Promise<void> {
  const db = getDb();
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
});
