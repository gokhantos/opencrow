// iTunes fetch shell + scanKeyword orchestration for the App Store
// keyword-gap scanner. Fetches the live top-N results for a keyword from the
// iTunes Search API, maps them into `TopApp`s, and runs them through the pure
// scoring core in `keyword-scoring.ts` to produce a `KeywordGapProfile`.

import { z } from "zod";
import { loadConfig } from "../../config/loader";
import { createLogger } from "../../logger";
import { RateLimitError, ssrfSafeFetch } from "../shared/ssrf-safe-fetch";
import { recordVelocityObservationsForScan } from "./app-velocity-store";
import {
  shouldDeactivateKeyword,
  shouldDeactivateMinedKeyword,
  DEACTIVATION_MIN_SCANS,
} from "./keyword-deactivation";
import type { DeactivationCandidate, MinedDeactivationCandidate } from "./keyword-deactivation";
import { computePerSweepCap } from "./keyword-tiering";
import {
  classifyTrend,
  computeCompetitiveness,
  computeDemand,
  computeIncumbentWeakness,
  computeOpportunity,
  winsorizeRatingsPerDayAtP90,
} from "./keyword-scoring";
import type { KeywordGapProfile, TopApp } from "./keyword-types";
import {
  countMinedScansSince,
  countScansSince,
  deactivateJunkKeywords,
  getKeywordMeta,
  getMinedDeactivationStats,
  getScanHistory,
  getStaleKeywords,
  getStaleKeywordsTiered,
  getTier1ProtectedKeywords,
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
// Floor for `enrichWithVelocity`'s flap-robust cap (2026-07-21 audit item C
// fix) — see that function's doc comment. Applies even to an app with a
// near-zero lifetime rate, so a genuinely fast-emerging newcomer still gets
// SOME velocity headroom rather than being capped to near-zero by its own
// (still-small) lifetime average.
const MIN_VELOCITY_CAP_PER_DAY = 50;
// Non-matched apps with at least this many lifetime reviews are excluded
// from the demand/incumbent-weakness "relevant" set entirely (2026-07-21
// audit item C fix) — see `scanKeyword`'s doc comment. A mega-app with
// hundreds of thousands of reviews unrelated to the search phrase must never
// be allowed to set a keyword's demand via sheer review mass.
export const GIANT_REVIEW_THRESHOLD = 100_000;
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

// Splits on ANY run of non-alphanumeric characters (whitespace AND
// punctuation — commas, colons, hyphens, ampersands, parens, apostrophes,
// en/em dashes, etc.), lowercased. Shared by both the keyword and the app
// name (see `toTopApp`) so `titleMatch` compares like-for-like tokens
// (2026-07-21 audit item C fix — the prior whitespace-only split on the
// keyword, combined with a raw `String.includes` check against the
// UN-tokenized name, matched any substring at any position regardless of
// word boundaries: "hat" inside "ChatGPT", "face" inside "Facebook", "tub"
// inside "YouTube" — none of which are real matches).
function tokenize(text: string): readonly string[] {
  return text
    .toLowerCase()
    .trim()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}

// A keyword token counts as matched against a name token only if the two are
// EQUAL, or the keyword token is a genuine word-boundary PREFIX of the name
// token (starting at position 0) within a small inflection allowance —
// covers plurals/simple suffixes ("widget" matching "widgets", diff 1 char)
// without reopening the old substring-anywhere hole: "face" must NOT match
// "facebook" (the unmatched remainder "book" is far longer than a
// plural/inflection suffix), even though "face" IS a structural prefix of
// "facebook". `MIN_PREFIX_MATCH_LEN` additionally keeps very short keyword
// tokens (< 4 chars) from ever prefix-matching at all — "hat"/"tub" fail
// this length gate before the prefix check even runs (and wouldn't pass it
// anyway, since neither is a structural prefix of "chatgpt"/"youtube").
const MIN_PREFIX_MATCH_LEN = 4;
const MAX_INFLECTION_SUFFIX_CHARS = 2;

function tokenMatches(keywordToken: string, nameToken: string): boolean {
  if (keywordToken === nameToken) return true;
  if (keywordToken.length < MIN_PREFIX_MATCH_LEN) return false;
  if (!nameToken.startsWith(keywordToken)) return false;
  return nameToken.length - keywordToken.length <= MAX_INFLECTION_SUFFIX_CHARS;
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
  const nameTokens = tokenize(raw.trackName);
  const titleMatch =
    keywordTokens.length > 0 &&
    keywordTokens.every((kt) => nameTokens.some((nt) => tokenMatches(kt, nt)));
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

export async function fetchTopApps(
  keyword: string,
  topN: number,
  country: string = "us",
): Promise<readonly TopApp[]> {
  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(keyword)}&entity=software&limit=${topN}&country=${encodeURIComponent(country)}`;

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
    const rawVelocity = Math.max(0, a.reviews - prev) / daysBetweenScans;
    // Cap (2026-07-21 audit item C fix): bounds a single flapped/corrected
    // review-count reading from minting an implausible demand spike — see
    // `scanKeyword`'s "flap-robust velocity baseline" doc comment. A cap
    // relative to the app's OWN lifetime rate (10x headroom for genuine
    // heating) with an absolute floor (so a near-zero-lifetime-rate app
    // isn't capped to near-zero).
    const cap = Math.max(10 * a.ratingsPerDay, MIN_VELOCITY_CAP_PER_DAY);
    const recentVelocity = Math.min(rawVelocity, cap);
    return { ...a, recentVelocity };
  });
}

export async function scanKeyword(
  keyword: string,
  opts?: {
    readonly topN?: number;
    readonly store?: "app" | "play" | "DE";
    /** iTunes `country` query param. Defaults from `store`: "DE" -> "de", else "us". */
    readonly country?: string;
  },
): Promise<KeywordGapProfile> {
  const topN = opts?.topN ?? DEFAULT_TOP_N;
  const store = opts?.store ?? "app";
  const country = opts?.country ?? (store === "DE" ? "de" : "us");
  const scannedAt = Math.floor(Date.now() / 1000);

  const fetched = await fetchTopApps(keyword, topN, country);

  // Prior scans (this store, newest-first) drive both live velocity and
  // momentum: an old-enough scan is the velocity baseline; the whole series
  // feeds trend. `getScanHistory`'s `store` param filters IN the SQL itself
  // (2026-07-21 audit item B fix — was a TS-side `.filter` after a plain
  // `LIMIT HISTORY_LIMIT`, which silently starved a store's history depth
  // below `HISTORY_LIMIT` whenever another store's rows were interleaved in
  // the most recent `HISTORY_LIMIT` scans) — keeps the DE lane's history (a
  // distinct storefront's review counts/ratings) from being diffed against
  // US scans.
  const history = await getScanHistory(keyword, HISTORY_LIMIT, store);

  // Velocity baseline: per-app MAX reviews across the TWO newest prior scans
  // at least MIN_VELOCITY_WINDOW_DAYS old (2026-07-21 audit item C fix,
  // "flap-robust velocity baseline") — not just the single newest. Survives
  // an Apple review-count flap (a transient drop then a near-full recovery):
  // diffing only against the single newest eligible scan can land on the
  // dip and read the recovery back up to the pre-flap level as a phantom
  // spike; taking the max across the two newest anchors the baseline at the
  // higher (real) prior level instead. `daysBetweenScans` still uses the
  // single newest eligible scan's timestamp (the closest-in-time anchor),
  // only the REVIEW COUNT baseline is maxed across two. Falls back to the
  // lifetime average (see `enrichWithVelocity`'s early return) when no prior
  // scan is yet that old.
  const eligibleBaselines = history.filter(
    (h) => (scannedAt - h.scannedAt) / 86_400 >= MIN_VELOCITY_WINDOW_DAYS,
  );
  const newestEligibleBaselines = eligibleBaselines.slice(0, 2);
  const baselineReviews = new Map<string, number>();
  for (const h of newestEligibleBaselines) {
    for (const a of h.topApps) {
      const prevMax = baselineReviews.get(a.id);
      if (prevMax === undefined || a.reviews > prevMax) {
        baselineReviews.set(a.id, a.reviews);
      }
    }
  }
  const newestBaseline = newestEligibleBaselines[0];
  const daysBetweenScans = newestBaseline ? (scannedAt - newestBaseline.scannedAt) / 86_400 : 0;

  const topApps = enrichWithVelocity(fetched, baselineReviews, daysBetweenScans);

  // Demand + weakness are about the apps actually serving this phrase.
  // 2026-07-21 audit item C fix ("fix fabricated demand"): NEVER fall back
  // to the raw, unfiltered SERP when nothing title-matches — that let
  // review-mass giants unrelated to the keyword set demand (e.g. WhatsApp
  // scored demand 498 on "credit score widget"). When zero apps
  // title-match, compute demand/weakness only over the NON-matched apps
  // that are also NOT giants (< GIANT_REVIEW_THRESHOLD reviews); if none
  // qualify (an all-giant field), the relevant set is empty and demand is 0.
  // Either way the scan is flagged `lowConfidence` — no title-matched
  // incumbent means we don't actually know who serves this phrase.
  // Competitiveness stays over the whole ranked field regardless — that is
  // the crowd a new entrant ranks against, giants included.
  const matched = topApps.filter((a) => a.titleMatch);
  const lowConfidence = matched.length === 0;
  const relevant =
    matched.length > 0 ? matched : topApps.filter((a) => a.reviews < GIANT_REVIEW_THRESHOLD);

  // Winsorize per-app ratingsPerDay at the relevant set's own p90 before it
  // enters demand — bounds a single outlier app's lifetime review mass from
  // dominating the mean. Scoped to the demand computation only (does not
  // affect `topApps`/`incumbentWeakness`, and is NOT persisted back onto the
  // stored `topApps` payload — see `winsorizeRatingsPerDayAtP90`'s doc
  // comment for why median was tried and rejected).
  const demand = computeDemand(winsorizeRatingsPerDayAtP90(relevant));
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
    lowConfidence,
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
  // ALWAYS the US storefront, regardless of which store this particular scan
  // was — junk-deactivation is a US-corpus concept (see keyword-deactivation.ts)
  // and must never fire (or fail to fire) based on a DE-lane scan's history
  // (2026-07-21 audit item B fix).
  const history = await getScanHistory(profile.keyword, DEACTIVATION_MIN_SCANS, "app");
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
  opts: {
    readonly topN: number;
    readonly delayMs: number;
    readonly logContext?: Record<string, unknown>;
    readonly store?: "app" | "play" | "DE";
    readonly country?: string;
    /**
     * Run junk-deactivation + velocity bookkeeping for this batch. Default
     * true. The DE storefront lane (store: "DE") sets this false: DE-derived
     * demand/reviews must never deactivate a keyword's single, store-agnostic
     * `active` flag based on how it looks in a DIFFERENT storefront, and DE
     * review counts must never be diffed into the same `appstore_app_velocity`
     * series as US observations of the same app id — see `keyword-gaps.ts`
     * module doc / `runDeStorefrontSweep`.
     */
    readonly runBookkeeping?: boolean;
    /**
     * Update `appstore_keywords.last_scanned_at` for scanned keywords.
     * Default true. The DE lane sets this false so it never interferes with
     * the US tier-1/mined-exploration staleness cadence — that column drives
     * `getStaleKeywordsTiered` exclusively, and the DE lane is a wholly
     * separate daily pass, not a US-rescan substitute.
     */
    readonly markCorpusScanned?: boolean;
  },
): Promise<{ scanned: number; failed: number; bailed: boolean; rateLimitErrors: number }> {
  const { appstoreVelocity, appstoreJunkDeactivation } = loadConfig();
  const store = opts.store ?? "app";
  const country = opts.country;
  const runBookkeeping = opts.runBookkeeping ?? true;
  const markCorpusScanned = opts.markCorpusScanned ?? true;
  const succeeded: string[] = [];
  const toDeactivate: string[] = [];
  let scanned = 0;
  let failed = 0;
  let rateLimitErrors = 0;
  let consecutiveFailures = 0;
  let bailed = false;

  for (const keyword of keywords) {
    try {
      const profile = await scanKeyword(keyword, { topN: opts.topN, store, ...(country ? { country } : {}) });
      await insertScan(profile);
      succeeded.push(keyword);
      scanned++;
      consecutiveFailures = 0;

      // Newborn-velocity time-series: bounded, read-mostly bookkeeping over
      // data this scan already fetched — never allowed to break the sweep.
      if (appstoreVelocity.enabled && runBookkeeping) {
        try {
          await recordVelocityObservationsForScan(profile);
        } catch (err) {
          log.warn("Velocity observation recording failed — skipping", { keyword, error: err });
        }
      }

      // Junk deactivation: evaluated per-keyword here (needs this scan's
      // fresh profile), applied in ONE bulk UPDATE after the batch — see
      // below. Two independent rules OR together: the general data-hopeless
      // rule (any non-protected source, latest-scan demand), and the
      // mined-pool-specific rule (source: 'mined' only, demand EVER reached
      // across the whole scan history, exempt on any signature hit — see
      // `keyword-deactivation.ts`'s `shouldDeactivateMinedKeyword`).
      if (appstoreJunkDeactivation.enabled && runBookkeeping) {
        try {
          const candidate = await buildDeactivationCandidate(profile);
          if (candidate) {
            let deactivate = shouldDeactivateKeyword(candidate);
            if (!deactivate && candidate.source === "mined") {
              const stats = await getMinedDeactivationStats(keyword);
              const minedCandidate: MinedDeactivationCandidate = {
                source: candidate.source,
                scanCount: stats.scanCount,
                maxDemandEver: stats.maxDemand,
                hasSignatureHit: stats.hasSignatureHit,
              };
              deactivate = shouldDeactivateMinedKeyword(minedCandidate);
            }
            if (deactivate) toDeactivate.push(keyword);
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

  if (succeeded.length > 0 && markCorpusScanned) {
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
// genre-zone rotation) each cycle, selected via the tier-1-guaranteed +
// mined-quota lane (`getStaleKeywordsTiered` — see keyword-tiering.ts). The
// cadence comes from the caller's own timer (see scraper.ts), not from an
// interval gate here. Enforces `dailyKeywordBudget` as a rolling 24h safety
// ceiling: if the corpus has already been scanned that many times in the
// last 24h, the sweep is skipped for this cycle rather than spending more
// lookups. Mined exploration additionally enforces its own, smaller rolling
// quota (`minedExploration.dailyQuota`) — see `countMinedScansSince`.
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
  /** Remaining mined-exploration quota for the rolling 24h window AFTER this sweep. */
  mineQuotaRemaining: number;
}> {
  const { topN, dailyKeywordBudget, minedExploration, tier1StaleThresholdMs, scanIntervalMs } =
    loadConfig().appstoreKeywordGap;

  const since = Math.floor(Date.now() / 1000) - 86_400;
  const scansLast24h = await countScansSince(since);
  if (scansLast24h >= dailyKeywordBudget) {
    log.debug("Keyword-gap sweep skipped — rolling 24h budget reached", {
      scansLast24h,
      dailyKeywordBudget,
    });
    return {
      scanned: 0,
      failed: 0,
      skipped: true,
      bailed: false,
      rateLimitErrors: 0,
      mineQuotaRemaining: minedExploration.dailyQuota,
    };
  }

  // Mined exploration's OWN rolling-24h quota, tracked independently of the
  // whole-corpus `dailyKeywordBudget` ceiling above — see keyword-tiering.ts
  // module doc / getStaleKeywordsTiered.
  const minedScansLast24h = await countMinedScansSince(since);
  const mineQuotaRemaining = Math.max(0, minedExploration.dailyQuota - minedScansLast24h);

  // Per-sweep slice of the mined quota (2026-07-21 audit NOW-tier fix, item
  // A): without this, `getStaleKeywordsTiered`'s greedy fill lets a single
  // LIGHT sweep (small hot+tier1 lanes) spend the WHOLE day's remaining
  // mined quota in one cycle, starving every later sweep of the day of any
  // mined slots at all. Spreads the quota evenly across the ~86_400_000 /
  // scanIntervalMs sweeps expected per day instead.
  const perSweepCap = computePerSweepCap(minedExploration.dailyQuota, scanIntervalMs);

  // Priority re-scan lanes (see keyword-tiering.ts): the hot lane (open
  // signature hits, stale >6h) and tier 1 (ALL due seed/manual/autocomplete/
  // signature-hit keywords) fill first (both effectively uncapped by this
  // cycle's batch — hot has its own small fixed cap), then mined exploration
  // fills whatever's left of the batch, capped by both its own daily quota
  // and this sweep's `perSweepCap` slice of it.
  const keywords = await getStaleKeywordsTiered({
    batchLimit: opts.limit,
    mineQuotaRemaining,
    tier1StaleThresholdMs,
    perSweepCap,
  });
  const result = await scanAndRecord(keywords, { topN, delayMs: opts.delayMs });
  return { ...result, skipped: false, mineQuotaRemaining };
}

// ---------------------------------------------------------------------------
// DE storefront lane (2026-07-21 scan-budget retune) — a daily pass over the
// human-curated corpus (active seed/manual/autocomplete keywords) against the
// German App Store, purely for querying/mining. Deliberately bypasses
// junk-deactivation, velocity bookkeeping, and `last_scanned_at` updates (see
// `scanAndRecord`'s `runBookkeeping`/`markCorpusScanned` doc comments) — this
// data augments the corpus without perturbing the US tier-1/mined cadence or
// risking a keyword being deactivated for looking weak in a market it was
// never curated for. The signature screener stays exclusively US (`store =
// 'app'` — see `signature-hits-store.ts`'s `getScreenerCandidates`), so DE
// rows are structurally invisible to it regardless.
// ---------------------------------------------------------------------------

export async function runDeStorefrontSweep(opts: {
  readonly delayMs: number;
}): Promise<{ scanned: number; failed: number; bailed: boolean; rateLimitErrors: number }> {
  const { topN } = loadConfig().appstoreKeywordGap;
  const keywords = await getTier1ProtectedKeywords();
  return scanAndRecord(keywords, {
    topN,
    delayMs: opts.delayMs,
    store: "DE",
    country: "de",
    runBookkeeping: false,
    markCorpusScanned: false,
    logContext: { lane: "de-storefront" },
  });
}
