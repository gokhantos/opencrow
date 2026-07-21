// Shared type contract + pure logic for the App Store app-meta registry
// (deep-scrape build Stage 2, migration 045). No I/O, no Date.now() — every
// input is a plain value the caller already read from the DB or the Lookup
// API, so `detectMetaEvents` is exhaustively unit-testable with injected
// snapshots. Split from `app-meta-store.ts` the same way `app-velocity.ts`
// is split from `app-velocity-store.ts` / `keyword-scoring.ts` from
// `keyword-store.ts`.

import type { LookupApp } from "./app-lookup";

/**
 * Where a registry row's FIRST sighting came from. Matches migration 045's
 * `first_seen_source` CHECK constraint exactly — keep in lockstep.
 */
export type AppMetaSource =
  | "serp"
  | "chart"
  | "chart-intl"
  | "discovery"
  | "velocity"
  | "portfolio"
  | "backfill";

export const APP_META_SOURCES: readonly AppMetaSource[] = Object.freeze([
  "serp",
  "chart",
  "chart-intl",
  "discovery",
  "velocity",
  "portfolio",
  "backfill",
]);

/** One "every app id we ever see" registry row (domain shape, camelCase). */
export interface AppMeta {
  readonly id: string;
  readonly name: string;
  readonly firstSeenAt: number; // epoch seconds
  readonly firstSeenSource: AppMetaSource;
  readonly firstSeenStorefront: string;
  readonly firstSeenKeyword: string | null;
  readonly lastSeenAt: number; // epoch seconds
  readonly enrichedAt: number | null; // epoch seconds; null = never enriched
  readonly releaseDate: string | null;
  readonly currentVersionReleaseDate: string | null;
  readonly version: string | null;
  readonly genreId: string | null;
  readonly genreName: string | null;
  readonly price: number | null;
  readonly formattedPrice: string | null;
  readonly ratingCount: number | null;
  readonly averageRating: number | null;
  readonly artistId: string | null;
  readonly artistName: string | null;
  readonly bundleId: string | null;
  readonly trackViewUrl: string | null;
  readonly artworkUrl: string | null;
  readonly missCount: number;
  readonly delistedAt: number | null;
  readonly relistedAt: number | null;
  readonly updatedAt: number; // epoch seconds
}

export type AppMetaEventType =
  | "price_change"
  | "rating_spike"
  | "developer_change"
  | "delisted"
  | "relisted";

export interface AppMetaEvent {
  readonly eventType: AppMetaEventType;
  readonly oldValue: string | null;
  readonly newValue: string | null;
}

/**
 * Converts an iTunes-style ISO 8601 date string (e.g.
 * `"2020-01-01T00:00:00Z"`) to epoch SECONDS. Returns `null` for an
 * empty/unparseable string rather than throwing — every date field on the
 * Lookup API response is best-effort per `app-lookup.ts`'s defensive zod
 * schema, so callers must tolerate a missing/garbled value.
 */
export function isoToEpochSeconds(iso: string): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  return Math.floor(ms / 1000);
}

/**
 * Days between `releaseDate` (ISO 8601) and `nowSeconds` (epoch seconds).
 * Returns `null` when `releaseDate` is missing/unparseable — callers must
 * treat that as "unknown age", never silently default to 0/newborn.
 */
export function ageDaysFromReleaseDate(releaseDate: string, nowSeconds: number): number | null {
  const releasedAtSeconds = isoToEpochSeconds(releaseDate);
  if (releasedAtSeconds === null) return null;
  return Math.max(0, Math.floor((nowSeconds - releasedAtSeconds) / 86_400));
}

// ---------------------------------------------------------------------------
// Event detection
// ---------------------------------------------------------------------------

/**
 * A rating-count jump only counts as a "spike" event when it clears BOTH an
 * absolute floor and a relative-percentage bar — mirrors the pattern in
 * `keyword-gaps.ts`'s `GIANT_REVIEW_THRESHOLD`/winsorizing: either bound
 * alone is too noisy (a 1 -> 2 review jump is a 100% increase; a 100,000 ->
 * 100,500 jump is a 0.5% increase but +500 raw reviews), so both must hold.
 */
const RATING_SPIKE_MIN_ABSOLUTE = 100;
const RATING_SPIKE_MIN_RELATIVE = 0.5; // 50%

/** Minimal "previous state" shape `detectMetaEvents` diffs against — a subset of `AppMeta`. */
export interface AppMetaPrevious {
  readonly ratingCount: number | null;
  readonly price: number | null;
  readonly artistId: string | null;
  readonly delistedAt: number | null;
}

/**
 * Diffs a registry row's PRIOR persisted state against a FRESH Lookup-API
 * result (or `null`, meaning the app was absent from a lookup batch's
 * results — a miss/delist signal) and returns the events that fired. Pure:
 * no I/O, no clock reads — `detected_at` is stamped by the caller
 * (`app-meta-store.ts`'s `upsertLookupResult`/`recordEnrichmentMiss`).
 *
 * `previous: null` means this is the app's FIRST-ever enrichment (nothing to
 * diff against) — no events fire regardless of `current`, since every
 * "change" event is inherently relative to a prior known state.
 */
export function detectMetaEvents(
  previous: AppMetaPrevious | null,
  current: LookupApp | null,
): readonly AppMetaEvent[] {
  if (previous === null) return [];

  // A miss (current === null): only a "delisted" event, and only on the
  // transition INTO delisted (a repeat miss on an already-delisted row is
  // not a new event — see `recordEnrichmentMiss`'s idempotency).
  if (current === null) {
    if (previous.delistedAt !== null) return [];
    return [{ eventType: "delisted", oldValue: null, newValue: null }];
  }

  const events: AppMetaEvent[] = [];

  // Relisted: the row WAS delisted and a lookup just found it again.
  if (previous.delistedAt !== null) {
    events.push({ eventType: "relisted", oldValue: null, newValue: null });
  }

  if (previous.price !== null && current.price !== previous.price) {
    events.push({
      eventType: "price_change",
      oldValue: String(previous.price),
      newValue: String(current.price),
    });
  }

  if (previous.artistId !== null && current.artistId !== "" && current.artistId !== previous.artistId) {
    events.push({
      eventType: "developer_change",
      oldValue: previous.artistId,
      newValue: current.artistId,
    });
  }

  if (previous.ratingCount !== null) {
    const delta = current.reviews - previous.ratingCount;
    const relative = delta / Math.max(previous.ratingCount, 1);
    if (delta >= RATING_SPIKE_MIN_ABSOLUTE && relative >= RATING_SPIKE_MIN_RELATIVE) {
      events.push({
        eventType: "rating_spike",
        oldValue: String(previous.ratingCount),
        newValue: String(current.reviews),
      });
    }
  }

  return events;
}
