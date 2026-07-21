// Orchestration for the App Store app-meta registry's Lookup-API enrichment
// (deep-scrape build Stage 2): drains `appstore_app_meta` rows via
// `app-lookup.ts`'s batched `/lookup` client, writing results back through
// `app-meta-store.ts`. Mirrors `keyword-gaps.ts`'s `scanAndRecord` shape —
// per-item try/catch, a 5-consecutive-failure batch bail, and counts
// (`attempted`/`rateLimitErrors`) the caller (`scraper.ts`) folds into the
// ONE shared `sweepThrottleState` — but never throws itself, so scraper.ts's
// `runAppEnrichmentIfDue` stays a thin cadence/config gate.

import { createLogger } from "../../logger";
import { RateLimitError } from "../shared/ssrf-safe-fetch";
import { chunkIds, fetchArtistPortfolio, fetchLookupBatch } from "./app-lookup";
import type { LookupApp } from "./app-lookup";
import { ageDaysFromReleaseDate } from "./app-meta-types";
import {
  backfillRegistry,
  claimForEnrichment,
  countLookupRequestsSince,
  getAppMetaBatch,
  pruneLookupRequestLedger,
  recordAppSightings,
  recordEnrichmentMiss,
  recordLookupRequest,
  selectDueForEnrichment,
  upsertLookupResult,
} from "./app-meta-store";
import { isNewborn } from "./app-velocity";
import { getTopAcceleratingNewborns, insertObservation } from "./app-velocity-store";
import { getDevelopersDueForPortfolioScan, markPortfolioScanned, upsertDeveloper } from "./developer-store";

const log = createLogger("appstore:app-enrichment");

// Mirrors `keyword-gaps.ts`'s `MAX_CONSECUTIVE_FAILURES` — the same
// "upstream looks wedged, stop burning the rest of the pass" rationale,
// applied here at the batch (not per-keyword) granularity.
const MAX_CONSECUTIVE_FAILURES = 5;

/** Keyword tag for the chart-newborn synthetic velocity observation (build plan §0.1). */
export const CHART_FIRST_SEEN_KEYWORD = "chart-first-seen";

/**
 * Scales `maxBatchesPerPass` by the shared adaptive-throttle multiplier —
 * mirrors `sweep-throttle.ts`'s `computeEffectiveSweepRate` (a rate-limit
 * spike in ANY lane backs off every lane via the same shared multiplier, see
 * `scraper.ts`'s `sweepThrottleState`). Floored and clamped to >= 0: a
 * fully-throttled pass (multiplier -> 0) skips the enrichment pass entirely
 * for this cycle rather than going negative. Pure — no I/O.
 */
export function computeEffectiveMaxBatches(maxBatchesPerPass: number, throttleMultiplier: number): number {
  return Math.max(0, Math.floor(maxBatchesPerPass * throttleMultiplier));
}

/** Sources whose enriched apps are eligible for the chart-newborn velocity hook. */
const CHART_SOURCED = new Set(["chart", "chart-intl", "discovery"]);

/**
 * True iff `err` is (or carries the code of) `RateLimitError` — mirrors
 * `keyword-gaps.ts`'s `isRateLimitError` (same dual `instanceof` + `.code`
 * check, same rationale: works even across a mocked module boundary).
 */
function isRateLimitError(err: unknown): boolean {
  if (RateLimitError && err instanceof RateLimitError) return true;
  return (err as { code?: unknown } | null)?.code === "RATE_LIMITED";
}

export interface EnrichmentPassResult {
  readonly enrichedCount: number;
  readonly missCount: number;
  readonly delistedCount: number;
  readonly relistedCount: number;
  readonly chartNewbornVelocityCount: number;
  readonly attempted: number; // batches attempted, not ids
  readonly rateLimitErrors: number;
  readonly bailed: boolean;
  readonly skipped: boolean;
}

const SKIPPED_RESULT: EnrichmentPassResult = {
  enrichedCount: 0,
  missCount: 0,
  delistedCount: 0,
  relistedCount: 0,
  chartNewbornVelocityCount: 0,
  attempted: 0,
  rateLimitErrors: 0,
  bailed: false,
  skipped: true,
};

