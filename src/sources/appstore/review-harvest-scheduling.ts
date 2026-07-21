// Pure logic for the review-text harvester's cohort/cadence/stop-condition
// decisions (deep-scrape build Stage 4). No I/O, no Date.now() — every input
// is a plain value the caller already read from the DB or a fetched feed
// page, so this is exhaustively unit-testable with injected timestamps.
// Split from `review-harvest-store.ts` the same way `app-velocity.ts` is
// split from `app-velocity-store.ts` / `app-meta-types.ts` from
// `app-meta-store.ts`.

import { MAX_REVIEW_PAGES, REVIEW_PAGE_SIZE } from "./review-rss";
import type { AppReviewRow } from "./store";

/** Why an app is enrolled in the review harvester — matches migration 047's `enrolled_via` CHECK. */
export type ReviewHarvestEnrollmentReason = "signature-hit" | "velocity" | "chart-newborn";

export const REVIEW_HARVEST_ENROLLMENT_REASONS: readonly ReviewHarvestEnrollmentReason[] = Object.freeze([
  "signature-hit",
  "velocity",
  "chart-newborn",
]);

/** Harvest cadence tier — matches migration 047's `cohort` CHECK. */
export type ReviewHarvestCohort = "daily" | "weekly";

export const DAILY_INTERVAL_SECONDS = 24 * 60 * 60;
export const WEEKLY_INTERVAL_SECONDS = 7 * 24 * 60 * 60;

/**
 * `signature-hit` and `velocity` enrollment reasons are cadence-worthy of a
 * DAILY harvest (an open opportunity-window keyword's incumbents, or a
 * currently-accelerating newborn, both change fast enough that a week-old
 * review snapshot is stale); `chart-newborn` alone only earns a WEEKLY slot
 * (a newborn merely spotted on a chart/discovery sighting, with no other
 * corroborating signal yet).
 */
const COHORT_BY_REASON: Readonly<Record<ReviewHarvestEnrollmentReason, ReviewHarvestCohort>> = Object.freeze({
  "signature-hit": "daily",
  velocity: "daily",
  "chart-newborn": "weekly",
});

/**
 * Resolves the cohort for a candidate app matched by one or more enrollment
 * reasons in the SAME cohort-refresh pass. "Daily wins": any daily-cadence
 * reason present promotes the whole enrollment to daily, even alongside a
 * chart-newborn match — an app never gets DOWNGRADED to weekly just because
 * chart-newborn also happened to match it. Empty input defaults to weekly
 * (the least aggressive tier) rather than throwing — defensive, though every
 * real caller only ever calls this with at least one matched reason.
 */
export function resolveCohort(reasons: readonly ReviewHarvestEnrollmentReason[]): ReviewHarvestCohort {
  return reasons.some((r) => COHORT_BY_REASON[r] === "daily") ? "daily" : "weekly";
}

/**
 * The next epoch-seconds timestamp a `cohort`-tier enrollment becomes due
 * for harvest, given its last harvest time (`null` = never harvested, due
 * immediately). Pure — the caller supplies `nowSeconds` rather than this
 * reading the clock, and `getDueEnrollments` (review-harvest-store.ts)
 * mirrors this exact interval math in SQL for its due-selection query.
 */
export function computeNextDueAt(cohort: ReviewHarvestCohort, lastHarvestedAt: number | null): number | null {
  if (lastHarvestedAt === null) return null; // "due immediately" — no meaningful next-due timestamp yet
  const interval = cohort === "daily" ? DAILY_INTERVAL_SECONDS : WEEKLY_INTERVAL_SECONDS;
  return lastHarvestedAt + interval;
}

/** True iff a `cohort`-tier enrollment last harvested at `lastHarvestedAt` is due at `nowSeconds`. */
export function isHarvestDue(
  cohort: ReviewHarvestCohort,
  lastHarvestedAt: number | null,
  nowSeconds: number,
): boolean {
  const nextDueAt = computeNextDueAt(cohort, lastHarvestedAt);
  return nextDueAt === null || nextDueAt <= nowSeconds;
}

