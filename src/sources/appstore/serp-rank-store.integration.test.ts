import { describe, expect, it, beforeAll, afterAll, afterEach } from "bun:test";
import { initDb, getDb } from "../../store/db";
import { insertScan } from "./keyword-store";
import { getRankSeriesFromScans, getRankClimbers } from "./serp-rank-store";
import type { KeywordGapProfile, TopApp } from "./keyword-types";

const TEST_KEYWORDS: readonly string[] = [
  "zzz-rank-series-kw",
  "zzz-rank-climbers-kw",
  "zzz-rank-single-scan-kw",
];

async function cleanup(): Promise<void> {
  const db = getDb();
  await db`DELETE FROM appstore_keyword_scans WHERE keyword IN ${db(TEST_KEYWORDS)}`;
}

function makeTopApp(overrides: Partial<TopApp> = {}): TopApp {
  return {
    id: "app-1",
    name: "Sample App",
    reviews: 10,
    rating: 4.0,
    ageDays: 100,
    ratingsPerDay: 0.1,
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
    brandNavigational: false,
    ...overrides,
  };
}

describe("serp-rank-store", () => {
  beforeAll(async () => {
    await initDb(process.env.DATABASE_URL);
    await cleanup();
  });

  afterEach(cleanup);
  afterAll(cleanup);

  describe("getRankSeriesFromScans", () => {
    it("round-trips a rank found in top_apps (index position)", async () => {
      const now = Math.floor(Date.now() / 1000);
      await insertScan(
        makeScan({
          keyword: "zzz-rank-series-kw",
          scannedAt: now,
          topApps: [
            makeTopApp({ id: "leader" }),
            makeTopApp({ id: "runner-up" }),
            makeTopApp({ id: "target-app" }),
          ],
        }),
      );

      const series = await getRankSeriesFromScans("zzz-rank-series-kw", "app", "target-app");
      expect(series.length).toBe(1);
      expect(series[0]?.rank).toBe(2);
      expect(series[0]?.scannedAt).toBe(now);
    });

    it("round-trips a rank found only in serp_tail (deep-scan-only entry)", async () => {
      const now = Math.floor(Date.now() / 1000);
      await insertScan(
        makeScan({
          keyword: "zzz-rank-series-kw",
          scannedAt: now,
          topApps: [makeTopApp({ id: "leader" })],
          serpTail: [
            { id: "deep-app-a", rank: 20 },
            { id: "deep-app-b", rank: 21 },
          ],
        }),
      );

      const series = await getRankSeriesFromScans("zzz-rank-series-kw", "app", "deep-app-b");
      expect(series.length).toBe(1);
      expect(series[0]?.rank).toBe(21);
    });

    it("returns rank: null for a scan where the app appears in neither top_apps nor serp_tail", async () => {
      await insertScan(
        makeScan({
          keyword: "zzz-rank-series-kw",
          topApps: [makeTopApp({ id: "someone-else" })],
        }),
      );

      const series = await getRankSeriesFromScans("zzz-rank-series-kw", "app", "absent-app");
      expect(series.length).toBe(1);
      expect(series[0]?.rank).toBeNull();
    });

    it("orders newest-first and respects limit", async () => {
      const now = Math.floor(Date.now() / 1000);
      await insertScan(
        makeScan({ keyword: "zzz-rank-series-kw", scannedAt: now - 200, topApps: [makeTopApp({ id: "x" })] }),
      );
      await insertScan(
        makeScan({ keyword: "zzz-rank-series-kw", scannedAt: now - 100, topApps: [makeTopApp({ id: "x" })] }),
      );
      await insertScan(
        makeScan({ keyword: "zzz-rank-series-kw", scannedAt: now, topApps: [makeTopApp({ id: "x" })] }),
      );

      const series = await getRankSeriesFromScans("zzz-rank-series-kw", "app", "x", 2);
      expect(series.length).toBe(2);
      expect(series[0]?.scannedAt).toBe(now);
      expect(series[1]?.scannedAt).toBe(now - 100);
    });

    it("scopes to the requested store — a DE scan never leaks into a US series", async () => {
      const now = Math.floor(Date.now() / 1000);
      await insertScan(
        makeScan({
          keyword: "zzz-rank-series-kw",
          store: "DE",
          scannedAt: now,
          topApps: [makeTopApp({ id: "de-only" })],
        }),
      );

      const usSeries = await getRankSeriesFromScans("zzz-rank-series-kw", "app", "de-only");
      expect(usSeries.length).toBe(0);

      const deSeries = await getRankSeriesFromScans("zzz-rank-series-kw", "DE", "de-only");
      expect(deSeries.length).toBe(1);
      expect(deSeries[0]?.rank).toBe(0);
    });
  });

  describe("getRankClimbers", () => {
    it("returns [] when fewer than 2 scans exist", async () => {
      await insertScan(makeScan({ keyword: "zzz-rank-single-scan-kw" }));
      const climbers = await getRankClimbers("zzz-rank-single-scan-kw", "app", 10);
      expect(climbers).toEqual([]);
    });

    it("ranks a climbing app first (delta = fromRank - toRank, positive = climbed)", async () => {
      const now = Math.floor(Date.now() / 1000);
      // Older scan: "climber" at rank 5, "steady" at rank 0.
      await insertScan(
        makeScan({
          keyword: "zzz-rank-climbers-kw",
          scannedAt: now - 3600,
          topApps: [
            makeTopApp({ id: "steady" }),
            makeTopApp({ id: "b" }),
            makeTopApp({ id: "c" }),
            makeTopApp({ id: "d" }),
            makeTopApp({ id: "e" }),
            makeTopApp({ id: "climber" }),
          ],
        }),
      );
      // Newer scan: "climber" jumped to rank 0 (delta = 5 - 0 = 5); "steady"
      // stayed at 0 -> now rank 1 (delta = 0 - 1 = -1).
      await insertScan(
        makeScan({
          keyword: "zzz-rank-climbers-kw",
          scannedAt: now,
          topApps: [makeTopApp({ id: "climber" }), makeTopApp({ id: "steady" })],
        }),
      );

      const climbers = await getRankClimbers("zzz-rank-climbers-kw", "app", 10);
      expect(climbers.length).toBe(2);
      expect(climbers[0]?.appId).toBe("climber");
      expect(climbers[0]?.fromRank).toBe(5);
      expect(climbers[0]?.toRank).toBe(0);
      expect(climbers[0]?.delta).toBe(5);
      expect(climbers[1]?.appId).toBe("steady");
      expect(climbers[1]?.delta).toBe(-1);
    });

    it("sorts a brand-new entrant (fromRank: null) ahead of any numeric climber", async () => {
      const now = Math.floor(Date.now() / 1000);
      await insertScan(
        makeScan({
          keyword: "zzz-rank-climbers-kw",
          scannedAt: now - 3600,
          topApps: [makeTopApp({ id: "incumbent" }), makeTopApp({ id: "big-climber" })],
        }),
      );
      await insertScan(
        makeScan({
          keyword: "zzz-rank-climbers-kw",
          scannedAt: now,
          topApps: [
            makeTopApp({ id: "new-entrant" }), // wasn't in the older scan at all
            makeTopApp({ id: "big-climber" }), // 1 -> 1, delta 0
            makeTopApp({ id: "incumbent" }), // 0 -> 2, delta -2
          ],
        }),
      );

      const climbers = await getRankClimbers("zzz-rank-climbers-kw", "app", 10);
      expect(climbers[0]?.appId).toBe("new-entrant");
      expect(climbers[0]?.fromRank).toBeNull();
      expect(climbers[0]?.delta).toBeNull();
    });

    it("respects limit", async () => {
      const now = Math.floor(Date.now() / 1000);
      await insertScan(
        makeScan({
          keyword: "zzz-rank-climbers-kw",
          scannedAt: now - 3600,
          topApps: [makeTopApp({ id: "a" }), makeTopApp({ id: "b" }), makeTopApp({ id: "c" })],
        }),
      );
      await insertScan(
        makeScan({
          keyword: "zzz-rank-climbers-kw",
          scannedAt: now,
          topApps: [makeTopApp({ id: "a" }), makeTopApp({ id: "b" }), makeTopApp({ id: "c" })],
        }),
      );

      const climbers = await getRankClimbers("zzz-rank-climbers-kw", "app", 1);
      expect(climbers.length).toBe(1);
    });
  });
});
