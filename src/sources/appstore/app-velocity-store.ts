// Persistence for the newborn-velocity time-series (`appstore_app_velocity`,
// migration 040). Follows the house `XRow` (snake_case, as returned by
// `Bun.sql`) <-> domain (camelCase, readonly) split used throughout
// `keyword-store.ts` / `signature-hits-store.ts`. Pure velocity/acceleration
// math lives in `app-velocity.ts`, imported here rather than duplicated —
// `getTopAcceleratingNewborns` feeds it a reduced 3-point sample per app
// (fetched in ONE aggregate query) instead of re-deriving the ratio in SQL,
// avoiding the SQL/TS drift risk `keyword-store.ts`'s `BUILDABILITY_SQL`
// comment warns about.

import { getDb } from "../../store/db";
import {
  computeAcceleration,
  isNewborn,
  isObservationDue,
  type VelocityPoint,
} from "./app-velocity";
import type { TopApp } from "./keyword-types";

export interface AppVelocityObservation {
  readonly appId: string;
  readonly observedAt: number; // epoch seconds
  readonly reviews: number;
  readonly rating: number;
  readonly firstSeenKeyword: string;
  readonly name: string;
  /**
   * 0-based SERP position at the scan that produced this observation
   * (migration 044, serp-rank Stage 1), or `null` for an observation with no
   * SERP position of its own — e.g. a legacy pre-migration row, or a future
   * chart-sourced synthetic observation (Stage 2's `"chart-first-seen"`).
   */
  readonly rank: number | null;
}

/** Raw column shape returned by `SELECT * FROM appstore_app_velocity`. */
interface AppVelocityRow {
  readonly app_id: string;
  readonly observed_at: number | string;
  readonly reviews: number | string;
  readonly rating: number | string;
  readonly first_seen_keyword: string;
  readonly name: string;
  /** Migration 044. Absent/null on any pre-migration row. */
  readonly rank?: number | string | null;
}

function rowToObservation(row: AppVelocityRow): AppVelocityObservation {
  return {
    appId: row.app_id,
    observedAt: Number(row.observed_at),
    reviews: Number(row.reviews),
    rating: Number(row.rating),
    firstSeenKeyword: row.first_seen_keyword,
    name: row.name,
    rank: row.rank === null || row.rank === undefined ? null : Number(row.rank),
  };
}

/** Most recent `observed_at` recorded for `appId`, or `null` if never observed. */
export async function getLatestObservedAt(appId: string): Promise<number | null> {
  const db = getDb();
  const rows = await db`
    SELECT MAX(observed_at) AS latest FROM appstore_app_velocity WHERE app_id = ${appId}
  `;
  const latest = (rows as ReadonlyArray<{ latest: number | string | null }>)[0]?.latest;
  return latest === null || latest === undefined ? null : Number(latest);
}

export interface InsertObservationInput {
  readonly appId: string;
  readonly observedAt: number; // epoch seconds
  readonly reviews: number;
  readonly rating: number;
  readonly keyword: string;
  readonly name: string;
  /**
   * 0-based SERP position at the triggering scan (migration 044). Optional —
   * omit (or pass `null`) when there is no SERP position (e.g. a future
   * chart-sourced synthetic observation), which persists as SQL NULL.
   */
  readonly rank?: number | null;
}

/**
 * Records one velocity observation for a newborn app, bucketed to at most
 * one row per `VELOCITY_BUCKET_MS` (6h) window: checks the app's latest
 * recorded observation before inserting (see `isObservationDue`). Returns
 * `false` (no-op, nothing inserted) when the app's last observation is still
 * within the current bucket. `ON CONFLICT DO NOTHING` is a defensive
 * backstop against a same-timestamp race, not the primary dedupe mechanism —
 * the bucket check above is what actually bounds write volume.
 */