/**
 * One Lookup-API enrichment pass: selects due ids (never-enriched first,
 * then stale, with currently-accelerating newborns prioritized — see
 * `app-meta-store.ts`'s `selectDueForEnrichment`), fetches them in batches
 * of `batchSize` (up to `maxBatches` batches this pass), and writes results
 * back. Enforces `dailyRequestBudget` as a rolling-24h ledger check up
 * front (skips the whole pass, mirroring `runKeywordSweep`'s
 * `dailyKeywordBudget` check) — NOT re-checked mid-pass, since `maxBatches`
 * already bounds a single pass's spend well under the budget.
 *
 * Chart-newborn velocity hook (build plan §0.1): after a successful
 * enrichment, if the app's `first_seen_source` is chart/chart-intl/discovery
 * AND its (lookup-reported) release date makes it a newborn, records one
 * `"chart-first-seen"` velocity observation (`rank: null`) via
 * `app-velocity-store.ts`'s `insertObservation` — which already bucket-dedupes
 * to at most one row per app per ~6h, so calling this on every enrichment
 * pass (not just the first-ever) is safe and keeps the series alive for as
 * long as the app remains a newborn.
 */
export async function runEnrichmentPass(opts: {
  readonly batchSize: number;
  readonly maxBatches: number;
  readonly staleAfterSeconds: number;
  readonly acceleratingLimit: number;
  readonly dailyRequestBudget: number;
  readonly delistMissThreshold: number;
}): Promise<EnrichmentPassResult> {
  if (opts.maxBatches <= 0) return SKIPPED_RESULT;

  const since = Math.floor(Date.now() / 1000) - 86_400;
  const requestsLast24h = await countLookupRequestsSince(since);
  if (requestsLast24h >= opts.dailyRequestBudget) {
    log.debug("App enrichment pass skipped — rolling 24h request budget reached", {
      requestsLast24h,
      dailyRequestBudget: opts.dailyRequestBudget,
    });
    return SKIPPED_RESULT;
  }

  const accelerating = await getTopAcceleratingNewborns({ limit: opts.acceleratingLimit }).catch(
    (err) => {
      log.warn("Failed to fetch accelerating newborns for enrichment priority — continuing without", {
        error: err,
      });
      return [];
    },
  );

  const dueIds = await selectDueForEnrichment({
    limit: opts.batchSize * opts.maxBatches,
    staleAfterSeconds: opts.staleAfterSeconds,
    acceleratingIds: accelerating.map((a) => a.appId),
  });

  const batches = chunkIds(dueIds, opts.batchSize).slice(0, opts.maxBatches);

  let enrichedCount = 0;
  let missCount = 0;
  let delistedCount = 0;
  let relistedCount = 0;
  let chartNewbornVelocityCount = 0;
  let attempted = 0;
  let rateLimitErrors = 0;
  let consecutiveFailures = 0;
  let bailed = false;

  for (const batch of batches) {
    attempted++;
    const now = Math.floor(Date.now() / 1000);
    const previousMap = await getAppMetaBatch(batch);
    await claimForEnrichment(batch, now);

    let results: readonly LookupApp[];
    try {
      results = await fetchLookupBatch(batch);
      await recordLookupRequest("lookup", batch.length, true, now);
      consecutiveFailures = 0;
    } catch (err) {
      await recordLookupRequest("lookup", batch.length, false, now).catch(() => {});
      if (isRateLimitError(err)) rateLimitErrors++;
      consecutiveFailures++;
      log.warn("Lookup batch failed — skipping", { batchSize: batch.length, error: err });
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        bailed = true;
        log.warn("App enrichment pass bailing early — too many consecutive failures", {
          consecutiveFailures,
        });
        break;
      }
      continue;
    }

    const foundById = new Map(results.map((r) => [r.id, r] as const));

    for (const id of batch) {
      const previous = previousMap.get(id) ?? null;
      const result = foundById.get(id);
      try {
        if (result) {
          const relistedBefore = previous?.delistedAt !== null && previous?.delistedAt !== undefined;
          const events = await upsertLookupResult(id, result, now, previous);
          enrichedCount++;
          if (relistedBefore) relistedCount++;
          if (events.some((e) => e.eventType === "relisted")) relistedCount++;

          if (result.artistId) {
            await upsertDeveloper({ artistId: result.artistId, name: result.artistName }, now).catch(
              (err) => log.warn("Developer upsert failed — skipping", { artistId: result.artistId, error: err }),
            );
          }

          if (previous && CHART_SOURCED.has(previous.firstSeenSource)) {
            const ageDays = ageDaysFromReleaseDate(result.releaseDate, now);
            if (ageDays !== null && isNewborn(ageDays)) {
              const inserted = await insertObservation({
                appId: id,
                observedAt: now,
                reviews: result.reviews,
                rating: result.rating,
                keyword: CHART_FIRST_SEEN_KEYWORD,
                name: result.name,
                rank: null,
              });
              if (inserted) chartNewbornVelocityCount++;
            }
          }
        } else {
          const { delisted } = await recordEnrichmentMiss(id, now, previous, opts.delistMissThreshold);
          missCount++;
          if (delisted) delistedCount++;
        }
      } catch (err) {
        log.warn("App enrichment write failed for id — skipping", { id, error: err });
      }
    }
  }

  return {
    enrichedCount,
    missCount,
    delistedCount,
    relistedCount,
    chartNewbornVelocityCount,
    attempted,
    rateLimitErrors,
    bailed,
    skipped: false,
  };
}

