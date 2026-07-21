// International storefront chart sweep (deep-scrape build Stage 3): fetches
// the SAME per-category iTunes RSS charts as the existing hourly US pass
// (see charts.ts / scraper.ts's `scrape()`), but for non-US storefronts
// (GB/CA/AU by default — `appstoreSync.intlCharts`). Registers sightings
// into the app-meta registry with source 'chart-intl' (build plan §0.1) so
// an app discovered ONLY in an intl storefront still gets drained by the
// enrichment pass (Stage 2) and, later, the review harvester's
// 'chart-newborn' cohort (Stage 4).
//
// Mirrors keyword-gaps.ts's `runDeStorefrontSweep` shape: a flat work list,
// per-item try/catch, a 5-consecutive-failure bail, and rate-limit-error
// counting the caller (scraper.ts's `runIntlChartsIfDue`) folds into the ONE
// shared `sweepThrottleState` — a spike here backs off every other lane too.
// Never throws itself; `scraper.ts` keeps its "IfDue" passes as thin
// cadence/config gates around this.

import { getErrorMessage } from "../../lib/error-serialization";
import { createLogger } from "../../logger";
import type { AppstoreSyncListType } from "../../config/schema";
import { RateLimitError, ssrfSafeFetch } from "../shared/ssrf-safe-fetch";
import { isPassOverBudget } from "../shared/pass-deadline";
import { recordAppSightings } from "./app-meta-store";
import {
  ITUNES_CATEGORIES,
  buildCategoryRankingUrl,
  categoryListTypeTag,
  dedupeRankingsByListKey,
  parseTopAppsItunes,
} from "./charts";
import { type AppRankingRow, upsertRankings } from "./store";

const log = createLogger("appstore:charts-intl");

// Mirrors keyword-gaps.ts's `MAX_CONSECUTIVE_FAILURES` / app-enrichment.ts's
// own copy — same "upstream looks wedged, stop burning the rest of the pass"
// rationale, applied here at the (storefront, category, listType) work-item
// granularity.
const MAX_CONSECUTIVE_FAILURES = 5;

// Wall-clock budget for one sweep (see `pass-deadline.ts`'s doc comment for
// the 2026-07-21 incident this guards against): this lane's work list is by
// far the largest of the four deep-scrape lanes on the shared
// `keywordSweepTick` (up to storefronts × 23 categories × listTypes — 207
// items at the schema default), so it's the one most exposed to a
// slow-but-not-failing upstream running past the consecutive-failure bail
// above. 5 minutes bounds the worst case from 100+ minutes (207 items × a
// ~30s per-request `ssrfSafeFetch` timeout) down to something the shared
// single-flight tick guard can recover from on the NEXT cycle.
const MAX_PASS_DURATION_MS = 5 * 60_000;

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

interface WorkItem {
  readonly storefront: string;
  readonly genreId: number;
  readonly listType: AppstoreSyncListType;
}

/**
 * Full (category × listType × storefront) work list — storefront innermost
 * so a throttle-truncated pass (see `runIntlChartsSweep`'s slice below)
 * still touches every storefront partially rather than dropping later
 * storefronts entirely.
 */
function buildWorkList(
  storefronts: readonly string[],
  listTypes: readonly AppstoreSyncListType[],
): readonly WorkItem[] {
  const items: WorkItem[] = [];
  for (const cat of ITUNES_CATEGORIES) {
    for (const listType of listTypes) {
      for (const storefront of storefronts) {
        items.push({ storefront, genreId: cat.id, listType });
      }
    }
  }
  return items;
}

export interface IntlChartsSweepResult {
  readonly scanned: number;
  readonly failed: number;
  readonly bailed: boolean;
  readonly rateLimitErrors: number;
  readonly sightingsRecorded: number;
}

const EMPTY_RESULT: IntlChartsSweepResult = {
  scanned: 0,
  failed: 0,
  bailed: false,
  rateLimitErrors: 0,
  sightingsRecorded: 0,
};

