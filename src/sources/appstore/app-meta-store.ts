// Persistence for the App Store app-meta registry (`appstore_app_meta` +
// `appstore_app_meta_events` + `appstore_lookup_requests`, migration 045).
// Follows the house `XRow` (snake_case, as returned by `Bun.sql`) <-> domain
// (camelCase, readonly) split used throughout `keyword-store.ts` /
// `signature-hits-store.ts`. Pure event-diffing lives in
// `app-meta-types.ts`, imported here rather than duplicated.

import { getDb } from "../../store/db";
import type { LookupApp } from "./app-lookup";
import {
  detectMetaEvents,
  type AppMeta,
  type AppMetaEvent,
  type AppMetaPrevious,
  type AppMetaSource,
} from "./app-meta-types";

/** Raw column shape returned by `SELECT * FROM appstore_app_meta`. */
interface AppMetaRow {
  readonly id: string;
  readonly name: string;
  readonly first_seen_at: number | string;
  readonly first_seen_source: string;
  readonly first_seen_storefront: string;
  readonly first_seen_keyword: string | null;
  readonly last_seen_at: number | string;
  readonly enriched_at: number | string | null;
  readonly release_date: string | null;
  readonly current_version_release_date: string | null;
  readonly version: string | null;
  readonly genre_id: string | null;
  readonly genre_name: string | null;
  readonly price: number | string | null;
  readonly formatted_price: string | null;
  readonly rating_count: number | string | null;
  readonly average_rating: number | string | null;
  readonly artist_id: string | null;
  readonly artist_name: string | null;
  readonly bundle_id: string | null;
  readonly track_view_url: string | null;
  readonly artwork_url: string | null;
  readonly miss_count: number | string;
  readonly delisted_at: number | string | null;
  readonly relisted_at: number | string | null;
  readonly updated_at: number | string;
}

function numOrNull(v: number | string | null | undefined): number | null {
  return v === null || v === undefined ? null : Number(v);
}

function rowToAppMeta(row: AppMetaRow): AppMeta {
  return {
    id: row.id,
    name: row.name,
    firstSeenAt: Number(row.first_seen_at),
    firstSeenSource: row.first_seen_source as AppMetaSource,
    firstSeenStorefront: row.first_seen_storefront,
    firstSeenKeyword: row.first_seen_keyword,
    lastSeenAt: Number(row.last_seen_at),
    enrichedAt: numOrNull(row.enriched_at),
    releaseDate: row.release_date,
    currentVersionReleaseDate: row.current_version_release_date,
    version: row.version,
    genreId: row.genre_id,
    genreName: row.genre_name,
    price: numOrNull(row.price),
    formattedPrice: row.formatted_price,
    ratingCount: numOrNull(row.rating_count),
    averageRating: numOrNull(row.average_rating),
    artistId: row.artist_id,
    artistName: row.artist_name,
    bundleId: row.bundle_id,
    trackViewUrl: row.track_view_url,
    artworkUrl: row.artwork_url,
    missCount: Number(row.miss_count),
    delistedAt: numOrNull(row.delisted_at),
    relistedAt: numOrNull(row.relisted_at),
    updatedAt: Number(row.updated_at),
  };
}

function toAppMetaPrevious(m: AppMeta): AppMetaPrevious {
  return {
    ratingCount: m.ratingCount,
    price: m.price,
    artistId: m.artistId,
    delistedAt: m.delistedAt,
  };
}

// ---------------------------------------------------------------------------
// Sightings — the registry's write path from every discovery lane (charts,
// keyword-gap SERP scans, developer portfolios, the one-shot backfill).
// ---------------------------------------------------------------------------

export interface AppMetaSighting {
  readonly id: string;
  readonly name?: string;
}

