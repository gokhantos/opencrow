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

// zzz-prefixed nonce keywords so fixtures can't collide with real scanned rows.
const KEYWORD = "zzzgapprobe fatty liver diet";
const DEDUP_KEYWORD = "zzzgapprobe dedup latest scan wins";
const GENRE_ZONE = "health/us";
const NOW = Math.floor(Date.now() / 1000);
const OPTS = { windowSec: 3600 * 24 * 400, limit: 50 } as const;
const KEYWORDS_UNDER_TEST = [KEYWORD, DEDUP_KEYWORD] as const;

// NOTE: keywords contain spaces, so a hand-built PG array literal (the
// codebase's usual workaround for Bun.sql misformatting JS arrays in ANY())
// would need per-element quoting; two plain equality deletes per keyword
// keep this hermetic without that complexity.
async function cleanup(): Promise<void> {
  const db = getDb();
  for (const keyword of KEYWORDS_UNDER_TEST) {
    await db`DELETE FROM appstore_keyword_scans WHERE keyword = ${keyword}`;
    await db`DELETE FROM appstore_keywords WHERE keyword = ${keyword}`;
  }
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
      lowConfidence: false,
      brandNavigational: false,
    });

    const out = await appstoreGapProbe.probe([KEYWORD], OPTS);

    expect(out.length).toBe(1);
    const evidence = out[0];
    expect(evidence?.kind).toBe("appstore_gap");
    // Exact match on the seeded `demand` (13), not `> 0` — a regression that
    // sourced `count` from `opportunity` (0.62) would round to 1 and still
    // pass a `> 0` check, so only an exact match on `demand` locks this down.
    expect(evidence?.count).toBe(13);
    expect(evidence?.sourceId).toBeTruthy();
    expect(evidence?.quote ?? "").toContain("Weak Liver App");
  });

  it("picks the LATEST scan per keyword (DISTINCT ON ... ORDER BY scanned_at DESC), not the oldest", async () => {
    await upsertKeywords([{ keyword: DEDUP_KEYWORD, genreZone: GENRE_ZONE, source: "manual" }]);

    // Older scan: distinctly different demand/opportunity/incumbent. If the
    // probe ever regressed to picking the oldest (or an arbitrary) row, this
    // scan's values would leak into the assertions below.
    await insertScan({
      keyword: DEDUP_KEYWORD,
      store: "app",
      competitiveness: 50,
      demand: 3,
      incumbentWeakness: 0.2,
      opportunity: 0.15, // below threshold — would have been filtered anyway
      trend: "stable",
      topAppReviews: 900,
      avgRating: 4.5,
      avgAgeDays: 1200,
      topApps: [
        {
          id: "com.example.oldincumbent",
          name: "Old Stale Incumbent",
          reviews: 900,
          rating: 4.5,
          ageDays: 1200,
          ratingsPerDay: 0.01,
          titleMatch: true,
        },
      ],
      scannedAt: NOW - 3600 * 24 * 30, // 30 days older
      lowConfidence: false,
      brandNavigational: false,
    });

    // Newer scan: above threshold, with different demand + a different
    // incumbent name so the assertions can only pass if this row wins.
    await insertScan({
      keyword: DEDUP_KEYWORD,
      store: "app",
      competitiveness: 10,
      demand: 27,
      incumbentWeakness: 0.8,
      opportunity: 0.55, // >= default appstoreKeywordGap.opportunityThresholdForSeed (0.4)
      trend: "heating",
      topAppReviews: 20,
      avgRating: 2.0,
      avgAgeDays: 300,
      topApps: [
        {
          id: "com.example.freshincumbent",
          name: "Fresh Weak Incumbent",
          reviews: 20,
          rating: 2.0,
          ageDays: 300,
          ratingsPerDay: 0.07,
          titleMatch: true,
        },
      ],
      scannedAt: NOW,
      lowConfidence: false,
      brandNavigational: false,
    });

    const out = await appstoreGapProbe.probe([DEDUP_KEYWORD], OPTS);

    expect(out.length).toBe(1);
    const evidence = out[0];
    expect(evidence?.kind).toBe("appstore_gap");
    // Newer scan's demand (27), not the older scan's (3).
    expect(evidence?.count).toBe(27);
    // Newer scan's incumbent, not the older scan's.
    expect(evidence?.quote ?? "").toContain("Fresh Weak Incumbent");
    expect(evidence?.quote ?? "").not.toContain("Old Stale Incumbent");
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
      lowConfidence: false,
      brandNavigational: false,
    });

    const out = await appstoreGapProbe.probe([KEYWORD], OPTS);
    expect(out).toEqual([]);
  });

  it("returns [] when no candidate keywords are supplied", async () => {
    const out = await appstoreGapProbe.probe([], OPTS);
    expect(out).toEqual([]);
  });
});
