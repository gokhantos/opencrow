// Orchestration for the newborn re-observation lane (throughput wave
// 2026-07-21, item 2 — audit NEXT item F): a DAILY pass that re-observes
// EVERY app ever recorded in `appstore_app_velocity` (the newborn-velocity
// population, apps < `maxAgeDays` — see `app-velocity.ts`'s
// `NEWBORN_AGE_DAYS_MAX`) via the SAME batched `/lookup` client
// `app-lookup.ts` already provides for `app-enrichment.ts`, writing a fresh
// `appstore_app_velocity` observation per app.
//
// Why this lane exists: before it, a newborn app only got a fresh
// time-series point when a keyword-gap SERP scan happened to surface it in
// its top-N results that cycle — an "accidental sighting". Most newborns
// went days between sightings, or never got a second observation at all,
// so `appstore_app_velocity`'s acceleration math (`app-velocity.ts`'s
// `computeAcceleration`) was starved of data for the very population it
// exists to track. This lane instead deliberately re-observes the WHOLE
// population daily via `/lookup` (reviews + rating come back on every
// lookup result) — `rank` is always `null` for these rows (a lookup has no
// SERP position), mirroring `app-enrichment.ts`'s existing
// `"chart-first-seen"` synthetic-observation hook.
//
// MANDATORY wall-clock pass-deadline guard (`pass-deadline.ts`): this lane
// runs a single sequential loop over ~225 batches (at the default
// `batchSize` of 200, covering a ~45k-app population) on the SAME shared
// `keywordSweepTick` single-flight guard every other deep-scrape lane rides
// (see `scraper.ts`) — exactly the shape that wedged every other lane on
// that tick for 95+ minutes before PR #327 added `isPassOverBudget` to the
// other lanes (2026-07-21 incident, see `pass-deadline.ts`'s doc comment).
// This NEW lane must not reintroduce that failure mode, so it uses the
// SAME `MAX_PASS_DURATION_MS` + `isPassOverBudget` bail as
// `app-enrichment.ts`'s `runEnrichmentPass`/`runPortfolioPass`.

import { getErrorMessage } from "../../lib/error-serialization";
import { createLogger } from "../../logger";
import { isPassOverBudget } from "../shared/pass-deadline";
import { RateLimitError } from "../shared/ssrf-safe-fetch";
import { chunkIds, fetchLookupBatch, type LookupApp } from "./app-lookup";
import { ageDaysFromReleaseDate } from "./app-meta-types";
import { isNewborn } from "./app-velocity";
import { getNewbornVelocityAppIds, insertObservation } from "./app-velocity-store";

const log = createLogger("appstore:newborn-reobservation");

// Mirrors `app-enrichment.ts`'s `MAX_CONSECUTIVE_FAILURES` — same "upstream
// looks wedged, stop burning the rest of the pass" rationale, applied here
// at the batch (not per-app) granularity.
const MAX_CONSECUTIVE_FAILURES = 5;

// Wall-clock budget for one pass — see `pass-deadline.ts`'s doc comment and
// this module's own doc comment above (2026-07-21 PR #327 incident).
const MAX_PASS_DURATION_MS = 5 * 60_000;

/** Keyword tag for a lookup-sourced re-observation row — mirrors `app-enrichment.ts`'s `CHART_FIRST_SEEN_KEYWORD`. */
export const NEWBORN_REOBSERVATION_KEYWORD = "newborn-reobservation";

/**
 * True iff `err` is (or carries the code of) `RateLimitError` — mirrors
 * `app-enrichment.ts`'s `isRateLimitError` (same dual `instanceof` + `.code`
 * check, same rationale: works even across a mocked module boundary).
 */