/**
 * Records that `rows` were just seen, tagged with `source`. First sighting
 * of an id INSERTs a fresh registry row (`first_seen_*` stamped, `enriched_at`
 * left NULL so `selectDueForEnrichment` picks it up); a repeat sighting only
 * ever bumps `last_seen_at` — via `GREATEST`, so an out-of-order/delayed
 * sighting can never regress it backwards — and NEVER touches `first_seen_*`
 * (immutable once set) or anything the enrichment pass owns. Rows with an
 * empty `id` are skipped. Returns the count of rows touched (inserted OR
 * updated).
 */
export async function recordAppSightings(
  rows: readonly AppMetaSighting[],
  source: AppMetaSource,
  opts?: { readonly storefront?: string; readonly keyword?: string },
): Promise<number> {
  const filtered = rows.filter((r) => r.id);
  if (filtered.length === 0) return 0;

  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const storefront = opts?.storefront ?? "us";
  const keyword = opts?.keyword ?? null;

  let touched = 0;
  for (const r of filtered) {
    await db`
      INSERT INTO appstore_app_meta (
        id, name, first_seen_at, first_seen_source, first_seen_storefront,
        first_seen_keyword, last_seen_at, updated_at
      ) VALUES (
        ${r.id}, ${r.name ?? ""}, ${now}, ${source}, ${storefront},
        ${keyword}, ${now}, ${now}
      )
      ON CONFLICT (id) DO UPDATE SET
        last_seen_at = GREATEST(appstore_app_meta.last_seen_at, EXCLUDED.last_seen_at),
        updated_at = GREATEST(appstore_app_meta.updated_at, EXCLUDED.updated_at)
    `;
    touched++;
  }
  return touched;
}

/**
 * One-shot, set-based seed of the registry from the PRE-EXISTING
 * `appstore_apps` table (apps discovered before the registry existed) —
 * mirrors `keyword-store.ts`'s `backfillMinedDeactivation` in being a single
 * idempotent `INSERT ... SELECT ... WHERE NOT EXISTS` rather than budgeted
 * batches: a second call only ever touches ids the first call (or any
 * `recordAppSightings` call since) hasn't already registered.
 * `first_seen_source = 'backfill'` — deliberately excluded from
 * chart-newborn enrollment (Stage 4) per the build plan's §0.1: a 15.8k-row
 * backfill must never look like a fresh newborn chart entry.
 */
export async function backfillRegistry(): Promise<number> {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const rows = await db`
    INSERT INTO appstore_app_meta (
      id, name, first_seen_at, first_seen_source, first_seen_storefront, last_seen_at, updated_at
    )
    SELECT a.id, a.name, ${now}, 'backfill', 'us', ${now}, ${now}
    FROM appstore_apps a
    WHERE a.id <> ''
      AND NOT EXISTS (SELECT 1 FROM appstore_app_meta m WHERE m.id = a.id)
    ON CONFLICT (id) DO NOTHING
    RETURNING id
  `;
  return (rows as ReadonlyArray<{ id: string }>).length;
}

// ---------------------------------------------------------------------------
// Enrichment queue
// ---------------------------------------------------------------------------

/**
 * Batch-fetches the FULL registry row for each of `ids` — the enrichment
 * pass's "previous state" read, taken BEFORE `claimForEnrichment` touches
 * `enriched_at` (though claiming only touches `enriched_at`/`updated_at`, so
 * ordering relative to this call doesn't matter for the fields
 * `app-meta-types.ts`'s `detectMetaEvents` diffs). Missing ids are simply
 * absent from the returned map.
 */
export async function getAppMetaBatch(ids: readonly string[]): Promise<ReadonlyMap<string, AppMeta>> {
  const map = new Map<string, AppMeta>();
  if (ids.length === 0) return map;
  const db = getDb();
  const rows = await db`SELECT * FROM appstore_app_meta WHERE id IN ${db(ids)}`;
  for (const row of rows as AppMetaRow[]) {
    const m = rowToAppMeta(row);
    map.set(m.id, m);
  }
  return map;
}