/**
 * Decides whether to stop paging an app's review feed after the page just
 * fetched. Four conditions, checked in order:
 *
 *   1. `page >= MAX_REVIEW_PAGES` — the feed only ever serves 10 pages
 *      (verified live: page 11 is HTTP 400), so page 10 is always the last
 *      one attempted regardless of its content.
 *   2. `entriesReturned === 0` — nothing left to page through.
 *   3. `entriesReturned < REVIEW_PAGE_SIZE` — a short page IS the last page
 *      (the feed doesn't pad short pages), so there's nothing beyond it.
 *   4. `!isFirstHarvestForApp && allEntriesAlreadyKnown` — "we've caught up
 *      to previously-harvested content" early-stop. Deliberately GATED to
 *      non-first harvests only (the "first-harvest legacy-remnant rule",
 *      build plan Stage 4): on an app's FIRST-ever deep harvest, page 1 may
 *      already be fully known purely because `scraper.ts`'s legacy hourly
 *      path already wrote those exact review ids (it only ever fetches page
 *      1) — that must NOT be read as "everything is already harvested,
 *      stop", since pages 2-10 are still genuinely unfetched. Only a LATER
 *      harvest (one that has already done its own first deep pass) may
 *      trust "a fully-known page means we've reached previously-harvested
 *      territory" and bail early.
 *
 * Pure: the caller (`review-harvester.ts`) determines `allEntriesAlreadyKnown`
 * from `upsertReviews`'s `newIds` result (a page where nothing was newly
 * inserted).
 */
export function shouldStopPaging(opts: {
  readonly page: number; // 1-indexed page just fetched
  readonly entriesReturned: number;
  readonly allEntriesAlreadyKnown: boolean;
  readonly isFirstHarvestForApp: boolean;
}): boolean {
  if (opts.page >= MAX_REVIEW_PAGES) return true;
  if (opts.entriesReturned === 0) return true;
  if (opts.entriesReturned < REVIEW_PAGE_SIZE) return true;
  if (!opts.isFirstHarvestForApp && opts.allEntriesAlreadyKnown) return true;
  return false;
}

/**
 * Decides whether an enrollment should be deactivated after recording a
 * harvest outcome. A delisted app (per the app-meta registry — Stage 2)
 * deactivates immediately regardless of the empty-harvest streak: nothing
 * left to harvest. Otherwise, `maxConsecutiveEmptyHarvests` consecutive
 * passes with zero NEW reviews found means the app has gone quiet — stop
 * burning budget on it every cadence cycle. A quiet app's enrollment isn't
 * deleted, just marked inactive; a fresh cohort-refresh match (build plan:
 * `upsertEnrollment` reactivates on conflict) can re-enroll it later if a
 * new signal (e.g. it re-accelerates) matches it again.
 */
export function shouldDeactivateEnrollment(opts: {
  readonly consecutiveEmptyHarvests: number;
  readonly maxConsecutiveEmptyHarvests: number;
  readonly delisted: boolean;
}): boolean {
  if (opts.delisted) return true;
  return opts.consecutiveEmptyHarvests >= opts.maxConsecutiveEmptyHarvests;
}

/**
 * `memoryIndexing: "low-star-only"` policy (build plan Stage 4): pre-marks
 * 4/5-star review rows as already-indexed (`indexed_at` stamped to `now`)
 * at write time, so they never enter `getUnindexedReviews`'s RAG-indexing
 * queue — the theory being that critical (1-3 star) review text is the more
 * actionable signal, and indexing every 5-star "great app!" scales the
 * embedding/index volume for little benefit. `"all"` (the legacy hourly
 * path's implicit behavior) is a no-op passthrough. Pure, immutable — never
 * mutates `rows`.
 */
export function applyMemoryIndexingPolicy(
  rows: readonly AppReviewRow[],
  policy: "all" | "low-star-only",
  now: number,
): readonly AppReviewRow[] {
  if (policy !== "low-star-only") return rows;
  return rows.map((r) => (r.rating >= 4 ? { ...r, indexed_at: now } : r));
}
