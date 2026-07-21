/**
 * Integration tests for the App Store keyword-gap opportunities routes.
 *
 * Contracts:
 * - GET /appstore/opportunities?limit&offset&sort&dir&genreZone&trend — pages
 *   through the WHOLE keyword corpus's latest scan per (keyword, store),
 *   sorted by any of the ten `SortKey` columns (default "opportunity") in
 *   `dir` direction (default "desc"). Responds
 *   `{ success, data: OpportunityRow[], meta: { total, limit, offset } }`,
 *   where `total` is the filtered (genreZone/trend), pre-pagination match
 *   count and each row carries both `opportunity` (latest scan) and
 *   `peakOpportunity` (all-time best). Zod-validates query params; a bad
 *   `trend`/`sort` value returns 400. `limit` is 1..100 (default 50).
 * - GET /appstore/opportunities/:keyword — scan history for one keyword,
 *   newest first, bounded by `limit`.
 *
 * Lane: *.integration.test.ts — `bun run test:integration`.
 * Requires: docker compose up -d postgres
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { initDb, getDb } from "../../store/db";
import { upsertKeywords, insertScan } from "../../sources/appstore/keyword-store";
import type { KeywordGapProfile, TopApp } from "../../sources/appstore/keyword-types";
import { createAppStoreRoutes } from "./appstore";

const BASE = "http://localhost";

/**
 * Every keyword any test in this file inserts. Centralized so cleanup can
 * always target a fixed, known set — keeps repeated `bun run test:integration`
 * runs from leaking rows into other opportunities-ordering assertions.
 * Deleting a keyword a prior (crashed) run left behind is a safe no-op.
 */
const TEST_KEYWORDS: readonly string[] = [
  "zzz-web-gap-low opportunity keyword",
  "zzz-web-gap-high opportunity keyword",
  "zzz-web-gap-history keyword",
  "zzz-web-page-a",
  "zzz-web-page-b",
  "zzz-web-sort-asc-a",
  "zzz-web-sort-asc-b",
  "zzz-web-sort-text-alpha",
  "zzz-web-sort-text-bravo",
  "zzz-web-empty-genre-zone-keyword",
  "zzz-web-sweet-spot-match",
  "zzz-web-sweet-spot-decoy",
  "zzz-web-hidejunk-false-keyword",
  "hd",
  "zzz-web-build-sort-a",
  "zzz-web-build-sort-b",
  "zzz-web-build-filter-high",
  "zzz-web-build-filter-low",
];

async function cleanupTestKeywords(): Promise<void> {
  const db = getDb();
  await db`DELETE FROM appstore_keyword_scans WHERE keyword IN ${db(TEST_KEYWORDS)}`;
  await db`DELETE FROM appstore_keywords WHERE keyword IN ${db(TEST_KEYWORDS)}`;
}

function makeApp() {
  return createAppStoreRoutes();
}

async function json<T>(res: Response): Promise<T> {
  return res.json() as Promise<T>;
}

function get(app: ReturnType<typeof makeApp>, path: string): Promise<Response> {
  return Promise.resolve(app.fetch(new Request(`${BASE}${path}`)));
}

function makeTopApp(overrides: Partial<TopApp> = {}): TopApp {
  return {
    id: "1",
    name: "Toy",
    reviews: 11,
    rating: 3.4,
    ageDays: 500,
    ratingsPerDay: 0.02,
    titleMatch: true,
    ...overrides,
  };
}

function makeScan(overrides: Partial<KeywordGapProfile> & { keyword: string }): KeywordGapProfile {
  const now = Math.floor(Date.now() / 1000);
  return {
    store: "app",
    competitiveness: 20,
    demand: 13,
    incumbentWeakness: 0.8,
    opportunity: 0.53,
    trend: "heating",
    topAppReviews: 11,
    avgRating: 3.4,
    avgAgeDays: 500,
    topApps: [makeTopApp()],
    scannedAt: now,
    lowConfidence: false,
    ...overrides,
  };
}

interface OpportunityRow {
  readonly keyword: string;
  readonly opportunity: number;
  readonly peakOpportunity: number;
  readonly buildability: number;
  readonly scannedAt: number;
  readonly firstFoundAt: number | null;
  readonly source: string | null;
}