/** Single-row convenience wrapper over `getAppMetaBatch`. */
export async function getAppMeta(id: string): Promise<AppMeta | null> {
  const batch = await getAppMetaBatch([id]);
  return batch.get(id) ?? null;
}

/**
 * App ids referenced in the stored top-apps snapshot of an OPEN (`status`
 * `'new'`/`'active'`, never `'dismissed'`) signature hit — a validated
 * opportunity-window keyword is exactly where the registry's metadata
 * (developer, price, delist status) matters most to keep fresh. `up to
 * limit` distinct ids, no further ordering guarantee. `top_apps_snapshot` is
 * stored DOUBLE-ENCODED (see `signature-hits-store.ts`'s `getScreenerCandidates`
 * doc comment re: `top_apps`) — unwrapped with `#>> '{}'` the same way before
 * `jsonb_array_elements` walks the array.
 */
async function getHitRelatedAppIds(limit: number): Promise<readonly string[]> {
  if (limit <= 0) return [];
  const db = getDb();
  const rows = await db`
    SELECT DISTINCT (elem ->> 'id') AS id
    FROM appstore_signature_hits h,
         LATERAL jsonb_array_elements((h.top_apps_snapshot #>> '{}')::jsonb) AS elem
    WHERE h.status IN ('new', 'active') AND (elem ->> 'id') IS NOT NULL AND (elem ->> 'id') <> ''
    LIMIT ${limit}
  `;
  return (rows as ReadonlyArray<{ id: string | null }>)
    .map((r) => r.id)
    .filter((id): id is string => id !== null);
}

/**
 * Selects up to `limit` app ids due for Lookup-API enrichment, in priority
 * order:
 *   1. `acceleratingIds` (currently-accelerating newborns per
 *      `app-velocity-store.ts`'s `getTopAcceleratingNewborns` — re-enriched
 *      regardless of staleness, since a fast-moving app's rating/price/
 *      developer data going stale matters more than an ordinary app's).
 *   2. Hit-related ids (`getHitRelatedAppIds` above — apps inside an open
 *      signature hit's snapshot).
 *   3. Never-enriched (`enriched_at IS NULL`) and stale (`enriched_at` older
 *      than `staleAfterSeconds`) rows, oldest/never-enriched first.
 * Delisted apps are excluded from every tier — a delisted app has nothing
 * left to re-enrich until Apple relists it, which `recordAppSightings` would
 * surface as a fresh sighting, not this queue.
 *
 * Implemented as separate queries + a TS-side merge (not a single CTE) —
 * bounds complexity and sidesteps the empty-array edge case an
 * `id = ANY($1::text[])` with a zero-length priority-id array would
 * otherwise need special-casing for; the result is behaviorally identical to
 * a CTE union with the same tiered priority ordering.
 */
export async function selectDueForEnrichment(opts: {
  readonly limit: number;
  readonly staleAfterSeconds: number;
  readonly acceleratingIds?: readonly string[];
}): Promise<readonly string[]> {
  const limit = Math.max(0, Math.floor(opts.limit));
  if (limit === 0) return [];

  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const staleSince = now - Math.max(0, opts.staleAfterSeconds);

  const prioritized: string[] = [];
  const seen = new Set<string>();

  const addPrioritized = (ids: readonly string[]) => {
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      prioritized.push(id);
      if (prioritized.length >= limit) break;
    }
  };

  const acceleratingIds = (opts.acceleratingIds ?? []).filter((id) => id.length > 0);
  if (acceleratingIds.length > 0 && prioritized.length < limit) {
    const rows = await db`
      SELECT id FROM appstore_app_meta
      WHERE id IN ${db(acceleratingIds)} AND delisted_at IS NULL
    `;
    addPrioritized((rows as ReadonlyArray<{ id: string }>).map((r) => r.id));
  }

  if (prioritized.length < limit) {
    const hitRelatedIds = await getHitRelatedAppIds(limit - prioritized.length + seen.size);
    if (hitRelatedIds.length > 0) {
      const rows = await db`
        SELECT id FROM appstore_app_meta
        WHERE id IN ${db(hitRelatedIds)} AND delisted_at IS NULL
      `;
      addPrioritized((rows as ReadonlyArray<{ id: string }>).map((r) => r.id));
    }
  }

  if (prioritized.length < limit) {
    const fetchLimit = limit - prioritized.length + seen.size;
    const rows = await db`
      SELECT id FROM appstore_app_meta
      WHERE delisted_at IS NULL
        AND (enriched_at IS NULL OR enriched_at < ${staleSince})
      ORDER BY enriched_at ASC NULLS FIRST
      LIMIT ${fetchLimit}
    `;
    for (const r of rows as ReadonlyArray<{ id: string }>) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      prioritized.push(r.id);
      if (prioritized.length >= limit) break;
    }
  }

  return prioritized;
}

