import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { getDb, initDb } from "../../store/db";
import { insertScan, upsertKeywords } from "./keyword-store";
import type { KeywordGapProfile, TopApp } from "./keyword-types";
import {
  getAlertWatermark,
  getFirstEverCrossings,
  setAlertWatermark,
  GAP_ALERTS_NAMESPACE,
} from "./gap-alerts";
import { deleteOverride } from "../../store/config-overrides";

const TEST_KEYWORDS: readonly string[] = [
  "zzz-crossing-first-ever",
  "zzz-crossing-oscillation",
  "zzz-crossing-never",
  "zzz-crossing-de-excluded",
  "zzz-crossing-lowconf-excluded",
  "zzz-crossing-watermark-old",
  "zzz-crossing-watermark-new",
];

async function cleanup(): Promise<void> {
  const db = getDb();
  await db`DELETE FROM appstore_keyword_scans WHERE keyword IN ${db(TEST_KEYWORDS)}`;
  await db`DELETE FROM appstore_keywords WHERE keyword IN ${db(TEST_KEYWORDS)}`;
  await deleteOverride(GAP_ALERTS_NAMESPACE, "lastAlertRunAt");
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
    lastUpdatedDays: 400,
    price: 0,
    formattedPrice: "Free",
    recentVelocity: 1.5,
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
    opportunity: 0.5,
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

const THRESHOLD = 0.5;

describe("gap-alerts (integration)", () => {
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

  describe("getFirstEverCrossings", () => {
    it("surfaces a keyword whose latest scan clears the threshold for the first time", async () => {
      const now = Math.floor(Date.now() / 1000);
      await upsertKeywords([
        { keyword: "zzz-crossing-first-ever", genreZone: "zzz-crossing-zone", source: "seed" },
      ]);
      await insertScan(
        makeScan({ keyword: "zzz-crossing-first-ever", opportunity: 0.3, scannedAt: now - 200 }),
      );
      await insertScan(
        makeScan({ keyword: "zzz-crossing-first-ever", opportunity: 0.7, scannedAt: now }),
      );

      const crossings = await getFirstEverCrossings({ threshold: THRESHOLD, sinceWatermark: 0 });
      const keywords = crossings.map((c) => c.keyword);
      expect(keywords).toContain("zzz-crossing-first-ever");
    });

    it("does NOT refire for a keyword oscillating around the threshold — only the FIRST crossing counts", async () => {
      const now = Math.floor(Date.now() / 1000);
      await upsertKeywords([
        { keyword: "zzz-crossing-oscillation", genreZone: "zzz-crossing-zone", source: "seed" },
      ]);
      // Crosses above (first-ever crossing)...
      await insertScan(
        makeScan({ keyword: "zzz-crossing-oscillation", opportunity: 0.6, scannedAt: now - 300 }),
      );
      // ...drops below...
      await insertScan(
        makeScan({ keyword: "zzz-crossing-oscillation", opportunity: 0.3, scannedAt: now - 200 }),
      );
      // ...and crosses above AGAIN. The latest scan is above threshold, but this
      // is a RE-crossing, not the first-ever one — must not be reported.
      await insertScan(
        makeScan({ keyword: "zzz-crossing-oscillation", opportunity: 0.65, scannedAt: now }),
      );

      const crossings = await getFirstEverCrossings({ threshold: THRESHOLD, sinceWatermark: 0 });
      expect(crossings.some((c) => c.keyword === "zzz-crossing-oscillation")).toBe(false);
    });

    it("omits a keyword whose latest scan never cleared the threshold", async () => {
      const now = Math.floor(Date.now() / 1000);
      await upsertKeywords([
        { keyword: "zzz-crossing-never", genreZone: "zzz-crossing-zone", source: "seed" },
      ]);
      await insertScan(
        makeScan({ keyword: "zzz-crossing-never", opportunity: 0.1, scannedAt: now }),
      );

      const crossings = await getFirstEverCrossings({ threshold: THRESHOLD, sinceWatermark: 0 });
      expect(crossings.some((c) => c.keyword === "zzz-crossing-never")).toBe(false);
    });

    it("excludes a DE-storefront scan even if it clears the threshold", async () => {
      const now = Math.floor(Date.now() / 1000);
      await upsertKeywords([
        { keyword: "zzz-crossing-de-excluded", genreZone: "zzz-crossing-zone", source: "seed" },
      ]);
      await insertScan(
        makeScan({
          keyword: "zzz-crossing-de-excluded",
          store: "DE",
          opportunity: 0.9,
          scannedAt: now,
        }),
      );

      const crossings = await getFirstEverCrossings({ threshold: THRESHOLD, sinceWatermark: 0 });
      expect(crossings.some((c) => c.keyword === "zzz-crossing-de-excluded")).toBe(false);
    });

    it("excludes a low_confidence scan even if it clears the threshold", async () => {
      const now = Math.floor(Date.now() / 1000);
      await upsertKeywords([
        { keyword: "zzz-crossing-lowconf-excluded", genreZone: "zzz-crossing-zone", source: "seed" },
      ]);
      await insertScan(
        makeScan({
          keyword: "zzz-crossing-lowconf-excluded",
          lowConfidence: true,
          opportunity: 0.9,
          scannedAt: now,
        }),
      );

      const crossings = await getFirstEverCrossings({ threshold: THRESHOLD, sinceWatermark: 0 });
      expect(crossings.some((c) => c.keyword === "zzz-crossing-lowconf-excluded")).toBe(false);
    });

    it("respects sinceWatermark — a crossing scan older than the watermark is excluded", async () => {
      const now = Math.floor(Date.now() / 1000);
      await upsertKeywords([
        { keyword: "zzz-crossing-watermark-old", genreZone: "zzz-crossing-zone", source: "seed" },
        { keyword: "zzz-crossing-watermark-new", genreZone: "zzz-crossing-zone", source: "seed" },
      ]);
      await insertScan(
        makeScan({ keyword: "zzz-crossing-watermark-old", opportunity: 0.9, scannedAt: now - 1000 }),
      );
      await insertScan(
        makeScan({ keyword: "zzz-crossing-watermark-new", opportunity: 0.9, scannedAt: now }),
      );

      const crossings = await getFirstEverCrossings({
        threshold: THRESHOLD,
        sinceWatermark: now - 10,
      });
      const keywords = crossings.map((c) => c.keyword);
      expect(keywords).not.toContain("zzz-crossing-watermark-old");
      expect(keywords).toContain("zzz-crossing-watermark-new");
    });
  });

  describe("alert watermark", () => {
    it("defaults to 0 when never set, and round-trips a persisted value", async () => {
      const initial = await getAlertWatermark();
      expect(initial).toBe(0);

      const now = Math.floor(Date.now() / 1000);
      await setAlertWatermark(now);
      const read = await getAlertWatermark();
      expect(read).toBe(now);
    });
  });
});
