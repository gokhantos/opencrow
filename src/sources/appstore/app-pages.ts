// Orchestration for the `apps.apple.com` product-page HTML lane (deep-scrape
// build Stage 5): budget check -> due-selection (`app-pages-store.ts`) ->
// fetch (`ssrfSafeFetch`) -> parse (`app-page-parse.ts`) -> persist. Mirrors
// `review-harvester.ts`'s shape — per-item try/catch, a 5-consecutive-
// failure batch bail, and counts (`attempted`/`rateLimitErrors`) the caller
// (`scraper.ts`) folds into the ONE shared `sweepThrottleState` — but never
// throws itself, so `scraper.ts`'s `runAppPageEnrichmentIfDue` stays a thin
// cadence/config gate. `syncTrackedAppPages` (hot/rolling tier membership)
// is exposed as a SEPARATE pass (`runAppPageSyncPass`) with its own cadence,
// mirroring `review-harvester.ts`'s cohort-refresh split from its harvest
// pass — `scraper.ts` gates each independently, same pattern as
// `lastReviewCohortRefreshRunAt` / `lastReviewHarvestRunAt`.

import { createLogger } from "../../logger";
import { getErrorMessage } from "../../lib/error-serialization";
import { RateLimitError, ssrfSafeFetch } from "../shared/ssrf-safe-fetch";
import { AppPageParseError, buildAppPageUrl, parseAppPage } from "./app-page-parse";
import {
  countPageFetchesSince,
  getDueAppPages,
  recordPageFailure,
  recordPageGone,
  recordPageSuccess,
  syncTrackedAppPages,
  type SyncTrackedAppPagesResult,
} from "./app-pages-store";

const log = createLogger("appstore:app-pages");

// Mirrors `review-harvester.ts`'s `MAX_CONSECUTIVE_FAILURES` — the same
// "upstream looks wedged, stop burning the rest of the pass" rationale.
const MAX_CONSECUTIVE_FAILURES = 5;

const USER_AGENT = "OpenCrow/1.0 (App Store Scraper)";

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

// ---------------------------------------------------------------------------
// Sync pass — thin wrapper, own cadence in scraper.ts.
// ---------------------------------------------------------------------------

/** Thin wrapper over `app-pages-store.ts`'s `syncTrackedAppPages`. */
export async function runAppPageSyncPass(opts: {
  readonly hotSignatureHitCap: number;
  readonly hotVelocityCap: number;
  readonly rollingAddPerSync: number;
}): Promise<SyncTrackedAppPagesResult> {
  return syncTrackedAppPages(opts);
}

// ---------------------------------------------------------------------------
// Fetch pass
// ---------------------------------------------------------------------------

export interface AppPageFetchPassResult {
  readonly attempted: number; // fetch attempts (apps)
  readonly succeeded: number; // fetched + parsed + persisted OK
  readonly gone: number; // verified 404
  readonly failed: number; // network/HTTP error OR parse error
  readonly parseFailed: number; // subset of `failed`: a 200 response that failed to parse
  readonly rateLimitErrors: number;
  readonly bailed: boolean;
  readonly skipped: boolean;
  /**
   * True iff this pass's parse-failure rate exceeded the canary threshold —
   * a strong signal Apple changed the page structure. Already logged as an
   * ALARM (`log.error`) by this function; surfaced on the result too so the
   * caller can fold it into its own summary log.
   */
  readonly canaryTripped: boolean;
}

const SKIPPED_RESULT: AppPageFetchPassResult = {
  attempted: 0,
  succeeded: 0,
  gone: 0,
  failed: 0,
  parseFailed: 0,
  rateLimitErrors: 0,
  bailed: false,
  skipped: true,
  canaryTripped: false,
};

/**
 * One fetch pass: selects due tracked apps (up to `pagesPerBatch`, already
 * throttle-scaled by the caller), and for each, fetches its product page
 * (`ssrfSafeFetch`, following the `/app/id<id>` -> canonical-slug redirect),
 * parses it (`app-page-parse.ts`), and persists the result
 * (`app-pages-store.ts`). Enforces `dailyPageBudget` as a rolling-24h ledger
 * check up front (skips the whole pass, mirroring `runEnrichmentPass`'s
 * `dailyRequestBudget` check).
 *
 * Outcome handling per app:
 *   - HTTP 404 -> `recordPageGone` (permanent; NOT counted toward the
 *     consecutive-failure bail — a delisted app is an expected, not a
 *     wedged-upstream, outcome).
 *   - Network error / non-ok non-404 response / `AppPageParseError` ->
 *     `recordPageFailure` (counts toward the bail).
 *   - Success -> `recordPageSuccess`.
 *
 * Batch canary (build plan §5): if at least `canaryMinBatchSize` apps were
 * attempted AND more than `canaryParseFailureThreshold` of them failed to
 * PARSE (a 200 response `app-page-parse.ts` couldn't make sense of — NOT a
 * network/HTTP failure), logs an ALARM. A parse-failure spike across many
 * DIFFERENT apps in the same pass is the signature of Apple changing the
 * page's JSON shape, not of any one app being broken.
 */