/**
 * Speculatively marks `ids` as claimed by touching `enriched_at`/`updated_at`
 * to `now` BEFORE the lookup fetch runs — bounds the blast radius of a
 * mid-batch crash/failure: without this, a batch whose fetch throws would
 * stay perpetually "due" and get re-selected (and re-fetched) on every
 * subsequent pass until it succeeds. A claimed-then-failed id is simply
 * reconsidered once `staleAfterSeconds` elapses, same as any other stale
 * row, rather than on the very next 15-minute pass.
 */
export async function claimForEnrichment(ids: readonly string[], now: number): Promise<void> {
  if (ids.length === 0) return;
  const db = getDb();
  await db`
    UPDATE appstore_app_meta SET enriched_at = ${now}, updated_at = ${now}
    WHERE id IN ${db(ids)}
  `;
}

/**
 * Writes a successful Lookup-API result back onto the registry row: full
 * field refresh, `miss_count` reset to 0, `delisted_at` cleared (stamping
 * `relisted_at` iff it WAS delisted — a genuine relist, not just an
 * ordinary re-enrichment of a never-delisted row), `enriched_at`/`updated_at`
 * bumped to `now`. `previous` is the row's state as read by
 * `getAppMetaBatch` BEFORE this call (or `null` for an app that somehow
 * isn't registered yet — defensive; callers always pass a registered id) —
 * diffed via `detectMetaEvents` to produce the events persisted to
 * `appstore_app_meta_events`. Returns the events that fired (for the
 * caller's logging).
 */
export async function upsertLookupResult(
  appId: string,
  result: LookupApp,
  now: number,
  previous: AppMeta | null,
): Promise<readonly AppMetaEvent[]> {
  const db = getDb();
  await db`
    UPDATE appstore_app_meta SET
      name = CASE WHEN ${result.name} <> '' THEN ${result.name} ELSE name END,
      release_date = ${result.releaseDate || null},
      current_version_release_date = ${result.currentVersionReleaseDate || null},
      version = ${result.version || null},
      genre_id = ${result.genreId || null},
      genre_name = ${result.genreName || null},
      price = ${result.price},
      formatted_price = ${result.formattedPrice || null},
      rating_count = ${result.reviews},
      average_rating = ${result.rating},
      artist_id = ${result.artistId || null},
      artist_name = ${result.artistName || null},
      bundle_id = ${result.bundleId || null},
      track_view_url = ${result.trackViewUrl || null},
      artwork_url = ${result.artworkUrl || null},
      miss_count = 0,
      relisted_at = CASE WHEN delisted_at IS NOT NULL THEN ${now} ELSE relisted_at END,
      delisted_at = NULL,
      enriched_at = ${now},
      updated_at = ${now}
    WHERE id = ${appId}
  `;

  const prevForEvents: AppMetaPrevious | null = previous ? toAppMetaPrevious(previous) : null;
  const events = detectMetaEvents(prevForEvents, result);
  for (const e of events) {
    await db`
      INSERT INTO appstore_app_meta_events (app_id, event_type, detected_at, old_value, new_value)
      VALUES (${appId}, ${e.eventType}, ${now}, ${e.oldValue}, ${e.newValue})
    `;
  }
  return events;
}

