import { loadConfig } from "../../config/loader";
import { createLogger } from "../../logger";
import type { MemoryManager, AppReviewForIndex, AppRankingForIndex } from "../../memory/types";
import { runKeywordSweep, runDeStorefrontSweep, runProxyKeywordSweep } from "./keyword-gaps";
import {
  advanceProxyBreaker,
  computeBreakerCooloffMs,
  createSweepPartition,
  INITIAL_PROXY_BREAKER_STATE,
  isProxyBreakerOpen,
} from "./proxy-stream";
import type { ProxyBreakerParams, ProxyBreakerState } from "./proxy-stream";
import { runScreener } from "./keyword-screener";
import { runGapAlerts } from "./gap-alerts";
import { expandCorpus } from "./keyword-autocomplete";
import { mineKeywords } from "./keyword-miner";
import { mineReviewKeywords } from "./keyword-review-miner";
import {
  backfillMinedDeactivation,
  countScansSince,
  pruneAutocompleteHints,
  pruneKeywordScans,
} from "./keyword-store";
import { advanceThrottle, computeEffectiveSweepRate, computeErrorRate, INITIAL_THROTTLE_STATE } from "./sweep-throttle";
import type { ThrottleOutcome, ThrottleState } from "./sweep-throttle";
import {
  runEnrichmentPass,
  runPortfolioPass,
  runRegistryBackfillOnce,
  runLookupLedgerPrune,
  computeEffectiveMaxBatches,
} from "./app-enrichment";
import { recordAppSightings } from "./app-meta-store";
import { runIntlChartsSweep } from "./charts-intl";
import {
  ITUNES_CATEGORIES,
  buildCategoryRankingUrl,
  buildGlobalTopAppsUrl,
  categoryListTypeTag,
  dedupeRankingsByListKey,
  parseTopAppsItunes,
  parseTopAppsV2,
} from "./charts";
import {
  computeEffectiveAppsPerTick,
  harvestDueApps,
  runCohortRefresh,
  runReviewHarvestLedgerPrune,
} from "./review-harvester";
import { buildReviewFeedUrl, parseReviewFeedPage, toAppReviewRow } from "./review-rss";
import { runAppPageFetchPass, runAppPageSyncPass } from "./app-pages";
import { runNewbornReobservationPass } from "./newborn-reobservation";
import {
  upsertRankings,
  upsertReviews,
  getRankings,
  getDiscoveredAppIds,
  getUnindexedReviews,
  markReviewsIndexed,
  getUnindexedRankings,
  markRankingsIndexed,
  type AppRankingRow,
  type AppReviewRow,
  type AppRow,
} from "./store";

import { getErrorMessage } from "../../lib/error-serialization";
import { loadScraperIntervalMs } from "../scraper-config";
import { getAppstoreProxyUrl } from "../shared/appstore-proxy";
import { fetchWithTimeout } from "../shared/fetch-with-timeout";

const log = createLogger("appstore-scraper");

const DEFAULT_INTERVAL_MINUTES = 60;
const REQUEST_TIMEOUT_MS = 20_000;
const REQUEST_DELAY_MS = 2_000; // 2 seconds between API calls
const TOP_APPS_PER_LIST = 5; // fetch reviews for top N from each list/category
const DISCOVERY_LOOKUPS_PER_CYCLE = 3; // discover related apps for N random seeds per cycle
const KEYWORD_MINING_SCAN_LIMIT = 3000; // ranking rows scanned for keyword candidates per cycle

// B2 flatline detector: escalate to log.error once a discovery/scan lane has
// returned nothing across this many CONSECUTIVE non-empty passes (attempted>0
// but zero raw output). Tuned to survive a couple of genuinely-empty passes
// without alerting, while catching a silent endpoint/header break within a
// few passes (the 2026-07-18 header change killed discovery for days — see
// keyword-autocomplete.ts's module doc).
const FLATLINE_STREAK_THRESHOLD = 3;

// Batch D item D1: retention for `appstore_autocomplete_hints` (migration
// 052 raised the table from no-retention to this, now that
// `getHintEvidence` reads it — see `keyword-store.ts`'s
// `pruneAutocompleteHints`) and how often the prune runs. A separate,
// clearly-named lane from `appstoreKeywordGap.dailyKeywordBudget`'s scan
// ledger / any sibling scans-table prune — this one is scoped exclusively to
// the autocomplete hints table.
const AUTOCOMPLETE_HINTS_PRUNE_RETENTION_DAYS = 90;
const AUTOCOMPLETE_HINTS_PRUNE_MIN_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h

const APPSTORE_AGENT_ID = "appstore";

export interface AppStoreScraper {
  start(): void;
  stop(): void;
  scrapeNow(): Promise<ScrapeResult>;
}

interface ScrapeResult {
  ok: boolean;
  rankings?: number;
  reviews?: number;
  error?: string;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url: string, useProxy: boolean = false): Promise<unknown> {
  const proxy = useProxy ? await getAppstoreProxyUrl() : undefined;
  const response = await fetchWithTimeout(
    url,
    {
      headers: {
        "User-Agent": "OpenCrow/1.0 (App Store Scraper)",
        Accept: "application/json",
      },
      ...(proxy ? { proxy } : {}),
    },
    REQUEST_TIMEOUT_MS,
  );

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }

  return response.json();
}

function reviewsToAppReviewsForIndex(
  reviews: readonly AppReviewRow[],
): readonly AppReviewForIndex[] {
  return reviews.map((r) => ({
    id: `appstore-review-${r.id}`,
    appName: r.app_name,
    title: r.title,
    content: r.content,
    rating: r.rating,
    store: "appstore" as const,
    firstSeenAt: r.first_seen_at,
  }));
}

function rankingsToAppRankingsForIndex(
  rankings: readonly AppRow[],
): readonly AppRankingForIndex[] {
  return rankings
    .map((r) => ({
      id: `appstore-ranking-${r.id}`,
      name: r.name,
      artist: r.artist,
      category: r.category,
      price:
        r.price === "0.00000" || r.price === "0" || r.price === "Free"
          ? "Free"
          : "$" + r.price,
      storeUrl: r.store_url,
      description: r.description,
      store: "appstore" as const,
      updatedAt: r.updated_at,
    }));
}