interface OpportunitiesResponse {
  readonly success: boolean;
  readonly data: OpportunityRow[];
  readonly meta: {
    readonly total: number;
    readonly limit: number;
    readonly offset: number;
  };
}

interface ScanHistoryData {
  readonly history: readonly OpportunityRow[];
  readonly meta: {
    readonly keyword: string;
    readonly firstFoundAt: number | null;
    readonly source: string | null;
  };
}

describe("appstore opportunities routes", () => {
  beforeAll(async () => {
    await initDb(process.env.DATABASE_URL);
    // Pre-clean in case a previous crashed run left rows behind.
    await cleanupTestKeywords();
  });

  afterEach(async () => {
    await cleanupTestKeywords();
  });

  afterAll(async () => {
    await cleanupTestKeywords();
  });

  describe("GET /appstore/opportunities", () => {
    it("200 returns the seeded keywords, ordered by opportunity desc by default", async () => {
      const now = Math.floor(Date.now() / 1000);
      const zone = "zzz-web-gap-zone";
      await upsertKeywords([
        {
          keyword: "zzz-web-gap-low opportunity keyword",
          genreZone: zone,
          source: "seed",
        },
        {
          keyword: "zzz-web-gap-high opportunity keyword",
          genreZone: zone,
          source: "autocomplete",
        },
      ]);
      await insertScan(
        makeScan({
          keyword: "zzz-web-gap-low opportunity keyword",
          opportunity: 0.1,
          scannedAt: now,
        }),
      );
      await insertScan(
        makeScan({
          keyword: "zzz-web-gap-high opportunity keyword",
          opportunity: 0.9,
          scannedAt: now,
        }),
      );

      const app = makeApp();
      const res = await get(app, `/appstore/opportunities?limit=5&genreZone=${zone}`);
      expect(res.status).toBe(200);

      const body = await json<OpportunitiesResponse>(res);
      expect(body.success).toBe(true);
      expect(body.meta.limit).toBe(5);
      expect(body.meta.offset).toBe(0);
      expect(body.meta.total).toBe(2);

      const keywords = body.data.map((r) => r.keyword);
      expect(keywords).toEqual([
        "zzz-web-gap-high opportunity keyword",
        "zzz-web-gap-low opportunity keyword",
      ]);

      // firstFoundAt/source come from the joined appstore_keywords row.
      const highRow = body.data.find(
        (r) => r.keyword === "zzz-web-gap-high opportunity keyword",
      );
      expect(highRow?.source).toBe("autocomplete");
      expect(typeof highRow?.firstFoundAt).toBe("number");
      // Single scan each — peak-ever equals the latest scan's opportunity.
      expect(highRow?.peakOpportunity).toBeCloseTo(0.9, 2);
    });

    it("200 sorts by dir=asc on a numeric column", async () => {
      const now = Math.floor(Date.now() / 1000);
      const zone = "zzz-web-sort-asc-zone";
      await upsertKeywords([
        { keyword: "zzz-web-sort-asc-a", genreZone: zone, source: "seed" },
        { keyword: "zzz-web-sort-asc-b", genreZone: zone, source: "seed" },
      ]);
      await insertScan(
        makeScan({ keyword: "zzz-web-sort-asc-a", opportunity: 0.2, scannedAt: now }),
      );
      await insertScan(
        makeScan({ keyword: "zzz-web-sort-asc-b", opportunity: 0.8, scannedAt: now }),
      );

      const app = makeApp();
      const res = await get(
        app,
        `/appstore/opportunities?genreZone=${zone}&sort=opportunity&dir=asc`,
      );
      expect(res.status).toBe(200);
      const body = await json<OpportunitiesResponse>(res);
      expect(body.data.map((r) => r.keyword)).toEqual([
        "zzz-web-sort-asc-a",
        "zzz-web-sort-asc-b",
      ]);
    });

    it("200 sorts by the keyword text column", async () => {
      const now = Math.floor(Date.now() / 1000);
      const zone = "zzz-web-sort-text-zone";
      await upsertKeywords([
        { keyword: "zzz-web-sort-text-bravo", genreZone: zone, source: "seed" },
        { keyword: "zzz-web-sort-text-alpha", genreZone: zone, source: "seed" },
      ]);
      await insertScan(makeScan({ keyword: "zzz-web-sort-text-bravo", scannedAt: now }));
      await insertScan(makeScan({ keyword: "zzz-web-sort-text-alpha", scannedAt: now }));

      const app = makeApp();
      const ascRes = await get(
        app,
        `/appstore/opportunities?genreZone=${zone}&sort=keyword&dir=asc`,
      );
      const ascBody = await json<OpportunitiesResponse>(ascRes);
      expect(ascBody.data.map((r) => r.keyword)).toEqual([
        "zzz-web-sort-text-alpha",
        "zzz-web-sort-text-bravo",
      ]);

      const descRes = await get(
        app,
        `/appstore/opportunities?genreZone=${zone}&sort=keyword&dir=desc`,
      );
      const descBody = await json<OpportunitiesResponse>(descRes);
      expect(descBody.data.map((r) => r.keyword)).toEqual([
        "zzz-web-sort-text-bravo",
        "zzz-web-sort-text-alpha",
      ]);
    });

    it("400 on an invalid sort value", async () => {
      const app = makeApp();
      const res = await get(app, "/appstore/opportunities?sort=bogus");
      expect(res.status).toBe(400);
      const body = await json<{ success: boolean }>(res);
      expect(body.success).toBe(false);
    });

    it("200 paginates via offset, and meta.total reflects the whole filtered corpus", async () => {
      const now = Math.floor(Date.now() / 1000);
      const zone = "zzz-web-page-zone";
      await upsertKeywords([
        { keyword: "zzz-web-page-a", genreZone: zone, source: "seed" },
        { keyword: "zzz-web-page-b", genreZone: zone, source: "seed" },
      ]);
      await insertScan(makeScan({ keyword: "zzz-web-page-a", opportunity: 0.8, scannedAt: now }));
      await insertScan(makeScan({ keyword: "zzz-web-page-b", opportunity: 0.4, scannedAt: now }));

      const app = makeApp();
      const page0 = await json<OpportunitiesResponse>(
        await get(app, `/appstore/opportunities?genreZone=${zone}&limit=1&offset=0`),
      );
      expect(page0.meta.total).toBe(2);
      expect(page0.data).toHaveLength(1);
      expect(page0.data[0]?.keyword).toBe("zzz-web-page-a");

      const page1 = await json<OpportunitiesResponse>(
        await get(app, `/appstore/opportunities?genreZone=${zone}&limit=1&offset=1`),
      );
      expect(page1.meta.total).toBe(2);
      expect(page1.data[0]?.keyword).toBe("zzz-web-page-b");
    });

    it("400 on an invalid trend value", async () => {
      const app = makeApp();
      const res = await get(app, "/appstore/opportunities?trend=bogus");
      expect(res.status).toBe(400);
      const body = await json<{ success: boolean }>(res);
      expect(body.success).toBe(false);
    });

    it("400 on a limit above the 100 cap", async () => {
      const app = makeApp();
      const res = await get(app, "/appstore/opportunities?limit=500");
      expect(res.status).toBe(400);
      const body = await json<{ success: boolean }>(res);
      expect(body.success).toBe(false);
    });

    it("200 with empty genreZone ignores the filter, still returns the seeded keyword", async () => {
      const now = Math.floor(Date.now() / 1000);
      await upsertKeywords([
        {
          keyword: "zzz-web-empty-genre-zone-keyword",
          genreZone: "zzz-web-empty-genre-actual-zone",
          source: "seed",
        },
      ]);
      // Set far above any realistic opportunity score so, with the default
      // sort=opportunity&dir=desc, this row is guaranteed to land on page 1
      // regardless of how much real corpus data already exists in this
      // shared DB.
      await insertScan(
        makeScan({
          keyword: "zzz-web-empty-genre-zone-keyword",
          opportunity: 999_999,
          scannedAt: now,
        }),
      );

      const app = makeApp();
      const res = await get(app, "/appstore/opportunities?genreZone=&limit=1");
      expect(res.status).toBe(200);

      const body = await json<OpportunitiesResponse>(res);
      expect(body.success).toBe(true);
      expect(body.data.map((r) => r.keyword)).toContain(
        "zzz-web-empty-genre-zone-keyword",
      );
    });

    it("400 when maxCompetitiveness is out of the 0..100 range", async () => {
      const app = makeApp();
      const res = await get(app, "/appstore/opportunities?maxCompetitiveness=200");
      expect(res.status).toBe(400);
      const body = await json<{ success: boolean }>(res);
      expect(body.success).toBe(false);
    });

    it("400 when minIncumbentWeakness is out of the 0..1 range", async () => {
      const app = makeApp();
      const res = await get(app, "/appstore/opportunities?minIncumbentWeakness=5");
      expect(res.status).toBe(400);
      const body = await json<{ success: boolean }>(res);
      expect(body.success).toBe(false);
    });

    it("parses hideJunk=false correctly (does not coerce the string 'false' to true)", async () => {
      const now = Math.floor(Date.now() / 1000);
      await upsertKeywords([{ keyword: "hd", genreZone: "zzz-web-hidejunk-zone", source: "seed" }]);
      await insertScan(makeScan({ keyword: "hd", scannedAt: now }));

      const app = makeApp();
      const res = await get(
        app,
        "/appstore/opportunities?genreZone=zzz-web-hidejunk-zone&hideJunk=false",
      );
      expect(res.status).toBe(200);
      const body = await json<OpportunitiesResponse>(res);
      expect(body.data.map((r) => r.keyword)).toContain("hd");
    });

    it("200 the 'Indie sweet spot' filter set (minDemand/maxCompetitiveness/minIncumbentWeakness/hideJunk) returns only matching rows, and meta.total reflects the filtered count", async () => {
      const now = Math.floor(Date.now() / 1000);
      const zone = "zzz-web-sweet-spot-zone";
      await upsertKeywords([
        { keyword: "zzz-web-sweet-spot-match", genreZone: zone, source: "seed" },
        { keyword: "zzz-web-sweet-spot-decoy", genreZone: zone, source: "seed" },
      ]);
      await insertScan(
        makeScan({
          keyword: "zzz-web-sweet-spot-match",
          demand: 10,
          competitiveness: 30,
          incumbentWeakness: 0.6,
          scannedAt: now,
        }),
      );
      // Fails minDemand.
      await insertScan(
        makeScan({
          keyword: "zzz-web-sweet-spot-decoy",
          demand: 1,
          competitiveness: 30,
          incumbentWeakness: 0.6,
          scannedAt: now,
        }),
      );

      const app = makeApp();
      const res = await get(
        app,
        `/appstore/opportunities?genreZone=${zone}&minDemand=5&maxCompetitiveness=45&minIncumbentWeakness=0.4&hideJunk=true`,
      );
      expect(res.status).toBe(200);
      const body = await json<OpportunitiesResponse>(res);
      expect(body.data.map((r) => r.keyword)).toEqual(["zzz-web-sweet-spot-match"]);
      expect(body.meta.total).toBe(1);
    });

    it("200 accepts sort=buildability and orders rows by it", async () => {
      const now = Math.floor(Date.now() / 1000);
      const zone = "zzz-web-build-sort-zone";
      await upsertKeywords([
        { keyword: "zzz-web-build-sort-a", genreZone: zone, source: "seed" },
        { keyword: "zzz-web-build-sort-b", genreZone: zone, source: "seed" },
      ]);
      // a: no demand => buildability 0. b: strong demand + weak incumbent => high.
      await insertScan(
        makeScan({
          keyword: "zzz-web-build-sort-a",
          demand: 0,
          topAppReviews: 100,
          avgRating: 3.0,
          scannedAt: now,
        }),
      );
      await insertScan(
        makeScan({
          keyword: "zzz-web-build-sort-b",
          demand: 200,
          topAppReviews: 10,
          avgRating: 2.0,
          scannedAt: now,
        }),
      );

      const app = makeApp();
      const res = await get(
        app,
        `/appstore/opportunities?genreZone=${zone}&sort=buildability&dir=desc`,
      );
      expect(res.status).toBe(200);
      const body = await json<OpportunitiesResponse>(res);
      expect(body.data.map((r) => r.keyword)).toEqual([
        "zzz-web-build-sort-b",
        "zzz-web-build-sort-a",
      ]);
      expect(body.data[0]?.buildability).toBeGreaterThan(70);
      expect(body.data[1]?.buildability).toBe(0);
    });

    it("400 when minBuildability is above the 100 cap", async () => {
      const app = makeApp();
      const res = await get(app, "/appstore/opportunities?minBuildability=150");
      expect(res.status).toBe(400);
      const body = await json<{ success: boolean }>(res);
      expect(body.success).toBe(false);
    });

    it("200 minBuildability filters out low-buildability rows and total reflects the filtered count", async () => {
      const now = Math.floor(Date.now() / 1000);
      const zone = "zzz-web-build-filter-zone";
      await upsertKeywords([
        { keyword: "zzz-web-build-filter-high", genreZone: zone, source: "seed" },
        { keyword: "zzz-web-build-filter-low", genreZone: zone, source: "seed" },
      ]);
      await insertScan(
        makeScan({
          keyword: "zzz-web-build-filter-high",
          demand: 200,
          topAppReviews: 10,
          avgRating: 2.0,
          scannedAt: now,
        }),
      );
      await insertScan(
        makeScan({
          keyword: "zzz-web-build-filter-low",
          demand: 0,
          topAppReviews: 100,
          avgRating: 3.0,
          scannedAt: now,
        }),
      );

      const app = makeApp();
      const res = await get(
        app,
        `/appstore/opportunities?genreZone=${zone}&minBuildability=50`,
      );
      expect(res.status).toBe(200);
      const body = await json<OpportunitiesResponse>(res);
      expect(body.data.map((r) => r.keyword)).toEqual(["zzz-web-build-filter-high"]);
      expect(body.meta.total).toBe(1);
    });
  });

  describe("GET /appstore/opportunities/:keyword", () => {
    it("200 returns { history, meta }: scan history newest-first + keyword meta", async () => {
      const base = Math.floor(Date.now() / 1000);
      await upsertKeywords([
        { keyword: "zzz-web-gap-history keyword", genreZone: "health", source: "pipeline" },
      ]);
      await insertScan(
        makeScan({ keyword: "zzz-web-gap-history keyword", opportunity: 0.2, scannedAt: base - 100 }),
      );
      await insertScan(
        makeScan({ keyword: "zzz-web-gap-history keyword", opportunity: 0.4, scannedAt: base }),
      );

      const app = makeApp();
      const res = await get(
        app,
        `/appstore/opportunities/${encodeURIComponent("zzz-web-gap-history keyword")}`,
      );
      expect(res.status).toBe(200);

      const body = await json<{ success: boolean; data: ScanHistoryData }>(res);
      expect(body.success).toBe(true);
      expect(body.data.history).toHaveLength(2);
      expect(body.data.history[0]?.scannedAt).toBe(base);
      expect(body.data.history[1]?.scannedAt).toBe(base - 100);
      expect(
        body.data.history.every((r) => r.keyword === "zzz-web-gap-history keyword"),
      ).toBe(true);

      expect(body.data.meta.keyword).toBe("zzz-web-gap-history keyword");
      expect(body.data.meta.source).toBe("pipeline");
      expect(typeof body.data.meta.firstFoundAt).toBe("number");
    });

    it("200 returns meta with null firstFoundAt/source when the keyword has no corpus row", async () => {
      const base = Math.floor(Date.now() / 1000);
      // Insert a scan with no corresponding appstore_keywords row — the
      // history endpoint has no NOT NULL / FK dependency on the corpus.
      await insertScan(
        makeScan({ keyword: "zzz-web-gap-history keyword", opportunity: 0.2, scannedAt: base }),
      );

      const app = makeApp();
      const res = await get(
        app,
        `/appstore/opportunities/${encodeURIComponent("zzz-web-gap-history keyword")}`,
      );
      expect(res.status).toBe(200);

      const body = await json<{ success: boolean; data: ScanHistoryData }>(res);
      expect(body.data.history).toHaveLength(1);
      expect(body.data.meta.firstFoundAt).toBeNull();
      expect(body.data.meta.source).toBeNull();
    });
  });
});
