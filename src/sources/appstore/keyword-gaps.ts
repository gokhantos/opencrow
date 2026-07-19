// iTunes fetch shell + scanKeyword orchestration for the App Store
// keyword-gap scanner. Fetches the live top-N results for a keyword from the
// iTunes Search API, maps them into `TopApp`s, and runs them through the pure
// scoring core in `keyword-scoring.ts` to produce a `KeywordGapProfile`.

import { z } from "zod";
import { loadConfig } from "../../config/loader";
import { createLogger } from "../../logger";
import { RateLimitError, ssrfSafeFetch } from "../shared/ssrf-safe-fetch";
import { recordVelocityObservationsForScan } from "./app-velocity-store";
import { shouldDeactivateKeyword, DEACTIVATION_MIN_SCANS } from "./keyword-deactivation";
import type { DeactivationCandidate } from "./keyword-deactivation";
import {
  classifyTrend,
  computeCompetitiveness,
  computeDemand,
  computeIncumbentWeakness,
  computeOpportunity,
} from "./keyword-scoring";
import type { KeywordGapProfile, TopApp } from "./keyword-types";
import {
  countScansSince,
  deactivateJunkKeywords,
  getKeywordMeta,
  getScanHistory,
  getStaleKeywords,
  getStaleKeywordsTiered,
  insertScan,
  markScanned,
} from "./keyword-store";

const log = createLogger("appstore:keyword-gaps");

const DEFAULT_TOP_N = 20;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
// How many prior scans to pull for momentum + velocity. Must be deep enough to
// reach a velocity baseline that is at least MIN_VELOCITY_WINDOW_DAYS (12h) old:
// under the live sweep a ~1,200-keyword corpus at 25/min re-scans each keyword
// roughly every ~48 minutes, so a 12h-old baseline sits ~15 scans back. 24
// covers ~19h of history with margin while staying bounded.
const HISTORY_LIMIT = 24;
// Minimum age of a prior scan before its review counts are trusted as a
// velocity baseline. Under the ~1-minute sweep cadence the immediately-previous
// scan is only ~48 min old — far too fresh to diff, since a 1-review delta over
// such a short window annualizes to a wildly noisy ratings/day. We instead pick
// the newest prior scan at least this old; below this we fall back to lifetime.
const MIN_VELOCITY_WINDOW_DAYS = 0.5;
// Consecutive `scanKeyword` throws that trip the sweep's early-bail guard. The
// scan runs every minute; if the upstream (iTunes / rate-limit backoff) is
// wedged, bail the rest of the batch instead of burning the whole slice into a
// wall of failures. Detected generically via a counter — no cross-module error
// type is imported.
const MAX_CONSECUTIVE_FAILURES = 5;

// ---------------------------------------------------------------------------
// iTunes Search API response — parsed defensively. A single malformed row
// (missing/non-numeric fields, unparseable date) must not crash the scan;
// every field falls back to a safe default instead of throwing.
// ---------------------------------------------------------------------------

const ItunesSoftwareResultSchema = z
  .object({
    trackId: z.coerce.number().catch(0),
    trackName: z.string().catch(""),
    userRatingCount: z.coerce.number().catch(0),
    averageUserRating: z.coerce.number().catch(0),
    releaseDate: z.string().catch(""),
    currentVersionReleaseDate: z.string().catch(""),
    price: z.coerce.number().catch(0),
    formattedPrice: z.string().catch(""),
  })
  .catch({
    trackId: 0,
    trackName: "",
    userRatingCount: 0,
    averageUserRating: 0,
    releaseDate: "",
    currentVersionReleaseDate: "",
    price: 0,
    formattedPrice: "",
  });

const ItunesSearchResponseSchema = z.object({
  results: z.array(ItunesSoftwareResultSchema).catch([]),
});

export type ItunesSoftwareResult = z.infer<typeof ItunesSoftwareResultSchema>;

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

