// Self-sufficient App Store keyword miner — SECONDARY corpus-discovery
// source (see keyword-autocomplete.ts for the PRIMARY one).
//
// CORRECTION (2026-07-21): this miner originally replaced Apple
// search-suggest ("autocomplete") entirely, on the diagnosis that its
// MZSearchHints endpoint just echoed the query back with no suggestions
// (confirmed live at the time: `budget` -> `budget`, `budg` -> `budg`). That
// diagnosis was WRONG — the endpoint requires an `X-Apple-Store-Front`
// header (verified live 2026-07-20/21: without it, an empty hints array;
// with it, real popularity-ordered user queries). Apple made the header
// mandatory at some point; the endpoint itself was never actually dead. See
// keyword-autocomplete.ts, now restored as the PRIMARY discovery source —
// this miner is demoted to a secondary top-up (small `maxMinedPerCycle`; see
// `corpusDiscovery` in config/schema.ts) that still earns its keep by
// catching brand-new apps autocomplete hasn't indexed yet.
//
// This miner extracts candidate keyword phrases from App Store data the
// scraper already fetches. It blends TWO sources:
//
//   1. Top-chart app NAMES and CATEGORIES (see store.ts `getRankings`) —
//      finite (~a few thousand distinct apps) and plateaus once exhausted.
//   2. Distinct app NAMES embedded in the `top_apps` snapshot every
//      per-keyword scan already records (see keyword-store.ts
//      `getScannedAppNames`) — a much larger, continuously-growing pool
//      with no category, so it's mined name-only (empty artist/category —
//      the brand-filter and genre-zone mapping both degrade gracefully to
//      a no-op / default zone for that shape of input).
//
// Both are broad, popular, and real — no extra network calls, no
// dependency on a live third-party suggest API.
//
// Extraction is a PURE function (`extractCandidatesFromApp`/
// `extractCandidates`): lowercase, strip punctuation/emoji, drop the
// brand/developer token (colon/dash/pipe-prefixed app titles, plus any
// token matching the app's own `artist`/developer name), generate 1-2 word
// n-grams, and filter stopwords, too-short tokens, and pure numbers.
//
// SUBTITLE MINING — investigated 2026-07-19, not implemented: App Store
// "subtitles" (the short tagline under an app's name) are NOT present in any
// payload this scraper already fetches. Verified live against every
// endpoint in this pipeline: the iTunes Search API (`keyword-gaps.ts`
// `fetchTopApps`, used for every keyword SERP scan), the iTunes RSS top-chart
// feeds (`scraper.ts` `parseTopAppsItunes`), the rss.applemarketingtools.com
// v2 feed (`parseTopAppsV2`), and the `itunes.apple.com/lookup` endpoint
// (`fetchRelatedApps`) — none of their response objects carry a subtitle
// field (confirmed against the full key set of each live response). Apple
// only exposes it via scraped storefront HTML or the App Store Connect API
// (developer-authenticated, own-apps-only) — both out of scope for a
// no-new-network-calls PR. Rather than add a new fetch, this miner instead
// tightens NAME-based mining: every candidate n-gram is now rejected via
// `isJunkKeyword` (the same stoplist/short/numeric/non-Latin-script rules
// the newborn-velocity screener and the dashboard's `hideJunk` filter
// already apply) — previously that check only ran at screening/display
// time, never at mining time, so junk could enter the corpus in the first
// place.

import { createLogger } from "../../logger";
import { stripBrandPrefix } from "./brand-title-split";
import { isJunkKeyword } from "./keyword-junk";
import { getScannedAppNames, keywordsExist, upsertKeywords } from "./keyword-store";
import type { KeywordSeedRow } from "./keyword-store";
import { getRankings } from "./store";
import type { AppRankingRow } from "./store";

const log = createLogger("appstore:keyword-miner");

/** Candidate n-grams shorter than this many characters are dropped. */
const MIN_TOKEN_LENGTH = 3;

/** How many ranking rows to scan for candidates by default (see `mineKeywords`). */
const DEFAULT_RANKINGS_SCAN_LIMIT = 3000;