export async function insertObservation(input: InsertObservationInput): Promise<boolean> {
  const latest = await getLatestObservedAt(input.appId);
  if (!isObservationDue(latest, input.observedAt)) return false;

  const db = getDb();
  await db`
    INSERT INTO appstore_app_velocity (app_id, observed_at, reviews, rating, first_seen_keyword, name, rank)
    VALUES (
      ${input.appId}, ${input.observedAt}, ${input.reviews}, ${input.rating},
      ${input.keyword}, ${input.name}, ${input.rank ?? null}
    )
    ON CONFLICT (app_id, observed_at) DO NOTHING
  `;
  return true;
}

export interface RecordVelocityObservationsInput {
  readonly keyword: string;
  readonly scannedAt: number; // epoch seconds
  /**
   * The scan's SERP-ordered app list — index 0 = SERP position #1. Callers
   * that only ever have a scored top-N slice (the pre-Stage-1 default) still
   * satisfy this: rank is simply capped at that slice's length. Deep-scan
   * callers pass the FULL ranked fetch (`scanKeywordDeep`'s `rankedSerp`, up
   * to `serpDepth`), not just the scored `topApps` — see `keyword-gaps.ts`'s
   * `scanAndRecord`.
   */
  readonly topApps: readonly TopApp[];
}

/**
 * Hooked into the SERP-scan persist path (see `keyword-gaps.ts`
 * `scanAndRecord`): for every app in `topApps` younger than
 * `NEWBORN_AGE_DAYS_MAX` (see `isNewborn`), records one bucketed observation
 * tagged with its 0-based array index as `rank`. Apps with no `id` are
 * skipped (nothing to key the row on). `opts.maxRankRecorded`
 * (`appstoreVelocity.maxRankRecorded` config, read by the caller) bounds how
 * deep into `topApps` observations are even attempted — since `topApps` is
 * rank-ordered by construction, once the cap is reached every remaining
 * entry is deeper still, so the loop stops rather than continuing to check
 * each one. Omitting `maxRankRecorded` records the whole array (matches the
 * pre-Stage-1 behavior for shallow, already-bounded `topApps` inputs). Never
 * throws for a single app — an insert failure propagates only for genuine DB
 * errors, which the caller already wraps in a try/catch alongside its own
 * logging.
 */
export async function recordVelocityObservationsForScan(
  input: RecordVelocityObservationsInput,
  opts?: { readonly maxRankRecorded?: number },
): Promise<{ readonly recorded: number }> {
  const maxRankRecorded = opts?.maxRankRecorded;
  let recorded = 0;
  for (let rank = 0; rank < input.topApps.length; rank++) {
    if (maxRankRecorded !== undefined && rank >= maxRankRecorded) break;
    const app = input.topApps[rank];
    if (!app || !app.id || !isNewborn(app.ageDays)) continue;
    const inserted = await insertObservation({
      appId: app.id,
      observedAt: input.scannedAt,
      reviews: app.reviews,
      rating: app.rating,
      keyword: input.keyword,
      name: app.name,
      rank,
    });
    if (inserted) recorded++;
  }
  return { recorded };
}

/** Full observation history for one app, newest-first, bounded by `limit`. */
export async function getAppVelocitySeries(
  appId: string,
  limit = 200,
): Promise<readonly AppVelocityObservation[]> {
  const db = getDb();
  const rows = await db`
    SELECT * FROM appstore_app_velocity
    WHERE app_id = ${appId}
    ORDER BY observed_at DESC
    LIMIT ${limit}
  `;
  return (rows as AppVelocityRow[]).map(rowToObservation);
}

export interface AcceleratingNewborn {
  readonly appId: string;
  readonly name: string;
  readonly recentVelocity: number;
  readonly overallVelocity: number;
  readonly acceleration: number;
  readonly latestReviews: number;
  readonly latestRating: number;
  readonly observationCount: number;
}

/** Only apps observed within this many days are considered — an app with no recent observation can't be "currently accelerating". */
const DEFAULT_ACCELERATING_LOOKBACK_DAYS = 30;

