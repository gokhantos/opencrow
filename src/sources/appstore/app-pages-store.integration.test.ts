import { describe, expect, it, beforeAll, afterAll, afterEach } from "bun:test";
import { initDb, getDb } from "../../store/db";
import {
  countPageFetchesSince,
  getDueAppPages,
  getTrackedAppPage,
  recordPageFailure,
  recordPageGone,
  recordPageSuccess,
  syncTrackedAppPages,
  upsertRelatedApps,
} from "./app-pages-store";

/** Every app_id any test in this file inserts — centralized for reliable cleanup. */
const TEST_APP_IDS: readonly string[] = [
  "zzz-page-sighting-app",
  "zzz-page-hit-hot",
  "zzz-page-velocity-hot",
  "zzz-page-demote",
  "zzz-page-gone-never-revived",
  "zzz-page-due-hot-fresh",
  "zzz-page-due-hot-stale",
  "zzz-page-due-rolling-fresh",
  "zzz-page-due-rolling-stale",
  "zzz-page-due-never-fetched",
  "zzz-page-ledger-ok",
  "zzz-page-ledger-fail",
  "zzz-page-ledger-gone",
  "zzz-page-related-a",
  "zzz-page-related-b",
  "zzz-page-rolling-cand-1",
  "zzz-page-rolling-cand-2",
  "zzz-page-rolling-cand-3",
];

const TEST_KEYWORD = "zzz-page-store-test-hit";

async function cleanupTestData(): Promise<void> {
  const db = getDb();
  await db`DELETE FROM appstore_related_apps WHERE app_id IN ${db(TEST_APP_IDS)} OR related_app_id IN ${db(TEST_APP_IDS)}`;
  await db`DELETE FROM appstore_app_ratings_history WHERE app_id IN ${db(TEST_APP_IDS)}`;
  // `appstore_app_pages` (migration 048) has NO real production writer yet
  // (this whole stage is unshipped) — some tests below deliberately pass a
  // GENEROUS `hotSignatureHitCap` to `syncTrackedAppPages` so this file's
  // own seeded signature-hit row is reliably included among the SHARED,
  // live `appstore_signature_hits` table's real rows (same
  // `GENEROUS_LIMIT` rationale as `app-meta-store.integration.test.ts`).
  // Unlike that file's read-only query, `syncTrackedAppPages` WRITES a row
  // for every id in the resulting candidate set — so a generous cap here
  // would otherwise leave thousands of real production app ids newly
  // enrolled in this tracking table as test pollution. Since nothing else
  // legitimately writes to this table yet, wiping every non-test row here
  // is safe and keeps the shared DB clean regardless of cap size.
  // Deletes EVERY row, not just this file's own zzz- ids — see the doc
  // comment above (no real writer exists for this table yet).
  await db`DELETE FROM appstore_app_pages`;
  await db`DELETE FROM appstore_app_meta WHERE id IN ${db(TEST_APP_IDS)}`;
  await db`DELETE FROM appstore_app_velocity WHERE app_id IN ${db(TEST_APP_IDS)}`;
  await db`DELETE FROM appstore_signature_hits WHERE keyword = ${TEST_KEYWORD}`;
}

async function trackApp(appId: string, tier: "hot" | "rolling", overrides: Record<string, unknown> = {}): Promise<void> {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  await db`
    INSERT INTO appstore_app_pages (app_id, tier, tracked_since, last_fetched_at, gone_at, updated_at)
    VALUES (${appId}, ${tier}, ${now}, ${(overrides.lastFetchedAt as number | null) ?? null}, ${(overrides.goneAt as number | null) ?? null}, ${now})
  `;
}