function tokenize(text: string): readonly string[] {
  return text
    .toLowerCase()
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

/** Days between `releaseDate` and `now`, clamped to a minimum of 1. */
function computeAgeDays(releaseDate: string, now: number): number {
  const releasedAt = Date.parse(releaseDate);
  if (Number.isNaN(releasedAt)) return 1;
  const days = Math.floor((now - releasedAt) / MS_PER_DAY);
  return Math.max(days, 1);
}

/** Days since `date`, or `undefined` when the date is missing/unparseable. */
function daysSince(date: string, now: number): number | undefined {
  const at = Date.parse(date);
  if (Number.isNaN(at)) return undefined;
  return Math.max(Math.floor((now - at) / MS_PER_DAY), 0);
}

export function toTopApp(raw: ItunesSoftwareResult, keyword: string, now: number): TopApp {
  const ageDays = computeAgeDays(raw.releaseDate, now);
  const keywordTokens = tokenize(keyword);
  const nameTokens = raw.trackName.toLowerCase();
  const titleMatch = keywordTokens.length > 0 && keywordTokens.every((t) => nameTokens.includes(t));
  const lastUpdatedDays = daysSince(raw.currentVersionReleaseDate, now);
  const formattedPrice = raw.formattedPrice.trim();

  return {
    id: String(raw.trackId),
    name: raw.trackName,
    reviews: raw.userRatingCount,
    rating: raw.averageUserRating,
    ageDays,
    ratingsPerDay: raw.userRatingCount / Math.max(ageDays, 1),
    titleMatch,
    ...(lastUpdatedDays !== undefined ? { lastUpdatedDays } : {}),
    price: raw.price,
    ...(formattedPrice.length > 0 ? { formattedPrice } : {}),
  };
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

export async function fetchTopApps(keyword: string, topN: number): Promise<readonly TopApp[]> {
  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(keyword)}&entity=software&limit=${topN}&country=us`;

  // Opt into the shared rate-limit backoff: at the ~1/min sweep cadence this
  // scanner must honor iTunes 429/503 instead of hammering. On exhausted
  // retries ssrfSafeFetch throws RateLimitError — the sweep's consecutive-throw
  // bail already handles repeated throws generically (no type import needed).
  const res = await ssrfSafeFetch(url, { retryOnRateLimit: true });
  if (!res.ok) {
    throw new Error(`iTunes search failed for "${keyword}": HTTP ${res.status}`);
  }

  const json = await res.json();
  const parsed = ItunesSearchResponseSchema.safeParse(json);
  if (!parsed.success) {
    log.warn("iTunes response failed schema validation — treating as empty result set", {
      keyword,
    });
    return [];
  }

  const now = Date.now();
  return parsed.data.results.map((raw) => toTopApp(raw, keyword, now));
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

/**
 * Attach a `recentVelocity` (ratings/day since the baseline scan) to each app
 * whose review count we can diff against `baselineReviews`. The caller selects a
 * baseline that is already at least `MIN_VELOCITY_WINDOW_DAYS` old; when no such
 * baseline exists (empty map) or the window is degenerate, the app is left as-is
 * so the pure scorer falls back to its lifetime `ratingsPerDay`. Immutable:
 * returns new TopApp objects.
 */
function enrichWithVelocity(
  apps: readonly TopApp[],
  baselineReviews: ReadonlyMap<string, number>,
  daysBetweenScans: number,
): readonly TopApp[] {
  if (baselineReviews.size === 0 || daysBetweenScans < MIN_VELOCITY_WINDOW_DAYS) {
    return apps;
  }
  return apps.map((a) => {
    const prev = baselineReviews.get(a.id);
    if (prev === undefined) return a;
    const recentVelocity = Math.max(0, a.reviews - prev) / daysBetweenScans;
    return { ...a, recentVelocity };
  });
}

export async function scanKeyword(
  keyword: string,
  opts?: { readonly topN?: number; readonly store?: "app" | "play" },
): Promise<KeywordGapProfile> {
  const topN = opts?.topN ?? DEFAULT_TOP_N;
  const store = opts?.store ?? "app";
  const scannedAt = Math.floor(Date.now() / 1000);

  const fetched = await fetchTopApps(keyword, topN);

  // Prior scans (this store, newest-first) drive both live velocity and
  // momentum: an old-enough scan is the velocity baseline; the whole series
  // feeds trend.
  const history = (await getScanHistory(keyword, HISTORY_LIMIT)).filter((h) => h.store === store);

  // Velocity baseline: the NEWEST prior scan at least MIN_VELOCITY_WINDOW_DAYS
  // old. The immediately-previous scan is only ~48 min old under the live
  // cadence — too fresh to diff — so we look further back to a scan carrying a
  // meaningful review delta. Only when no prior scan is yet that old (genuinely
  // early days for this keyword) do we fall back to the lifetime average.
  const baseline = history.find(
    (h) => (scannedAt - h.scannedAt) / 86_400 >= MIN_VELOCITY_WINDOW_DAYS,
  );
  const baselineReviews = new Map<string, number>(
    (baseline?.topApps ?? []).map((a) => [a.id, a.reviews]),
  );
  const daysBetweenScans = baseline ? (scannedAt - baseline.scannedAt) / 86_400 : 0;

  const topApps = enrichWithVelocity(fetched, baselineReviews, daysBetweenScans);

  // Demand + weakness are about the apps actually serving this phrase: restrict
  // to title-matched incumbents, falling back to the whole field only when
  // nothing matches. Competitiveness stays over the whole ranked field — that
  // is the crowd a new entrant ranks against.
  const matched = topApps.filter((a) => a.titleMatch);
  const relevant = matched.length > 0 ? matched : topApps;

  const demand = computeDemand(relevant);
  const competitiveness = computeCompetitiveness(topApps);
  const incumbentWeakness = computeIncumbentWeakness(relevant);

  // Oldest → newest demand series (prior scans, newest-first from the store),
  // with the current demand appended, so momentum reflects this reading too.
  const demandSeries = [...history.map((h) => h.demand).reverse(), demand];
  const trend = classifyTrend(demandSeries);

  const opportunity = computeOpportunity({ demand, competitiveness, incumbentWeakness, trend });

  const topAppReviews = topApps.reduce((max, a) => Math.max(max, a.reviews), 0);
  const avgRating = mean(topApps.map((a) => a.rating));
  const avgAgeDays = mean(topApps.map((a) => a.ageDays));

  return {
    keyword,
    store,
    competitiveness,
    demand,
    incumbentWeakness,
    opportunity,
    trend,
    topAppReviews,
    avgRating,
    avgAgeDays,
    topApps,
    scannedAt,
  };
}

// ---------------------------------------------------------------------------
// Sweeps — scan a slice of stale keywords within a budget, throttled between
// requests. A single bad keyword must never abort a sweep: failures are
// counted and logged, not thrown. `runScanSlice` scans one genre zone;
// `runKeywordSweep` (below) scans the stalest keywords across the whole
// corpus and is what the timer-driven scraper actually calls.
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Builds the `keyword-deactivation.ts` predicate input for `profile`'s
 * keyword: its corpus `source` (via `getKeywordMeta`) and its total scan
 * count (via a `LIMIT DEACTIVATION_MIN_SCANS` history probe — cheap, and we
 * only need to know whether it's >= that threshold, not the exact count). A
 * keyword with no corpus row (shouldn't happen in practice — scans only ever
 * target corpus keywords) returns `null`, skipping deactivation for it
 * rather than guessing a source.
 */
async function buildDeactivationCandidate(
  profile: KeywordGapProfile,
): Promise<DeactivationCandidate | null> {
  const meta = await getKeywordMeta(profile.keyword);
  if (!meta) return null;
  const history = await getScanHistory(profile.keyword, DEACTIVATION_MIN_SCANS);
  return {
    keyword: profile.keyword,
    source: meta.source,
    scanCount: history.length,
    demand: profile.demand,
    topApps: profile.topApps,
    topAppReviews: profile.topAppReviews,
  };
}

/**
 * True iff `err` is (or carries the code of) `RateLimitError` — thrown by
 * `ssrfSafeFetch` when its rate-limit backoff retries are exhausted (see
 * `fetchTopApps` above, which opts in via `retryOnRateLimit: true`). Checked
 * via BOTH `instanceof` and the `.code` string per `RateLimitError`'s own
 * doc comment: the `.code` duck-type check is primary (works even if a test
 * mocks `../shared/ssrf-safe-fetch` without re-exporting the real class, or
 * if the error crossed some other module boundary that lost class
 * identity); `RateLimitError &&` guards `instanceof` against that same
 * mocked-module case, where the import itself would be `undefined` and
 * `instanceof undefined` would throw.
 */
function isRateLimitError(err: unknown): boolean {
  if (RateLimitError && err instanceof RateLimitError) return true;
  return (err as { code?: unknown } | null)?.code === "RATE_LIMITED";
}

async function scanAndRecord(
  keywords: readonly string[],
  opts: { readonly topN: number; readonly delayMs: number; readonly logContext?: Record<string, unknown> },
): Promise<{ scanned: number; failed: number; bailed: boolean; rateLimitErrors: number }> {
  const { appstoreVelocity, appstoreJunkDeactivation } = loadConfig();
  const succeeded: string[] = [];
  const toDeactivate: string[] = [];
  let scanned = 0;
  let failed = 0;
  let rateLimitErrors = 0;
  let consecutiveFailures = 0;
  let bailed = false;

  for (const keyword of keywords) {
    try {
      const profile = await scanKeyword(keyword, { topN: opts.topN });
      await insertScan(profile);
      succeeded.push(keyword);
      scanned++;
      consecutiveFailures = 0;

      // Newborn-velocity time-series: bounded, read-mostly bookkeeping over
      // data this scan already fetched — never allowed to break the sweep.
      if (appstoreVelocity.enabled) {
        try {
          await recordVelocityObservationsForScan(profile);
        } catch (err) {
          log.warn("Velocity observation recording failed — skipping", { keyword, error: err });
        }
      }

      // Junk deactivation: evaluated per-keyword here (needs this scan's
      // fresh profile), applied in ONE bulk UPDATE after the batch — see
      // below.
      if (appstoreJunkDeactivation.enabled) {
        try {
          const candidate = await buildDeactivationCandidate(profile);
          if (candidate && shouldDeactivateKeyword(candidate)) {
            toDeactivate.push(keyword);
          }
        } catch (err) {
          log.warn("Junk-deactivation check failed — skipping", { keyword, error: err });
        }
      }
    } catch (err) {
      failed++;
      consecutiveFailures++;
      if (isRateLimitError(err)) rateLimitErrors++;
      log.warn("Keyword scan failed — skipping", { keyword, ...opts.logContext, error: err });
      // Upstream looks wedged (e.g. rate-limit backoff): stop burning the rest
      // of the batch into a wall of failures and return what we have so far.
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        bailed = true;
        log.warn("Keyword sweep bailing early — too many consecutive failures", {
          ...opts.logContext,
          consecutiveFailures,
        });
        break;
      }
    }

    await sleep(opts.delayMs);
  }

  if (succeeded.length > 0) {
    await markScanned(succeeded, Math.floor(Date.now() / 1000));
  }

  if (toDeactivate.length > 0) {
    const deactivated = await deactivateJunkKeywords(toDeactivate);
    log.info("Junk-keyword deactivation", {
      evaluated: toDeactivate.length,
      deactivated,
      ...opts.logContext,
    });
  }

  return { scanned, failed, bailed, rateLimitErrors };
}

export async function runScanSlice(opts: {
  readonly genreZone: string;
  readonly budget: number;
  readonly delayMs: number;
}): Promise<{ scanned: number; failed: number }> {
  const { topN } = loadConfig().appstoreKeywordGap;
  const keywords = await getStaleKeywords(opts.genreZone, opts.budget);
  const { scanned, failed } = await scanAndRecord(keywords, {
    topN,
    delayMs: opts.delayMs,
    logContext: { genreZone: opts.genreZone },
  });
  return { scanned, failed };
}

// ---------------------------------------------------------------------------
// Timer-driven sweep — scans `limit` keywords across the WHOLE corpus (no
// genre-zone rotation) each cycle, selected via the two-tier priority lane
// (`getStaleKeywordsTiered` — see keyword-tiering.ts). The cadence comes from
// the caller's own timer (see scraper.ts), not from an interval gate here.
// Enforces `dailyKeywordBudget` as a rolling 24h safety ceiling: if the
// corpus has already been scanned that many times in the last 24h, the sweep
// is skipped for this cycle rather than spending more lookups.
// ---------------------------------------------------------------------------

export async function runKeywordSweep(opts: {
  readonly limit: number;
  readonly delayMs: number;
}): Promise<{
  scanned: number;
  failed: number;
  skipped: boolean;
  bailed: boolean;
  rateLimitErrors: number;
}> {
  const { topN, dailyKeywordBudget } = loadConfig().appstoreKeywordGap;

  const since = Math.floor(Date.now() / 1000) - 86_400;
  const scansLast24h = await countScansSince(since);
  if (scansLast24h >= dailyKeywordBudget) {
    log.debug("Keyword-gap sweep skipped — rolling 24h budget reached", {
      scansLast24h,
      dailyKeywordBudget,
    });
    return { scanned: 0, failed: 0, skipped: true, bailed: false, rateLimitErrors: 0 };
  }

  // Two-tier priority re-scan lane (see keyword-tiering.ts): manual/seed and
  // actively-watchlisted keywords due for a re-scan fill first, up to a
  // capped share of the batch, then the rest of the batch falls back to the
  // pre-existing stalest-first behavior across the whole corpus.
  const keywords = await getStaleKeywordsTiered(opts.limit);
  const result = await scanAndRecord(keywords, { topN, delayMs: opts.delayMs });
  return { ...result, skipped: false };
}