export function createAppStoreScraper(config?: {
  memoryManager?: MemoryManager;
}): AppStoreScraper {
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;
  // Independent timer for the keyword-gap sweep — decoupled from the
  // ~hourly ranking `timer`/`tick` above so it can run on its own, much
  // faster cadence (`appstoreKeywordGap.scanIntervalMs`, default 5 min).
  let keywordSweepTimer: ReturnType<typeof setInterval> | null = null;
  let keywordSweepRunning = false;
  // Independent timer for the ~12 auxiliary keyword-gap lanes (screener,
  // alerts, autocomplete expansion, GB hints, newborn re-observation, DE
  // storefront, mined backfill, intl charts, review harvest, app/app-page
  // enrichment, scans retention) — decoupled from the gap-sweep timer above
  // (throughput fix, 2026-07-23) so a long-running auxiliary chain (all
  // lanes due at once post-restart, ~15-20min) can no longer block the
  // high-value gap-sweep from running on its own ~60s cadence. See
  // `auxiliaryLanesTick`.
  let auxiliaryLanesTimer: ReturnType<typeof setInterval> | null = null;
  let auxiliaryLanesRunning = false;
  // Independent timer for the proxied SECOND scan stream (2026-07-24
  // throughput pass — see `proxy-stream.ts`'s module doc and
  // `keyword-gaps.ts`'s `runProxyKeywordSweep`): a parallel, Webshare-backed
  // sweep over the mined backlog, on its own timer + single-flight lock so
  // it can never block (or be blocked by) the direct gap-sweep tick. Gated
  // per-tick by `appstoreKeywordGap.proxyStream.enabled` (default OFF).
  let proxyStreamTimer: ReturnType<typeof setInterval> | null = null;
  let proxyStreamRunning = false;
  // The proxied stream's OWN adaptive-throttle state — a wholly separate
  // instance from `sweepThrottleState` below (same `sweep-throttle.ts` state
  // machine, same config-driven AIMD step sizes, separate STATE): the
  // proxied stream's 403/429s must never shrink the direct stream's batch,
  // and vice versa — the two request identities (Webshare exits vs the box
  // IP) hit entirely different per-IP ceilings at Apple.
  let proxyThrottleState: ThrottleState = INITIAL_THROTTLE_STATE;
  // Circuit-breaker state for the proxied stream (see `proxy-stream.ts`):
  // process-local like the throttle; a restart resets it, which is harmless
  // (a dead pool re-trips within one small sweep's worth of failures).
  let proxyBreakerState: ProxyBreakerState = INITIAL_PROXY_BREAKER_STATE;
  // Two-stream work-partition registry (see `proxy-stream.ts`'s
  // `createSweepPartition`): guarantees the direct gap-sweep and the proxied
  // stream never scan the same keyword concurrently. Both ticks pass their
  // slot into their sweep call; claims are released when each batch ends.
  const sweepPartition = createSweepPartition();
  // Soft cadence gate for the newborn-velocity screener (`keyword-screener.ts`):
  // process-local, not persisted — a restart simply lets the next due tick run
  // it again, which is harmless (the screener is idempotent and cheap). Keeps
  // a screener run from firing on every keyword-sweep tick (as often as every
  // minute) when config wants it capped to `minRunIntervalMs` (default 6h).
  let lastScreenerRunAt = 0;
  // Soft cadence gate for the new-hit / first-crossing alert digest (Batch
  // F4 — see `runGapAlertsIfDue` below): process-local, same rationale as
  // `lastScreenerRunAt` — gated to its own
  // `appstoreKeywordGap.alerts.minRunIntervalMs` (default 24h) so the digest
  // fires at a sane cadence instead of on every ~1min sweep tick.
  let lastGapAlertsRunAt = 0;
  // Soft cadence gate for autocomplete corpus expansion (see
  // keyword-autocomplete.ts's `expandCorpus`) — process-local, same
  // rationale as `lastScreenerRunAt`: gated to its own
  // `autocompleteExpansion.minIntervalMs` (default 15min) so its network
  // fan-out (one request per seed) doesn't run on every ~1min sweep tick.
  let lastAutocompleteRunAt = 0;
  // Soft cadence gate for the autocomplete-hints ledger prune (Batch D item
  // D1 — see `pruneAutocompleteHints`'s doc comment): process-local, same
  // rationale as `lastAutocompleteRunAt` — default 24h, own lane, separate
  // from any sibling scans-table prune.
  let lastAutocompleteHintsPruneRunAt = 0;
  // Soft cadence gate for the GB hints lane (throughput wave item 3 — see
  // `keyword-autocomplete.ts`'s `expandCorpus` called a second time with
  // `storefront`/`market` swapped to GB), independent of
  // `lastAutocompleteRunAt` above: the two lanes have their own
  // `autocompleteExpansion.gbLane.minIntervalMs` cadence, same rationale as
  // every other lane pair in this file (e.g. `lastDeStorefrontRunAt` vs the
  // US sweep).
  let lastGbHintsRunAt = 0;
  // Soft cadence gate for the newborn re-observation lane (throughput wave
  // item 2, audit NEXT item F — see `newborn-reobservation.ts`'s
  // `runNewbornReobservationPass`): process-local, same rationale as
  // `lastDeStorefrontRunAt` — gated to its own
  // `appstoreNewbornReobservation.minIntervalMs` (default 24h, "a daily
  // pass") so it doesn't re-scan the whole tracked-newborn population on
  // every ~1min sweep tick.
  let lastNewbornReobservationRunAt = 0;
  // Soft cadence gate for the DE storefront lane (2026-07-21 scan-budget
  // retune — see `keyword-gaps.ts`'s `runDeStorefrontSweep`): process-local,
  // same rationale as `lastAutocompleteRunAt` — gated to its own
  // `deStorefrontLane.minIntervalMs` (default 24h, "a daily pass") so it
  // doesn't re-scan the whole tier-1-protected corpus on every ~1min sweep
  // tick.
  let lastDeStorefrontRunAt = 0;
  // Soft cadence gate for the international storefront chart sweep (deep-
  // scrape build Stage 3 — see `charts-intl.ts`'s `runIntlChartsSweep`):
  // process-local, same rationale as `lastDeStorefrontRunAt` — gated to its
  // own `appstoreSync.intlCharts.minIntervalMs` (default 12h) since one pass
  // sweeps every configured storefront's whole category list in one shot.
  let lastIntlChartsRunAt = 0;
  // One-shot guard for the mined-pool deactivation backfill (see
  // `keyword-store.ts`'s `backfillMinedDeactivation`) — runs at most ONCE per
  // process lifetime, off the async sweep tick so it never blocks startup. A
  // restart simply lets it run again, which is harmless: the backfill query
  // itself is idempotent (`active = TRUE` in its WHERE clause), so a second
  // run only ever touches keywords the first run (or the inline per-scan
  // check) hasn't already caught.
  let minedBackfillDone = false;
  // Soft cadence gate for the app-meta registry's Lookup-API enrichment pass
  // (deep-scrape build Stage 2, build plan §0.4 slot 7 — see
  // `runAppEnrichmentIfDue` below): process-local, same rationale as
  // `lastDeStorefrontRunAt` — default 15min so its network fan-out (batched
  // `/lookup` requests) doesn't run on every ~1min sweep tick.
  let lastEnrichmentRunAt = 0;
  // Soft cadence gate for the developer-portfolio sub-pass, decoupled from
  // the enrichment pass's own cadence above (both default 15min but are
  // independently configurable — see `appstoreAppEnrichment.portfolio`).
  let lastPortfolioRunAt = 0;
  // Soft cadence gate for the lookup-request ledger prune (default 24h).
  let lastLedgerPruneRunAt = 0;
  // One-shot guard for the app-meta registry's initial backfill (see
  // `app-meta-store.ts`'s `backfillRegistry`) — same pattern as
  // `minedBackfillDone`: runs at most once per process lifetime, and a
  // restart simply re-runs the (idempotent, `WHERE NOT EXISTS`-guarded) seed.
  let registryBackfillDone = false;
  // Soft cadence gate for the review-text harvester's main harvest pass
  // (deep-scrape build Stage 4, build plan §0.4 slot 6 — see
  // `runReviewHarvestIfDue` below): process-local, same rationale as
  // `lastEnrichmentRunAt` — default 60s (effectively "every tick"), since
  // `getDueEnrollments` itself is the real cadence gate per app (daily/weekly
  // cohort intervals) and this just avoids re-querying it on a sub-60s tick.
  let lastReviewHarvestRunAt = 0;
  // Soft cadence gate for the review harvester's cohort-refresh sub-pass,
  // decoupled from the harvest pass's own cadence above (default 6h — see
  // `appstoreReviewHarvest.cohortRefresh`).
  let lastReviewCohortRefreshRunAt = 0;
  // Soft cadence gate for the review-harvest ledger prune (default 24h).
  let lastReviewLedgerPruneRunAt = 0;
  // Soft cadence gate for the Batch C4 review-complaint keyword-mining
  // sub-pass (see `corpusDiscovery.reviewMining` in src/config/schema.ts —
  // default OFF), decoupled from the harvest pass's own cadence above; rides
  // the same review-harvest tick, no new timer.
  let lastReviewMiningRunAt = 0;
  // Soft cadence gate for the app-page HTML lane's fetch pass (deep-scrape
  // build Stage 5, build plan §0.4 slot 8 — see `runAppPageEnrichmentIfDue`
  // below): process-local, same rationale as `lastEnrichmentRunAt` — default
  // 5min so this lane's heaviest-per-request fetches (~0.6-1MB HTML each)
  // don't run on every ~1min sweep tick.
  let lastAppPagesFetchRunAt = 0;
  // Soft cadence gate for the app-page lane's hot/rolling tier-sync sub-pass,
  // decoupled from the fetch pass's own cadence above (default 6h — see
  // `appstoreAppPages.sync`). Pure DB reads/writes, no network.
  let lastAppPagesSyncRunAt = 0;
  // Adaptive-throttle state for the keyword-gap sweep's scan rate (see
  // sweep-throttle.ts) — process-local like `lastScreenerRunAt` above; a
  // restart resets to full rate, which is harmless (the state machine
  // re-detects a real problem within one sweep).
  // Throttle ownership (throughput fix, 2026-07-23 — independent-tick
  // decouple): OWNED EXCLUSIVELY by the gap-sweep tick (`keywordSweepTick`)
  // now. The auxiliary lanes (autocomplete expansion, GB hints, etc.) used
  // to feed this same throttle, but now that the gap-sweep and the
  // auxiliary lanes run on separate timers under separate single-flight
  // locks (`keywordSweepRunning` / `auxiliaryLanesRunning`), a shared writer
  // would race the gap-sweep's own reset/read of `tickThrottle` below. The
  // gap-sweep is >95% of Apple request volume anyway, so it now drives this
  // throttle from its own errors only; the auxiliary lanes self-protect via
  // `ssrfSafeFetch`'s `retryOnRateLimit` backoff instead of the shared AIMD
  // multiplier.
  let sweepThrottleState: ThrottleState = INITIAL_THROTTLE_STATE;
  // Per-tick throttle accumulator (B1): the gap-sweep is the ONLY
  // contributor now (see the throttle-ownership note above) —
  // `keywordSweepTick` folds its own outcome into `sweepThrottleState` via
  // ONE `advanceThrottle` call at the end of the tick. This still (a)
  // weights the error rate by real request volume within the sweep itself
  // and (b) makes one "sweep" equal one TICK, so `THROTTLE_HOLD_SWEEPS`
  // means that many gap-sweep ticks of recovery hold.
  // Reset at the top of each gap-sweep tick; safe as closure-level state
  // because the `keywordSweepRunning` single-flight guard means only one
  // gap-sweep tick runs at a time.
  let tickThrottle: ThrottleOutcome = { rateLimitErrors: 0, attempted: 0 };
  function accumulateThrottle(rateLimitErrors: number, attempted: number): void {
    tickThrottle = {
      rateLimitErrors: tickThrottle.rateLimitErrors + rateLimitErrors,
      attempted: tickThrottle.attempted + attempted,
    };
  }
  // Cross-pass flatline counters (B2): process-local, reset on guardian
  // restart — B3's DB-backed heartbeat (GET /api/appstore/stats) is the
  // durable backstop. A pass that succeeds but returns nothing looks
  // identical to a healthy idle one, so per-lane consecutive-zero streaks
  // escalate to log.error once a lane has gone silently dead for
  // `FLATLINE_STREAK_THRESHOLD` consecutive non-empty passes.
  let autocompleteZeroStreak = 0;
  let gbHintsZeroStreak = 0;
  let serpSweepZeroStreak = 0;
  // Soft cadence gate for the keyword-scans retention prune (B3, default 6h).
  let lastScansPruneRunAt = 0;

  async function fetchTopApps(
    url: string,
    listType: string,
  ): Promise<readonly AppRankingRow[]> {
    try {
      const data = await fetchJson(url, loadConfig().appstoreSync.useProxy);
      return parseTopAppsV2(data, listType);
    } catch (err) {
      const msg = getErrorMessage(err);
      log.warn("Failed to fetch top apps", { listType, error: msg });
      return [];
    }
  }

  // Legacy hourly page-1-only review path, re-based onto the shared
  // `review-rss.ts` parser (deep-scrape build Stage 4, build plan §0.4
  // hourly hook 2) — same behavior/pacing as before (still one `fetchJson`
  // call via `fetchWithTimeout`, no rate-limit-retry added here), just
  // gaining `review_date`/vote columns on the rows it writes and sharing the
  // ONE review parser with the deep harvester rather than maintaining its
  // own copy.
  async function fetchReviewsForApp(
    appId: string,
    appName: string,
  ): Promise<readonly AppReviewRow[]> {
    try {
      const now = Math.floor(Date.now() / 1000);
      const data = await fetchJson(buildReviewFeedUrl(appId, 1, "us"), loadConfig().appstoreReviewHarvest.useProxy);
      return parseReviewFeedPage(data).map((p) => toAppReviewRow(p, appId, appName, "us", now));
    } catch (err) {
      const msg = getErrorMessage(err);
      log.warn("Failed to fetch reviews", { appId, appName, error: msg });
      return [];
    }
  }

  function parseItunesResult(r: Record<string, unknown>): AppRankingRow {
    const now = Math.floor(Date.now() / 1000);
    return {
      id: String(r.trackId ?? ""),
      name: String(r.trackName ?? ""),
      artist: String(r.artistName ?? ""),
      category: String(r.primaryGenreName ?? ""),
      rank: 0,
      list_type: "discovered",
      icon_url: String(r.artworkUrl100 ?? ""),
      store_url: String(r.trackViewUrl ?? ""),
      description: String(r.description ?? "").slice(0, 2000),
      price: r.price === 0 ? "Free" : `$${r.price ?? 0}`,
      bundle_id: String(r.bundleId ?? ""),
      release_date: String(r.releaseDate ?? ""),
      updated_at: now,
      indexed_at: null,
    };
  }

  async function fetchRelatedApps(appId: string): Promise<readonly AppRankingRow[]> {
    try {
      const useProxy = loadConfig().appstoreSync.useProxy;
      // Step 1: Look up the seed app to get its artistId and genre
      const lookupData = await fetchJson(
        `https://itunes.apple.com/lookup?id=${appId}`,
        useProxy,
      ) as { results?: readonly Record<string, unknown>[] };

      const seedApp = (lookupData.results ?? [])[0];
      if (!seedApp) return [];

      const artistId = seedApp.artistId as number | undefined;
      const genre = seedApp.primaryGenreName as string | undefined;
      const discovered: AppRankingRow[] = [];

      // Step 2: Fetch other apps by the same developer
      if (artistId) {
        await delay(REQUEST_DELAY_MS);
        const artistData = await fetchJson(
          `https://itunes.apple.com/lookup?id=${artistId}&entity=software&limit=25`,
          useProxy,
        ) as { results?: readonly Record<string, unknown>[] };

        const artistResults = (artistData.results ?? [])
          .filter((r) => r.wrapperType === "software" && String(r.trackId ?? "") !== appId);

        for (const r of artistResults) {
          if (r.trackId) discovered.push(parseItunesResult(r));
        }
      }

      // Step 3: Search for apps in the same genre
      if (genre) {
        await delay(REQUEST_DELAY_MS);
        const term = encodeURIComponent(genre);
        const searchData = await fetchJson(
          `https://itunes.apple.com/search?term=${term}&entity=software&limit=25&country=us`,
          useProxy,
        ) as { results?: readonly Record<string, unknown>[] };

        const seenIds = new Set(discovered.map((d) => d.id));
        seenIds.add(appId);

        for (const r of searchData.results ?? []) {
          const trackId = String(r.trackId ?? "");
          if (trackId && !seenIds.has(trackId)) {
            seenIds.add(trackId);
            discovered.push(parseItunesResult(r));
          }
        }
      }

      return discovered;
    } catch (err) {
      const msg = getErrorMessage(err);
      log.warn("Failed to fetch related apps", { appId, error: msg });
      return [];
    }
  }

  async function indexUnindexedReviews(): Promise<void> {
    if (!config?.memoryManager) return;

    const MAX_ITERATIONS = 10;
    let iterations = 0;

    try {
      while (iterations < MAX_ITERATIONS) {
        const unindexed = await getUnindexedReviews(200);
        if (unindexed.length === 0) break;

        const forIndex = reviewsToAppReviewsForIndex(unindexed);
        const ids = unindexed.map((r) => r.id);

        await config.memoryManager.indexAppReviews(APPSTORE_AGENT_ID, forIndex);
        await markReviewsIndexed(ids);

        log.info("Indexed reviews into memory", { count: ids.length, iteration: iterations + 1 });
        iterations++;
      }
    } catch (err) {
      log.error("Failed to index reviews into RAG", { error: err });
    }
  }

  async function indexUnindexedRankings(): Promise<void> {
    if (!config?.memoryManager) return;

    const MAX_ITERATIONS = 10;
    let iterations = 0;

    try {
      while (iterations < MAX_ITERATIONS) {
        const unindexed = await getUnindexedRankings(200);
        if (unindexed.length === 0) break;

        const forIndex = rankingsToAppRankingsForIndex(unindexed);
        const ids = unindexed.map((r) => r.id);

        await config.memoryManager.indexAppRankings(APPSTORE_AGENT_ID, forIndex);
        await markRankingsIndexed(ids);

        log.info("Indexed rankings into memory", { count: ids.length, iteration: iterations + 1 });
        iterations++;
      }
    } catch (err) {
      log.error("Failed to index rankings into RAG", { error: err });
    }
  }

  async function scrape(): Promise<ScrapeResult> {
    try {
      const syncCfg = loadConfig().appstoreSync;

      // Fetch overall top-free and top-paid from Apple Marketing Tools API.
      // NOTE: this is a different API from the per-category iTunes RSS below
      // and hard-errors (HTTP 500) above limit=100 (verified live) — clamped
      // via appstoreSync.globalLimit's own z.number().max(100).
      const [freeApps, paidApps] = await Promise.all([
        fetchTopApps(buildGlobalTopAppsUrl("top-free", syncCfg.globalLimit), "top-free"),
        fetchTopApps(buildGlobalTopAppsUrl("top-paid", syncCfg.globalLimit), "top-paid"),
      ]);

      const overallRankings = [...freeApps, ...paidApps];
      let rankingsCount = await upsertRankings(overallRankings);

      log.info("Upserted overall app rankings", {
        free: freeApps.length,
        paid: paidApps.length,
      });

      // App-meta registry sighting (deep-scrape build Stage 2, §0.1/§0.4):
      // cheap DB upsert, no network — never allowed to break the scrape.
      try {
        await recordAppSightings(overallRankings, "chart");
      } catch (err) {
        log.warn("App-meta sighting recording failed (overall rankings)", { error: getErrorMessage(err) });
      }

      // Fetch per-category rankings from iTunes RSS API (richer data) across
      // every configured list type (top-free/top-paid/top-grossing by
      // default) — this is the main breadth lever for the app corpus that
      // feeds the keyword miner. Logged as a single summary (not per fetch)
      // since this loop now runs categories.length * listTypes.length
      // requests per cycle.
      const categoryRankingsRaw: AppRankingRow[] = [];
      let categoryFetchFailures = 0;

      for (const cat of ITUNES_CATEGORIES) {
        for (const listType of syncCfg.listTypes) {
          await delay(REQUEST_DELAY_MS);

          const itunesUrl = buildCategoryRankingUrl(cat.id, listType, syncCfg.perCategoryLimit);
          const listTypeTag = categoryListTypeTag(cat.id, listType);

          try {
            const data = await fetchJson(itunesUrl);
            const apps = parseTopAppsItunes(data, listTypeTag);
            categoryRankingsRaw.push(...apps);
          } catch (err) {
            categoryFetchFailures++;
            const msg = getErrorMessage(err);
            log.warn("Failed to fetch iTunes category rankings", {
              category: cat.name,
              listType,
              error: msg,
            });
          }
        }
      }

      const categoryRankings = dedupeRankingsByListKey(categoryRankingsRaw);

      log.info("Fetched iTunes category rankings", {
        categories: ITUNES_CATEGORIES.length,
        listTypes: syncCfg.listTypes.length,
        requests: ITUNES_CATEGORIES.length * syncCfg.listTypes.length,
        failures: categoryFetchFailures,
        apps: categoryRankings.length,
      });

      if (categoryRankings.length > 0) {
        const catCount = await upsertRankings(categoryRankings);
        rankingsCount += catCount;
        log.info("Upserted category rankings", {
          categories: ITUNES_CATEGORIES.length,
          total: catCount,
        });

        try {
          await recordAppSightings(categoryRankings, "chart");
        } catch (err) {
          log.warn("App-meta sighting recording failed (category rankings)", { error: getErrorMessage(err) });
        }
      }

      // Build list of apps to fetch reviews for:
      // top N from overall lists + top N from each category's top-free list.
      // Reviews are an expensive, separate path (one iTunes reviews-endpoint
      // call per app) — deliberately NOT multiplied by the new top-paid/
      // top-grossing list types added above; only ranking breadth grows.
      const appsToReview: AppRankingRow[] = [
        ...freeApps.slice(0, TOP_APPS_PER_LIST),
        ...paidApps.slice(0, TOP_APPS_PER_LIST),
      ];

      // Add top N from each category's top-free list (deduplicate by app id)
      const seenIds = new Set(appsToReview.map((a) => a.id));
      for (const cat of ITUNES_CATEGORIES) {
        const listTypeTag = categoryListTypeTag(cat.id, "top-free");
        const catApps = categoryRankings
          .filter((a) => a.list_type === listTypeTag)
          .slice(0, TOP_APPS_PER_LIST);
        for (const app of catApps) {
          if (!seenIds.has(app.id)) {
            seenIds.add(app.id);
            appsToReview.push(app);
          }
        }
      }

      // Also include discovered apps in review fetching
      const discoveredApps = await getRankings("discovered", TOP_APPS_PER_LIST);
      for (const app of discoveredApps) {
        if (!seenIds.has(app.id)) {
          seenIds.add(app.id);
          appsToReview.push(app);
        }
      }

      let totalReviews = 0;

      for (const app of appsToReview) {
        if (!app.id) continue;

        await delay(REQUEST_DELAY_MS);

        const reviews = await fetchReviewsForApp(app.id, app.name);
        if (reviews.length > 0) {
          const result = await upsertReviews(reviews);
          totalReviews += result.upserted;
        }
      }

      log.info("Upserted app reviews", {
        appsChecked: appsToReview.length,
        reviews: totalReviews,
      });

      // Discovery: find related apps to expand the database
      try {
        const knownIds = await getDiscoveredAppIds();
        const allRanked = [...freeApps, ...paidApps, ...categoryRankings].filter((a) => a.id);
        const seeds = allRanked.sort(() => Math.random() - 0.5).slice(0, DISCOVERY_LOOKUPS_PER_CYCLE);
        let discoveredCount = 0;

        for (const seed of seeds) {
          await delay(REQUEST_DELAY_MS);
          const related = await fetchRelatedApps(seed.id);
          const newApps = related.filter((a) => a.id && !knownIds.has(a.id));

          if (newApps.length > 0) {
            await upsertRankings(newApps);
            discoveredCount += newApps.length;
            for (const a of newApps) knownIds.add(a.id);

            try {
              await recordAppSightings(newApps, "discovery");
            } catch (err) {
              log.warn("App-meta sighting recording failed (discovery)", { error: getErrorMessage(err) });
            }
          }
        }

        if (discoveredCount > 0) {
          log.info("Discovered new App Store apps", { count: discoveredCount, seeds: seeds.length });
        }
      } catch (err) {
        log.warn("App Store discovery phase failed", { error: getErrorMessage(err) });
      }

      // Index unindexed content into memory
      await indexUnindexedReviews();
      await indexUnindexedRankings();

      // Keyword-gap sweep now runs on its own independent timer
      // (`keywordSweepTimer` below), decoupled from this ~hourly ranking
      // tick — see `keywordSweepTick()`.

      // Keyword-corpus discovery — SECONDARY source: mine new candidate
      // keywords from the App Store ranking data this scrape cycle already
      // fetched (top-chart app names + categories — see keyword-miner.ts).
      // Demoted 2026-07-21 in favor of autocomplete expansion (the PRIMARY
      // source — see keyword-autocomplete.ts and
      // `runAutocompleteExpansionIfDue` in this file's `keywordSweepTick`);
      // this miner still runs at a small capped contribution to catch
      // brand-new apps autocomplete hasn't indexed yet. No extra network
      // calls — purely reads what's already in the DB — so it's kept on
      // this ~hourly ranking tick (not the faster keyword-sweep timer)
      // simply to run once per scrape rather than every sweep cycle. Gated
      // by its own `corpusDiscovery.enabled` flag and never allowed to
      // break the rest of the scrape cycle — a failure here is logged and
      // swallowed.
      try {
        const cfg = loadConfig().appstoreKeywordGap;
        if (cfg.corpusDiscovery.enabled) {
          const result = await mineKeywords({
            rankingsLimit: KEYWORD_MINING_SCAN_LIMIT,
            maxNew: cfg.corpusDiscovery.maxMinedPerCycle,
          });
          log.info("[appstore] Keyword mining", { added: result.added, scanned: result.scanned });
        }
      } catch (err) {
        log.warn("Keyword-corpus mining failed", { error: getErrorMessage(err) });
      }

      return { ok: true, rankings: rankingsCount, reviews: totalReviews };
    } catch (err) {
      const msg = getErrorMessage(err);
      log.error("App Store scrape failed", { error: msg });
      return { ok: false, error: msg };
    }
  }

  // Runs the keyword-gap sweep on its own timer. Scans the globally stalest
  // `keywordsPerSweep` keywords across the whole corpus each cycle (scaled by
  // the adaptive throttle — see sweep-throttle.ts); gated by `enabled` and
  // internally rate-limited by the `dailyKeywordBudget` rolling-24h ceiling
  // in `runKeywordSweep`. Never allowed to break the scraper — a failure is
  // logged and swallowed here, mirroring `tick()`.
  async function keywordSweepTick(): Promise<void> {
    if (keywordSweepRunning) {
      log.debug("Keyword-gap sweep already running, skipping");
      return;
    }

    keywordSweepRunning = true;
    try {
      // B1: fresh per-tick throttle accumulator — the gap-sweep is the only
      // contributor now (see the throttle-ownership note above
      // `sweepThrottleState`); the single end-of-tick advance below folds it
      // in.
      tickThrottle = { rateLimitErrors: 0, attempted: 0 };
      const cfg = loadConfig().appstoreKeywordGap;
      if (!cfg.enabled) {
        log.debug("Keyword-gap sweep skipped — feature disabled");
        return;
      }

      const { keywordsPerSweep, delayMs } = computeEffectiveSweepRate({
        configuredKeywordsPerSweep: cfg.keywordsPerSweep,
        configuredDelayMs: cfg.sweepDelayMs,
        legacyRateOverride: cfg.sweepRateSafety.legacyRateOverride,
        throttleMultiplier: sweepThrottleState.multiplier,
      });

      const result = await runKeywordSweep({
        limit: keywordsPerSweep,
        delayMs,
        // Two-stream partition (proxied second scan stream, 2026-07-24):
        // excludes any keyword the proxied stream currently has in flight
        // and claims this batch for the sweep's duration. A no-op while
        // `proxyStream.enabled` is off (the proxied slot never claims).
        slot: sweepPartition.direct,
      });

      if (result.skipped) {
        log.debug("Keyword-gap sweep skipped this cycle — rolling 24h budget reached");
      } else {
        log.info("Keyword-gap sweep complete", {
          scanned: result.scanned,
          failed: result.failed,
          rateLimitErrors: result.rateLimitErrors,
          effectiveKeywordsPerSweep: keywordsPerSweep,
          effectiveDelayMs: delayMs,
          mineQuotaRemaining: result.mineQuotaRemaining,
          // Continuous fetch (2026-07-23): with mined exploration filling the
          // whole batch every cycle, this multiplier — not idle gaps — is
          // the thing regulating sustained throughput. Logged every sweep
          // (not just on a state change) so it's watchable in real time as
          // it AIMD-probes toward Apple's ceiling.
          throttleMultiplier: sweepThrottleState.multiplier,
        });

        // Adaptive throttle (B1): accumulate this sweep's outcome into the
        // per-tick accumulator rather than advancing the shared throttle here.
        // The single end-of-tick advance (below) folds it in. Accumulated
        // unconditionally — the end-of-tick advance is what's gated on
        // adaptiveThrottleEnabled/legacyRateOverride.
        const sweepAttempted = result.scanned + result.failed;
        accumulateThrottle(result.rateLimitErrors, sweepAttempted);

        // Flatline detector (B2): a non-empty sweep (batch>0) that inserted
        // ZERO scans looks identical to a healthy idle one at info level —
        // escalate once it stays dead across consecutive passes. Counter is
        // process-local; B3's DB heartbeat is the durable backstop.
        if (sweepAttempted > 0) {
          if (result.scanned === 0) {
            serpSweepZeroStreak++;
            if (serpSweepZeroStreak >= FLATLINE_STREAK_THRESHOLD) {
              log.error("keyword SERP sweep flatlined", {
                consecutivePasses: serpSweepZeroStreak,
                attempted: sweepAttempted,
                failed: result.failed,
                rateLimitErrors: result.rateLimitErrors,
                hint: "zero scans inserted across consecutive non-empty sweeps — the iTunes Search fetch/parse path may be broken",
              });
            }
          } else {
            serpSweepZeroStreak = 0;
          }
        }
      }

      // B1: single end-of-tick throttle advance — folds the gap-sweep's own
      // (rateLimitErrors, attempted) into the shared throttle ONCE. Gated
      // exactly as before: only under adaptive throttling, and never under
      // the hard kill-switch (a fixed, known-safe rate with no automation).
      // AIMD step sizes (continuous-fetch pass, 2026-07-23) are config-driven
      // — see `sweepRateSafety.throttleBackoffFactor` /
      // `throttleRecoveryStep` in src/config/schema.ts and
      // `sweep-throttle.ts`'s `advanceThrottle`.
      //
      // Independent-tick decouple (throughput fix, 2026-07-23): this used to
      // also fold in every auxiliary lane's totals from later in this same
      // tick. Those lanes now run on their own independently-locked
      // `auxiliaryLanesTick` and no longer write into `tickThrottle` — see
      // the throttle-ownership note above `sweepThrottleState`.
      if (cfg.sweepRateSafety.adaptiveThrottleEnabled && !cfg.sweepRateSafety.legacyRateOverride) {
        const wasThrottled = sweepThrottleState.throttled;
        const prevMultiplier = sweepThrottleState.multiplier;
        sweepThrottleState = advanceThrottle(sweepThrottleState, tickThrottle, {
          backoffFactor: cfg.sweepRateSafety.throttleBackoffFactor,
          recoveryStep: cfg.sweepRateSafety.throttleRecoveryStep,
          minMultiplier: cfg.sweepRateSafety.throttleMinMultiplier,
        });
        const errorRate = computeErrorRate(tickThrottle.rateLimitErrors, tickThrottle.attempted);

        if (!wasThrottled && sweepThrottleState.throttled) {
          log.warn("Keyword sweep adaptive throttle TRIPPED — halving effective rate", {
            errorRate,
            attempted: tickThrottle.attempted,
            rateLimitErrors: tickThrottle.rateLimitErrors,
            newMultiplier: sweepThrottleState.multiplier,
          });
        } else if (wasThrottled && !sweepThrottleState.throttled) {
          log.info("Keyword sweep adaptive throttle fully recovered", {
            multiplier: sweepThrottleState.multiplier,
          });
        } else if (sweepThrottleState.multiplier !== prevMultiplier) {
          log.info("Keyword sweep adaptive throttle stepped", {
            multiplier: sweepThrottleState.multiplier,
            previousMultiplier: prevMultiplier,
            errorRate,
            attempted: tickThrottle.attempted,
          });
        } else if (wasThrottled) {
          log.debug("Keyword sweep adaptive throttle still active", {
            multiplier: sweepThrottleState.multiplier,
            sweepsSinceChange: sweepThrottleState.sweepsSinceChange,
          });
        }
      }
    } catch (err) {
      log.warn("Keyword-gap sweep failed", { error: getErrorMessage(err) });
    } finally {
      keywordSweepRunning = false;
    }
  }

  // Runs the proxied SECOND scan stream on its own timer + single-flight
  // lock (2026-07-24 throughput pass): a parallel sweep over the mined
  // backlog through the Webshare rotating proxy — see
  // `runProxyKeywordSweep`'s doc comment for the work-partition rationale
  // and `config/schema.ts`'s `appstoreKeywordGap.proxyStream` for the
  // evidence basis. Self-protective by design (the Webshare pool's health is
  // time-varying — 100% clean on the 2026-07-24 soak, scanned:0/failed:5 on
  // the 2026-07-23 morning): its own AIMD throttle instance scales its batch
  // on partial 403/429 spikes, and its circuit breaker disables the stream
  // entirely (exponentially longer per consecutive trip) on the dead-pool
  // pattern. The direct stream is never affected either way. Never allowed
  // to break the scraper — a failure is logged and swallowed, mirroring
  // `keywordSweepTick`.
  async function proxyStreamTick(): Promise<void> {
    if (proxyStreamRunning) {
      log.debug("Proxied scan stream already running, skipping");
      return;
    }

    proxyStreamRunning = true;
    try {
      const cfg = loadConfig().appstoreKeywordGap;
      const ps = cfg.proxyStream;
      if (!cfg.enabled || !ps.enabled) {
        return;
      }
      // The hard kill-switch means "go fully conservative on Apple's
      // endpoints" — that operator intent must suppress this stream too,
      // same as every other Apple-endpoint lane.
      if (cfg.sweepRateSafety.legacyRateOverride) {
        log.debug("Proxied scan stream skipped — legacy rate override active");
        return;
      }

      const breakerParams: ProxyBreakerParams = {
        failureThreshold: ps.breakerFailureThreshold,
        cooloffMs: ps.breakerCooloffMs,
        maxCooloffMs: ps.breakerMaxCooloffMs,
      };

      if (isProxyBreakerOpen(proxyBreakerState, Date.now())) {
        log.debug("Proxied scan stream skipped — circuit breaker open", {
          openUntilMs: proxyBreakerState.openUntilMs,
          consecutiveTrips: proxyBreakerState.consecutiveTrips,
        });
        return;
      }

      // This stream's OWN rate knobs + throttle multiplier — the direct
      // lane's `keywordsPerSweep`/`sweepDelayMs`/`sweepThrottleState` are
      // never read here. `legacyRateOverride: false` is structural: the
      // kill-switch already skipped this tick entirely above.
      const { keywordsPerSweep, delayMs } = computeEffectiveSweepRate({
        configuredKeywordsPerSweep: ps.keywordsPerSweep,
        configuredDelayMs: ps.sweepDelayMs,
        legacyRateOverride: false,
        throttleMultiplier: proxyThrottleState.multiplier,
      });

      const result = await runProxyKeywordSweep({
        limit: keywordsPerSweep,
        delayMs,
        slot: sweepPartition.proxied,
      });

      if (result.skipped) {
        log.debug("Proxied scan stream skipped this cycle — shared budget/quota reached");
        return;
      }

      log.info("Proxied scan stream sweep complete", {
        scanned: result.scanned,
        failed: result.failed,
        rateLimitErrors: result.rateLimitErrors,
        bailed: result.bailed,
        effectiveKeywordsPerSweep: keywordsPerSweep,
        effectiveDelayMs: delayMs,
        throttleMultiplier: proxyThrottleState.multiplier,
      });

      // Own AIMD throttle advance — same tick-level accounting as the direct
      // sweep's, but into this stream's SEPARATE state. Same config-driven
      // step sizes (`sweepRateSafety.throttle*`) — they tune the controller,
      // not the ceiling; the STATE (and therefore the effective rate) is
      // fully isolated per stream.
      if (cfg.sweepRateSafety.adaptiveThrottleEnabled) {
        const wasThrottled = proxyThrottleState.throttled;
        const attempted = result.scanned + result.failed;
        proxyThrottleState = advanceThrottle(
          proxyThrottleState,
          { rateLimitErrors: result.rateLimitErrors, attempted },
          {
            backoffFactor: cfg.sweepRateSafety.throttleBackoffFactor,
            recoveryStep: cfg.sweepRateSafety.throttleRecoveryStep,
            minMultiplier: cfg.sweepRateSafety.throttleMinMultiplier,
          },
        );
        if (!wasThrottled && proxyThrottleState.throttled) {
          log.warn("Proxied scan stream adaptive throttle TRIPPED — halving effective rate", {
            errorRate: computeErrorRate(result.rateLimitErrors, attempted),
            attempted,
            rateLimitErrors: result.rateLimitErrors,
            newMultiplier: proxyThrottleState.multiplier,
          });
        } else if (wasThrottled && !proxyThrottleState.throttled) {
          log.info("Proxied scan stream adaptive throttle fully recovered", {
            multiplier: proxyThrottleState.multiplier,
          });
        }
      }

      // Circuit breaker advance (see `proxy-stream.ts`): a healthy tick
      // resets it; accumulated success-free failures trip it. Logged LOUDLY
      // on a trip — structured, presence-only (no URLs/credentials in
      // scope, only counts and durations).
      const wasOpen = isProxyBreakerOpen(proxyBreakerState, Date.now());
      proxyBreakerState = advanceProxyBreaker(
        proxyBreakerState,
        { scanned: result.scanned, failed: result.failed },
        Date.now(),
        breakerParams,
      );
      const nowOpen = isProxyBreakerOpen(proxyBreakerState, Date.now());
      if (!wasOpen && nowOpen) {
        log.error("Proxied scan stream circuit breaker TRIPPED — stream disabled for cool-off", {
          consecutiveTrips: proxyBreakerState.consecutiveTrips,
          cooloffMs: computeBreakerCooloffMs(proxyBreakerState.consecutiveTrips, breakerParams),
          openUntilMs: proxyBreakerState.openUntilMs,
          lastTickScanned: result.scanned,
          lastTickFailed: result.failed,
          lastTickRateLimitErrors: result.rateLimitErrors,
          hint: "Webshare pool likely unhealthy (Apple 403s on datacenter exits — see 2026-07-23 incident); the direct stream is unaffected",
        });
      }
    } catch (err) {
      log.warn("Proxied scan stream tick failed", { error: getErrorMessage(err) });
    } finally {
      proxyStreamRunning = false;
    }
  }

  // Runs the ~12 auxiliary keyword-gap lanes on their own independent timer
  // + single-flight lock, decoupled from the gap-sweep tick above
  // (throughput fix, 2026-07-23): post-restart every lane below is due at
  // once, and sequentially awaiting all of them under the gap-sweep's own
  // lock used to block the high-value gap-sweep — which should run every
  // `scanIntervalMs` (~60s) — for the whole 15-20min chain. Each lane below
  // is still self-gated to its own `...IfDue` cadence internally, so this
  // tick only needs to run often enough to check due-ness (see
  // `auxiliaryLanesTimer` in `start()`). Guarded by `auxiliaryLanesRunning`
  // so this tick can never overlap itself; independent of
  // `keywordSweepRunning` so a long-running auxiliary chain can never block
  // a gap-sweep tick (or vice versa). Never allowed to break the scraper —
  // a failure is logged and swallowed here, mirroring `keywordSweepTick`.
  async function auxiliaryLanesTick(): Promise<void> {
    if (auxiliaryLanesRunning) {
      log.debug("Auxiliary keyword-gap lanes already running, skipping");
      return;
    }

    auxiliaryLanesRunning = true;
    try {
      const cfg = loadConfig().appstoreKeywordGap;
      if (!cfg.enabled) {
        log.debug("Auxiliary keyword-gap lanes skipped — feature disabled");
        return;
      }

      // Screener runs each tick (whether or not the gap-sweep scanned
      // anything new this cycle — it evaluates the corpus's LATEST scans,
      // not just the gap-sweep's most recent cycle), gated to its own
      // cadence internally.
      await runSignatureScreenerIfDue();

      // New-hit / first-crossing alert digest (Batch F4) — runs after the
      // screener so a fresh signature hit is eligible to be included, gated
      // to its own (default 24h) cadence internally, same pattern as every
      // other lane on this tick.
      await runGapAlertsIfDue();

      // Autocomplete corpus expansion (PRIMARY discovery source — see
      // keyword-autocomplete.ts) also runs off this tick, gated to its own
      // slower cadence internally, same pattern as the screener above.
      await runAutocompleteExpansionIfDue();

      // GB hints lane (throughput wave 2026-07-21, item 3) — a second
      // autocomplete-expansion pass against the GB App Store, gated to its
      // own cadence internally, same pattern as the US lane above.
      await runGbHintsLaneIfDue();

      // Newborn re-observation lane (throughput wave 2026-07-21, item 2,
      // audit NEXT item F) — daily batched-lookup re-observation of every
      // tracked newborn app, gated to its own cadence internally, same
      // pattern as every other lane above.
      await runNewbornReobservationIfDue();

      // DE storefront lane (2026-07-21 scan-budget retune) — daily pass over
      // the tier-1-protected corpus against the German App Store, gated to
      // its own cadence internally, same pattern as the screener/autocomplete
      // passes above. A no-op by default (`deStorefrontLane.enabled` is
      // `false`) — kept here regardless so re-enabling it doesn't require
      // re-wiring the tick.
      await runDeStorefrontSweepIfDue();

      // One-shot mined-pool deactivation backfill — see `minedBackfillDone`'s
      // doc comment. Runs at most once, off the gap-sweep tick so it never
      // blocks scraper startup.
      await runMinedBackfillOnce();

      // International storefront chart sweep (deep-scrape build Stage 3,
      // build plan §0.4 slot 5) — gated to its own cadence internally, same
      // pattern as the screener/autocomplete/DE-storefront passes above.
      await runIntlChartsIfDue();

      // Review-text harvester (deep-scrape build Stage 4, build plan §0.4
      // slot 6) — gated to its own cadence internally, same pattern as the
      // screener/autocomplete/DE-storefront/intl-charts passes above.
      await runReviewHarvestIfDue();

      // App-meta registry Lookup-API enrichment (deep-scrape build Stage 2,
      // build plan §0.4 slot 7) — gated to its own cadence internally, same
      // pattern as the screener/autocomplete/DE-storefront passes above.
      await runAppEnrichmentIfDue();

      // App-page HTML enrichment (deep-scrape build Stage 5, build plan
      // §0.4 slot 8) — gated to its own cadence internally, same pattern as
      // every other pass above.
      await runAppPageEnrichmentIfDue();

      // Keyword-scans retention prune (B3) — DB-only (no Apple requests, so
      // it feeds nothing into the throttle), gated to its own ~6h cadence,
      // same log-and-swallow pattern as the ledger prunes above.
      await runScansRetentionIfDue();
    } catch (err) {
      log.warn("Auxiliary keyword-gap lanes failed", { error: getErrorMessage(err) });
    } finally {
      auxiliaryLanesRunning = false;
    }
  }

  // Runs autocomplete-driven corpus expansion (see keyword-autocomplete.ts's
  // `expandCorpus`), gated to `autocompleteExpansion.minIntervalMs` (default
  // 15min) so its network fan-out — one Apple search-suggest request per
  // seed keyword — stays infrequent relative to the ~1min scan-sweep tick
  // this is called from. Respects the SAME `sweepRateSafety` rails as the
  // scan sweep: the hard kill-switch (`legacyRateOverride`) skips this pass
  // entirely, and (when adaptive throttling is on) any rate-limit errors
  // this pass hits are folded into the SHARED `sweepThrottleState`, so a
  // spike here backs off the scan sweep too and vice versa — both hit an
  // Apple search endpoint on the same corpus. Never allowed to break the
  // sweep tick — a failure is logged and swallowed, mirroring
  // `runSignatureScreenerIfDue`.
  async function runAutocompleteExpansionIfDue(): Promise<void> {
    try {
      const cfg = loadConfig().appstoreKeywordGap;
      const ac = cfg.autocompleteExpansion;
      if (!ac.enabled) return;
      if (cfg.sweepRateSafety.legacyRateOverride) {
        log.debug("Autocomplete expansion skipped — legacy rate override active");
        return;
      }

      const now = Date.now();
      if (now - lastAutocompleteRunAt < ac.minIntervalMs) return;
      lastAutocompleteRunAt = now;

      // Scale this pass's seed fan-out by the SAME throttle multiplier the
      // scan sweep uses — if Apple is already rate-limiting the sweep, this
      // pass backs off in lockstep rather than piling on more requests.
      const multiplier = cfg.sweepRateSafety.adaptiveThrottleEnabled
        ? sweepThrottleState.multiplier
        : 1;
      const winnerLimit = Math.max(0, Math.floor(ac.winnerLimit * multiplier));
      const diverseLimit = Math.max(0, Math.floor(ac.diverseLimit * multiplier));
      // Prefix fan-out (2026-07-21 audit item D fix) — scaled by the SAME
      // throttle multiplier as winnerLimit/diverseLimit, same rationale.
      const maxPrefixesPerSeed = ac.prefixFanOut.enabled
        ? Math.max(0, Math.floor(ac.prefixFanOut.maxPrefixesPerSeed * multiplier))
        : 0;

      const result = await expandCorpus({
        minOpportunity: cfg.opportunityThresholdForSeed,
        winnerLimit,
        diverseLimit,
        perSeed: ac.perSeed,
        storefront: ac.storefront,
        market: "us",
        delayMs: ac.delayMs,
        maxPrefixesPerSeed,
        useProxy: ac.useProxy,
      });

      log.info("Autocomplete expansion tick", {
        added: result.added,
        seedsUsed: result.seedsUsed,
        attempted: result.attempted,
        rawTermCount: result.rawTermCount,
        rateLimitErrors: result.rateLimitErrors,
        throttleMultiplier: multiplier,
        maxPrefixesPerSeed,
      });

      // Throttle ownership (independent-tick decouple, 2026-07-23): this
      // lane no longer feeds the gap-sweep's `tickThrottle` — it now runs
      // on the independently-locked `auxiliaryLanesTick` and self-protects
      // via `ssrfSafeFetch`'s `retryOnRateLimit` backoff instead. See the
      // throttle-ownership note above `sweepThrottleState`.

      // B2 flatline: a pass that fetched (attempted>0) but Apple returned
      // ZERO raw suggestions (rawTermCount===0, pre-junk-filter) means the
      // endpoint/header likely broke — an all-junk pass would still show
      // rawTermCount>0. Escalate after consecutive dead passes.
      if (result.attempted > 0) {
        if (result.rawTermCount === 0) {
          autocompleteZeroStreak++;
          if (autocompleteZeroStreak >= FLATLINE_STREAK_THRESHOLD) {
            log.error("autocomplete lane flatlined", {
              lane: "us",
              consecutivePasses: autocompleteZeroStreak,
              attempted: result.attempted,
              rateLimitErrors: result.rateLimitErrors,
              hint: "Apple returned zero raw suggestions across consecutive passes — likely an endpoint/header change (see keyword-autocomplete.ts's 2026-07-18 incident)",
            });
          }
        } else {
          autocompleteZeroStreak = 0;
        }
      }
    } catch (err) {
      log.warn("Autocomplete expansion failed", { error: getErrorMessage(err) });
    }

    // Autocomplete-hints ledger prune (Batch D item D1) — its own cadence
    // gate, independent of (and outside) the try/catch above so a failed
    // expansion pass never skips the prune, and vice versa. Try/catch-
    // swallowed, matching every other ledger-prune lane in this file.
    if (Date.now() - lastAutocompleteHintsPruneRunAt >= AUTOCOMPLETE_HINTS_PRUNE_MIN_INTERVAL_MS) {
      lastAutocompleteHintsPruneRunAt = Date.now();
      try {
        const pruned = await pruneAutocompleteHints(AUTOCOMPLETE_HINTS_PRUNE_RETENTION_DAYS);
        log.debug("Autocomplete-hints ledger pruned", { pruned });
      } catch (err) {
        log.warn("Autocomplete-hints ledger prune failed", { error: getErrorMessage(err) });
      }
    }
  }

  // Runs the GB hints lane (throughput wave 2026-07-21, item 3 "hint
  // breadth"): a SECOND autocomplete-expansion pass against the GB App
  // Store, writing into the SAME `appstore_autocomplete_hints` table with
  // `storefront: "gb"` (migration 049). Own cadence
  // (`autocompleteExpansion.gbLane.minIntervalMs`, default 1h), gated by the
  // SAME `sweepRateSafety` kill-switch/adaptive-throttle rails as the US
  // lane above — a rate-limit spike in either market backs off both, since
  // they hit the same Apple search-suggest endpoint family. Never allowed
  // to break the sweep tick — a failure is logged and swallowed, mirroring
  // `runAutocompleteExpansionIfDue`.
  async function runGbHintsLaneIfDue(): Promise<void> {
    try {
      const cfg = loadConfig().appstoreKeywordGap;
      const gb = cfg.autocompleteExpansion.gbLane;
      if (!gb.enabled) return;
      if (cfg.sweepRateSafety.legacyRateOverride) {
        log.debug("GB hints lane skipped — legacy rate override active");
        return;
      }

      const now = Date.now();
      if (now - lastGbHintsRunAt < gb.minIntervalMs) return;
      lastGbHintsRunAt = now;

      const multiplier = cfg.sweepRateSafety.adaptiveThrottleEnabled
        ? sweepThrottleState.multiplier
        : 1;
      const winnerLimit = Math.max(0, Math.floor(gb.winnerLimit * multiplier));
      const diverseLimit = Math.max(0, Math.floor(gb.diverseLimit * multiplier));
      const maxPrefixesPerSeed = gb.prefixFanOut.enabled
        ? Math.max(0, Math.floor(gb.prefixFanOut.maxPrefixesPerSeed * multiplier))
        : 0;

      const result = await expandCorpus({
        minOpportunity: cfg.opportunityThresholdForSeed,
        winnerLimit,
        diverseLimit,
        perSeed: gb.perSeed,
        storefront: gb.storefront,
        market: "gb",
        delayMs: gb.delayMs,
        maxPrefixesPerSeed,
        useProxy: gb.useProxy,
      });

      log.info("GB hints lane tick", {
        added: result.added,
        seedsUsed: result.seedsUsed,
        attempted: result.attempted,
        rawTermCount: result.rawTermCount,
        rateLimitErrors: result.rateLimitErrors,
        throttleMultiplier: multiplier,
        maxPrefixesPerSeed,
      });

      // Throttle ownership: no longer feeds the gap-sweep's `tickThrottle`
      // (see the throttle-ownership note above `sweepThrottleState`) — self-
      // protects via `retryOnRateLimit` like every other auxiliary lane.

      // B2 flatline: same rawTermCount===0 heartbeat as the US lane, tracked
      // on its own GB streak counter.
      if (result.attempted > 0) {
        if (result.rawTermCount === 0) {
          gbHintsZeroStreak++;
          if (gbHintsZeroStreak >= FLATLINE_STREAK_THRESHOLD) {
            log.error("autocomplete lane flatlined", {
              lane: "gb",
              consecutivePasses: gbHintsZeroStreak,
              attempted: result.attempted,
              rateLimitErrors: result.rateLimitErrors,
              hint: "Apple returned zero raw suggestions across consecutive passes — likely an endpoint/header change (see keyword-autocomplete.ts's 2026-07-18 incident)",
            });
          }
        } else {
          gbHintsZeroStreak = 0;
        }
      }
    } catch (err) {
      log.warn("GB hints lane failed", { error: getErrorMessage(err) });
    }
  }

  // Runs the newborn re-observation lane (throughput wave 2026-07-21, item
  // 2 — audit NEXT item F, see `newborn-reobservation.ts`), gated to
  // `appstoreNewbornReobservation.minIntervalMs` (default 24h, "a daily
  // pass over the whole tracked-newborn population") and to the SAME
  // `sweepRateSafety` kill-switch as every other Apple-endpoint lane on
  // this tick (this lane hits the `/lookup` endpoint, same family as
  // `appstoreAppEnrichment` — a legacy-override operator intent to go
  // fully conservative should suppress this lane too). Rate-limit errors
  // feed into the SHARED `sweepThrottleState`, same pattern as every other
  // lane. Never allowed to break the sweep tick — a failure is logged and
  // swallowed, mirroring the other "IfDue" passes. The pass itself is
  // internally wall-clock-bounded (`newborn-reobservation.ts`'s
  // `isPassOverBudget` — MANDATORY, see that module's doc comment for the
  // PR #327 incident this guards against) so it can never wedge this
  // shared tick regardless of population size.
  async function runNewbornReobservationIfDue(): Promise<void> {
    try {
      const fullCfg = loadConfig();
      const cfg = fullCfg.appstoreNewbornReobservation;
      if (!cfg.enabled) return;
      if (fullCfg.appstoreKeywordGap.sweepRateSafety.legacyRateOverride) {
        log.debug("Newborn re-observation skipped — legacy rate override active");
        return;
      }

      const now = Date.now();
      if (now - lastNewbornReobservationRunAt < cfg.minIntervalMs) return;
      lastNewbornReobservationRunAt = now;

      const result = await runNewbornReobservationPass({
        batchSize: cfg.batchSize,
        maxAgeDays: cfg.maxAgeDays,
        delayMs: cfg.delayMs,
        useProxy: cfg.useProxy,
      });

      if (result.skipped) {
        log.debug("Newborn re-observation pass skipped this cycle — batchSize <= 0");
        return;
      }

      log.info("Newborn re-observation pass complete", {
        candidateCount: result.candidateCount,
        stillNewbornCount: result.stillNewbornCount,
        observed: result.observed,
        missing: result.missing,
        agedOut: result.agedOut,
        attempted: result.attempted,
        rateLimitErrors: result.rateLimitErrors,
        bailed: result.bailed,
      });

      // Throttle ownership: no longer feeds the gap-sweep's `tickThrottle`
      // (see the throttle-ownership note above `sweepThrottleState`) — self-
      // protects via `retryOnRateLimit` like every other auxiliary lane.
    } catch (err) {
      log.warn("Newborn re-observation failed", { error: getErrorMessage(err) });
    }
  }

  // Runs the DE storefront lane (see `keyword-gaps.ts`'s
  // `runDeStorefrontSweep`), gated to `deStorefrontLane.minIntervalMs`
  // (default 25min as of the 2026-07-22 Batch A budget rescue — each pass
  // now only scans one `deStorefrontLane.deChunkSize` chunk of the protected
  // pool, not the whole thing, so the re-check below runs far more often
  // than the old 12h/24h cadence, and is what keeps this lane from
  // overshooting `dailyKeywordBudget` by more than one chunk) and to the
  // SAME `sweepRateSafety` rails as the scan sweep and autocomplete
  // expansion above: the hard kill-switch (`legacyRateOverride`) skips this
  // pass entirely, and any rate-limit errors it hits feed into the SHARED
  // `sweepThrottleState` — a spike here backs off the US sweep too, "the
  // shared throttle envelope". Also checks the rolling 24h
  // `dailyKeywordBudget` ceiling directly (rather than relying solely on
  // `runKeywordSweep`'s own check) since this pass can run independently of
  // a US sweep tick. Never allowed to break the sweep tick — a failure is
  // logged and swallowed, mirroring the other "IfDue" passes.
  async function runDeStorefrontSweepIfDue(): Promise<void> {
    try {
      const cfg = loadConfig().appstoreKeywordGap;
      const de = cfg.deStorefrontLane;
      if (!de.enabled) return;
      if (cfg.sweepRateSafety.legacyRateOverride) {
        log.debug("DE storefront lane skipped — legacy rate override active");
        return;
      }

      const now = Date.now();
      if (now - lastDeStorefrontRunAt < de.minIntervalMs) return;

      const since = Math.floor(Date.now() / 1000) - 86_400;
      const scansLast24h = await countScansSince(since);
      if (scansLast24h >= cfg.dailyKeywordBudget) {
        log.debug("DE storefront lane skipped — rolling 24h budget reached", { scansLast24h });
        return;
      }

      lastDeStorefrontRunAt = now;

      const result = await runDeStorefrontSweep({ delayMs: de.delayMs, chunkSize: de.deChunkSize });
      log.info("DE storefront lane complete", {
        scanned: result.scanned,
        failed: result.failed,
        bailed: result.bailed,
        rateLimitErrors: result.rateLimitErrors,
      });

      // Throttle ownership: no longer feeds the gap-sweep's `tickThrottle`
      // (see the throttle-ownership note above `sweepThrottleState`) — self-
      // protects via `retryOnRateLimit` like every other auxiliary lane.
    } catch (err) {
      log.warn("DE storefront lane failed", { error: getErrorMessage(err) });
    }
  }

  // Runs the international storefront chart sweep (deep-scrape build
  // Stage 3 — see `charts-intl.ts`'s `runIntlChartsSweep`), gated to
  // `appstoreSync.intlCharts.minIntervalMs` (default 12h) and to the SAME
  // `sweepRateSafety` rails as every other lane on this tick: the hard
  // kill-switch (`legacyRateOverride`) skips this pass entirely, and any
  // rate-limit errors it hits feed into the SHARED `sweepThrottleState` —
  // which ALSO scales this pass's own work-list size (build plan §0.4:
  // "work-list truncated by multiplier"), so a spike anywhere shrinks this
  // pass's next run too, not just future runs of the lane that tripped it.
  // Never allowed to break the sweep tick — a failure is logged and
  // swallowed, mirroring the other "IfDue" passes.
  async function runIntlChartsIfDue(): Promise<void> {
    try {
      const fullCfg = loadConfig();
      const cfg = fullCfg.appstoreSync.intlCharts;
      if (!cfg.enabled) return;
      if (fullCfg.appstoreKeywordGap.sweepRateSafety.legacyRateOverride) {
        log.debug("Intl charts lane skipped — legacy rate override active");
        return;
      }

      const now = Date.now();
      if (now - lastIntlChartsRunAt < cfg.minIntervalMs) return;
      lastIntlChartsRunAt = now;

      const adaptiveThrottleEnabled = fullCfg.appstoreKeywordGap.sweepRateSafety.adaptiveThrottleEnabled;
      const multiplier = adaptiveThrottleEnabled ? sweepThrottleState.multiplier : 1;

      const result = await runIntlChartsSweep({
        storefronts: cfg.storefronts,
        listTypes: cfg.listTypes,
        perCategoryLimit: fullCfg.appstoreSync.perCategoryLimit,
        delayMs: cfg.delayMs,
        throttleMultiplier: multiplier,
        useProxy: cfg.useProxy,
      });

      log.info("Intl charts lane complete", {
        scanned: result.scanned,
        failed: result.failed,
        bailed: result.bailed,
        rateLimitErrors: result.rateLimitErrors,
        sightingsRecorded: result.sightingsRecorded,
        storefronts: cfg.storefronts,
        throttleMultiplier: multiplier,
      });

      // Throttle ownership: no longer feeds the gap-sweep's `tickThrottle`
      // (see the throttle-ownership note above `sweepThrottleState`) — self-
      // protects via `retryOnRateLimit` like every other auxiliary lane.
    } catch (err) {
      log.warn("Intl charts lane failed", { error: getErrorMessage(err) });
    }
  }

  // One-shot backfill of the mined-pool deactivation rule against the
  // EXISTING corpus (see `keyword-store.ts`'s `backfillMinedDeactivation` for
  // why this is a single set-based UPDATE rather than budgeted batches).
  // Gated by `appstoreJunkDeactivation.minedBackfillEnabled` and
  // `minedBackfillDone` — runs at most once per process lifetime. Never
  // allowed to break the sweep tick — a failure is logged and swallowed.
  async function runMinedBackfillOnce(): Promise<void> {
    if (minedBackfillDone) return;
    minedBackfillDone = true;
    try {
      const cfg = loadConfig().appstoreJunkDeactivation;
      if (!cfg.enabled || !cfg.minedBackfillEnabled) return;

      const deactivated = await backfillMinedDeactivation();
      log.info("Mined-pool deactivation backfill complete", { deactivated });
    } catch (err) {
      log.warn("Mined-pool deactivation backfill failed", { error: getErrorMessage(err) });
    }
  }

  // Runs the review-text harvester (deep-scrape build Stage 4 — see
  // `review-harvester.ts`'s `runCohortRefresh`/`harvestDueApps`), plus its
  // ledger prune, each gated to its OWN cadence — NO new timer (build plan
  // §0.4): all three ride this ~1min sweep tick, same pattern as
  // `runAppEnrichmentIfDue` below. Respects the SAME `legacyRateOverride`
  // kill-switch and SHARED `sweepThrottleState` as every other lane on this
  // tick — a rate-limit spike in any lane backs off every lane. Never
  // allowed to break the sweep tick — a failure is logged and swallowed,
  // mirroring the other "IfDue" passes.
  async function runReviewHarvestIfDue(): Promise<void> {
    try {
      const fullCfg = loadConfig();
      const cfg = fullCfg.appstoreReviewHarvest;
      if (!cfg.enabled) return;
      if (fullCfg.appstoreKeywordGap.sweepRateSafety.legacyRateOverride) {
        log.debug("Review harvest skipped — legacy rate override active");
        return;
      }
      const adaptiveThrottleEnabled = fullCfg.appstoreKeywordGap.sweepRateSafety.adaptiveThrottleEnabled;

      // Cohort-refresh sub-pass — its own cadence gate, independent of the
      // harvest pass's `minIntervalMs` below. No network calls of its own
      // (pure DB read/write), so it isn't throttle-scaled.
      if (cfg.cohortRefresh.enabled && Date.now() - lastReviewCohortRefreshRunAt >= cfg.cohortRefresh.minIntervalMs) {
        lastReviewCohortRefreshRunAt = Date.now();
        try {
          const refreshResult = await runCohortRefresh({
            signatureHitCap: cfg.cohortRefresh.signatureHitCap,
            velocityCap: cfg.cohortRefresh.velocityCap,
            chartNewbornCap: cfg.cohortRefresh.chartNewbornCap,
          });
          log.info("Review-harvest cohort refresh complete", refreshResult);
        } catch (err) {
          log.warn("Review-harvest cohort refresh failed", { error: getErrorMessage(err) });
        }
      }

      // Batch C4 review-complaint keyword-mining sub-pass — its own cadence
      // gate, independent of both the cohort-refresh and harvest passes
      // above. Pure DB read/extract over reviews the harvester already
      // collected (no network calls of its own), so — like cohort-refresh —
      // it isn't throttle-scaled. Default OFF (opt-in — see
      // `corpusDiscovery.reviewMining`'s doc comment in config/schema.ts).
      const reviewMiningCfg = fullCfg.appstoreKeywordGap.corpusDiscovery.reviewMining;
      if (
        reviewMiningCfg.enabled &&
        Date.now() - lastReviewMiningRunAt >= reviewMiningCfg.minIntervalMs
      ) {
        lastReviewMiningRunAt = Date.now();
        try {
          const sinceSeconds = Math.floor((Date.now() - reviewMiningCfg.lookbackMs) / 1000);
          const miningResult = await mineReviewKeywords({
            reviewLimit: reviewMiningCfg.reviewScanLimit,
            sinceSeconds,
            maxNew: reviewMiningCfg.maxNewPerCycle,
          });
          log.info("Review-complaint keyword mining complete", miningResult);
        } catch (err) {
          log.warn("Review-complaint keyword mining failed", { error: getErrorMessage(err) });
        }
      }

      const now = Date.now();
      if (now - lastReviewHarvestRunAt >= cfg.minIntervalMs) {
        lastReviewHarvestRunAt = now;

        const multiplier = adaptiveThrottleEnabled ? sweepThrottleState.multiplier : 1;
        const effectiveAppsPerTick = computeEffectiveAppsPerTick(cfg.appsPerTick, multiplier);

        const result = await harvestDueApps({
          appsPerTick: effectiveAppsPerTick,
          storefront: cfg.storefront,
          pageDelayMs: cfg.pageDelayMs,
          dailyRequestBudget: cfg.dailyRequestBudget,
          maxConsecutiveEmptyHarvests: cfg.maxConsecutiveEmptyHarvests,
          memoryIndexing: cfg.memoryIndexing,
          useProxy: cfg.useProxy,
        });

        if (result.skipped) {
          log.debug("Review harvest pass skipped this cycle", { effectiveAppsPerTick });
        } else {
          log.info("Review harvest pass complete", {
            appsHarvested: result.appsHarvested,
            pagesFetched: result.pagesFetched,
            reviewsFound: result.reviewsFound,
            newReviews: result.newReviews,
            deactivated: result.deactivated,
            attempted: result.attempted,
            rateLimitErrors: result.rateLimitErrors,
            bailed: result.bailed,
            effectiveAppsPerTick,
          });

          // Throttle ownership: no longer feeds the gap-sweep's
          // `tickThrottle` (see the throttle-ownership note above
          // `sweepThrottleState`) — self-protects via `retryOnRateLimit`
          // like every other auxiliary lane.
        }
      }

      // Review-harvest ledger prune — its own cadence gate.
      if (Date.now() - lastReviewLedgerPruneRunAt >= cfg.ledgerPrune.minIntervalMs) {
        lastReviewLedgerPruneRunAt = Date.now();
        try {
          const { pruned } = await runReviewHarvestLedgerPrune(Math.floor(cfg.ledgerPrune.maxAgeMs / 1000));
          log.debug("Review-harvest ledger pruned", { pruned });
        } catch (err) {
          log.warn("Review-harvest ledger prune failed", { error: getErrorMessage(err) });
        }
      }
    } catch (err) {
      log.warn("Review harvest failed", { error: getErrorMessage(err) });
    }
  }

  // Runs the app-meta registry's Lookup-API enrichment pass (deep-scrape
  // build Stage 2 — see `app-enrichment.ts`'s `runEnrichmentPass` and
  // `app-meta-store.ts`), plus its developer-portfolio sub-pass and
  // lookup-request ledger prune, each gated to its OWN cadence — NO new
  // timer (build plan §0.4): all three ride this ~1min sweep tick. Respects
  // the SAME `legacyRateOverride` kill-switch and SHARED `sweepThrottleState`
  // as the scan sweep/autocomplete/DE-storefront passes — a rate-limit spike
  // in any lane backs off every lane. Never allowed to break the sweep tick —
  // a failure is logged and swallowed, mirroring the other "IfDue" passes.
  async function runAppEnrichmentIfDue(): Promise<void> {
    try {
      const fullCfg = loadConfig();
      const cfg = fullCfg.appstoreAppEnrichment;
      if (!cfg.enabled) return;
      if (fullCfg.appstoreKeywordGap.sweepRateSafety.legacyRateOverride) {
        log.debug("App enrichment skipped — legacy rate override active");
        return;
      }
      const adaptiveThrottleEnabled = fullCfg.appstoreKeywordGap.sweepRateSafety.adaptiveThrottleEnabled;

      // One-shot registry backfill — see `registryBackfillDone`'s doc comment.
      if (!registryBackfillDone) {
        registryBackfillDone = true;
        try {
          const { inserted } = await runRegistryBackfillOnce();
          log.info("App-meta registry backfill complete", { inserted });
        } catch (err) {
          log.warn("App-meta registry backfill failed", { error: getErrorMessage(err) });
        }
      }

      const now = Date.now();
      if (now - lastEnrichmentRunAt >= cfg.minIntervalMs) {
        lastEnrichmentRunAt = now;

        const multiplier = adaptiveThrottleEnabled ? sweepThrottleState.multiplier : 1;
        const effectiveMaxBatches = computeEffectiveMaxBatches(cfg.maxBatchesPerPass, multiplier);

        const result = await runEnrichmentPass({
          batchSize: cfg.batchSize,
          maxBatches: effectiveMaxBatches,
          staleAfterSeconds: Math.floor(cfg.staleAfterMs / 1000),
          acceleratingLimit: cfg.acceleratingLimit,
          dailyRequestBudget: cfg.dailyRequestBudget,
          delistMissThreshold: cfg.delistMissThreshold,
          useProxy: cfg.useProxy,
        });

        if (result.skipped) {
          log.debug("App enrichment pass skipped this cycle", { effectiveMaxBatches });
        } else {
          log.info("App enrichment pass complete", {
            enriched: result.enrichedCount,
            misses: result.missCount,
            delisted: result.delistedCount,
            relisted: result.relistedCount,
            chartNewbornVelocity: result.chartNewbornVelocityCount,
            attempted: result.attempted,
            rateLimitErrors: result.rateLimitErrors,
            bailed: result.bailed,
            effectiveMaxBatches,
          });

          // Throttle ownership: no longer feeds the gap-sweep's
          // `tickThrottle` (see the throttle-ownership note above
          // `sweepThrottleState`) — self-protects via `retryOnRateLimit`
          // like every other auxiliary lane.
        }
      }

      // Developer-portfolio sub-pass — its own cadence gate, independent of
      // the enrichment pass's `minIntervalMs` above.
      if (cfg.portfolio.enabled && now - lastPortfolioRunAt >= cfg.portfolio.minIntervalMs) {
        lastPortfolioRunAt = now;
        const portfolioResult = await runPortfolioPass({
          developerLimit: cfg.portfolio.developerLimit,
          portfolioLimit: cfg.portfolio.portfolioLimit,
          minIntervalSeconds: Math.floor(cfg.portfolio.minRescanIntervalMs / 1000),
          useProxy: cfg.useProxy,
        });
        log.info("Developer portfolio pass complete", {
          developersScanned: portfolioResult.developersScanned,
          newSightings: portfolioResult.newSightings,
          attempted: portfolioResult.attempted,
          rateLimitErrors: portfolioResult.rateLimitErrors,
          bailed: portfolioResult.bailed,
        });

        // Throttle ownership: no longer feeds the gap-sweep's `tickThrottle`
        // (see the throttle-ownership note above `sweepThrottleState`) —
        // self-protects via `retryOnRateLimit` like every other auxiliary
        // lane.
      }

      // Lookup-request ledger prune — its own cadence gate.
      if (now - lastLedgerPruneRunAt >= cfg.ledgerPrune.minIntervalMs) {
        lastLedgerPruneRunAt = now;
        try {
          const { pruned } = await runLookupLedgerPrune(Math.floor(cfg.ledgerPrune.maxAgeMs / 1000));
          log.debug("Lookup-request ledger pruned", { pruned });
        } catch (err) {
          log.warn("Lookup-request ledger prune failed", { error: getErrorMessage(err) });
        }
      }
    } catch (err) {
      log.warn("App enrichment failed", { error: getErrorMessage(err) });
    }
  }

  // Runs the app-page HTML lane (deep-scrape build Stage 5 — see
  // `app-pages.ts`'s `runAppPageSyncPass`/`runAppPageFetchPass`), each gated
  // to its OWN cadence — NO new timer (build plan §0.4): both ride this
  // ~1min sweep tick, same pattern as `runAppEnrichmentIfDue` above.
  // Respects the SAME `legacyRateOverride` kill-switch and SHARED
  // `sweepThrottleState` as every other lane on this tick — a rate-limit
  // spike in any lane backs off every lane. Never allowed to break the
  // sweep tick — a failure is logged and swallowed, mirroring the other
  // "IfDue" passes.
  async function runAppPageEnrichmentIfDue(): Promise<void> {
    try {
      const fullCfg = loadConfig();
      const cfg = fullCfg.appstoreAppPages;
      if (!cfg.enabled) return;
      if (fullCfg.appstoreKeywordGap.sweepRateSafety.legacyRateOverride) {
        log.debug("App-page enrichment skipped — legacy rate override active");
        return;
      }
      const adaptiveThrottleEnabled = fullCfg.appstoreKeywordGap.sweepRateSafety.adaptiveThrottleEnabled;

      // Tier-sync sub-pass — its own cadence gate, independent of the fetch
      // pass's `minIntervalMs` below. No network calls of its own (pure DB
      // read/write), so it isn't throttle-scaled.
      if (cfg.sync.enabled && Date.now() - lastAppPagesSyncRunAt >= cfg.sync.minIntervalMs) {
        lastAppPagesSyncRunAt = Date.now();
        try {
          const syncResult = await runAppPageSyncPass({
            hotSignatureHitCap: cfg.sync.hotSignatureHitCap,
            hotVelocityCap: cfg.sync.hotVelocityCap,
            rollingAddPerSync: cfg.sync.rollingAddPerSync,
          });
          log.info("App-page tier sync complete", syncResult);
        } catch (err) {
          log.warn("App-page tier sync failed", { error: getErrorMessage(err) });
        }
      }

      const now = Date.now();
      if (now - lastAppPagesFetchRunAt >= cfg.minIntervalMs) {
        lastAppPagesFetchRunAt = now;

        const multiplier = adaptiveThrottleEnabled ? sweepThrottleState.multiplier : 1;
        const effectivePagesPerBatch = Math.max(0, Math.floor(cfg.pagesPerBatch * multiplier));

        const result = await runAppPageFetchPass({
          pagesPerBatch: effectivePagesPerBatch,
          storefront: cfg.storefront,
          requestDelayMs: cfg.requestDelayMs,
          dailyPageBudget: cfg.dailyPageBudget,
          hotIntervalSeconds: Math.floor(cfg.hotIntervalMs / 1000),
          rollingIntervalSeconds: Math.floor(cfg.rollingIntervalMs / 1000),
          canaryMinBatchSize: cfg.canary.minBatchSize,
          canaryParseFailureThreshold: cfg.canary.parseFailureThreshold,
          useProxy: cfg.useProxy,
        });

        if (result.skipped) {
          log.debug("App-page fetch pass skipped this cycle", { effectivePagesPerBatch });
        } else {
          log.info("App-page fetch pass complete", {
            attempted: result.attempted,
            succeeded: result.succeeded,
            gone: result.gone,
            failed: result.failed,
            parseFailed: result.parseFailed,
            rateLimitErrors: result.rateLimitErrors,
            bailed: result.bailed,
            canaryTripped: result.canaryTripped,
            effectivePagesPerBatch,
          });

          // Throttle ownership: no longer feeds the gap-sweep's
          // `tickThrottle` (see the throttle-ownership note above
          // `sweepThrottleState`) — self-protects via `retryOnRateLimit`
          // like every other auxiliary lane.
        }
      }
    } catch (err) {
      log.warn("App-page enrichment failed", { error: getErrorMessage(err) });
    }
  }

  // Runs the keyword-scans retention prune (B3 — see `keyword-store.ts`'s
  // `pruneKeywordScans`): an AGE-ONLY, chunked DELETE of
  // `appstore_keyword_scans` rows older than `scansRetention.maxAgeMs`, with a
  // keep-newest-N-per-(keyword,store) guard so the dashboard's scan-history
  // (up to limit=200) is never truncated. Gated to its own ~6h cadence and
  // to its `enabled` flag; DB-only (no Apple requests, so it feeds nothing
  // into the shared throttle). Never allowed to break the sweep tick — a
  // failure is logged and swallowed, mirroring the ledger prunes.
  async function runScansRetentionIfDue(): Promise<void> {
    try {
      const cfg = loadConfig().appstoreKeywordGap.scansRetention;
      if (!cfg.enabled) return;

      const now = Date.now();
      if (now - lastScansPruneRunAt < cfg.minIntervalMs) return;
      lastScansPruneRunAt = now;

      const { pruned } = await pruneKeywordScans({
        maxAgeSeconds: Math.floor(cfg.maxAgeMs / 1000),
        keepNewestPerKeyword: cfg.keepNewestPerKeyword,
        chunkSize: cfg.chunkSize,
        maxChunks: cfg.maxChunksPerRun,
      });
      log.info("Keyword-scans retention prune complete", { pruned });
    } catch (err) {
      log.warn("Keyword-scans retention prune failed", { error: getErrorMessage(err) });
    }
  }

  // Runs the newborn-velocity screener over the whole corpus's latest scans,
  // gated to `appstoreSignatureScreener.minRunIntervalMs` (default 6h) so it
  // doesn't re-scan the full corpus on every keyword-sweep tick. Gated by its
  // own `enabled` flag (default ON — the screener is a read-only pass over
  // data the sweep already collected, no extra network calls). Never allowed
  // to break the sweep — a failure is logged and swallowed, mirroring
  // `keywordSweepTick`'s own failure handling.
  async function runSignatureScreenerIfDue(): Promise<void> {
    try {
      const cfg = loadConfig().appstoreSignatureScreener;
      if (!cfg.enabled) return;

      const now = Date.now();
      if (now - lastScreenerRunAt < cfg.minRunIntervalMs) return;
      lastScreenerRunAt = now;

      const result = await runScreener();
      log.info("Newborn-velocity screener triggered", {
        evaluated: result.evaluated,
        hits: result.hits,
        newHits: result.newHits,
      });
    } catch (err) {
      log.warn("Newborn-velocity screener failed", { error: getErrorMessage(err) });
    }
  }

  // New-hit / first-crossing alert digest (Batch F4 — see `gap-alerts.ts`).
  // Default OFF (`appstoreKeywordGap.alerts.enabled`): unlike the other
  // *IfDue lanes on this tick, this actually sends a message to the
  // operator's primary Telegram chat via the EXISTING cron delivery queue
  // (`DeliveryStore.enqueue` — never a separate Telegram bot instance here,
  // avoiding a duplicate-poller 409 risk), so it stays opt-in. Never throws
  // — failures are logged and swallowed, same pattern as every other lane on
  // this tick.
  async function runGapAlertsIfDue(): Promise<void> {
    try {
      const fullConfig = loadConfig();
      const cfg = fullConfig.appstoreKeywordGap;
      if (!cfg.alerts.enabled) return;

      const now = Date.now();
      if (now - lastGapAlertsRunAt < cfg.alerts.minRunIntervalMs) return;
      lastGapAlertsRunAt = now;

      const primaryUserId = fullConfig.channels.telegram.allowedUserIds[0];
      if (!primaryUserId) {
        log.debug("Gap alerts skipped — no primary Telegram user configured");
        return;
      }

      const result = await runGapAlerts({
        opportunityThreshold: cfg.opportunityThresholdForSeed,
        channel: "telegram",
        chatId: String(primaryUserId),
      });
      log.info("Gap alerts run complete", result);
    } catch (err) {
      log.warn("Gap alerts run failed", { error: getErrorMessage(err) });
    }
  }

  async function tick(): Promise<void> {
    if (running) {
      log.info("App Store scrape already running, skipping");
      return;
    }

    running = true;
    try {
      await scrape();
    } catch (err) {
      const msg = getErrorMessage(err);
      log.error("App Store scrape error", { error: msg });
    } finally {
      running = false;
    }
  }

  return {
    async start() {
      if (timer) return;
      const intervalMs = await loadScraperIntervalMs("appstore", DEFAULT_INTERVAL_MINUTES);
      timer = setInterval(tick, intervalMs);
      log.info("App Store scraper started", { tickMs: intervalMs });
      tick().catch((err) =>
        log.error("App Store scraper first tick error", { error: err }),
      );

      if (!keywordSweepTimer) {
        const sweepIntervalMs = loadConfig().appstoreKeywordGap.scanIntervalMs;
        keywordSweepTimer = setInterval(keywordSweepTick, sweepIntervalMs);
        log.info("Keyword-gap sweep timer started", { sweepIntervalMs });
        keywordSweepTick().catch((err) =>
          log.error("Keyword-gap sweep first tick error", { error: err }),
        );
      }

      // Independent-tick decouple (throughput fix, 2026-07-23): the
      // auxiliary lanes get their own timer + single-flight lock so a long
      // auxiliary chain can never block the gap-sweep above. Each lane is
      // self-gated to its own `...IfDue` cadence internally, so reusing the
      // gap-sweep's `scanIntervalMs` here is just a due-ness check
      // frequency, not a request-volume driver.
      if (!auxiliaryLanesTimer) {
        const sweepIntervalMs = loadConfig().appstoreKeywordGap.scanIntervalMs;
        auxiliaryLanesTimer = setInterval(auxiliaryLanesTick, sweepIntervalMs);
        log.info("Auxiliary keyword-gap lanes timer started", { sweepIntervalMs });
        auxiliaryLanesTick().catch((err) =>
          log.error("Auxiliary keyword-gap lanes first tick error", { error: err }),
        );
      }

      // Proxied second scan stream (2026-07-24): its own timer + lock,
      // same due-ness cadence as the gap-sweep. The timer always runs; the
      // tick itself no-ops until `appstoreKeywordGap.proxyStream.enabled`
      // is flipped on (config is re-read per tick, so arming the stream
      // needs no restart) — matching how `keywordSweepTick` gates on
      // `cfg.enabled`.
      if (!proxyStreamTimer) {
        const sweepIntervalMs = loadConfig().appstoreKeywordGap.scanIntervalMs;
        proxyStreamTimer = setInterval(proxyStreamTick, sweepIntervalMs);
        log.info("Proxied scan stream timer started", {
          sweepIntervalMs,
          enabled: loadConfig().appstoreKeywordGap.proxyStream.enabled,
        });
        proxyStreamTick().catch((err) =>
          log.error("Proxied scan stream first tick error", { error: err }),
        );
      }
    },

    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
        log.info("App Store scraper stopped");
      }
      if (keywordSweepTimer) {
        clearInterval(keywordSweepTimer);
        keywordSweepTimer = null;
        log.info("Keyword-gap sweep timer stopped");
      }
      if (auxiliaryLanesTimer) {
        clearInterval(auxiliaryLanesTimer);
        auxiliaryLanesTimer = null;
        log.info("Auxiliary keyword-gap lanes timer stopped");
      }
      if (proxyStreamTimer) {
        clearInterval(proxyStreamTimer);
        proxyStreamTimer = null;
        log.info("Proxied scan stream timer stopped");
      }
    },

    async scrapeNow(): Promise<ScrapeResult> {
      if (running) {
        return { ok: false, error: "Already running" };
      }

      running = true;
      try {
        return await scrape();
      } finally {
        running = false;
      }
    },
  };
}
