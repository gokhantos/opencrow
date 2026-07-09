// iTunes fetch shell + scanKeyword orchestration for the App Store
// keyword-gap scanner. Fetches the live top-N results for a keyword from the
// iTunes Search API, maps them into `TopApp`s, and runs them through the pure
// scoring core in `keyword-scoring.ts` to produce a `KeywordGapProfile`.

import { z } from "zod";
import { loadConfig } from "../../config/loader";
import { createLogger } from "../../logger";
import { ssrfSafeFetch } from "../shared/ssrf-safe-fetch";
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
  getLatestScan,
  getStaleKeywords,
  getStaleKeywordsAcrossZones,
  insertScan,
  markScanned,
} from "./keyword-store";

const log = createLogger("appstore:keyword-gaps");

const DEFAULT_TOP_N = 20;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

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
  })
  .catch({
    trackId: 0,
    trackName: "",
    userRatingCount: 0,
    averageUserRating: 0,
    releaseDate: "",
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

export function toTopApp(raw: ItunesSoftwareResult, keyword: string, now: number): TopApp {
  const ageDays = computeAgeDays(raw.releaseDate, now);
  const keywordTokens = tokenize(keyword);
  const nameTokens = raw.trackName.toLowerCase();
  const titleMatch = keywordTokens.length > 0 && keywordTokens.every((t) => nameTokens.includes(t));

  return {
    id: String(raw.trackId),
    name: raw.trackName,
    reviews: raw.userRatingCount,
    rating: raw.averageUserRating,
    ageDays,
    ratingsPerDay: raw.userRatingCount / Math.max(ageDays, 1),
    titleMatch,
  };
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

export async function fetchTopApps(keyword: string, topN: number): Promise<readonly TopApp[]> {
  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(keyword)}&entity=software&limit=${topN}&country=us`;

  const res = await ssrfSafeFetch(url);
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

export async function scanKeyword(
  keyword: string,
  opts?: { readonly topN?: number; readonly store?: "app" | "play" },
): Promise<KeywordGapProfile> {
  const topN = opts?.topN ?? DEFAULT_TOP_N;
  const store = opts?.store ?? "app";

  const topApps = await fetchTopApps(keyword, topN);

  const demand = computeDemand(topApps);
  const competitiveness = computeCompetitiveness(topApps);
  const incumbentWeakness = computeIncumbentWeakness(topApps, competitiveness);

  const previousScan = await getLatestScan(keyword, store);
  const trend = classifyTrend(demand, previousScan?.demand ?? null);

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
    scannedAt: Math.floor(Date.now() / 1000),
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

async function scanAndRecord(
  keywords: readonly string[],
  opts: { readonly topN: number; readonly delayMs: number; readonly logContext?: Record<string, unknown> },
): Promise<{ scanned: number; failed: number }> {
  const succeeded: string[] = [];
  let scanned = 0;
  let failed = 0;

  for (const keyword of keywords) {
    try {
      const profile = await scanKeyword(keyword, { topN: opts.topN });
      await insertScan(profile);
      succeeded.push(keyword);
      scanned++;
    } catch (err) {
      failed++;
      log.warn("Keyword scan failed — skipping", { keyword, ...opts.logContext, error: err });
    }

    await sleep(opts.delayMs);
  }

  if (succeeded.length > 0) {
    await markScanned(succeeded, Math.floor(Date.now() / 1000));
  }

  return { scanned, failed };
}

export async function runScanSlice(opts: {
  readonly genreZone: string;
  readonly budget: number;
  readonly delayMs: number;
}): Promise<{ scanned: number; failed: number }> {
  const { topN } = loadConfig().appstoreKeywordGap;
  const keywords = await getStaleKeywords(opts.genreZone, opts.budget);
  return scanAndRecord(keywords, {
    topN,
    delayMs: opts.delayMs,
    logContext: { genreZone: opts.genreZone },
  });
}

// ---------------------------------------------------------------------------
// Timer-driven sweep — scans the globally stalest `limit` keywords across the
// WHOLE corpus (no genre-zone rotation) each cycle. The cadence comes from
// the caller's own timer (see scraper.ts), not from an interval gate here.
// Enforces `dailyKeywordBudget` as a rolling 24h safety ceiling: if the
// corpus has already been scanned that many times in the last 24h, the sweep
// is skipped for this cycle rather than spending more lookups.
// ---------------------------------------------------------------------------

export async function runKeywordSweep(opts: {
  readonly limit: number;
  readonly delayMs: number;
}): Promise<{ scanned: number; failed: number; skipped: boolean }> {
  const { topN, dailyKeywordBudget } = loadConfig().appstoreKeywordGap;

  const since = Math.floor(Date.now() / 1000) - 86_400;
  const scansLast24h = await countScansSince(since);
  if (scansLast24h >= dailyKeywordBudget) {
    log.debug("Keyword-gap sweep skipped — rolling 24h budget reached", {
      scansLast24h,
      dailyKeywordBudget,
    });
    return { scanned: 0, failed: 0, skipped: true };
  }

  const keywords = await getStaleKeywordsAcrossZones(opts.limit);
  const result = await scanAndRecord(keywords, { topN, delayMs: opts.delayMs });
  return { ...result, skipped: false };
}
