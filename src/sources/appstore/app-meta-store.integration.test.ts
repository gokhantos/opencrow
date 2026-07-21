import { describe, expect, it, beforeAll, afterAll, afterEach } from "bun:test";
import { initDb, getDb } from "../../store/db";
import {
  backfillRegistry,
  claimForEnrichment,
  countLookupRequestsSince,
  getAppMeta,
  getAppMetaBatch,
  pruneLookupRequestLedger,
  recordAppSightings,
  recordEnrichmentMiss,
  recordLookupRequest,
  selectDueForEnrichment,
  upsertLookupResult,
} from "./app-meta-store";
import type { LookupApp } from "./app-lookup";

/** Every app_id any test in this file inserts — centralized for reliable cleanup. */
const TEST_APP_IDS: readonly string[] = [
  "zzz-meta-sighting-app",
  "zzz-meta-greatest-app",
  "zzz-meta-immutable-app",
  "zzz-meta-due-never-1",
  "zzz-meta-due-never-2",
  "zzz-meta-due-stale",
  "zzz-meta-due-fresh",
  "zzz-meta-due-delisted",
  "zzz-meta-accel-priority",
  "zzz-meta-hit-priority",
  "zzz-meta-upsert-app",
  "zzz-meta-events-app",
  "zzz-meta-miss-app",
  "zzz-meta-relist-app",
  "zzz-meta-backfill-app",
];

const TEST_KEYWORD = "zzz-meta-store-test-hit";

async function cleanupTestApps(): Promise<void> {
  const db = getDb();
  await db`DELETE FROM appstore_app_meta_events WHERE app_id IN ${db(TEST_APP_IDS)}`;
  await db`DELETE FROM appstore_app_meta WHERE id IN ${db(TEST_APP_IDS)}`;
  await db`DELETE FROM appstore_apps WHERE id IN ${db(TEST_APP_IDS)}`;
  await db`DELETE FROM appstore_signature_hits WHERE keyword = ${TEST_KEYWORD}`;
  await db`DELETE FROM appstore_lookup_requests WHERE id_count IN (777, 778, 779)`;
}

function lookupApp(overrides: Partial<LookupApp> = {}): LookupApp {
  return {
    id: "zzz-meta-upsert-app",
    name: "Sample",
    reviews: 500,
    rating: 4.2,
    releaseDate: "2024-01-01T00:00:00Z",
    currentVersionReleaseDate: "2024-06-01T00:00:00Z",
    version: "2.0.0",
    price: 0,
    formattedPrice: "Free",
    genreId: "6000",
    genreName: "Business",
    artistId: "artist-1",
    artistName: "Acme",
    bundleId: "com.acme.sample",
    trackViewUrl: "https://apps.apple.com/app/id1",
    artworkUrl: "https://example.com/icon.png",
    ...overrides,
  };
}