/**
 * Records that `appId` was ABSENT from a lookup batch's results — increments
 * `miss_count`, and on crossing `delistMissThreshold` (and only on that
 * transition — a repeat miss on an already-delisted row is a no-op past the
 * counter bump) stamps `delisted_at` and persists a `'delisted'` event.
 * `previous` is the pre-miss registry state (for `detectMetaEvents`'s
 * transition check — a `null`/already-delisted `previous` suppresses a
 * duplicate event even if the SQL's own `delisted_at IS NULL` guard somehow
 * raced). Returns whether this call transitioned the row to delisted.
 */
export async function recordEnrichmentMiss(
  appId: string,
  now: number,
  previous: AppMeta | null,
  delistMissThreshold: number,
): Promise<{ readonly delisted: boolean }> {
  const db = getDb();
  const rows = await db`
    UPDATE appstore_app_meta SET
      miss_count = miss_count + 1,
      enriched_at = ${now},
      updated_at = ${now},
      delisted_at = CASE
        WHEN delisted_at IS NULL AND miss_count + 1 >= ${delistMissThreshold} THEN ${now}
        ELSE delisted_at
      END
    WHERE id = ${appId}
    RETURNING delisted_at
  `;
  const row = (rows as ReadonlyArray<{ delisted_at: number | string | null }>)[0];
  const nowDelisted = row?.delisted_at !== null && row?.delisted_at !== undefined;
  const wasAlreadyDelisted = previous?.delistedAt !== null && previous?.delistedAt !== undefined;

  if (nowDelisted && !wasAlreadyDelisted) {
    const prevForEvents: AppMetaPrevious | null = previous ? toAppMetaPrevious(previous) : null;
    const events = detectMetaEvents(prevForEvents, null);
    for (const e of events) {
      await db`
        INSERT INTO appstore_app_meta_events (app_id, event_type, detected_at, old_value, new_value)
        VALUES (${appId}, ${e.eventType}, ${now}, ${e.oldValue}, ${e.newValue})
      `;
    }
  }

  return { delisted: nowDelisted };
}

// ---------------------------------------------------------------------------
// Lookup-request ledger — backs `appstoreAppEnrichment.dailyRequestBudget`'s
// rolling-24h check, mirroring `appstore_keyword_scans`' role for
// `dailyKeywordBudget` (see `keyword-store.ts`'s `countScansSince`).
// ---------------------------------------------------------------------------

export async function recordLookupRequest(
  requestType: "lookup" | "portfolio",
  idCount: number,
  success: boolean,
  now: number,
): Promise<void> {
  const db = getDb();
  await db`
    INSERT INTO appstore_lookup_requests (requested_at, request_type, id_count, success)
    VALUES (${now}, ${requestType}, ${idCount}, ${success})
  `;
}

export async function countLookupRequestsSince(sinceEpochSeconds: number): Promise<number> {
  const db = getDb();
  const rows = await db`
    SELECT COUNT(*)::int AS count FROM appstore_lookup_requests WHERE requested_at >= ${sinceEpochSeconds}
  `;
  return Number((rows as ReadonlyArray<{ count: number }>)[0]?.count ?? 0);
}

/** Deletes ledger rows older than `olderThanEpochSeconds`. Returns the count deleted. */
export async function pruneLookupRequestLedger(olderThanEpochSeconds: number): Promise<number> {
  const db = getDb();
  const rows = await db`
    DELETE FROM appstore_lookup_requests WHERE requested_at < ${olderThanEpochSeconds} RETURNING id
  `;
  return (rows as ReadonlyArray<{ id: number }>).length;
}
