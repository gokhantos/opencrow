/**
 * Integration tests for the App Store keyword-gap opportunities routes.
 *
 * Contracts:
 * - GET /appstore/opportunities?limit&genreZone&trend — latest scan per
 *   keyword, ordered by opportunity DESC. Zod-validates query params; a bad
 *   `trend` value returns 400.
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
  readonly scannedAt: number;
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
        { keyword: "zzz-web-gap-low opportunity keyword", genreZone: "health", source: "seed" },
        { keyword: "zzz-web-gap-high opportunity keyword", genreZone: "health", source: "seed" },
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
      const res = await get(app, "/appstore/opportunities?limit=5");
      expect(res.status).toBe(200);

      const body = await json<{ success: boolean; data: OpportunityRow[] }>(res);
      expect(body.success).toBe(true);

      const keywords = body.data.map((r) => r.keyword);
      expect(keywords).toContain("zzz-web-gap-low opportunity keyword");
      expect(keywords).toContain("zzz-web-gap-high opportunity keyword");

      const highIdx = keywords.indexOf("zzz-web-gap-high opportunity keyword");
      const lowIdx = keywords.indexOf("zzz-web-gap-low opportunity keyword");
      expect(highIdx).toBeLessThan(lowIdx);
    });

    it("400 on an invalid trend value", async () => {
      const app = makeApp();
      const res = await get(app, "/appstore/opportunities?trend=bogus");
      expect(res.status).toBe(400);
      const body = await json<{ success: boolean }>(res);
      expect(body.success).toBe(false);
    });
  });

  describe("GET /appstore/opportunities/:keyword", () => {
    it("200 returns that keyword's scan history, newest first", async () => {
      const base = Math.floor(Date.now() / 1000);
      await upsertKeywords([
        { keyword: "zzz-web-gap-history keyword", genreZone: "health", source: "seed" },
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

      const body = await json<{ success: boolean; data: OpportunityRow[] }>(res);
      expect(body.success).toBe(true);
      expect(body.data).toHaveLength(2);
      expect(body.data[0]?.scannedAt).toBe(base);
      expect(body.data[1]?.scannedAt).toBe(base - 100);
      expect(body.data.every((r) => r.keyword === "zzz-web-gap-history keyword")).toBe(true);
    });
  });
});
