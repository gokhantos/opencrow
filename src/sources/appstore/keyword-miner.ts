// Self-sufficient App Store keyword miner.
//
// Replaces the retired Apple search-suggest ("autocomplete") corpus
// expansion — see the deleted keyword-autocomplete.ts — which relied on
// Apple's MZSearchHints endpoint. That endpoint now just echoes the query
// back verbatim and returns no suggestions, so it could never discover new
// keywords (confirmed live: `budget` -> `budget`, `budg` -> `budg`).
//
// This miner instead extracts candidate keyword phrases from App Store data
// the scraper already fetches on every hourly ranking tick: top-chart app
// NAMES and CATEGORIES (see store.ts `getRankings`). That data is broad,
// popular, and real — no extra network calls, no dependency on a live
// third-party suggest API.
//
// Extraction is a PURE function (`extractCandidatesFromApp`/
// `extractCandidates`): lowercase, strip punctuation/emoji, drop the
// brand/developer token (colon/dash/pipe-prefixed app titles, plus any
// token matching the app's own `artist`/developer name), generate 1-2 word
// n-grams, and filter stopwords, too-short tokens, and pure numbers.

import { createLogger } from "../../logger";
import { keywordsExist, upsertKeywords } from "./keyword-store";
import type { KeywordSeedRow } from "./keyword-store";
import { getRankings } from "./store";
import type { AppRankingRow } from "./store";

const log = createLogger("appstore:keyword-miner");

/** Candidate n-grams shorter than this many characters are dropped. */
const MIN_TOKEN_LENGTH = 3;

/** How many ranking rows to scan for candidates by default (see `mineKeywords`). */
const DEFAULT_RANKINGS_SCAN_LIMIT = 3000;

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

/** Separators that typically split "Brand Name" from a descriptive suffix in App Store titles. */
const BRAND_SEPARATORS: readonly RegExp[] = [/:/, / - /, / – /, / \| /];

/**
 * App Store category label (as returned by the iTunes/RSS APIs — see
 * `ITUNES_CATEGORIES` in scraper.ts) mapped to a `GENRE_ZONES` entry
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

/** Catch-all genre zone for categories with no explicit mapping. */
const DEFAULT_ZONE = "lifestyle";

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
 * Strips a leading "Brand Name<sep>" prefix from an App Store title, e.g.
 * `"MyFitnessPal: Calorie Counter"` -> `"Calorie Counter"`. Splits on the
 * EARLIEST occurrence of any of `BRAND_SEPARATORS` — colon, " - ", " – ",
 * " | " — all common "brand: description" title conventions. Returns the
 * original name unchanged if no separator is found, or if the text after
 * the separator is empty (defensive — never returns an empty string when
 * the input wasn't empty).
 */
function stripBrandPrefix(name: string): string {
  let earliestIndex = -1;
  let matchedLength = 0;

  for (const sep of BRAND_SEPARATORS) {
    const match = sep.exec(name);
    if (match && (earliestIndex === -1 || match.index < earliestIndex)) {
      earliestIndex = match.index;
      matchedLength = match[0].length;
    }
  }

  if (earliestIndex === -1) return name;
  const rest = name.slice(earliestIndex + matchedLength).trim();
  return rest.length > 0 ? rest : name;
}

/**
 * Lowercases, strips punctuation/emoji (keeps only letters/digits/spaces
 * via unicode property escapes so accented text survives while emoji and
 * symbols don't), and collapses whitespace.
 */
function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(text: string): readonly string[] {
  return text.length === 0 ? [] : text.split(" ").filter((t) => t.length > 0);
}

const PURE_NUMBER_PATTERN = /^\d+$/;

/** Drops tokens that are pure numbers or shorter than `MIN_TOKEN_LENGTH`. */
function filterJunkTokens(tokens: readonly string[]): readonly string[] {
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

function filterStopwords(tokens: readonly string[]): readonly string[] {
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
  /** Upper bound on newly-added corpus keywords for this cycle. */
  readonly maxNew: number;
}

export interface MineKeywordsResult {
  /** Count of NEW corpus keywords upserted with `source: "mined"`. */
  readonly added: number;
  /** Count of ranking rows scanned for candidates. */
  readonly scanned: number;
}

/**
 * Mines new keyword candidates from the App Store rankings the scraper
 * already collects, dedupes against the existing corpus, bounds growth to
 * `opts.maxNew` per cycle, and upserts the genuinely new ones with
 * `source: "mined"`. Never throws on empty input — callers (scraper.ts)
 * still wrap this in a try/catch since DB calls can fail transiently.
 */
export async function mineKeywords(opts: MineKeywordsOptions): Promise<MineKeywordsResult> {
  const rankingsLimit = opts.rankingsLimit ?? DEFAULT_RANKINGS_SCAN_LIMIT;
  const rankings: readonly AppRankingRow[] = await getRankings(opts.listType, rankingsLimit);
  if (rankings.length === 0) {
    return { added: 0, scanned: 0 };
  }

  const candidates = extractCandidates(
    rankings.map((r) => ({ name: r.name, artist: r.artist, category: r.category })),
  );
  if (candidates.length === 0) {
    return { added: 0, scanned: rankings.length };
  }

  const existing = await keywordsExist(candidates.map((c) => c.keyword));
  const newCandidates = candidates.filter((c) => !existing.has(c.keyword)).slice(0, opts.maxNew);

  if (newCandidates.length === 0) {
    log.info("Keyword mining", { added: 0, scanned: rankings.length });
    return { added: 0, scanned: rankings.length };
  }

  const rows: readonly KeywordSeedRow[] = newCandidates.map((c) => ({
    keyword: c.keyword,
    genreZone: c.genreZone,
    source: "mined",
  }));
  await upsertKeywords(rows);

  log.info("Keyword mining", { added: rows.length, scanned: rankings.length });
  return { added: rows.length, scanned: rankings.length };
}