describe("app-pages-store", () => {
  beforeAll(async () => {
    await initDb(process.env.DATABASE_URL);
    await cleanupTestData();
  });

  afterEach(async () => {
    await cleanupTestData();
  });

  afterAll(async () => {
    await cleanupTestData();
  });

  describe("syncTrackedAppPages", () => {
    it("newly tracks a hot candidate from an OPEN signature hit's double-encoded top_apps_snapshot", async () => {
      const db = getDb();
      const now = Math.floor(Date.now() / 1000);
      // `top_apps_snapshot` is DOUBLE-ENCODED at the Postgres level (see
      // `signature-hits-store.ts`'s doc comment) — writing via
      // `JSON.stringify(...)` into the jsonb column mirrors that convention.
      const snapshot = JSON.stringify([{ id: "zzz-page-hit-hot", name: "Hit App" }]);
      await db`
        INSERT INTO appstore_signature_hits (
          keyword, first_detected_at, last_seen_at, times_seen, status, top_apps_snapshot
        ) VALUES (
          ${TEST_KEYWORD}, ${now}, ${now}, 1, 'active', ${snapshot}
        )
      `;

      // `appstore_signature_hits` is ALSO a shared, live table with hundreds
      // of real production hits — a generous cap (far exceeding the real
      // row count) means the LIMIT never truncates before reaching this
      // test's seeded row, mirroring `app-meta-store.integration.test.ts`'s
      // `GENEROUS_LIMIT` convention. `hotVelocityCap: 0` sidesteps the
      // SEPARATE (ranked, hard-capped-at-200) velocity candidate source
      // entirely — not what this test targets.
      const result = await syncTrackedAppPages({ hotSignatureHitCap: 50_000, hotVelocityCap: 0, rollingAddPerSync: 0 });

      expect(result.newlyTracked).toBeGreaterThanOrEqual(1);
      const tracked = await getTrackedAppPage("zzz-page-hit-hot");
      expect(tracked?.tier).toBe("hot");
    });

    it("promotes an existing rolling-tier row to hot when it becomes a signature-hit candidate", async () => {
      const db = getDb();
      const now = Math.floor(Date.now() / 1000);
      await trackApp("zzz-page-hit-hot", "rolling");

      const snapshot = JSON.stringify([{ id: "zzz-page-hit-hot", name: "Hit App" }]);
      await db`
        INSERT INTO appstore_signature_hits (
          keyword, first_detected_at, last_seen_at, times_seen, status, top_apps_snapshot
        ) VALUES (
          ${TEST_KEYWORD}, ${now}, ${now}, 1, 'active', ${snapshot}
        )
      `;

      const result = await syncTrackedAppPages({ hotSignatureHitCap: 50_000, hotVelocityCap: 0, rollingAddPerSync: 0 });
      expect(result.promoted).toBeGreaterThanOrEqual(1);

      const tracked = await getTrackedAppPage("zzz-page-hit-hot");
      expect(tracked?.tier).toBe("hot");
    });

    it("demotes a hot-tier row back to rolling when it no longer matches any hot candidate source", async () => {
      await trackApp("zzz-page-demote", "hot");

      // No signature hit / velocity observation seeded for this id — it
      // will not appear in either candidate source this pass.
      const result = await syncTrackedAppPages({ hotSignatureHitCap: 50_000, hotVelocityCap: 0, rollingAddPerSync: 0 });
      expect(result.demoted).toBeGreaterThanOrEqual(1);

      const tracked = await getTrackedAppPage("zzz-page-demote");
      expect(tracked?.tier).toBe("rolling");
    });

    it("promotes via an extreme-acceleration velocity candidate (shared, live table — see doc comment)", async () => {
      const db = getDb();
      const now = Math.floor(Date.now() / 1000);
      // `appstore_app_velocity` is ALSO a shared, live table, and
      // `getTopAcceleratingNewborns` (which `getVelocityCandidates` wraps)
      // hard-caps its OWN internal limit at 200 and RANKS by acceleration —
      // unlike the signature-hit source above, a generous `hotVelocityCap`
      // does not guarantee inclusion. An extreme synthetic acceleration
      // ratio (huge recent review jump over a short window vs a near-flat
      // long-term baseline) makes this test's row rank far above realistic
      // production data, but this is best-effort, not airtight, against a
      // live shared table.
      await db`
        INSERT INTO appstore_app_velocity (app_id, observed_at, reviews, rating, first_seen_keyword, name)
        VALUES
          (${"zzz-page-velocity-hot"}, ${now - 30 * 86_400}, 1, 4.5, 'seed', 'Velocity App'),
          (${"zzz-page-velocity-hot"}, ${now - 13 * 3_600}, 2, 4.5, 'seed', 'Velocity App'),
          (${"zzz-page-velocity-hot"}, ${now}, 10_000_002, 4.5, 'seed', 'Velocity App')
      `;

      const result = await syncTrackedAppPages({ hotSignatureHitCap: 0, hotVelocityCap: 200, rollingAddPerSync: 0 });
      expect(result.newlyTracked).toBeGreaterThanOrEqual(1);

      const tracked = await getTrackedAppPage("zzz-page-velocity-hot");
      expect(tracked?.tier).toBe("hot");
    });

    it("gone rows are NEVER revived, even when they resurface as a hot candidate", async () => {
      const db = getDb();
      const now = Math.floor(Date.now() / 1000);
      await trackApp("zzz-page-gone-never-revived", "rolling", { goneAt: now - 1000 });

      const snapshot = JSON.stringify([{ id: "zzz-page-gone-never-revived", name: "Gone App" }]);
      await db`
        INSERT INTO appstore_signature_hits (
          keyword, first_detected_at, last_seen_at, times_seen, status, top_apps_snapshot
        ) VALUES (
          ${TEST_KEYWORD}, ${now}, ${now}, 1, 'active', ${snapshot}
        )
      `;

      await syncTrackedAppPages({ hotSignatureHitCap: 50_000, hotVelocityCap: 0, rollingAddPerSync: 0 });

      const tracked = await getTrackedAppPage("zzz-page-gone-never-revived");
      expect(tracked?.tier).toBe("rolling"); // NOT promoted to hot
      expect(tracked?.goneAt).not.toBeNull();
    });

    it("caps new rolling-tier enrollment at rollingAddPerSync", async () => {
      const db = getDb();
      // Future last_seen_at guarantees these three synthetic rows always
      // rank above every REAL registry row (which can never have a future
      // timestamp) in the `ORDER BY last_seen_at DESC` due-selection —
      // deterministic regardless of the live registry's actual size/recency.
      const future = Math.floor(Date.now() / 1000) + 100_000;
      for (const id of ["zzz-page-rolling-cand-1", "zzz-page-rolling-cand-2", "zzz-page-rolling-cand-3"]) {
        await db`
          INSERT INTO appstore_app_meta (id, name, first_seen_at, first_seen_source, first_seen_storefront, last_seen_at, updated_at)
          VALUES (${id}, ${"Candidate"}, ${future}, 'serp', 'us', ${future}, ${future})
        `;
      }

      const result = await syncTrackedAppPages({ hotSignatureHitCap: 0, hotVelocityCap: 0, rollingAddPerSync: 2 });
      expect(result.rollingAdded).toBe(2);

      const rows = await db`SELECT app_id FROM appstore_app_pages WHERE app_id IN ${db([
        "zzz-page-rolling-cand-1",
        "zzz-page-rolling-cand-2",
        "zzz-page-rolling-cand-3",
      ])}`;
      expect((rows as ReadonlyArray<{ app_id: string }>).length).toBe(2);
    });

    it("returns the empty result without querying when there's nothing to do", async () => {
      const result = await syncTrackedAppPages({ hotSignatureHitCap: 0, hotVelocityCap: 0, rollingAddPerSync: 0 });
      expect(result).toEqual({ hotCandidates: 0, newlyTracked: 0, promoted: 0, demoted: 0, rollingAdded: 0 });
    });
  });

  describe("getDueAppPages — cadence windows", () => {
    it("selects hot/rolling rows past their own interval, excludes fresh and gone rows", async () => {
      const now = Math.floor(Date.now() / 1000);
      await trackApp("zzz-page-due-hot-fresh", "hot", { lastFetchedAt: now - 100 }); // well within 24h hot interval
      await trackApp("zzz-page-due-hot-stale", "hot", { lastFetchedAt: now - 2 * 86_400 }); // past 24h hot interval
      await trackApp("zzz-page-due-rolling-fresh", "rolling", { lastFetchedAt: now - 100 }); // well within 14d rolling interval
      await trackApp("zzz-page-due-rolling-stale", "rolling", { lastFetchedAt: now - 15 * 86_400 }); // past 14d rolling interval
      await trackApp("zzz-page-due-never-fetched", "rolling", {}); // never fetched -> always due

      const due = await getDueAppPages({
        limit: 1_000,
        nowSeconds: now,
        hotIntervalSeconds: 86_400,
        rollingIntervalSeconds: 14 * 86_400,
      });
      const dueIds = new Set(due.map((d) => d.appId));

      expect(dueIds.has("zzz-page-due-hot-stale")).toBe(true);
      expect(dueIds.has("zzz-page-due-rolling-stale")).toBe(true);
      expect(dueIds.has("zzz-page-due-never-fetched")).toBe(true);
      expect(dueIds.has("zzz-page-due-hot-fresh")).toBe(false);
      expect(dueIds.has("zzz-page-due-rolling-fresh")).toBe(false);
    });

    it("orders hot-tier due rows before rolling-tier due rows", async () => {
      const now = Math.floor(Date.now() / 1000);
      await trackApp("zzz-page-due-rolling-stale", "rolling", { lastFetchedAt: now - 15 * 86_400 });
      await trackApp("zzz-page-due-hot-stale", "hot", { lastFetchedAt: now - 2 * 86_400 });

      const due = await getDueAppPages({
        limit: 1_000,
        nowSeconds: now,
        hotIntervalSeconds: 86_400,
        rollingIntervalSeconds: 14 * 86_400,
      });
      const ourDue = due.filter((d) => d.appId === "zzz-page-due-rolling-stale" || d.appId === "zzz-page-due-hot-stale");
      expect(ourDue[0]?.appId).toBe("zzz-page-due-hot-stale");
    });

    it("returns [] for a zero limit without querying", async () => {
      expect(await getDueAppPages({ limit: 0, nowSeconds: 0, hotIntervalSeconds: 0, rollingIntervalSeconds: 0 })).toEqual([]);
    });
  });

  describe("recordPageSuccess / recordPageFailure / recordPageGone — ledger", () => {
    it("recordPageSuccess resets consecutive_failures, stamps last_success_at, writes an 'ok' ledger row", async () => {
      await trackApp("zzz-page-ledger-ok", "hot");
      const now = Math.floor(Date.now() / 1000);

      await recordPageSuccess("zzz-page-ledger-ok", now, {
        ratings: { ratingAverage: 4.5, totalRatings: 100, ratingCounts: [60, 20, 10, 5, 5], orderFlipped: false },
        iapItems: [{ name: "Coins", price: "$0.99" }],
        relatedApps: [],
      });

      const tracked = await getTrackedAppPage("zzz-page-ledger-ok");
      expect(tracked?.lastStatus).toBe("ok");
      expect(tracked?.lastSuccessAt).toBe(now);
      expect(tracked?.consecutiveFailures).toBe(0);
      expect(tracked?.iapCount).toBe(1);

      const db = getDb();
      const rows = await db`SELECT fetch_status, rating_average, rating_counts FROM appstore_app_ratings_history WHERE app_id = ${"zzz-page-ledger-ok"}`;
      expect(rows).toHaveLength(1);
      const row = (rows as ReadonlyArray<{ fetch_status: string; rating_average: string; rating_counts: unknown }>)[0];
      expect(row?.fetch_status).toBe("ok");
      expect(Number(row?.rating_average)).toBe(4.5);
      // Single-encoded (explicit `::jsonb` cast) — NOT the legacy
      // double-encoded convention (which needs `#>> '{}'` to un-escape a
      // STRING-typed jsonb column back to its real array). Bun.sql's jsonb
      // read shape is itself driver-dependent (may come back as a JSON
      // string OR an already-parsed value — see
      // `pipeline-stamps.ts`'s/`feedback-bootstrap.ts`'s `parseGiantScores`
      // doc comment for the same caveat elsewhere in this codebase), so this
      // assertion normalizes via `JSON.parse` when it's a string rather than
      // asserting a specific driver behavior.
      const ratingCounts =
        typeof row?.rating_counts === "string" ? JSON.parse(row.rating_counts) : row?.rating_counts;
      expect(ratingCounts).toEqual([60, 20, 10, 5, 5]);
    });

    it("recordPageFailure increments consecutive_failures and writes an 'error' ledger row without touching last_success_at", async () => {
      await trackApp("zzz-page-ledger-fail", "hot");
      const now = Math.floor(Date.now() / 1000);

      await recordPageFailure("zzz-page-ledger-fail", now);
      await recordPageFailure("zzz-page-ledger-fail", now + 1);

      const tracked = await getTrackedAppPage("zzz-page-ledger-fail");
      expect(tracked?.consecutiveFailures).toBe(2);
      expect(tracked?.lastStatus).toBe("error");
      expect(tracked?.lastSuccessAt).toBeNull();

      const count = await countPageFetchesSince(now - 10);
      expect(count).toBeGreaterThanOrEqual(2);
    });

    it("recordPageGone stamps gone_at write-once (never overwritten by a later call)", async () => {
      await trackApp("zzz-page-ledger-gone", "hot");
      const now = Math.floor(Date.now() / 1000);

      await recordPageGone("zzz-page-ledger-gone", now);
      await recordPageGone("zzz-page-ledger-gone", now + 500);

      const tracked = await getTrackedAppPage("zzz-page-ledger-gone");
      expect(tracked?.goneAt).toBe(now); // first detection time preserved
      expect(tracked?.lastStatus).toBe("gone");
    });

    it("countPageFetchesSince counts every attempt (ok + error + gone), not just successes", async () => {
      await trackApp("zzz-page-ledger-ok", "hot");
      const now = Math.floor(Date.now() / 1000);
      const before = await countPageFetchesSince(now - 10);

      await recordPageSuccess("zzz-page-ledger-ok", now, { ratings: null, iapItems: [], relatedApps: [] });
      await recordPageFailure("zzz-page-ledger-ok", now);
      await recordPageGone("zzz-page-ledger-ok", now);

      const after = await countPageFetchesSince(now - 10);
      expect(after - before).toBe(3);
    });
  });

  describe("upsertRelatedApps", () => {
    it("upserts and refreshes rank/observed_at on re-fetch, keyed (app_id, related_app_id, source)", async () => {
      await trackApp("zzz-page-related-a", "hot");
      const now = Math.floor(Date.now() / 1000);

      await upsertRelatedApps(
        "zzz-page-related-a",
        [{ appId: "zzz-page-related-b", name: "First Name", bundleId: "com.a", source: "similar", rank: 1 }],
        now,
      );
      await upsertRelatedApps(
        "zzz-page-related-a",
        [{ appId: "zzz-page-related-b", name: "Updated Name", bundleId: "com.a", source: "similar", rank: 3 }],
        now + 500,
      );

      const db = getDb();
      const rows = await db`
        SELECT related_name, rank, observed_at FROM appstore_related_apps
        WHERE app_id = ${"zzz-page-related-a"} AND related_app_id = ${"zzz-page-related-b"} AND source = 'similar'
      `;
      expect(rows).toHaveLength(1); // upserted in place, not duplicated
      const row = (rows as ReadonlyArray<{ related_name: string; rank: number; observed_at: number | string }>)[0];
      expect(row?.related_name).toBe("Updated Name");
      expect(row?.rank).toBe(3);
      expect(Number(row?.observed_at)).toBe(now + 500);
    });
  });

  describe("getTrackedAppPage", () => {
    it("returns null for an unknown appId", async () => {
      expect(await getTrackedAppPage("zzz-page-does-not-exist")).toBeNull();
    });
  });
});
