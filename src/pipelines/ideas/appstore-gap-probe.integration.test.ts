/**
 * Integration test for `appstoreGapProbe` — `appstore_gap` demand evidence
 * derived from `appstore_keyword_scans` (Task 9).
 *
 * Requires a running Postgres instance (native brew Postgres on
 * 127.0.0.1:5432, db/user/pw `opencrow`, or `docker compose up -d postgres`).
 * Lane: *.integration.test.ts -> `bun run test:integration`
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { insertScan, upsertKeywords } from "../../sources/appstore/keyword-store";
import { closeDb, getDb, initDb } from "../../store/db";
import { appstoreGapProbe } from "./appstore-gap-probe";

// zzz-prefixed nonce keyword so fixtures can't collide with real scanned rows.
const KEYWORD = "zzzgapprobe fatty liver diet";
const GENRE_ZONE = "health/us";
const NOW = Math.floor(Date.now() / 1000);
const OPTS = { windowSec: 3600 * 24 * 400, limit: 50 } as const;

async function cleanup(): Promise<void> {
  const db = getDb();
  await db`DELETE FROM appstore_keyword_scans WHERE keyword = ${KEYWORD}`;
  await db`DELETE FROM appstore_keywords WHERE keyword = ${KEYWORD}`;
}

beforeAll(async () => {
  await initDb(process.env["DATABASE_URL"]);
  await cleanup();
});

afterEach(async () => {
  await cleanup();
});

afterAll(async () => {
  await closeDb();
});

describe("appstoreGapProbe", () => {
  it("emits appstore_gap evidence for a scan whose opportunity clears the seed threshold", async () => {
    await upsertKeywords([{ keyword: KEYWORD, genreZone: GENRE_ZONE, source: "manual" }]);
    await insertScan({
      keyword: KEYWORD,
      store: "app",
      competitiveness: 12,
      demand: 13,
      incumbentWeakness: 0.7,
      opportunity: 0.62, // >= default appstoreKeywordGap.opportunityThresholdForSeed (0.4)
      trend: "new",
      topAppReviews: 40,
      avgRating: 2.3,
      avgAgeDays: 900,
      topApps: [
        {
          id: "com.example.weakapp",
          name: "Weak Liver App",
          reviews: 40,
          rating: 2.3,
          ageDays: 900,
          ratingsPerDay: 0.04,
          titleMatch: true,
        },
      ],
      scannedAt: NOW,
    });

    const out = await appstoreGapProbe.probe([KEYWORD], OPTS);

    expect(out.length).toBe(1);
    const evidence = out[0];
    expect(evidence?.kind).toBe("appstore_gap");
    expect(evidence?.count ?? 0).toBeGreaterThan(0);
    expect(evidence?.sourceId).toBeTruthy();
    expect(evidence?.quote ?? "").toContain("Weak Liver App");
  });

  it("returns [] when the latest scan's opportunity is below the seed threshold", async () => {
    await upsertKeywords([{ keyword: KEYWORD, genreZone: GENRE_ZONE, source: "manual" }]);
    await insertScan({
      keyword: KEYWORD,
      store: "app",
      competitiveness: 80,
      demand: 5,
      incumbentWeakness: 0.1,
      opportunity: 0.1, // below default threshold 0.4
      trend: "stable",
      topAppReviews: 5000,
      avgRating: 4.6,
      avgAgeDays: 2000,
      topApps: [],
      scannedAt: NOW,
    });

    const out = await appstoreGapProbe.probe([KEYWORD], OPTS);
    expect(out).toEqual([]);
  });

  it("returns [] when no candidate keywords are supplied", async () => {
    const out = await appstoreGapProbe.probe([], OPTS);
    expect(out).toEqual([]);
  });
});
