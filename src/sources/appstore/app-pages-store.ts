// Persistence for the `apps.apple.com` product-page HTML lane
// (`appstore_app_pages` + `appstore_app_ratings_history` +
// `appstore_related_apps`, migration 048) — deep-scrape build Stage 5.
// Follows the house `XRow` (snake_case, as returned by `Bun.sql`) <-> domain
// (camelCase, readonly) split used throughout `app-meta-store.ts` /
// `review-harvest-store.ts`. Pure HTML parsing lives in `app-page-parse.ts`,
// imported here only for its result TYPES (never the parsing itself).

import { getDb } from "../../store/db";
import type { IapItem, RatingsHistogram, RelatedApp } from "./app-page-parse";
import { getSignatureHitCandidates, getVelocityCandidates } from "./review-harvest-store";

export type AppPageTier = "hot" | "rolling";
export type AppPageFetchStatus = "ok" | "gone" | "error";

export interface TrackedAppPage {
  readonly appId: string;
  readonly tier: AppPageTier;
  readonly trackedSince: number;
  readonly lastFetchedAt: number | null;
  readonly lastSuccessAt: number | null;
  readonly lastStatus: AppPageFetchStatus | null;
  readonly consecutiveFailures: number;
  readonly goneAt: number | null;
  readonly iapCount: number | null;
  readonly relatedCount: number | null;
  readonly updatedAt: number;
}

interface AppPageRow {
  readonly app_id: string;
  readonly tier: string;
  readonly tracked_since: number | string;
  readonly last_fetched_at: number | string | null;
  readonly last_success_at: number | string | null;
  readonly last_status: string | null;
  readonly consecutive_failures: number | string;
  readonly gone_at: number | string | null;
  readonly iap_count: number | string | null;
  readonly related_count: number | string | null;
  readonly updated_at: number | string;
}

function numOrNull(v: number | string | null | undefined): number | null {
  return v === null || v === undefined ? null : Number(v);
}

function rowToTracked(row: AppPageRow): TrackedAppPage {
  return {
    appId: row.app_id,
    tier: row.tier as AppPageTier,
    trackedSince: Number(row.tracked_since),
    lastFetchedAt: numOrNull(row.last_fetched_at),
    lastSuccessAt: numOrNull(row.last_success_at),
    lastStatus: row.last_status as AppPageFetchStatus | null,
    consecutiveFailures: Number(row.consecutive_failures),
    goneAt: numOrNull(row.gone_at),
    iapCount: numOrNull(row.iap_count),
    relatedCount: numOrNull(row.related_count),
    updatedAt: Number(row.updated_at),
  };
}

/** Single-row convenience wrapper — test/inspection use. */
export async function getTrackedAppPage(appId: string): Promise<TrackedAppPage | null> {
  const db = getDb();
  const rows = await db`SELECT * FROM appstore_app_pages WHERE app_id = ${appId}`;
  const row = (rows as AppPageRow[])[0];
  return row ? rowToTracked(row) : null;
}

// ---------------------------------------------------------------------------
// Sync — hot/rolling tier membership (promote/demote), the tracking pool's
// write path.
// ---------------------------------------------------------------------------

export interface SyncTrackedAppPagesResult {
  readonly hotCandidates: number;
  readonly newlyTracked: number;
  readonly promoted: number; // rolling -> hot
  readonly demoted: number; // hot -> rolling
  readonly rollingAdded: number;
}

const EMPTY_SYNC_RESULT: SyncTrackedAppPagesResult = {
  hotCandidates: 0,
  newlyTracked: 0,
  promoted: 0,
  demoted: 0,
  rollingAdded: 0,
};

/**
 * Re-derives the "hot" tier's membership EVERY sync pass (unlike
 * `review-harvest-store.ts`'s cohort, which only ever upgrades — see
 * `resolveCohort`'s "daily wins" doc comment) — a full ~600KB-1MB HTML
 * fetch is heavy enough (build plan §5: "heaviest per-request lane... most
 * conservative pacing") that an app dropping out of every hot-worthy signal
 * (its signature hit closed, it stopped accelerating) should fall back to
 * the slow rolling cadence rather than staying hot forever.
 *
 * Hot candidates reuse `review-harvest-store.ts`'s `getSignatureHitCandidates`
 * / `getVelocityCandidates` (the SAME "open signature hit" / "currently-
 * accelerating newborn" sources that lane's daily cohort uses) rather than
 * re-declaring the double-encoded-jsonb candidate query a third time.
 *
 * Rolling candidates are the app-meta registry's most-recently-seen ids
 * (Stage 2, `appstore_app_meta`) not already tracked, excluding delisted
 * rows — capped per pass (`rollingAddPerSync`) so one sync doesn't try to
 * enroll the entire (potentially 100k+ row) registry at once.
 *
 * `hotSignatureHitCap <= 0 AND hotVelocityCap <= 0` means the caller opted
 * OUT of hot-tier evaluation for this call entirely (the "0 ⇒ skip"
 * convention used elsewhere in this codebase, e.g.
 * `appstoreAppEnrichment.maxBatchesPerPass`) — this is NOT the same as "both
 * sources genuinely returned zero candidates" and must NOT demote the
 * existing hot tier. Getting this distinction wrong would wipe the entire
 * (potentially large) hot tier the moment either cap is temporarily zeroed
 * for an unrelated reason.
 */