export async function runAppPageFetchPass(opts: {
  readonly pagesPerBatch: number;
  readonly storefront: string;
  readonly requestDelayMs: number;
  readonly dailyPageBudget: number;
  readonly hotIntervalSeconds: number;
  readonly rollingIntervalSeconds: number;
  readonly canaryMinBatchSize: number;
  readonly canaryParseFailureThreshold: number;
}): Promise<AppPageFetchPassResult> {
  if (opts.pagesPerBatch <= 0) return SKIPPED_RESULT;

  const since = Math.floor(Date.now() / 1000) - 86_400;
  const fetchesLast24h = await countPageFetchesSince(since);
  if (fetchesLast24h >= opts.dailyPageBudget) {
    log.debug("App-page fetch pass skipped — rolling 24h page-fetch budget reached", {
      fetchesLast24h,
      dailyPageBudget: opts.dailyPageBudget,
    });
    return SKIPPED_RESULT;
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const due = await getDueAppPages({
    limit: opts.pagesPerBatch,
    nowSeconds,
    hotIntervalSeconds: opts.hotIntervalSeconds,
    rollingIntervalSeconds: opts.rollingIntervalSeconds,
  });

  let succeeded = 0;
  let gone = 0;
  let failed = 0;
  let parseFailed = 0;
  let attempted = 0;
  let rateLimitErrors = 0;
  let consecutiveFailures = 0;
  let bailed = false;

  for (const tracked of due) {
    attempted++;
    const now = Math.floor(Date.now() / 1000);
    const url = buildAppPageUrl(tracked.appId, opts.storefront);

    let res: Response;
    try {
      res = await ssrfSafeFetch(url, {
        retryOnRateLimit: true,
        headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
      });
    } catch (err) {
      if (isRateLimitError(err)) rateLimitErrors++;
      await recordPageFailure(tracked.appId, now).catch((writeErr) =>
        log.warn("Failed to record app-page fetch failure — skipping", { appId: tracked.appId, error: getErrorMessage(writeErr) }),
      );
      failed++;
      consecutiveFailures++;
      log.warn("App-page fetch failed", { appId: tracked.appId, error: getErrorMessage(err) });
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        bailed = true;
        log.warn("App-page fetch pass bailing early — too many consecutive failures", { consecutiveFailures });
        break;
      }
      if (opts.requestDelayMs > 0) await sleep(opts.requestDelayMs);
      continue;
    }

    if (res.status === 404) {
      await recordPageGone(tracked.appId, now).catch((writeErr) =>
        log.warn("Failed to record app-page gone — skipping", { appId: tracked.appId, error: getErrorMessage(writeErr) }),
      );
      gone++;
      consecutiveFailures = 0; // a delisted app is expected, not a wedged upstream
      if (opts.requestDelayMs > 0) await sleep(opts.requestDelayMs);
      continue;
    }

    if (!res.ok) {
      await recordPageFailure(tracked.appId, now).catch((writeErr) =>
        log.warn("Failed to record app-page fetch failure — skipping", { appId: tracked.appId, error: getErrorMessage(writeErr) }),
      );
      failed++;
      consecutiveFailures++;
      log.warn("App-page fetch returned non-ok", { appId: tracked.appId, status: res.status });
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        bailed = true;
        log.warn("App-page fetch pass bailing early — too many consecutive failures", { consecutiveFailures });
        break;
      }
      if (opts.requestDelayMs > 0) await sleep(opts.requestDelayMs);
      continue;
    }

    try {
      const html = await res.text();
      const parsed = parseAppPage(html, tracked.appId);
      await recordPageSuccess(tracked.appId, now, parsed);
      succeeded++;
      consecutiveFailures = 0;
    } catch (err) {
      if (err instanceof AppPageParseError) {
        parseFailed++;
        log.warn("App-page parse failed", { appId: tracked.appId, reason: err.reason, error: err.message });
      } else {
        log.warn("App-page fetch/persist failed after a 200 response", { appId: tracked.appId, error: getErrorMessage(err) });
      }
      await recordPageFailure(tracked.appId, now).catch((writeErr) =>
        log.warn("Failed to record app-page failure — skipping", { appId: tracked.appId, error: getErrorMessage(writeErr) }),
      );
      failed++;
      consecutiveFailures++;
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        bailed = true;
        log.warn("App-page fetch pass bailing early — too many consecutive failures", { consecutiveFailures });
        break;
      }
    }

    if (opts.requestDelayMs > 0) await sleep(opts.requestDelayMs);
  }

  const canaryTripped =
    attempted >= opts.canaryMinBatchSize && parseFailed / attempted > opts.canaryParseFailureThreshold;
  if (canaryTripped) {
    log.error(
      "ALARM: app-page parse failure rate exceeded the canary threshold this pass — Apple may have changed the product-page structure",
      { attempted, parseFailed, threshold: opts.canaryParseFailureThreshold },
    );
  }

  return { attempted, succeeded, gone, failed, parseFailed, rateLimitErrors, bailed, skipped: false, canaryTripped };
}
