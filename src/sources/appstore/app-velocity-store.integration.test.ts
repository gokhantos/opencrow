import { describe, expect, it, beforeAll, afterAll, afterEach } from "bun:test";
import { initDb, getDb } from "../../store/db";
import {
  getAppVelocitySeries,
  getLatestObservedAt,
  getTopAcceleratingNewborns,
  insertObservation,
  recordVelocityObservationsForScan,
} from "./app-velocity-store";
import { VELOCITY_BUCKET_MS } from "./app-velocity";
import type { TopApp } from "./keyword-types";

/** Every app_id any test in this file inserts — centralized for reliable cleanup. */
const TEST_APP_IDS: readonly string[] = [
  "zzz-vel-bucket-app",
  "zzz-vel-series-app",
  "zzz-vel-accel-fast",
  "zzz-vel-accel-slow",
  "zzz-vel-accel-single-obs",
  "zzz-vel-accel-stale",
  "zzz-vel-scan-newborn",
  "zzz-vel-scan-established",
  "zzz-vel-scan-no-id",
];

async function cleanupTestApps(): Promise<void> {
  const db = getDb();
  await db`DELETE FROM appstore_app_velocity WHERE app_id IN ${db(TEST_APP_IDS)}`;
}

function makeTopApp(overrides: Partial<TopApp> = {}): TopApp {
  return {
    id: "zzz-vel-scan-newborn",
    name: "Toy",
    reviews: 10,
    rating: 4.0,
    ageDays: 100,
    ratingsPerDay: 0.1,
    titleMatch: true,
    ...overrides,
  };
}