export async function syncTrackedAppPages(opts: {
  readonly hotSignatureHitCap: number;
  readonly hotVelocityCap: number;
  readonly rollingAddPerSync: number;
}): Promise<SyncTrackedAppPagesResult> {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);

  // Whether this call asked to evaluate hot-ness AT ALL — distinct from
  // "evaluated it and both sources genuinely returned zero ids". A caller
  // passing `hotSignatureHitCap: 0, hotVelocityCap: 0` (the "0 ⇒ skip"
  // convention used elsewhere in this codebase, e.g.
  // `appstoreAppEnrichment.maxBatchesPerPass`) means "don't touch the hot
  // tier this call", NOT "demote every currently-hot row" — see the demote
  // step below, which must NOT run in that case. Getting this wrong is a
  // real correctness bug, not just a test-isolation nuisance: it would wipe
  // the entire (potentially large, real) hot tier the moment ANY caller
  // temporarily zeroes both caps (e.g. an operator disabling the velocity
  // sub-source for a maintenance window).
  const attemptedHotEvaluation = opts.hotSignatureHitCap > 0 || opts.hotVelocityCap > 0;

  const [signatureHitIds, velocityIds] = await Promise.all([
    getSignatureHitCandidates(opts.hotSignatureHitCap),
    getVelocityCandidates(opts.hotVelocityCap),
  ]);
  const hotIds = Array.from(new Set([...signatureHitIds, ...velocityIds])).filter((id) => id.length > 0);

  if (!attemptedHotEvaluation && opts.rollingAddPerSync <= 0) return EMPTY_SYNC_RESULT;

  let newlyTracked = 0;
  let promoted = 0;

  // Batch-fetch existing rows for the hot candidate set FIRST so
  // newlyTracked/promoted can be counted precisely from prior state (an
  // `ON CONFLICT ... RETURNING xmax=0` loop can't distinguish "already hot,
  // no-op" from "promoted just now" — both take the UPDATE branch). Mirrors
  // `app-enrichment.ts`'s `getAppMetaBatch`-before-write pattern.
  const existingRows =
    hotIds.length > 0
      ? await db`SELECT app_id, tier, gone_at FROM appstore_app_pages WHERE app_id IN ${db(hotIds)}`
      : [];
  const existingById = new Map(
    (existingRows as ReadonlyArray<{ app_id: string; tier: string; gone_at: number | string | null }>).map(
      (r) => [r.app_id, r] as const,
    ),
  );

  for (const id of hotIds) {
    const existing = existingById.get(id);
    if (!existing) {
      await db`
        INSERT INTO appstore_app_pages (app_id, tier, tracked_since, updated_at)
        VALUES (${id}, 'hot', ${now}, ${now})
        ON CONFLICT (app_id) DO NOTHING
      `;
      newlyTracked++;
      continue;
    }
    // `gone_at IS NOT NULL` guard: a gone app never gets re-tracked even if
    // it resurfaces as a hot candidate — the registry sighting path
    // (Stage 2) is the only thing that can revive a gone id's story.
    if (existing.gone_at !== null) continue;
    if (existing.tier !== "hot") {
      await db`UPDATE appstore_app_pages SET tier = 'hot', updated_at = ${now} WHERE app_id = ${id}`;
      promoted++;
    }
  }

  // Demote: currently-hot, not-gone rows no longer present in this pass's
  // hot candidate set fall back to rolling. Gated on `attemptedHotEvaluation`
  // (see its doc comment above) — a caller that passed both caps as 0 opted
  // OUT of hot-tier evaluation entirely this call and must not have ANY
  // effect on the existing hot tier, not even via this fallback branch.
  let demoted = 0;
  if (attemptedHotEvaluation) {
    const demoteRows =
      hotIds.length > 0
        ? await db`
            UPDATE appstore_app_pages
            SET tier = 'rolling', updated_at = ${now}
            WHERE tier = 'hot' AND gone_at IS NULL AND app_id NOT IN ${db(hotIds)}
            RETURNING app_id
          `
        : await db`
            UPDATE appstore_app_pages
            SET tier = 'rolling', updated_at = ${now}
            WHERE tier = 'hot' AND gone_at IS NULL
            RETURNING app_id
          `;
    demoted = (demoteRows as ReadonlyArray<{ app_id: string }>).length;
  }

  let rollingAdded = 0;
  if (opts.rollingAddPerSync > 0) {
    const limit = Math.max(0, Math.floor(opts.rollingAddPerSync));
    const rollingRows = await db`
      INSERT INTO appstore_app_pages (app_id, tier, tracked_since, updated_at)
      SELECT m.id, 'rolling', ${now}, ${now}
      FROM appstore_app_meta m
      WHERE m.delisted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM appstore_app_pages p WHERE p.app_id = m.id)
      ORDER BY m.last_seen_at DESC
      LIMIT ${limit}
      ON CONFLICT (app_id) DO NOTHING
      RETURNING app_id
    `;
    rollingAdded = (rollingRows as ReadonlyArray<{ app_id: string }>).length;
  }

  return { hotCandidates: hotIds.length, newlyTracked, promoted, demoted, rollingAdded };
}

