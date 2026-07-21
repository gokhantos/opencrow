// Persistence for the review-text harvester (`appstore_review_harvest_state`
// + `appstore_review_harvests`, migration 047) — deep-scrape build Stage 4.
// Follows the house `XRow` (snake_case, as returned by `Bun.sql`) <->
// domain (camelCase, readonly) split used throughout `app-meta-store.ts` /
// `signature-hits-store.ts`. Pure cadence/cohort logic lives in
// `review-harvest-scheduling.ts`, imported here rather than duplicated.

import { getDb } from "../../store/db";
import { NEWBORN_AGE_DAYS_MAX } from "./app-velocity";
import { getTopAcceleratingNewborns } from "./app-velocity-store";
import {
  DAILY_INTERVAL_SECONDS,
  WEEKLY_INTERVAL_SECONDS,
  type ReviewHarvestCohort,
  type ReviewHarvestEnrollmentReason,
} from "./review-harvest-scheduling";

export interface ReviewHarvestEnrollment {
  readonly appId: string;
  readonly enrolledAt: number;
  readonly enrolledVia: ReviewHarvestEnrollmentReason;
  readonly cohort: ReviewHarvestCohort;
  readonly active: boolean;
  readonly firstHarvestDone: boolean;
  readonly lastHarvestedAt: number | null;
  readonly lastPageReached: number | null;
  readonly consecutiveEmptyHarvests: number;
  readonly deactivatedAt: number | null;
  readonly updatedAt: number;
}

interface ReviewHarvestStateRow {
  readonly app_id: string;
  readonly enrolled_at: number | string;
  readonly enrolled_via: string;
  readonly cohort: string;
  readonly active: boolean;
  readonly first_harvest_done: boolean;
  readonly last_harvested_at: number | string | null;
  readonly last_page_reached: number | string | null;
  readonly consecutive_empty_harvests: number | string;
  readonly deactivated_at: number | string | null;
  readonly updated_at: number | string;
}

function numOrNull(v: number | string | null | undefined): number | null {
  return v === null || v === undefined ? null : Number(v);
}

function rowToEnrollment(row: ReviewHarvestStateRow): ReviewHarvestEnrollment {
  return {
    appId: row.app_id,
    enrolledAt: Number(row.enrolled_at),
    enrolledVia: row.enrolled_via as ReviewHarvestEnrollmentReason,
    cohort: row.cohort as ReviewHarvestCohort,
    active: row.active,
    firstHarvestDone: row.first_harvest_done,
    lastHarvestedAt: numOrNull(row.last_harvested_at),
    lastPageReached: numOrNull(row.last_page_reached),
    consecutiveEmptyHarvests: Number(row.consecutive_empty_harvests),
    deactivatedAt: numOrNull(row.deactivated_at),
    updatedAt: Number(row.updated_at),
  };
}

// ---------------------------------------------------------------------------
// Enrollment — written by the cohort-refresh sub-pass (`review-harvester.ts`'s
// `runCohortRefresh`).
// ---------------------------------------------------------------------------

/**
 * Enrolls (or refreshes) an app's harvest enrollment. `enrolledVia` is
 * write-once — only stamped on first INSERT, never overwritten on conflict
 * (mirrors `appstore_app_meta.first_seen_source`'s immutability). `cohort`
 * is "daily wins": upgrades to daily on conflict if either the existing row
 * or this call's cohort is daily, never downgrades. A previously-deactivated
 * enrollment is reactivated (`active = TRUE`, `deactivated_at` cleared) —
 * fresh candidate-query evidence overrides an old deactivation. Returns
 * whether this call inserted a brand-new enrollment.
 */
export async function upsertEnrollment(input: {
  readonly appId: string;
  readonly enrolledVia: ReviewHarvestEnrollmentReason;
  readonly cohort: ReviewHarvestCohort;
  readonly now: number;
}): Promise<{ readonly isNew: boolean }> {
  const db = getDb();
  const rows = await db`
    INSERT INTO appstore_review_harvest_state (
      app_id, enrolled_at, enrolled_via, cohort, active, first_harvest_done, updated_at
    ) VALUES (
      ${input.appId}, ${input.now}, ${input.enrolledVia}, ${input.cohort}, TRUE, FALSE, ${input.now}
    )
    ON CONFLICT (app_id) DO UPDATE SET
      cohort = CASE
        WHEN appstore_review_harvest_state.cohort = 'daily' OR ${input.cohort} = 'daily'
        THEN 'daily' ELSE 'weekly'
      END,
      active = TRUE,
      deactivated_at = NULL,
      updated_at = ${input.now}
    RETURNING (xmax = 0) AS inserted
  `;
  const row = (rows as ReadonlyArray<{ inserted: boolean }>)[0];
  return { isNew: row?.inserted === true };
}

