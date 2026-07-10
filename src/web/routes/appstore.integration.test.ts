/**
 * Integration tests for the App Store keyword-gap opportunities routes.
 *
 * Contracts:
 * - GET /appstore/opportunities?limit&offset&search&sort&genreZone&trend —
 *   ranks the WHOLE keyword corpus by peak-ever opportunity (default,
 *   `sort=peak`) or latest-scan opportunity (`sort=latest`); `search` is a
 *   case-insensitive substring match on `keyword` applied server-side across
 *   the whole corpus, not just the returned page. Responds
 *   `{ success, data: OpportunityRow[], meta: { total, limit, offset } }`,
 *   where `total` is the filtered match count (for pagination) and each row
 *   carries both `opportunity` (latest scan) and `peakOpportunity`
 *   (all-time best). Zod-validates query params; a bad `trend`/`sort` value
 *   returns 400.
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
  "zzz-web-gap-bad trend keyword",
  "zzz-web-gap-history keyword",
  "zzz-web-peak-old-glory",
  "zzz-web-peak-steady",
  "zzz-web-page-a",
  "zzz-web-page-b",
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
    ...overrides,
  };
}

interface OpportunityRow {
  readonly keyword: string;
  readonly opportunity: number;
  readonly peakOpportunity: number;
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
    it("200 returns the seeded keyword, ordered by opportunity desc", async () => {
      const now = Math.floor(Date.now() / 1000);
      await upsertKeywords([
        {
          keyword: "zzz-web-gap-low opportunity keyword",
          genreZone: "health",
          source: "seed",
        },
        {
          keyword: "zzz-web-gap-high opportunity keyword",
          genreZone: "health",
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
      // Scoped via `search` so this is deterministic regardless of how much
      // real corpus data (with its own, possibly higher, peak/latest
      // opportunities) is already loaded into this shared DB.
      const res = await get(app, "/appstore/opportunities?limit=5&search=zzz-web-gap");
      expect(res.status).toBe(200);

      const body = await json<OpportunitiesResponse>(res);
      expect(body.success).toBe(true);
      expect(body.meta.limit).toBe(5);
      expect(body.meta.offset).toBe(0);
      expect(typeof body.meta.total).toBe("number");

      const keywords = body.data.map((r) => r.keyword);
      expect(keywords).toContain("zzz-web-gap-low opportunity keyword");
      expect(keywords).toContain("zzz-web-gap-high opportunity keyword");

      const highIdx = keywords.indexOf("zzz-web-gap-high opportunity keyword");
      const lowIdx = keywords.indexOf("zzz-web-gap-low opportunity keyword");
      expect(highIdx).toBeLessThan(lowIdx);

      // firstFoundAt/source come from the joined appstore_keywords row.
      const highRow = body.data.find(
        (r) => r.keyword === "zzz-web-gap-high opportunity keyword",
      );
      expect(highRow?.source).toBe("autocomplete");
      expect(typeof highRow?.firstFoundAt).toBe("number");
      // Single scan each — peak-ever equals the latest scan's opportunity.
      expect(highRow?.peakOpportunity).toBeCloseTo(0.9, 2);
    });

    it("200 defaults to sort=peak: a keyword's collapsed latest scan still surfaces via its all-time peak", async () => {
      const now = Math.floor(Date.now() / 1000);
      await upsertKeywords([
        { keyword: "zzz-web-peak-old-glory", genreZone: "health", source: "seed" },
        { keyword: "zzz-web-peak-steady", genreZone: "health", source: "seed" },
      ]);
      await insertScan(
        makeScan({ keyword: "zzz-web-peak-old-glory", opportunity: 0.95, scannedAt: now - 1000 }),
      );
      await insertScan(
        makeScan({ keyword: "zzz-web-peak-old-glory", opportunity: 0.05, scannedAt: now }),
      );
      await insertScan(
        makeScan({ keyword: "zzz-web-peak-steady", opportunity: 0.5, scannedAt: now }),
      );

      const app = makeApp();
      // No explicit `sort` — must default to peak.
      const res = await get(app, "/appstore/opportunities?search=zzz-web-peak&limit=50");
      expect(res.status).toBe(200);

      const body = await json<OpportunitiesResponse>(res);
      const keywords = body.data.map((r) => r.keyword);
      expect(keywords.indexOf("zzz-web-peak-old-glory")).toBeLessThan(
        keywords.indexOf("zzz-web-peak-steady"),
      );

      const oldGlory = body.data.find((r) => r.keyword === "zzz-web-peak-old-glory");
      expect(oldGlory?.peakOpportunity).toBeCloseTo(0.95, 2);
      expect(oldGlory?.opportunity).toBeCloseTo(0.05, 2);

      // sort=latest flips the order back: steady's 0.5 latest beats old-glory's collapsed 0.05.
      const latestRes = await get(
        app,
        "/appstore/opportunities?search=zzz-web-peak&limit=50&sort=latest",
      );
      const latestBody = await json<OpportunitiesResponse>(latestRes);
      const latestKeywords = latestBody.data.map((r) => r.keyword);
      expect(latestKeywords.indexOf("zzz-web-peak-steady")).toBeLessThan(
        latestKeywords.indexOf("zzz-web-peak-old-glory"),
      );
    });

    it("400 on an invalid sort value", async () => {
      const app = makeApp();
      const res = await get(app, "/appstore/opportunities?sort=bogus");
      expect(res.status).toBe(400);
      const body = await json<{ success: boolean }>(res);
      expect(body.success).toBe(false);
    });

    it("200 paginates via offset, and search scopes total to the matching corpus", async () => {
      const now = Math.floor(Date.now() / 1000);
      await upsertKeywords([
        { keyword: "zzz-web-page-a", genreZone: "health", source: "seed" },
        { keyword: "zzz-web-page-b", genreZone: "health", source: "seed" },
      ]);
      await insertScan(makeScan({ keyword: "zzz-web-page-a", opportunity: 0.8, scannedAt: now }));
      await insertScan(makeScan({ keyword: "zzz-web-page-b", opportunity: 0.4, scannedAt: now }));

      const app = makeApp();
      const page0 = await json<OpportunitiesResponse>(
        await get(app, "/appstore/opportunities?search=zzz-web-page&limit=1&offset=0"),
      );
      expect(page0.meta.total).toBe(2);
      expect(page0.data).toHaveLength(1);
      expect(page0.data[0]?.keyword).toBe("zzz-web-page-a");

      const page1 = await json<OpportunitiesResponse>(
        await get(app, "/appstore/opportunities?search=zzz-web-page&limit=1&offset=1"),
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

    it("200 with empty genreZone ignores filter, returns seeded keyword", async () => {
      const now = Math.floor(Date.now() / 1000);
      await upsertKeywords([
        {
          keyword: "zzz-web-gap-low opportunity keyword",
          genreZone: "health",
          source: "seed",
        },
      ]);
      await insertScan(
        makeScan({
          keyword: "zzz-web-gap-low opportunity keyword",
          opportunity: 0.3,
          scannedAt: now,
        }),
      );

      const app = makeApp();
      // Scoped via `search` so the assertion holds regardless of how much
      // real corpus data already exists in this shared DB.
      const res = await get(
        app,
        "/appstore/opportunities?genreZone=&search=zzz-web-gap-low",
      );
      expect(res.status).toBe(200);

      const body = await json<OpportunitiesResponse>(res);
      expect(body.success).toBe(true);
      expect(body.data.map((r) => r.keyword)).toContain(
        "zzz-web-gap-low opportunity keyword",
      );
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