/**
 * How many distinct app names to pull from the per-keyword `top_apps`
 * pool by default (see `mineKeywords`, `getScannedAppNames`). This pool is
 * much larger than the top-chart rankings pool and grows every scan cycle,
 * giving the miner a sustained, self-replenishing source instead of
 * plateauing once the finite rankings pool is exhausted.
 */
const DEFAULT_SCANNED_APPS_LIMIT = 2000;

/**
 * Purely grammatical connector words dropped from the token stream before
 * n-grams are built. Deliberately narrow — generic-but-meaningful modifier
 * words like "free"/"pro"/"app" are intentionally NOT stopworded here since
 * they double as legitimate keyword modifiers (see keyword-corpus.ts
 * MODIFIERS).
 */
const STOPWORDS: ReadonlySet<string> = new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "for",
  "of",
  "in",
  "on",
  "with",
  "to",
  "your",
  "my",
  "is",
  "are",
  "this",
  "that",
  "by",
  "at",
  "from",
  "&",
]);

/**
 * App Store category label (as returned by the iTunes/RSS APIs — see
 * `ITUNES_CATEGORIES` in charts.ts) mapped to a `GENRE_ZONES` entry
 * (keyword-corpus.ts). Unmapped/unknown categories fall back to
 * `DEFAULT_ZONE`.
 */
const CATEGORY_TO_ZONE: Readonly<Record<string, string>> = {
  business: "business",
  utilities: "utilities",
  "social networking": "social",
  productivity: "productivity",
  lifestyle: "lifestyle",
  "health & fitness": "health",
  games: "entertainment",
  finance: "finance",
  entertainment: "entertainment",
  education: "education",
  book: "reference",
  books: "reference",
  medical: "health",
  "food & drink": "food",
  shopping: "lifestyle",
  travel: "travel",
  photo: "photo",
  "photo & video": "photo",
  sports: "sports",
  reference: "reference",
};

/**
 * Catch-all genre zone for categories with no explicit mapping. Exported
 * (Batch C4) so `keyword-review-miner.ts` can fall back to the same default
 * when a review's app has no registry `genreName` yet, rather than inventing
 * a second default.
 */
export const DEFAULT_ZONE = "lifestyle";

/**
 * Maps a raw App Store category label to one of `keyword-corpus.ts`'s
 * `GENRE_ZONES`. Case/whitespace-insensitive; falls back to `DEFAULT_ZONE`
 * for anything unrecognized rather than throwing, since category labels
 * come straight from an external API and can drift.
 */
export function mapCategoryToZone(category: string): string {
  const key = category.trim().toLowerCase();
  return CATEGORY_TO_ZONE[key] ?? DEFAULT_ZONE;
}

/**
 * Lowercases, strips punctuation/emoji (keeps only letters/digits/spaces
 * via unicode property escapes so accented text survives while emoji and
 * symbols don't), and collapses whitespace. Exported (Batch C4) for reuse by
 * `keyword-review-miner.ts` — same text-normalization rules apply to review
 * title+content as to app names.
 */
export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Exported (Batch C4) for reuse by `keyword-review-miner.ts`. */
export function tokenize(text: string): readonly string[] {
  return text.length === 0 ? [] : text.split(" ").filter((t) => t.length > 0);
}

const PURE_NUMBER_PATTERN = /^\d+$/;

/**
 * Drops tokens that are pure numbers or shorter than `MIN_TOKEN_LENGTH`.
 * Exported (Batch C4) for reuse by `keyword-review-miner.ts`.
 */
export function filterJunkTokens(tokens: readonly string[]): readonly string[] {
  return tokens.filter((t) => t.length >= MIN_TOKEN_LENGTH && !PURE_NUMBER_PATTERN.test(t));
}

/**
 * Drops any app-title token that also appears in the app's developer/artist
 * name — the main heuristic for filtering "obvious brand names" that
 * weren't already separated out by `stripBrandPrefix` (e.g. a single-word
 * app title with no colon/dash, like "Notion").
 */
function filterArtistTokens(tokens: readonly string[], artist: string): readonly string[] {
  const artistTokens = new Set(tokenize(normalizeText(artist)));
  if (artistTokens.size === 0) return tokens;
  return tokens.filter((t) => !artistTokens.has(t));
}