describe("app-meta-store", () => {
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

  describe("recordAppSightings", () => {
    it("inserts a fresh registry row on first sighting", async () => {
      const touched = await recordAppSightings(
        [{ id: "zzz-meta-sighting-app", name: "First App" }],
        "chart",
        { storefront: "us" },
      );
      expect(touched).toBe(1);

      const meta = await getAppMeta("zzz-meta-sighting-app");
      expect(meta).not.toBeNull();
      expect(meta?.firstSeenSource).toBe("chart");
      expect(meta?.firstSeenStorefront).toBe("us");
      expect(meta?.enrichedAt).toBeNull();
    });

    it("bumps last_seen_at via GREATEST — an out-of-order (older) sighting never regresses it", async () => {
      const db = getDb();
      await recordAppSightings([{ id: "zzz-meta-greatest-app" }], "serp");
      const meta1 = await getAppMeta("zzz-meta-greatest-app");
      expect(meta1).not.toBeNull();

      // Simulate an out-of-order sighting arriving with an OLDER timestamp by
      // directly forcing last_seen_at far into the future, then re-recording
      // (which internally stamps `now` — always <= the forced future value).
      await db`UPDATE appstore_app_meta SET last_seen_at = last_seen_at + 1000000 WHERE id = 'zzz-meta-greatest-app'`;
      const bumped = await getAppMeta("zzz-meta-greatest-app");

      await recordAppSightings([{ id: "zzz-meta-greatest-app" }], "serp");
      const after = await getAppMeta("zzz-meta-greatest-app");

      expect(after?.lastSeenAt).toBe(bumped?.lastSeenAt as number);
    });

    it("never touches first_seen_* on a repeat sighting from a DIFFERENT source", async () => {
      await recordAppSightings([{ id: "zzz-meta-immutable-app" }], "serp", {
        storefront: "us",
        keyword: "original-keyword",
      });
      await recordAppSightings([{ id: "zzz-meta-immutable-app" }], "chart");

      const meta = await getAppMeta("zzz-meta-immutable-app");
      expect(meta?.firstSeenSource).toBe("serp");
      expect(meta?.firstSeenKeyword).toBe("original-keyword");
    });

    it("skips rows with an empty id and returns the touched count", async () => {
      const touched = await recordAppSightings(
        [{ id: "" }, { id: "zzz-meta-sighting-app" }],
        "discovery",
      );
      expect(touched).toBe(1);
    });
  });

  describe("selectDueForEnrichment", () => {
    // NOTE: this is a shared, live table too — `backfillRegistry` (tested
    // below) is idempotent and additive, so ANY prior test run (this file's
    // own `backfillRegistry` test, or a sibling session's) may have already
    // seeded thousands of real `first_seen_source: 'backfill'` rows with
    // `enriched_at IS NULL`, all tied with this test's own never-enriched
    // rows under `ORDER BY enriched_at ASC NULLS FIRST` (no secondary sort
    // key breaks a NULL tie). `limit` here is set generously above any
    // realistic real-row count so this test's own rows are guaranteed to
    // surface regardless of tie order or how much real backfill data exists.
    const GENEROUS_LIMIT = 50_000;

    it("returns never-enriched rows ahead of stale-but-enriched ones", async () => {
      const db = getDb();
      const now = Math.floor(Date.now() / 1000);
      await recordAppSightings([{ id: "zzz-meta-due-never-1" }], "serp");
      await recordAppSightings([{ id: "zzz-meta-due-stale" }], "serp");
      await db`UPDATE appstore_app_meta SET enriched_at = ${now - 1_000_000} WHERE id = 'zzz-meta-due-stale'`;
      await recordAppSightings([{ id: "zzz-meta-due-fresh" }], "serp");
      await db`UPDATE appstore_app_meta SET enriched_at = ${now} WHERE id = 'zzz-meta-due-fresh'`;

      const due = await selectDueForEnrichment({ limit: GENEROUS_LIMIT, staleAfterSeconds: 86_400 });
      expect(due).toContain("zzz-meta-due-never-1");
      expect(due).toContain("zzz-meta-due-stale");
      expect(due).not.toContain("zzz-meta-due-fresh");
    });

    it("excludes delisted apps", async () => {
      const db = getDb();
      await recordAppSightings([{ id: "zzz-meta-due-delisted" }], "serp");
      await db`UPDATE appstore_app_meta SET delisted_at = ${Math.floor(Date.now() / 1000)} WHERE id = 'zzz-meta-due-delisted'`;

      const due = await selectDueForEnrichment({ limit: 50, staleAfterSeconds: 0 });
      expect(due).not.toContain("zzz-meta-due-delisted");
    });

    it("prioritizes acceleratingIds ahead of the staleness ordering", async () => {
      const db = getDb();
      const now = Math.floor(Date.now() / 1000);
      await recordAppSightings([{ id: "zzz-meta-accel-priority" }], "serp");
      // Enriched recently — would NOT be due by staleness alone.
      await db`UPDATE appstore_app_meta SET enriched_at = ${now} WHERE id = 'zzz-meta-accel-priority'`;

      const due = await selectDueForEnrichment({
        limit: 1,
        staleAfterSeconds: 86_400,
        acceleratingIds: ["zzz-meta-accel-priority"],
      });
      expect(due).toEqual(["zzz-meta-accel-priority"]);
    });

    // `appstore_signature_hits` is ALSO a shared, live table with hundreds
    // of real production hits — the same `GENEROUS_LIMIT` (declared above)
    // and `toContain` (not `toEqual`) approach applies to these two tests.

    it("prioritizes hit-related ids from an OPEN signature hit's double-encoded top_apps_snapshot", async () => {
      const db = getDb();
      const now = Math.floor(Date.now() / 1000);
      await recordAppSightings([{ id: "zzz-meta-hit-priority" }], "serp");
      await db`UPDATE appstore_app_meta SET enriched_at = ${now} WHERE id = 'zzz-meta-hit-priority'`;

      // `top_apps_snapshot` is DOUBLE-ENCODED at the Postgres level (see
      // `signature-hits-store.ts`'s doc comment) — writing via
      // `JSON.stringify(...)` into the jsonb column mirrors that convention.
      const snapshot = JSON.stringify([{ id: "zzz-meta-hit-priority", name: "Hit App" }]);
      await db`
        INSERT INTO appstore_signature_hits (
          keyword, first_detected_at, last_seen_at, times_seen, status, top_apps_snapshot
        ) VALUES (
          ${TEST_KEYWORD}, ${now}, ${now}, 1, 'active', ${snapshot}
        )
      `;

      const due = await selectDueForEnrichment({
        limit: GENEROUS_LIMIT,
        staleAfterSeconds: 86_400,
      });
      expect(due).toContain("zzz-meta-hit-priority");
    });

    it("does not pull ids from a DISMISSED signature hit even though it would otherwise be due by staleness", async () => {
      const db = getDb();
      const now = Math.floor(Date.now() / 1000);
      // Both apps are freshly enriched (NOT due by the staleness tier), so
      // the ONLY way either could appear in `due` is via the hit-related
      // tier — isolating exactly what this test targets.
      await recordAppSightings([{ id: "zzz-meta-hit-priority" }], "serp");
      await db`UPDATE appstore_app_meta SET enriched_at = ${now} WHERE id = 'zzz-meta-hit-priority'`;

      const snapshot = JSON.stringify([{ id: "zzz-meta-hit-priority", name: "Hit App" }]);
      await db`
        INSERT INTO appstore_signature_hits (
          keyword, first_detected_at, last_seen_at, times_seen, status, top_apps_snapshot
        ) VALUES (
          ${TEST_KEYWORD}, ${now}, ${now}, 1, 'dismissed', ${snapshot}
        )
      `;

      const due = await selectDueForEnrichment({ limit: GENEROUS_LIMIT, staleAfterSeconds: 86_400 });
      expect(due).not.toContain("zzz-meta-hit-priority");
    });

    it("returns [] for a zero limit without querying", async () => {
      expect(await selectDueForEnrichment({ limit: 0, staleAfterSeconds: 0 })).toEqual([]);
    });
  });

  describe("claimForEnrichment", () => {
    it("stamps enriched_at/updated_at without touching other fields", async () => {
      await recordAppSightings([{ id: "zzz-meta-sighting-app", name: "Original" }], "serp");
      const now = Math.floor(Date.now() / 1000);
      await claimForEnrichment(["zzz-meta-sighting-app"], now);

      const meta = await getAppMeta("zzz-meta-sighting-app");
      expect(meta?.enrichedAt).toBe(now);
      expect(meta?.name).toBe("Original");
    });

    it("is a no-op for an empty id list", async () => {
      await expect(claimForEnrichment([], Math.floor(Date.now() / 1000))).resolves.toBeUndefined();
    });
  });

  describe("upsertLookupResult", () => {
    it("writes the full lookup result and clears miss_count/delisted_at", async () => {
      await recordAppSightings([{ id: "zzz-meta-upsert-app" }], "serp");
      const db = getDb();
      await db`UPDATE appstore_app_meta SET miss_count = 3 WHERE id = 'zzz-meta-upsert-app'`;

      const now = Math.floor(Date.now() / 1000);
      const previous = await getAppMeta("zzz-meta-upsert-app");
      await upsertLookupResult("zzz-meta-upsert-app", lookupApp(), now, previous);

      const meta = await getAppMeta("zzz-meta-upsert-app");
      expect(meta?.name).toBe("Sample");
      expect(meta?.ratingCount).toBe(500);
      expect(meta?.artistId).toBe("artist-1");
      expect(meta?.missCount).toBe(0);
      expect(meta?.delistedAt).toBeNull();
      expect(meta?.enrichedAt).toBe(now);
    });

    it("persists detected events to appstore_app_meta_events", async () => {
      await recordAppSightings([{ id: "zzz-meta-events-app" }], "serp");
      const now1 = Math.floor(Date.now() / 1000);
      const firstPrevious = await getAppMeta("zzz-meta-events-app");
      // First enrichment — no prior lookup state, so no events.
      await upsertLookupResult(
        "zzz-meta-events-app",
        lookupApp({ id: "zzz-meta-events-app", reviews: 100, price: 0 }),
        now1,
        firstPrevious,
      );

      const now2 = now1 + 10;
      const secondPrevious = await getAppMeta("zzz-meta-events-app");
      await upsertLookupResult(
        "zzz-meta-events-app",
        lookupApp({ id: "zzz-meta-events-app", reviews: 300, price: 4.99 }),
        now2,
        secondPrevious,
      );

      const db = getDb();
      const events = await db`SELECT event_type FROM appstore_app_meta_events WHERE app_id = 'zzz-meta-events-app' ORDER BY event_type`;
      const types = (events as ReadonlyArray<{ event_type: string }>).map((e) => e.event_type);
      expect(types).toContain("price_change");
      expect(types).toContain("rating_spike");
    });
  });

  describe("recordEnrichmentMiss / relist via upsertLookupResult", () => {
    it("increments miss_count and delists at the threshold", async () => {
      await recordAppSightings([{ id: "zzz-meta-miss-app" }], "serp");
      const now = Math.floor(Date.now() / 1000);
      const previous = await getAppMeta("zzz-meta-miss-app");

      const result = await recordEnrichmentMiss("zzz-meta-miss-app", now, previous, 1);
      expect(result.delisted).toBe(true);

      const meta = await getAppMeta("zzz-meta-miss-app");
      expect(meta?.missCount).toBe(1);
      expect(meta?.delistedAt).toBe(now);

      const db = getDb();
      const events = await db`SELECT event_type FROM appstore_app_meta_events WHERE app_id = 'zzz-meta-miss-app'`;
      expect((events as ReadonlyArray<{ event_type: string }>).map((e) => e.event_type)).toEqual([
        "delisted",
      ]);
    });

    it("does not re-emit 'delisted' on a repeat miss of an already-delisted app", async () => {
      await recordAppSightings([{ id: "zzz-meta-miss-app" }], "serp");
      const now = Math.floor(Date.now() / 1000);
      const previous1 = await getAppMeta("zzz-meta-miss-app");
      await recordEnrichmentMiss("zzz-meta-miss-app", now, previous1, 1);

      const previous2 = await getAppMeta("zzz-meta-miss-app");
      await recordEnrichmentMiss("zzz-meta-miss-app", now + 10, previous2, 1);

      const db = getDb();
      const events = await db`SELECT event_type FROM appstore_app_meta_events WHERE app_id = 'zzz-meta-miss-app'`;
      expect((events as ReadonlyArray<{ event_type: string }>).length).toBe(1);
    });

    it("relist: a delisted app that a later lookup finds gets delisted_at cleared and relisted_at stamped", async () => {
      await recordAppSightings([{ id: "zzz-meta-relist-app" }], "serp");
      const now1 = Math.floor(Date.now() / 1000);
      const beforeMiss = await getAppMeta("zzz-meta-relist-app");
      await recordEnrichmentMiss("zzz-meta-relist-app", now1, beforeMiss, 1);

      const now2 = now1 + 10;
      const beforeRelist = await getAppMeta("zzz-meta-relist-app");
      expect(beforeRelist?.delistedAt).not.toBeNull();

      await upsertLookupResult(
        "zzz-meta-relist-app",
        lookupApp({ id: "zzz-meta-relist-app" }),
        now2,
        beforeRelist,
      );

      const after = await getAppMeta("zzz-meta-relist-app");
      expect(after?.delistedAt).toBeNull();
      expect(after?.relistedAt).toBe(now2);

      const db = getDb();
      const events = await db`SELECT event_type FROM appstore_app_meta_events WHERE app_id = 'zzz-meta-relist-app' AND event_type = 'relisted'`;
      expect((events as unknown[]).length).toBe(1);
    });
  });

  describe("backfillRegistry", () => {
    it("seeds a registry row from appstore_apps and is idempotent on a second call", async () => {
      const db = getDb();
      await db`
        INSERT INTO appstore_apps (id, name, artist, category, icon_url, store_url, description, price, bundle_id, release_date, updated_at)
        VALUES ('zzz-meta-backfill-app', 'Backfill App', 'Dev', 'Games', '', '', '', 'Free', '', '', ${Math.floor(Date.now() / 1000)})
        ON CONFLICT (id) DO NOTHING
      `;

      const firstRun = await backfillRegistry();
      const meta = await getAppMeta("zzz-meta-backfill-app");
      expect(meta).not.toBeNull();
      expect(meta?.firstSeenSource).toBe("backfill");
      expect(firstRun).toBeGreaterThanOrEqual(1);

      const secondRunTouchedThisApp = await backfillRegistry();
      const stillOne = await getAppMeta("zzz-meta-backfill-app");
      // Idempotent: this specific app is not re-inserted (any nonzero count
      // on the second run would only be from OTHER pre-existing unregistered
      // apps in the shared DB, not this one — the assertion below is on the
      // row itself staying stable, not on the global count).
      expect(stillOne?.firstSeenAt).toBe(meta?.firstSeenAt);
      void secondRunTouchedThisApp;
    });
  });

  describe("lookup-request ledger", () => {
    it("counts requests within the rolling window and excludes older ones", async () => {
      const now = Math.floor(Date.now() / 1000);
      await recordLookupRequest("lookup", 777, true, now);
      await recordLookupRequest("portfolio", 778, true, now - 100_000);

      const countRecent = await countLookupRequestsSince(now - 3600);
      const countAll = await countLookupRequestsSince(now - 200_000);
      expect(countAll).toBeGreaterThan(countRecent);
    });

    it("prunes rows older than the cutoff", async () => {
      const now = Math.floor(Date.now() / 1000);
      await recordLookupRequest("lookup", 779, true, now - 1_000_000);

      const pruned = await pruneLookupRequestLedger(now - 500_000);
      expect(pruned).toBeGreaterThanOrEqual(1);

      const db = getDb();
      const remaining = await db`SELECT id FROM appstore_lookup_requests WHERE id_count = 779`;
      expect((remaining as unknown[]).length).toBe(0);
    });
  });

  describe("getAppMetaBatch", () => {
    it("returns an empty map for an empty id list", async () => {
      const map = await getAppMetaBatch([]);
      expect(map.size).toBe(0);
    });
  });
});