describe("app-velocity-store", () => {
  beforeAll(async () => {
    await initDb(process.env.DATABASE_URL);
    await cleanupTestApps();
  });

  afterEach(async () => {
    await cleanupTestApps();
  });

  afterAll(async () => {
    await cleanupTestApps();
  });

  describe("insertObservation bucketing", () => {
    it("inserts the first observation for a never-seen app", async () => {
      const inserted = await insertObservation({
        appId: "zzz-vel-bucket-app",
        observedAt: 1_000_000,
        reviews: 10,
        rating: 4.0,
        keyword: "zzz test keyword",
        name: "Bucket App",
      });
      expect(inserted).toBe(true);

      const latest = await getLatestObservedAt("zzz-vel-bucket-app");
      expect(latest).toBe(1_000_000);
    });

    it("skips a second observation within the same ~6h bucket", async () => {
      await insertObservation({
        appId: "zzz-vel-bucket-app",
        observedAt: 1_000_000,
        reviews: 10,
        rating: 4.0,
        keyword: "zzz test keyword",
        name: "Bucket App",
      });

      const withinBucket = 1_000_000 + VELOCITY_BUCKET_MS / 1000 / 2;
      const inserted = await insertObservation({
        appId: "zzz-vel-bucket-app",
        observedAt: withinBucket,
        reviews: 15,
        rating: 4.1,
        keyword: "zzz another keyword",
        name: "Bucket App",
      });
      expect(inserted).toBe(false);

      // Latest observed_at is unchanged — the second call was a no-op.
      const latest = await getLatestObservedAt("zzz-vel-bucket-app");
      expect(latest).toBe(1_000_000);
    });

    it("inserts a new row once the bucket has fully elapsed", async () => {
      await insertObservation({
        appId: "zzz-vel-bucket-app",
        observedAt: 1_000_000,
        reviews: 10,
        rating: 4.0,
        keyword: "zzz test keyword",
        name: "Bucket App",
      });

      const nextBucket = 1_000_000 + VELOCITY_BUCKET_MS / 1000;
      const inserted = await insertObservation({
        appId: "zzz-vel-bucket-app",
        observedAt: nextBucket,
        reviews: 15,
        rating: 4.1,
        keyword: "zzz another keyword",
        name: "Bucket App",
      });
      expect(inserted).toBe(true);

      const latest = await getLatestObservedAt("zzz-vel-bucket-app");
      expect(latest).toBe(nextBucket);
    });
  });

  describe("getAppVelocitySeries", () => {
    it("returns an app's observations newest-first", async () => {
      await insertObservation({
        appId: "zzz-vel-series-app",
        observedAt: 1_000_000,
        reviews: 10,
        rating: 4.0,
        keyword: "zzz kw a",
        name: "Series App",
      });
      await insertObservation({
        appId: "zzz-vel-series-app",
        observedAt: 1_000_000 + VELOCITY_BUCKET_MS / 1000,
        reviews: 20,
        rating: 4.2,
        keyword: "zzz kw b",
        name: "Series App",
      });

      const series = await getAppVelocitySeries("zzz-vel-series-app");
      expect(series.length).toBe(2);
      expect(series[0]?.observedAt).toBeGreaterThan(series[1]?.observedAt ?? 0);
      expect(series[0]?.reviews).toBe(20);
      expect(series[0]?.name).toBe("Series App");
      expect(series[0]?.firstSeenKeyword).toBe("zzz kw b");
    });

    it("returns an empty array for an app with no observations", async () => {
      const series = await getAppVelocitySeries("zzz-vel-nonexistent-app-xyz");
      expect(series).toEqual([]);
    });
  });

  describe("recordVelocityObservationsForScan", () => {
    it("records an observation only for newborn apps with an id, skipping established/id-less apps", async () => {
      const result = await recordVelocityObservationsForScan({
        keyword: "zzz scan keyword",
        scannedAt: 1_000_000,
        topApps: [
          makeTopApp({ id: "zzz-vel-scan-newborn", ageDays: 100 }),
          makeTopApp({ id: "zzz-vel-scan-established", ageDays: 900 }), // too old — not newborn
          makeTopApp({ id: "", ageDays: 50 }), // no id — unkeyable
        ],
      });
      expect(result.recorded).toBe(1);

      const newbornSeries = await getAppVelocitySeries("zzz-vel-scan-newborn");
      expect(newbornSeries.length).toBe(1);
      const establishedSeries = await getAppVelocitySeries("zzz-vel-scan-established");
      expect(establishedSeries.length).toBe(0);
    });
  });

  describe("getTopAcceleratingNewborns", () => {
    const HOUR = 3600;
    const DAY = 24 * HOUR;
    const now = Math.floor(Date.now() / 1000);

    it("ranks apps by acceleration, excludes single-observation apps, and resolves names", async () => {
      // Fast-accelerating app: earliest 5d ago (100 reviews), 1d ago (150),
      // now (500) — strong recent velocity vs. overall.
      await insertObservation({
        appId: "zzz-vel-accel-fast",
        observedAt: now - 5 * DAY,
        reviews: 100,
        rating: 4.0,
        keyword: "zzz kw",
        name: "Fast Riser",
      });
      await insertObservation({
        appId: "zzz-vel-accel-fast",
        observedAt: now - DAY,
        reviews: 150,
        rating: 4.1,
        keyword: "zzz kw",
        name: "Fast Riser",
      });
      await insertObservation({
        appId: "zzz-vel-accel-fast",
        observedAt: now,
        reviews: 500,
        rating: 4.3,
        keyword: "zzz kw",
        name: "Fast Riser",
      });

      // Slow/steady app: modest, roughly constant velocity -> low acceleration.
      await insertObservation({
        appId: "zzz-vel-accel-slow",
        observedAt: now - 5 * DAY,
        reviews: 100,
        rating: 4.0,
        keyword: "zzz kw",
        name: "Steady Riser",
      });
      await insertObservation({
        appId: "zzz-vel-accel-slow",
        observedAt: now - DAY,
        reviews: 120,
        rating: 4.0,
        keyword: "zzz kw",
        name: "Steady Riser",
      });
      await insertObservation({
        appId: "zzz-vel-accel-slow",
        observedAt: now,
        reviews: 140,
        rating: 4.0,
        keyword: "zzz kw",
        name: "Steady Riser",
      });

      // Single-observation app: must never appear (acceleration undefined).
      await insertObservation({
        appId: "zzz-vel-accel-single-obs",
        observedAt: now,
        reviews: 50,
        rating: 4.0,
        keyword: "zzz kw",
        name: "Lone Observation",
      });

      const result = await getTopAcceleratingNewborns({ limit: 10 });
      const ids = result.map((r) => r.appId);

      expect(ids).not.toContain("zzz-vel-accel-single-obs");
      expect(ids).toContain("zzz-vel-accel-fast");
      expect(ids).toContain("zzz-vel-accel-slow");

      const fastIdx = ids.indexOf("zzz-vel-accel-fast");
      const slowIdx = ids.indexOf("zzz-vel-accel-slow");
      expect(fastIdx).toBeLessThan(slowIdx);

      const fastEntry = result.find((r) => r.appId === "zzz-vel-accel-fast");
      expect(fastEntry?.name).toBe("Fast Riser");
      expect(fastEntry?.observationCount).toBe(3);
      expect(fastEntry?.acceleration).toBeGreaterThan(1);
    });

    it("excludes apps with no observation within the lookback window", async () => {
      await insertObservation({
        appId: "zzz-vel-accel-stale",
        observedAt: now - 60 * DAY,
        reviews: 10,
        rating: 4.0,
        keyword: "zzz kw",
        name: "Stale App",
      });
      await insertObservation({
        appId: "zzz-vel-accel-stale",
        observedAt: now - 59 * DAY,
        reviews: 50,
        rating: 4.0,
        keyword: "zzz kw",
        name: "Stale App",
      });

      const result = await getTopAcceleratingNewborns({ limit: 50, lookbackDays: 30 });
      expect(result.map((r) => r.appId)).not.toContain("zzz-vel-accel-stale");
    });

    it("respects the limit parameter", async () => {
      for (const appId of ["zzz-vel-accel-fast", "zzz-vel-accel-slow"] as const) {
        await insertObservation({
          appId,
          observedAt: now - 5 * DAY,
          reviews: 100,
          rating: 4.0,
          keyword: "zzz kw",
          name: appId,
        });
        await insertObservation({
          appId,
          observedAt: now,
          reviews: 200,
          rating: 4.0,
          keyword: "zzz kw",
          name: appId,
        });
      }

      const unlimited = await getTopAcceleratingNewborns({ limit: 50 });
      expect(unlimited.length).toBeGreaterThanOrEqual(2);

      const limited = await getTopAcceleratingNewborns({ limit: 1 });
      expect(limited.length).toBe(1);
    });
  });
});