/** Hard ceiling on `opts.limit`, mirroring the bounded-limit convention on `getSignatureHits` / `getTopOpportunities`. */
const MAX_ACCELERATING_LIMIT = 200;

interface AcceleratingCandidateRow {
  readonly app_id: string;
  readonly obs_count: number | string;
  readonly latest_at: number | string;
  readonly latest_reviews: number | string;
  readonly latest_rating: number | string;
  readonly second_at: number | string;
  readonly second_reviews: number | string;
  readonly earliest_at: number | string;
  readonly earliest_reviews: number | string;
  readonly latest_name: string;
}

/**
 * Top-N newborn apps ranked by acceleration (`app-velocity.ts`
 * `computeAcceleration`): recent velocity (last two observations) against
 * overall velocity (earliest-to-latest observation). A single aggregate
 * query pulls exactly the 3 points each app's acceleration needs (latest,
 * second-latest, earliest) via `ARRAY_AGG(... ORDER BY observed_at ...)`,
 * avoiding an N+1 query per candidate app. Apps with an unfinite/undefined
 * acceleration (e.g. no established baseline) are excluded rather than
 * ranked arbitrarily. `name` resolves from the latest observation's stored
 * `name` column — no extra join needed.
 */
export async function getTopAcceleratingNewborns(opts: {
  readonly limit: number;
  readonly lookbackDays?: number;
}): Promise<readonly AcceleratingNewborn[]> {
  const limit = Math.max(1, Math.min(opts.limit, MAX_ACCELERATING_LIMIT));
  const lookbackDays = opts.lookbackDays ?? DEFAULT_ACCELERATING_LOOKBACK_DAYS;
  const since = Math.floor(Date.now() / 1000) - lookbackDays * 86_400;

  const db = getDb();
  const rows = await db`
    SELECT
      app_id,
      COUNT(*)::int AS obs_count,
      (ARRAY_AGG(observed_at ORDER BY observed_at DESC))[1] AS latest_at,
      (ARRAY_AGG(reviews ORDER BY observed_at DESC))[1] AS latest_reviews,
      (ARRAY_AGG(rating ORDER BY observed_at DESC))[1] AS latest_rating,
      (ARRAY_AGG(observed_at ORDER BY observed_at DESC))[2] AS second_at,
      (ARRAY_AGG(reviews ORDER BY observed_at DESC))[2] AS second_reviews,
      (ARRAY_AGG(observed_at ORDER BY observed_at ASC))[1] AS earliest_at,
      (ARRAY_AGG(reviews ORDER BY observed_at ASC))[1] AS earliest_reviews,
      (ARRAY_AGG(name ORDER BY observed_at DESC))[1] AS latest_name
    FROM appstore_app_velocity
    WHERE observed_at >= ${since}
    GROUP BY app_id
    HAVING COUNT(*) >= 2
  `;

  const candidates = (rows as AcceleratingCandidateRow[]).map((r) => {
    const points: readonly VelocityPoint[] = [
      { observedAt: Number(r.latest_at), reviews: Number(r.latest_reviews) },
      { observedAt: Number(r.second_at), reviews: Number(r.second_reviews) },
      { observedAt: Number(r.earliest_at), reviews: Number(r.earliest_reviews) },
    ];
    return {
      appId: r.app_id,
      name: r.latest_name,
      latestReviews: Number(r.latest_reviews),
      latestRating: Number(r.latest_rating),
      observationCount: Number(r.obs_count),
      accel: computeAcceleration(points),
    };
  });

  return candidates
    .filter((c) => c.accel.acceleration !== null)
    .sort((a, b) => (b.accel.acceleration as number) - (a.accel.acceleration as number))
    .slice(0, limit)
    .map((c) => ({
      appId: c.appId,
      name: c.name,
      recentVelocity: c.accel.recentVelocity as number,
      overallVelocity: c.accel.overallVelocity as number,
      acceleration: c.accel.acceleration as number,
      latestReviews: c.latestReviews,
      latestRating: c.latestRating,
      observationCount: c.observationCount,
    }));
}
