// Orchestration for the review-text harvester (deep-scrape build Stage 4):
// a cohort-refresh sub-pass (`runCohortRefresh`, enrolls/refreshes apps into
// `appstore_review_harvest_state` from three candidate sources) and the main
// harvest pass (`harvestDueApps`, drains due enrollments via `review-rss.ts`'s
// multi-page feed fetch, writing through `store.ts`'s `upsertReviews`).
// Mirrors `app-enrichment.ts`'s shape — per-item try/catch, a
// 5-consecutive-failure batch bail, and counts (`attempted`/`rateLimitErrors`)
// the caller (`scraper.ts`) folds into the ONE shared `sweepThrottleState` —
// but never throws itself, so `scraper.ts`'s `runReviewHarvestIfDue` stays a
// thin cadence/config gate.

import { createLogger } from "../../logger";
import { getErrorMessage } from "../../lib/error-serialization";
import { RateLimitError, ssrfSafeFetch } from "../shared/ssrf-safe-fetch";
import { getAppMeta } from "./app-meta-store";
import {
  applyMemoryIndexingPolicy,
  resolveCohort,
  shouldDeactivateEnrollment,
  shouldStopPaging,
  type ReviewHarvestEnrollmentReason,
} from "./review-harvest-scheduling";
import {
  countReviewPagesFetchedSince,
  deactivateEnrollment,
  getChartNewbornCandidates,
  getDueEnrollments,
  getSignatureHitCandidates,
  getVelocityCandidates,
  pruneReviewHarvestLedger,
  recordHarvestOutcome,
  upsertEnrollment,
} from "./review-harvest-store";
import { buildReviewFeedUrl, MAX_REVIEW_PAGES, parseReviewFeedPage, toAppReviewRow } from "./review-rss";
import { upsertReviews } from "./store";

const log = createLogger("appstore:review-harvester");

// Mirrors `keyword-gaps.ts`'s `MAX_CONSECUTIVE_FAILURES` / `app-enrichment.ts`'s
// own copy — same "upstream looks wedged, stop burning the rest of the pass"
// rationale, applied here at the per-app granularity (an app whose FIRST
// page fetch fails counts; an app that fetched at least one page before a
// later page failed is a partial success, not a failure — see
// `harvestDueApps`'s doc comment).
const MAX_CONSECUTIVE_FAILURES = 5;

/**
 * True iff `err` is (or carries the code of) `RateLimitError` — the dual
 * `instanceof` + `.code` check copied from `keyword-gaps.ts` (build plan
 * §0.4 invariant): works even across a mocked module boundary in tests.
 */