/**
 * Active enrollments due for harvest, oldest-harvested-first (never-harvested
 * rows first via `NULLS FIRST`), up to `limit`. Mirrors
 * `review-harvest-scheduling.ts`'s `computeNextDueAt`/`isHarvestDue` interval
 * math directly in SQL (daily = 24h, weekly = 7d) rather than pulling every
 * active row into TS to filter — the two must be kept in lockstep, which is
 * why the interval constants themselves (`DAILY_INTERVAL_SECONDS` /
 * `WEEKLY_INTERVAL_SECONDS`) are imported from that pure module rather than
 * re-declared here.
 */
export async function getDueEnrollments(opts: {
  readonly limit: number;
  readonly nowSeconds: number;
}): Promise<readonly ReviewHarvestEnrollment[]> {
  const limit = Math.max(0, Math.floor(opts.limit));
  if (limit === 0) return [];

  const db = getDb();
  const dailyCutoff = opts.nowSeconds - DAILY_INTERVAL_SECONDS;
  const weeklyCutoff = opts.nowSeconds - WEEKLY_INTERVAL_SECONDS;

  const rows = await db`
    SELECT * FROM appstore_review_harvest_state
    WHERE active = TRUE
      AND (
        last_harvested_at IS NULL
        OR (cohort = 'daily' AND last_harvested_at < ${dailyCutoff})
        OR (cohort = 'weekly' AND last_harvested_at < ${weeklyCutoff})
      )
    ORDER BY last_harvested_at ASC NULLS FIRST
    LIMIT ${limit}
  `;
  return (rows as ReviewHarvestStateRow[]).map(rowToEnrollment);
}

/**
 * Records one harvest pass's outcome for `appId`: bumps `last_harvested_at`/
 * `last_page_reached`/`updated_at`, stamps `first_harvest_done = TRUE`
 * (write-once — a `TRUE` never reverts), and updates the empty-harvest
 * streak (`newReviews > 0` resets it to 0; a zero-new-review pass increments
 * it — feeding `review-harvest-scheduling.ts`'s `shouldDeactivateEnrollment`).
 * Also appends one row to the `appstore_review_harvests` ledger. Returns the
 * POST-update `consecutiveEmptyHarvests` so the caller can immediately
 * evaluate deactivation without a second read.
 */
export async function recordHarvestOutcome(input: {
  readonly appId: string;
  readonly now: number;
  readonly pagesFetched: number;
  readonly reviewsFound: number;
  readonly newReviews: number;
}): Promise<{ readonly consecutiveEmptyHarvests: number }> {
  const db = getDb();
  const rows = await db`
    UPDATE appstore_review_harvest_state SET
      last_harvested_at = ${input.now},
      last_page_reached = ${input.pagesFetched},
      first_harvest_done = TRUE,
      consecutive_empty_harvests = CASE
        WHEN ${input.newReviews} > 0 THEN 0
        ELSE consecutive_empty_harvests + 1
      END,
      updated_at = ${input.now}
    WHERE app_id = ${input.appId}
    RETURNING consecutive_empty_harvests
  `;
  await db`
    INSERT INTO appstore_review_harvests (app_id, harvested_at, pages_fetched, reviews_found, new_reviews, success)
    VALUES (${input.appId}, ${input.now}, ${input.pagesFetched}, ${input.reviewsFound}, ${input.newReviews}, TRUE)
  `;
  const row = (rows as ReadonlyArray<{ consecutive_empty_harvests: number | string }>)[0];
  return { consecutiveEmptyHarvests: row ? Number(row.consecutive_empty_harvests) : 0 };
}

/** Deactivates an enrollment — see `review-harvest-scheduling.ts`'s `shouldDeactivateEnrollment`. */
export async function deactivateEnrollment(appId: string, now: number): Promise<void> {
  const db = getDb();
  await db`
    UPDATE appstore_review_harvest_state
    SET active = FALSE, deactivated_at = ${now}, updated_at = ${now}
    WHERE app_id = ${appId}
  `;
}

/** Single-row convenience wrapper — test/inspection use. */
export async function getEnrollment(appId: string): Promise<ReviewHarvestEnrollment | null> {
  const db = getDb();
  const rows = await db`SELECT * FROM appstore_review_harvest_state WHERE app_id = ${appId}`;
  const row = (rows as ReviewHarvestStateRow[])[0];
  return row ? rowToEnrollment(row) : null;
}