/**
 * One intl-charts sweep: fetches every (category, listType) combination for
 * every configured storefront (work list truncated by `throttleMultiplier`,
 * build plan §0.4), upserts the resulting rankings (tagged with their
 * storefront — migration 046), and records app-meta sightings per storefront
 * group with source `'chart-intl'`.
 */
export async function runIntlChartsSweep(opts: {
  readonly storefronts: readonly string[];
  readonly listTypes: readonly AppstoreSyncListType[];
  readonly perCategoryLimit: number;
  readonly delayMs: number;
  readonly throttleMultiplier: number;
}): Promise<IntlChartsSweepResult> {
  const fullWorkList = buildWorkList(opts.storefronts, opts.listTypes);
  const effectiveLength = Math.max(0, Math.floor(fullWorkList.length * opts.throttleMultiplier));
  const workList = fullWorkList.slice(0, effectiveLength);

  if (workList.length === 0) {
    return EMPTY_RESULT;
  }

  let scanned = 0;
  let failed = 0;
  let bailed = false;
  let rateLimitErrors = 0;
  let consecutiveFailures = 0;
  const allRows: AppRankingRow[] = [];
  const passStartedAt = Date.now();

  for (const item of workList) {
    if (isPassOverBudget(passStartedAt, MAX_PASS_DURATION_MS)) {
      bailed = true;
      log.warn("Intl charts sweep bailing early — exceeded wall-clock budget", {
        elapsedMs: Date.now() - passStartedAt,
        scanned,
        remaining: workList.length - scanned - failed,
      });
      break;
    }
    try {
      const url = buildCategoryRankingUrl(
        item.genreId,
        item.listType,
        opts.perCategoryLimit,
        item.storefront,
      );
      // Opt into the shared rate-limit backoff, same as keyword-gaps.ts's
      // `fetchTopApps` — on exhausted retries `ssrfSafeFetch` throws
      // `RateLimitError`, handled generically by the consecutive-failure
      // bail below.
      const res = await ssrfSafeFetch(url, { retryOnRateLimit: true });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} for ${url}`);
      }
      const data = await res.json();
      const listTypeTag = categoryListTypeTag(item.genreId, item.listType);
      const rows = parseTopAppsItunes(data, listTypeTag, item.storefront);
      allRows.push(...rows);
      scanned++;
      consecutiveFailures = 0;
    } catch (err) {
      failed++;
      consecutiveFailures++;
      if (isRateLimitError(err)) rateLimitErrors++;
      log.warn("Intl chart category fetch failed — skipping", {
        storefront: item.storefront,
        genreId: item.genreId,
        listType: item.listType,
        error: getErrorMessage(err),
      });
      // Upstream looks wedged: stop burning the rest of the work list into a
      // wall of failures and persist what was already fetched.
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        bailed = true;
        log.warn("Intl charts sweep bailing early — too many consecutive failures", {
          consecutiveFailures,
        });
        break;
      }
    }

    await sleep(opts.delayMs);
  }

  const deduped = dedupeRankingsByListKey(allRows);

  if (deduped.length > 0) {
    await upsertRankings(deduped);
  }

  // Sightings are recorded PER STOREFRONT — `recordAppSightings` takes one
  // storefront for the whole call (stamped as `first_seen_storefront` on any
  // newly-registered id), so rows from different storefronts can't share a
  // call.
  let sightingsRecorded = 0;
  const byStorefront = new Map<string, AppRankingRow[]>();
  for (const row of deduped) {
    const sf = row.storefront ?? "us";
    const bucket = byStorefront.get(sf);
    if (bucket) {
      bucket.push(row);
    } else {
      byStorefront.set(sf, [row]);
    }
  }
  for (const [storefront, rows] of byStorefront) {
    try {
      sightingsRecorded += await recordAppSightings(rows, "chart-intl", { storefront });
    } catch (err) {
      log.warn("App-meta sighting recording failed (intl charts)", {
        storefront,
        error: getErrorMessage(err),
      });
    }
  }

  return { scanned, failed, bailed, rateLimitErrors, sightingsRecorded };
}