function isRateLimitError(err: unknown): boolean {
  if (RateLimitError && err instanceof RateLimitError) return true;
  return (err as { code?: unknown } | null)?.code === "RATE_LIMITED";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface NewbornReobservationPassResult {
  /** Total distinct apps ever recorded in `appstore_app_velocity`, before age filtering. */
  readonly candidateCount: number;
  /** Subset still younger than `maxAgeDays` per the pre-filter — what actually got queued for lookup. */
  readonly stillNewbornCount: number;
  /** Observations actually inserted (bucket-deduped by `insertObservation` — see `app-velocity.ts`'s `isObservationDue`). */
  readonly observed: number;
  /** Ids absent from their batch's lookup results (delisted, or a transient miss). */
  readonly missing: number;
  /** Ids present in results but dropped because the FRESH lookup-reported release date shows they've aged out since the pre-filter ran. */
  readonly agedOut: number;
  readonly attempted: number; // batches attempted, not ids
  readonly rateLimitErrors: number;
  readonly bailed: boolean;
  readonly skipped: boolean;
}

const SKIPPED_RESULT: NewbornReobservationPassResult = {
  candidateCount: 0,
  stillNewbornCount: 0,
  observed: 0,
  missing: 0,
  agedOut: 0,
  attempted: 0,
  rateLimitErrors: 0,
  bailed: false,
  skipped: true,
};

/**
 * One newborn re-observation pass: reads the whole `appstore_app_velocity`
 * population (`getNewbornVelocityAppIds`), drops apps CONFIDENTLY aged past
 * `maxAgeDays` per the app-meta registry's `release_date` (an app with no
 * known release date yet is kept — genuinely unknown age, and the lookup
 * call below will resolve it), batches the rest via `chunkIds`/
 * `fetchLookupBatch` (`app-lookup.ts`, the SAME client `app-enrichment.ts`
 * uses), and for every batch result re-checks newborn status against the
 * FRESH lookup-reported release date (authoritative — the pre-filter's
 * app-meta data can be stale or absent) before recording an observation via
 * `app-velocity-store.ts`'s `insertObservation` (`rank: null` — no SERP
 * position on a lookup-sourced row).
 */
export async function runNewbornReobservationPass(opts: {
  readonly batchSize: number;
  readonly maxAgeDays: number;
  readonly delayMs: number;
  readonly useProxy?: boolean;
}): Promise<NewbornReobservationPassResult> {
  if (opts.batchSize <= 0) return SKIPPED_RESULT;

  const population = await getNewbornVelocityAppIds();
  const nowSeconds = Math.floor(Date.now() / 1000);

  const stillNewborn = population.filter((p) => {
    if (p.releaseDate === null) return true; // unknown age — keep, resolved by this pass's lookup
    const ageDays = ageDaysFromReleaseDate(p.releaseDate, nowSeconds);
    return ageDays === null || ageDays < opts.maxAgeDays;
  });

  const ids = stillNewborn.map((p) => p.appId);
  const batches = chunkIds(ids, opts.batchSize);

  let observed = 0;
  let missing = 0;
  let agedOut = 0;
  let attempted = 0;
  let rateLimitErrors = 0;
  let consecutiveFailures = 0;
  let bailed = false;
  const passStartedAt = Date.now();

  for (const batch of batches) {
    if (isPassOverBudget(passStartedAt, MAX_PASS_DURATION_MS)) {
      bailed = true;
      log.warn("Newborn re-observation pass bailing early — exceeded wall-clock budget", {
        elapsedMs: Date.now() - passStartedAt,
        attempted,
        totalBatches: batches.length,
      });
      break;
    }
    attempted++;

    let results: readonly LookupApp[];
    try {
      results = await fetchLookupBatch(batch, opts.useProxy ?? false);
      consecutiveFailures = 0;
    } catch (err) {
      if (isRateLimitError(err)) rateLimitErrors++;
      consecutiveFailures++;
      log.warn("Newborn re-observation lookup batch failed — skipping", {
        batchSize: batch.length,
        error: getErrorMessage(err),
      });
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        bailed = true;
        log.warn("Newborn re-observation pass bailing early — too many consecutive failures", {
          consecutiveFailures,
        });
        break;
      }
      if (opts.delayMs > 0) await sleep(opts.delayMs);
      continue;
    }

    const foundById = new Map(results.map((r) => [r.id, r] as const));
    const observedAt = Math.floor(Date.now() / 1000);

    for (const id of batch) {
      const result = foundById.get(id);
      if (!result) {
        missing++;
        continue;
      }

      const ageDays = ageDaysFromReleaseDate(result.releaseDate, observedAt);
      if (ageDays !== null && !isNewborn(ageDays)) {
        agedOut++;
        continue;
      }

      try {
        const inserted = await insertObservation({
          appId: id,
          observedAt,
          reviews: result.reviews,
          rating: result.rating,
          keyword: NEWBORN_REOBSERVATION_KEYWORD,
          name: result.name,
          rank: null,
        });
        if (inserted) observed++;
      } catch (err) {
        log.warn("Newborn re-observation write failed for id — skipping", {
          id,
          error: getErrorMessage(err),
        });
      }
    }

    if (opts.delayMs > 0) await sleep(opts.delayMs);
  }

  return {
    candidateCount: population.length,
    stillNewbornCount: stillNewborn.length,
    observed,
    missing,
    agedOut,
    attempted,
    rateLimitErrors,
    bailed,
    skipped: false,
  };
}