// ---------------------------------------------------------------------------
// Due selection
// ---------------------------------------------------------------------------

/**
 * Active (not gone) tracked apps due for a page fetch, hot-tier first, then
 * rolling — each tier gated by its OWN cadence (`hotIntervalSeconds` /
 * `rollingIntervalSeconds`). Never-fetched rows (`last_fetched_at IS NULL`)
 * are always due, sorted first within their tier via `NULLS FIRST`.
 */
export async function getDueAppPages(opts: {
  readonly limit: number;
  readonly nowSeconds: number;
  readonly hotIntervalSeconds: number;
  readonly rollingIntervalSeconds: number;
}): Promise<readonly TrackedAppPage[]> {
  const limit = Math.max(0, Math.floor(opts.limit));
  if (limit === 0) return [];

  const db = getDb();
  const hotCutoff = opts.nowSeconds - Math.max(0, opts.hotIntervalSeconds);
  const rollingCutoff = opts.nowSeconds - Math.max(0, opts.rollingIntervalSeconds);

  const rows = await db`
    SELECT * FROM appstore_app_pages
    WHERE gone_at IS NULL
      AND (
        last_fetched_at IS NULL
        OR (tier = 'hot' AND last_fetched_at < ${hotCutoff})
        OR (tier = 'rolling' AND last_fetched_at < ${rollingCutoff})
      )
    ORDER BY (tier = 'hot') DESC, last_fetched_at ASC NULLS FIRST
    LIMIT ${limit}
  `;
  return (rows as AppPageRow[]).map(rowToTracked);
}

// ---------------------------------------------------------------------------
// Outcome recording
// ---------------------------------------------------------------------------

/**
 * Records a successful fetch+parse: refreshes `appstore_app_pages`
 * (resets `consecutive_failures`, stamps `last_success_at`), appends ONE
 * `appstore_app_ratings_history` ledger row (`fetch_status = 'ok'` — NULL
 * rating fields if the page had no `productRatings` shelf, e.g. a
 * zero-review app), and upserts `relatedApps` into `appstore_related_apps`.
 *
 * `rating_counts` is written via `${JSON.stringify(...)}::jsonb` — the
 * EXPLICIT cast single-encodes correctly (see migration 048's doc comment);
 * this is NOT the legacy double-encoded `top_apps`/`serp_tail` convention,
 * so readers must NOT `#>> '{}'` unwrap this column.
 */
export async function recordPageSuccess(
  appId: string,
  now: number,
  parsed: { readonly ratings: RatingsHistogram | null; readonly iapItems: readonly IapItem[]; readonly relatedApps: readonly RelatedApp[] },
): Promise<void> {
  const db = getDb();

  await db`
    UPDATE appstore_app_pages SET
      last_fetched_at = ${now},
      last_success_at = ${now},
      last_status = 'ok',
      consecutive_failures = 0,
      iap_count = ${parsed.iapItems.length},
      related_count = ${parsed.relatedApps.length},
      updated_at = ${now}
    WHERE app_id = ${appId}
  `;

  const ratingCountsJson = parsed.ratings ? JSON.stringify(parsed.ratings.ratingCounts) : null;
  await db`
    INSERT INTO appstore_app_ratings_history (app_id, observed_at, fetch_status, rating_average, total_ratings, rating_counts)
    VALUES (
      ${appId}, ${now}, 'ok',
      ${parsed.ratings?.ratingAverage ?? null}, ${parsed.ratings?.totalRatings ?? null},
      ${ratingCountsJson}::jsonb
    )
  `;

  await upsertRelatedApps(appId, parsed.relatedApps, now);
}