export interface PortfolioPassResult {
  readonly developersScanned: number;
  readonly newSightings: number;
  readonly attempted: number;
  readonly rateLimitErrors: number;
  readonly bailed: boolean;
}

const EMPTY_PORTFOLIO_RESULT: PortfolioPassResult = {
  developersScanned: 0,
  newSightings: 0,
  attempted: 0,
  rateLimitErrors: 0,
  bailed: false,
};

/**
 * One developer-portfolio pass: for each due developer (see
 * `developer-store.ts`'s `getDevelopersDueForPortfolioScan`), fetches their
 * full software portfolio and records every app as a `'portfolio'` sighting
 * — new-to-the-registry sibling apps get queued for their own future
 * enrichment via the normal `selectDueForEnrichment` path, not enriched
 * inline here.
 */
export async function runPortfolioPass(opts: {
  readonly developerLimit: number;
  readonly portfolioLimit: number;
  readonly minIntervalSeconds: number;
}): Promise<PortfolioPassResult> {
  if (opts.developerLimit <= 0) return EMPTY_PORTFOLIO_RESULT;

  const artistIds = await getDevelopersDueForPortfolioScan({
    limit: opts.developerLimit,
    minIntervalSeconds: opts.minIntervalSeconds,
  });

  let developersScanned = 0;
  let newSightings = 0;
  let attempted = 0;
  let rateLimitErrors = 0;
  let consecutiveFailures = 0;
  let bailed = false;

  for (const artistId of artistIds) {
    attempted++;
    const now = Math.floor(Date.now() / 1000);
    try {
      const portfolio = await fetchArtistPortfolio(artistId, opts.portfolioLimit);
      await recordLookupRequest("portfolio", 1, true, now);

      const sightings = portfolio.filter((p) => p.id).map((p) => ({ id: p.id, name: p.name }));
      newSightings += await recordAppSightings(sightings, "portfolio");
      await markPortfolioScanned(artistId, portfolio.length, now);
      developersScanned++;
      consecutiveFailures = 0;
    } catch (err) {
      await recordLookupRequest("portfolio", 1, false, now).catch(() => {});
      if (isRateLimitError(err)) rateLimitErrors++;
      consecutiveFailures++;
      log.warn("Portfolio fetch failed — skipping developer", { artistId, error: err });
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        bailed = true;
        log.warn("Portfolio pass bailing early — too many consecutive failures", {
          consecutiveFailures,
        });
        break;
      }
    }
  }

  return { developersScanned, newSightings, attempted, rateLimitErrors, bailed };
}

/**
 * Thin wrapper over `app-meta-store.ts`'s `backfillRegistry()` — the
 * one-shot process-lifetime GATE (a boolean flag, mirroring
 * `scraper.ts`'s `minedBackfillDone`/`runMinedBackfillOnce`) lives in
 * `scraper.ts`, not here; this function is the idempotent unit of work
 * that gate calls exactly once per process.
 */
export async function runRegistryBackfillOnce(): Promise<{ readonly inserted: number }> {
  const inserted = await backfillRegistry();
  return { inserted };
}

/** Thin wrapper over `app-meta-store.ts`'s `pruneLookupRequestLedger`. */
export async function runLookupLedgerPrune(maxAgeSeconds: number): Promise<{ readonly pruned: number }> {
  const cutoff = Math.floor(Date.now() / 1000) - Math.max(0, maxAgeSeconds);
  const pruned = await pruneLookupRequestLedger(cutoff);
  return { pruned };
}