// ---------------------------------------------------------------------------
// Candidate queries — the cohort-refresh sub-pass's three sources.
// ---------------------------------------------------------------------------

/**
 * App ids referenced in an OPEN (`status` `'new'`/`'active'`) signature
 * hit's stored top-apps snapshot — mirrors `app-meta-store.ts`'s
 * `getHitRelatedAppIds` (same rationale: a validated opportunity-window
 * keyword's incumbents are exactly where fresh review text matters most),
 * duplicated locally rather than imported since that function isn't
 * exported (an internal helper of the enrichment queue). `top_apps_snapshot`
 * is stored DOUBLE-ENCODED (see `signature-hits-store.ts`'s
 * `getScreenerCandidates` doc comment re: `top_apps`) — unwrapped with
 * `#>> '{}'` the same way before `jsonb_array_elements` walks the array.
 */
export async function getSignatureHitCandidates(cap: number): Promise<readonly string[]> {
  const limit = Math.max(0, Math.floor(cap));
  if (limit === 0) return [];
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
 * Currently-accelerating newborn app ids (`app-velocity-store.ts`'s
 * `getTopAcceleratingNewborns`) — a fast-moving app's incoming review text
 * is exactly the kind of fresh signal the daily cohort exists for.
 */
export async function getVelocityCandidates(cap: number): Promise<readonly string[]> {
  if (cap <= 0) return [];
  const accelerating = await getTopAcceleratingNewborns({ limit: cap });
  return accelerating.map((a) => a.appId);
}

/**
 * Registry rows (`appstore_app_meta`, Stage 2) sourced from a chart/intl-
 * chart/discovery sighting whose (Lookup-API-reported) `release_date` makes
 * them a newborn — build plan §0.1's chart-newborn weekly cohort. Excludes
 * delisted rows (nothing to harvest reviews for). `release_date` is
 * defensively pre-filtered with a `~` regex before the `::timestamptz` cast
 * — the Lookup API's date field is best-effort (see `app-lookup.ts`'s
 * defensive zod schema), so a single malformed value must not fail the cast
 * for the whole query.
 */
export async function getChartNewbornCandidates(cap: number): Promise<readonly string[]> {
  const limit = Math.max(0, Math.floor(cap));
  if (limit === 0) return [];
  const db = getDb();
  // NOTE: `\\d` (not `\d`) — inside a JS/TS template literal, `\d` is not a
  // recognized escape sequence, so the JS engine silently drops the
  // backslash (`` `\d` `` evaluates to the 1-character string `"d"`),
  // producing a regex that matches nothing rather than a syntax error. The
  // doubled backslash is required to get a literal `\d` into the SQL text.
  const rows = await db`
    SELECT id FROM appstore_app_meta
    WHERE first_seen_source IN ('chart', 'chart-intl', 'discovery')
      AND delisted_at IS NULL
      AND release_date ~ '^\\d{4}-\\d{2}-\\d{2}'
      AND (release_date)::timestamptz >= (now() - (${NEWBORN_AGE_DAYS_MAX} || ' days')::interval)
    LIMIT ${limit}
  `;
  return (rows as ReadonlyArray<{ id: string }>).map((r) => r.id);
}

// ---------------------------------------------------------------------------
// Ledger — backs `appstoreReviewHarvest.dailyRequestBudget`'s rolling-24h
// check, mirroring `appstore_lookup_requests`' role for the enrichment lane.
// ---------------------------------------------------------------------------

/** Rolling-24h page-fetch count (1 page = 1 HTTP request), summed across every harvest ledger row since `sinceEpochSeconds`. */
export async function countReviewPagesFetchedSince(sinceEpochSeconds: number): Promise<number> {
  const db = getDb();
  const rows = await db`
    SELECT COALESCE(SUM(pages_fetched), 0)::int AS total
    FROM appstore_review_harvests
    WHERE harvested_at >= ${sinceEpochSeconds}
  `;
  return Number((rows as ReadonlyArray<{ total: number }>)[0]?.total ?? 0);
}

/** Deletes ledger rows older than `olderThanEpochSeconds`. Returns the count deleted. */
export async function pruneReviewHarvestLedger(olderThanEpochSeconds: number): Promise<number> {
  const db = getDb();
  const rows = await db`
    DELETE FROM appstore_review_harvests WHERE harvested_at < ${olderThanEpochSeconds} RETURNING id
  `;
  return (rows as ReadonlyArray<{ id: number }>).length;
}