/**
 * Records a failed fetch/parse attempt (network error, non-404 non-ok
 * response, or `AppPageParseError`): bumps `consecutive_failures`,
 * `last_status = 'error'`, `last_fetched_at`, and appends a
 * `fetch_status = 'error'` ledger row (NULL rating fields — no data to
 * record, but the ATTEMPT still counts toward the rolling-24h request
 * budget, see `countPageFetchesSince`). Does NOT touch `last_success_at`.
 */
export async function recordPageFailure(appId: string, now: number): Promise<void> {
  const db = getDb();
  await db`
    UPDATE appstore_app_pages SET
      last_fetched_at = ${now},
      last_status = 'error',
      consecutive_failures = consecutive_failures + 1,
      updated_at = ${now}
    WHERE app_id = ${appId}
  `;
  await db`
    INSERT INTO appstore_app_ratings_history (app_id, observed_at, fetch_status, rating_average, total_ratings, rating_counts)
    VALUES (${appId}, ${now}, 'error', NULL, NULL, NULL)
  `;
}

/**
 * Records a verified-gone (HTTP 404) app: stamps `gone_at` (write-once — a
 * previously-gone row's `gone_at` is never overwritten, so the FIRST
 * detection timestamp is preserved) and appends a `fetch_status = 'gone'`
 * ledger row. A gone row is permanently excluded from `getDueAppPages` and
 * from `syncTrackedAppPages`'s hot re-promotion — see those functions' doc
 * comments ("gone never revived").
 */
export async function recordPageGone(appId: string, now: number): Promise<void> {
  const db = getDb();
  await db`
    UPDATE appstore_app_pages SET
      last_fetched_at = ${now},
      last_status = 'gone',
      gone_at = COALESCE(gone_at, ${now}),
      updated_at = ${now}
    WHERE app_id = ${appId}
  `;
  await db`
    INSERT INTO appstore_app_ratings_history (app_id, observed_at, fetch_status, rating_average, total_ratings, rating_counts)
    VALUES (${appId}, ${now}, 'gone', NULL, NULL, NULL)
  `;
}

/**
 * Upserts related-app edges keyed `(app_id, related_app_id, source)` — a
 * re-fetch refreshes `rank`/`observed_at`/`related_name`/`related_bundle_id`
 * in place rather than accumulating duplicate historical edges (this table
 * is a "latest known" snapshot, not a time series — `appstore_app_ratings_history`
 * is the time series). Exported (not `recordPageSuccess`-only) so tests can
 * seed edges directly.
 */
export async function upsertRelatedApps(appId: string, relatedApps: readonly RelatedApp[], now: number): Promise<void> {
  if (relatedApps.length === 0) return;
  const db = getDb();
  for (const r of relatedApps) {
    await db`
      INSERT INTO appstore_related_apps (app_id, related_app_id, related_name, related_bundle_id, source, rank, observed_at)
      VALUES (${appId}, ${r.appId}, ${r.name}, ${r.bundleId}, ${r.source}, ${r.rank}, ${now})
      ON CONFLICT (app_id, related_app_id, source) DO UPDATE SET
        related_name = EXCLUDED.related_name,
        related_bundle_id = EXCLUDED.related_bundle_id,
        rank = EXCLUDED.rank,
        observed_at = EXCLUDED.observed_at
    `;
  }
}

// ---------------------------------------------------------------------------
// Ledger — backs `appstoreAppPages.dailyPageBudget`'s rolling-24h check.
// `appstore_app_ratings_history` doubles as this lane's request ledger (see
// migration 048's file-level doc comment) — every recording function above
// appends exactly one row per fetch ATTEMPT regardless of outcome.
// ---------------------------------------------------------------------------

export async function countPageFetchesSince(sinceEpochSeconds: number): Promise<number> {
  const db = getDb();
  const rows = await db`
    SELECT COUNT(*)::int AS count FROM appstore_app_ratings_history WHERE observed_at >= ${sinceEpochSeconds}
  `;
  return Number((rows as ReadonlyArray<{ count: number }>)[0]?.count ?? 0);
}