/** Exported (Batch C4) for reuse by `keyword-review-miner.ts`. */
export function filterStopwords(tokens: readonly string[]): readonly string[] {
  return tokens.filter((t) => !STOPWORDS.has(t));
}

/** Builds unigrams + adjacent-pair bigrams from a cleaned token sequence. */
function buildNGrams(tokens: readonly string[]): readonly string[] {
  const grams: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === undefined) continue;
    grams.push(token);
    const next = tokens[i + 1];
    if (next !== undefined) grams.push(`${token} ${next}`);
  }
  return grams;
}

export interface MinerAppInput {
  readonly name: string;
  readonly artist: string;
  readonly category: string;
}

export interface MinedCandidate {
  readonly keyword: string;
  readonly genreZone: string;
}

/**
 * Extracts candidate keyword n-grams from a single app's title/artist/
 * category. Pure and deterministic — no I/O. Returns a deduped list (within
 * this one app) of `{keyword, genreZone}` pairs.
 */
export function extractCandidatesFromApp(app: MinerAppInput): readonly MinedCandidate[] {
  if (app.name.trim().length === 0) return [];

  const descriptive = stripBrandPrefix(app.name);
  const normalized = normalizeText(descriptive);
  const rawTokens = tokenize(normalized);

  const cleaned = filterStopwords(filterArtistTokens(filterJunkTokens(rawTokens), app.artist));
  if (cleaned.length === 0) return [];

  const zone = mapCategoryToZone(app.category);
  const seen = new Set<string>();
  const candidates: MinedCandidate[] = [];

  for (const gram of buildNGrams(cleaned)) {
    if (seen.has(gram)) continue;
    seen.add(gram);
    // Tightened rejection (see module doc comment): the same junk check the
    // dashboard/screener apply at read time, now applied at mining time too,
    // so junk (sole generic words, non-Latin script, etc.) never enters the
    // corpus in the first place.
    if (isJunkKeyword(gram)) continue;
    candidates.push({ keyword: gram, genreZone: zone });
  }

  return candidates;
}

/**
 * Extracts and dedupes candidates across a batch of apps. First app to
 * produce a given keyword wins the `genreZone` assignment for it — later
 * duplicates are dropped rather than overwriting. Insertion order is
 * preserved (stable, testable output).
 */
export function extractCandidates(apps: readonly MinerAppInput[]): readonly MinedCandidate[] {
  const seen = new Map<string, MinedCandidate>();
  for (const app of apps) {
    for (const candidate of extractCandidatesFromApp(app)) {
      if (seen.has(candidate.keyword)) continue;
      seen.set(candidate.keyword, candidate);
    }
  }
  return Array.from(seen.values());
}

/**
 * Maps a bare app name (from `getScannedAppNames`'s `top_apps` pool, which
 * carries no artist/category) into `extractCandidatesFromApp`'s input
 * shape. Empty `artist`/`category` are both safe no-ops in that pipeline:
 * `filterArtistTokens` returns tokens unchanged when the artist has no
 * tokens of its own, and `mapCategoryToZone` falls back to `DEFAULT_ZONE`
 * for an unrecognized (here, empty) category — so this name-only path
 * reuses the exact same extraction as the rankings path, just without a
 * brand-artist filter or a real genre zone.
 */
function scannedNameToAppInput(name: string): MinerAppInput {
  return { name, artist: "", category: "" };
}

/**
 * Filters `candidates` down to ones not already present in `existing`,
 * bounded to at most `maxNew` entries. Pure and order-preserving — split
 * out from `mineKeywords` so the "dedupe against corpus + cap growth" rule
 * is unit-testable without a DB.
 */
export function selectNewCandidates(
  candidates: readonly MinedCandidate[],
  existing: ReadonlySet<string>,
  maxNew: number,
): readonly MinedCandidate[] {
  return candidates.filter((c) => !existing.has(c.keyword)).slice(0, maxNew);
}