function isRateLimitError(err: unknown): boolean {
  if (RateLimitError && err instanceof RateLimitError) return true;
  return (err as { code?: unknown } | null)?.code === "RATE_LIMITED";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Scales `appsPerTick` by the shared adaptive-throttle multiplier — mirrors
 * `app-enrichment.ts`'s `computeEffectiveMaxBatches`, but with a DIFFERENT
 * floor (build plan §0.4: "appsPerTick × multiplier, floor 1"): a
 * fully-throttled pass still harvests at least 1 app per tick rather than
 * skipping entirely, since (unlike a lookup batch) a single-app review
 * harvest is a small, bounded unit of work. `appsPerTick <= 0` is the
 * explicit "pass disabled" knob (distinct from throttling) and always
 * yields 0, matching `maxBatchesPerPass: 0`'s "0 ⇒ skip" convention
 * elsewhere. Pure — no I/O.
 */
export function computeEffectiveAppsPerTick(appsPerTick: number, throttleMultiplier: number): number {
  if (appsPerTick <= 0) return 0;
  return Math.max(1, Math.floor(appsPerTick * throttleMultiplier));
}

// ---------------------------------------------------------------------------
// Cohort refresh
// ---------------------------------------------------------------------------

export interface CohortRefreshResult {
  readonly candidatesConsidered: number;
  readonly enrolled: number;
  readonly refreshed: number;
}

const EMPTY_COHORT_REFRESH_RESULT: CohortRefreshResult = {
  candidatesConsidered: 0,
  enrolled: 0,
  refreshed: 0,
};

/**
 * One cohort-refresh pass: pulls the three candidate sources (open
 * signature-hit related apps, currently-accelerating newborns, chart-sourced
 * newborns — `review-harvest-store.ts`), merges the enrollment reasons each
 * candidate id matched (a candidate can match more than one source in the
 * SAME pass), resolves each id's cohort via `resolveCohort`'s "daily wins"
 * rule, and upserts the enrollment. A candidate source's own query failure
 * is logged and swallowed (the other two sources still run) — never allowed
 * to break the pass.
 */
export async function runCohortRefresh(opts: {
  readonly signatureHitCap: number;
  readonly velocityCap: number;
  readonly chartNewbornCap: number;
}): Promise<CohortRefreshResult> {
  if (opts.signatureHitCap <= 0 && opts.velocityCap <= 0 && opts.chartNewbornCap <= 0) {
    return EMPTY_COHORT_REFRESH_RESULT;
  }

  const now = Math.floor(Date.now() / 1000);

  const [signatureHitIds, velocityIds, chartNewbornIds] = await Promise.all([
    getSignatureHitCandidates(opts.signatureHitCap).catch((err) => {
      log.warn("Signature-hit candidate query failed — continuing without", { error: getErrorMessage(err) });
      return [] as readonly string[];
    }),
    getVelocityCandidates(opts.velocityCap).catch((err) => {
      log.warn("Velocity candidate query failed — continuing without", { error: getErrorMessage(err) });
      return [] as readonly string[];
    }),
    getChartNewbornCandidates(opts.chartNewbornCap).catch((err) => {
      log.warn("Chart-newborn candidate query failed — continuing without", { error: getErrorMessage(err) });
      return [] as readonly string[];
    }),
  ]);

  const reasonsById = new Map<string, ReviewHarvestEnrollmentReason[]>();
  const addReason = (ids: readonly string[], reason: ReviewHarvestEnrollmentReason): void => {
    for (const id of ids) {
      if (!id) continue;
      const existing = reasonsById.get(id);
      if (existing) {
        existing.push(reason);
      } else {
        reasonsById.set(id, [reason]);
      }
    }
  };
  // Order matters only for the write-once `enrolled_via` column's PRIMARY
  // reason (below) — cohort resolution itself (`resolveCohort`) doesn't
  // care about order.
  addReason(signatureHitIds, "signature-hit");
  addReason(velocityIds, "velocity");
  addReason(chartNewbornIds, "chart-newborn");

  let enrolled = 0;
  let refreshed = 0;
  for (const [appId, reasons] of reasonsById) {
    const cohort = resolveCohort(reasons);
    const primaryReason = reasons[0] ?? "chart-newborn";
    try {
      const { isNew } = await upsertEnrollment({ appId, enrolledVia: primaryReason, cohort, now });
      if (isNew) {
        enrolled++;
      } else {
        refreshed++;
      }
    } catch (err) {
      log.warn("Enrollment upsert failed — skipping candidate", { appId, error: getErrorMessage(err) });
    }
  }

  return { candidatesConsidered: reasonsById.size, enrolled, refreshed };
}

// ---------------------------------------------------------------------------
// Harvest pass
// ---------------------------------------------------------------------------

export interface HarvestPassResult {
  readonly appsHarvested: number;
  readonly pagesFetched: number;
  readonly reviewsFound: number;
  readonly newReviews: number;
  readonly deactivated: number;
  readonly attempted: number; // apps attempted
  readonly rateLimitErrors: number;
  readonly bailed: boolean;
  readonly skipped: boolean;
}

const SKIPPED_HARVEST_RESULT: HarvestPassResult = {
  appsHarvested: 0,
  pagesFetched: 0,
  reviewsFound: 0,
  newReviews: 0,
  deactivated: 0,
  attempted: 0,
  rateLimitErrors: 0,
  bailed: false,
  skipped: true,
};

/**
 * One harvest pass: selects due enrollments (up to `appsPerTick`, already
 * throttle-scaled by the caller via `computeEffectiveAppsPerTick`), and for
 * each, pages through its review feed (1..`MAX_REVIEW_PAGES`) via
 * `review-rss.ts`, writing through `store.ts`'s `upsertReviews`. Enforces
 * `dailyRequestBudget` as a rolling-24h ledger check up front (skips the
 * whole pass, mirroring `runEnrichmentPass`'s `dailyRequestBudget` check).
 *
 * Failure granularity: a page-fetch failure on an app's FIRST page (nothing
 * fetched for it at all this pass) counts as a full item failure toward the
 * 5-consecutive-failure bail. A failure on a LATER page (some pages already
 * fetched successfully) is treated as a graceful early stop for that one
 * app — its outcome is still recorded for the pages it did get, and the
 * consecutive-failure counter is NOT incremented (partial success, not a
 * failure).
 */
export async function harvestDueApps(opts: {
  readonly appsPerTick: number;
  readonly storefront: string;
  readonly pageDelayMs: number;
  readonly dailyRequestBudget: number;
  readonly maxConsecutiveEmptyHarvests: number;
  readonly memoryIndexing: "all" | "low-star-only";
}): Promise<HarvestPassResult> {
  if (opts.appsPerTick <= 0) return SKIPPED_HARVEST_RESULT;

  const since = Math.floor(Date.now() / 1000) - 86_400;
  const pagesFetchedLast24h = await countReviewPagesFetchedSince(since);
  if (pagesFetchedLast24h >= opts.dailyRequestBudget) {
    log.debug("Review harvest pass skipped — rolling 24h page-fetch budget reached", {
      pagesFetchedLast24h,
      dailyRequestBudget: opts.dailyRequestBudget,
    });
    return SKIPPED_HARVEST_RESULT;
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const dueApps = await getDueEnrollments({ limit: opts.appsPerTick, nowSeconds });

  let appsHarvested = 0;
  let totalPagesFetched = 0;
  let totalReviewsFound = 0;
  let totalNewReviews = 0;
  let deactivated = 0;
  let attempted = 0;
  let rateLimitErrors = 0;
  let consecutiveFailures = 0;
  let bailed = false;

  for (const enrollment of dueApps) {
    attempted++;
    const now = Math.floor(Date.now() / 1000);
    let pagesFetched = 0;
    let reviewsFound = 0;
    let newReviewsThisApp = 0;
    let itemFailed = false;

    try {
      const appMeta = await getAppMeta(enrollment.appId).catch(() => null);
      const appName = appMeta?.name ?? "";

      for (let page = 1; page <= MAX_REVIEW_PAGES; page++) {
        const url = buildReviewFeedUrl(enrollment.appId, page, opts.storefront);
        let res: Response;
        try {
          res = await ssrfSafeFetch(url, { retryOnRateLimit: true });
        } catch (err) {
          if (isRateLimitError(err)) rateLimitErrors++;
          if (pagesFetched === 0) itemFailed = true;
          log.warn("Review page fetch failed — stopping this app's pagination", {
            appId: enrollment.appId,
            page,
            error: getErrorMessage(err),
          });
          break;
        }
        if (!res.ok) {
          if (pagesFetched === 0) itemFailed = true;
          log.warn("Review page fetch returned non-ok — stopping this app's pagination", {
            appId: enrollment.appId,
            page,
            status: res.status,
          });
          break;
        }

        const data = await res.json();
        const parsed = parseReviewFeedPage(data);
        const rawRows = parsed.map((p) => toAppReviewRow(p, enrollment.appId, appName, opts.storefront, now));
        const rows = applyMemoryIndexingPolicy(rawRows, opts.memoryIndexing, now);
        const upsertResult = await upsertReviews(rows);

        pagesFetched++;
        reviewsFound += parsed.length;
        newReviewsThisApp += upsertResult.newIds.length;

        const allEntriesAlreadyKnown = parsed.length > 0 && upsertResult.newIds.length === 0;
        const stop = shouldStopPaging({
          page,
          entriesReturned: parsed.length,
          allEntriesAlreadyKnown,
          isFirstHarvestForApp: !enrollment.firstHarvestDone,
        });
        if (stop) break;
        if (opts.pageDelayMs > 0) await sleep(opts.pageDelayMs);
      }
    } catch (err) {
      itemFailed = true;
      log.warn("Review harvest failed for app — skipping", {
        appId: enrollment.appId,
        error: getErrorMessage(err),
      });
    }

    if (itemFailed && pagesFetched === 0) {
      consecutiveFailures++;
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        bailed = true;
        log.warn("Review harvest pass bailing early — too many consecutive failures", {
          consecutiveFailures,
        });
        break;
      }
      continue;
    }

    consecutiveFailures = 0;
    appsHarvested++;
    totalPagesFetched += pagesFetched;
    totalReviewsFound += reviewsFound;
    totalNewReviews += newReviewsThisApp;

    try {
      const outcome = await recordHarvestOutcome({
        appId: enrollment.appId,
        now,
        pagesFetched,
        reviewsFound,
        newReviews: newReviewsThisApp,
      });
      const appMetaAfter = await getAppMeta(enrollment.appId).catch(() => null);
      const delisted = appMetaAfter?.delistedAt !== null && appMetaAfter?.delistedAt !== undefined;
      if (
        shouldDeactivateEnrollment({
          consecutiveEmptyHarvests: outcome.consecutiveEmptyHarvests,
          maxConsecutiveEmptyHarvests: opts.maxConsecutiveEmptyHarvests,
          delisted,
        })
      ) {
        await deactivateEnrollment(enrollment.appId, now);
        deactivated++;
      }
    } catch (err) {
      log.warn("Failed to record harvest outcome — skipping", {
        appId: enrollment.appId,
        error: getErrorMessage(err),
      });
    }
  }

  return {
    appsHarvested,
    pagesFetched: totalPagesFetched,
    reviewsFound: totalReviewsFound,
    newReviews: totalNewReviews,
    deactivated,
    attempted,
    rateLimitErrors,
    bailed,
    skipped: false,
  };
}

/** Thin wrapper over `review-harvest-store.ts`'s `pruneReviewHarvestLedger`. */
export async function runReviewHarvestLedgerPrune(maxAgeSeconds: number): Promise<{ readonly pruned: number }> {
  const cutoff = Math.floor(Date.now() / 1000) - Math.max(0, maxAgeSeconds);
  const pruned = await pruneReviewHarvestLedger(cutoff);
  return { pruned };
}