export interface MineKeywordsOptions {
  /** How many ranking rows to scan for candidates. Default `DEFAULT_RANKINGS_SCAN_LIMIT`. */
  readonly rankingsLimit?: number;
  /**
   * Optional `list_type` prefix filter, passed straight through to
   * `getRankings`. Unset (default) scans the whole rankings table, same as
   * production usage from scraper.ts. Mainly useful for tests that need to
   * isolate mining to a specific fixture without picking up unrelated rows
   * from a shared DB.
   */
  readonly listType?: string;
  /**
   * How many distinct app names to pull from the per-keyword scan `top_apps`
   * pool (see `getScannedAppNames`). Default `DEFAULT_SCANNED_APPS_LIMIT`.
   * This is the sustained, self-replenishing source — set to `0` to disable
   * it and mine only from rankings (e.g. for a test that wants to isolate
   * to a fixture with no unrelated rows from a shared DB).
   */
  readonly scannedAppsLimit?: number;
  /** Upper bound on newly-added corpus keywords for this cycle. */
  readonly maxNew: number;
}

export interface MineKeywordsResult {
  /** Count of NEW corpus keywords upserted with `source: "mined"`. */
  readonly added: number;
  /** Total rows/names scanned across both sources (`scannedFromRankings + scannedFromTopApps`). */
  readonly scanned: number;
  /** Count of top-chart ranking rows scanned for candidates. */
  readonly scannedFromRankings: number;
  /** Count of distinct app names pulled from the `top_apps` scan pool. */
  readonly scannedFromTopApps: number;
}

/**
 * Mines new keyword candidates by blending TWO App Store data sources the
 * scraper already collects: top-chart rankings (`getRankings`, finite,
 * plateaus) and the distinct app names embedded in every per-keyword scan's
 * `top_apps` snapshot (`getScannedAppNames`, much larger, grows every scan
 * cycle). Dedupes across both sources AND against the existing corpus,
 * bounds growth to `opts.maxNew` per cycle, and upserts the genuinely new
 * ones with `source: "mined"`. Never throws on empty input — callers
 * (scraper.ts) still wrap this in a try/catch since DB calls can fail
 * transiently.
 */
export async function mineKeywords(opts: MineKeywordsOptions): Promise<MineKeywordsResult> {
  const rankingsLimit = opts.rankingsLimit ?? DEFAULT_RANKINGS_SCAN_LIMIT;
  const scannedAppsLimit = opts.scannedAppsLimit ?? DEFAULT_SCANNED_APPS_LIMIT;

  const [rankings, scannedNames]: [readonly AppRankingRow[], readonly string[]] =
    await Promise.all([
      getRankings(opts.listType, rankingsLimit),
      scannedAppsLimit > 0 ? getScannedAppNames(scannedAppsLimit) : Promise.resolve([]),
    ]);

  const empty = (): MineKeywordsResult => ({
    added: 0,
    scanned: rankings.length + scannedNames.length,
    scannedFromRankings: rankings.length,
    scannedFromTopApps: scannedNames.length,
  });

  if (rankings.length === 0 && scannedNames.length === 0) {
    return empty();
  }

  const rankingApps: readonly MinerAppInput[] = rankings.map((r) => ({
    name: r.name,
    artist: r.artist,
    category: r.category,
  }));
  const scannedApps: readonly MinerAppInput[] = scannedNames.map(scannedNameToAppInput);

  const candidates = extractCandidates([...rankingApps, ...scannedApps]);
  if (candidates.length === 0) {
    return empty();
  }

  const existing = await keywordsExist(candidates.map((c) => c.keyword));
  const newCandidates = selectNewCandidates(candidates, existing, opts.maxNew);

  if (newCandidates.length === 0) {
    log.info("Keyword mining", {
      added: 0,
      scannedFromRankings: rankings.length,
      scannedFromTopApps: scannedNames.length,
    });
    return empty();
  }

  const rows: readonly KeywordSeedRow[] = newCandidates.map((c) => ({
    keyword: c.keyword,
    genreZone: c.genreZone,
    source: "mined",
  }));
  await upsertKeywords(rows);

  log.info("Keyword mining", {
    added: rows.length,
    scannedFromRankings: rankings.length,
    scannedFromTopApps: scannedNames.length,
  });
  return {
    added: rows.length,
    scanned: rankings.length + scannedNames.length,
    scannedFromRankings: rankings.length,
    scannedFromTopApps: scannedNames.length,
  };
}
