// Autocomplete-driven corpus growth — PRIMARY keyword-discovery source for
// the App Store keyword-gap scanner (see keyword-miner.ts for the demoted
// SECONDARY source).
//
// Widens the keyword corpus by pulling Apple's own search-suggest
// ("autocomplete") hints for a batch of expansion seeds each cycle. Unlike
// the app-name n-gram miner, these are REAL, popularity-ordered user search
// queries straight from Apple ("budget planner", "budget bestie", "budget —
// car rental"), not fragments extracted from app titles.
//
// HISTORY / CORRECTION (2026-07-21): this endpoint was previously believed
// retired — a 2026-07-18 diagnosis found `GET .../hints?term=budget` just
// echoing the query back with an empty hints array and concluded Apple had
// killed search-suggest. That diagnosis was WRONG. Verified live
// 2026-07-20/21:
//   - WITHOUT the `X-Apple-Store-Front` header: empty hints array (this is
//     exactly what led to the "dead" conclusion).
//   - WITH `X-Apple-Store-Front: 143441-1,29` (US storefront): real
//     suggestions come back as an XML plist, e.g. "budget – car rental",
//     "budget app", "budget planner", "budget bestie".
// Apple made the storefront header mandatory at some point; the endpoint
// itself was fine the whole time. This module restores the original
// expansion mechanism (see git history: commit 618d9f7) with the header fix
// and more robust plist parsing.

import { getErrorMessage } from "../../lib/error-serialization";
import { createLogger } from "../../logger";
import { RateLimitError, ssrfSafeFetch } from "../shared/ssrf-safe-fetch";
import { isJunkKeyword } from "./keyword-junk";
import {
  getExpansionSeeds,
  insertAutocompleteHints,
  keywordsExist,
  markSeedsExpanded,
  upsertKeywords,
} from "./keyword-store";
import type { AutocompleteHintRow, KeywordSeedRow } from "./keyword-store";

const log = createLogger("appstore:keyword-autocomplete");

const HINTS_BASE_URL = "https://search.itunes.apple.com/WebObjects/MZSearchHints.woa/wa/hints";

// Per-request timeout for a single seed's hint fetch. Short and separate
// from the SERP-scan timeout — this is a lightweight suggest endpoint, not a
// full search, and a wedged hint request shouldn't stall an expansion pass
// that fans out over many seeds.
const HINTS_FETCH_TIMEOUT_MS = 10_000;

// Prefix fan-out (2026-07-21 audit item D fix): the 26 single-letter query
// suffixes tried per seed, in order, up to `maxPrefixesPerSeed` — see
// `ExpandCorpusOptions` doc comment and `appstoreKeywordGap
// .autocompleteExpansion.prefixFanOut` in src/config/schema.ts.
const PREFIX_FAN_OUT_LETTERS: readonly string[] = "abcdefghijklmnopqrstuvwxyz".split("");

// ---------------------------------------------------------------------------
// Plist parsing
// ---------------------------------------------------------------------------

const NAMED_XML_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

/** Highest valid Unicode code point — `String.fromCodePoint` throws RangeError above this. */
const MAX_CODE_POINT = 0x10ffff;

/**
 * Decodes XML entities: the five named entities plus decimal (`&#8211;`) and
 * hex (`&#x2013;`) numeric character references — Apple's plist responses
 * can carry either form for punctuation like en/em dashes. Falls back to
 * leaving an unrecognized entity as-is rather than throwing, since this
 * parses untrusted upstream content — this includes an out-of-range numeric
 * reference (e.g. `&#x110000;`): `String.fromCodePoint` throws a RangeError
 * above U+10FFFF, so the code point is validated BEFORE it's ever passed in,
 * rather than relying on a try/catch, to keep the "never throws" contract
 * airtight for untrusted upstream content.
 */
function decodeXmlEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body.startsWith("#x")) {
      const code = Number.parseInt(body.slice(2), 16);
      return isValidCodePoint(code) ? String.fromCodePoint(code) : match;
    }
    if (body.startsWith("#")) {
      const code = Number.parseInt(body.slice(1), 10);
      return isValidCodePoint(code) ? String.fromCodePoint(code) : match;
    }
    return NAMED_XML_ENTITIES[body] ?? match;
  });
}

function isValidCodePoint(code: number): boolean {
  return !Number.isNaN(code) && code >= 0 && code <= MAX_CODE_POINT;
}

/**
 * Parses an Apple MZSearchHints plist-XML response body into an ordered
 * list of hint terms. The payload is a `<plist>` wrapping an `<array>` of
 * `<dict>` entries, each carrying (at least) a `<key>term</key><string>
 * PHRASE</string>` pair among other keys (e.g. `kind`). Array order IS
 * Apple's popularity ranking for the query — most-searched term first — so
 * this function preserves document order rather than re-sorting; callers
 * that only want the top handful should take a prefix rather than re-rank
 * the result (see `buildCandidatesFromHints`).
 *
 * Parsed defensively via a targeted regex rather than a full plist parser
 * (the project has no plist dependency and the shape is narrow and stable):
 * an unexpected or malformed body simply yields no matches instead of
 * throwing — this is untrusted upstream content and a parse miss should
 * degrade to "no suggestions this cycle", never crash the scraper process.
 */
export function parseHintTerms(body: string): readonly string[] {
  const terms: string[] = [];
  const termPattern = /<key>term<\/key>\s*<string>([^<]*)<\/string>/g;
  let match: RegExpExecArray | null = termPattern.exec(body);
  while (match !== null) {
    const raw = match[1];
    if (raw !== undefined) {
      const decoded = decodeXmlEntities(raw).trim();
      if (decoded.length > 0) terms.push(decoded);
    }
    match = termPattern.exec(body);
  }
  return terms;
}

/** Lowercase, trim, and collapse internal whitespace to single spaces. */
function normalizeSuggestion(s: string): string {
  return s.toLowerCase().trim().replace(/\s+/g, " ");
}

export interface HintCandidate {
  readonly keyword: string;
  readonly genreZone: string;
  /**
   * 0-based position in Apple's popularity-ordered response for this seed
   * (index into the array `parseHintTerms` returned, BEFORE junk-filtering
   * or the `perSeed` cap — so a candidate at rank 3 means 3 higher-ranked
   * raw terms preceded it, some of which may have been dropped as junk).
   * Not persisted (no corpus column carries per-suggestion rank — see
   * module doc in scraper.ts's wiring); exposed here for logging/tests and
   * because slicing to `perSeed` in rank order already applies it
   * structurally to what gets kept.
   */
  readonly rank: number;
}

// Suggestions longer than this are dropped outright — real App Store search
// queries are short phrases (a handful of words), so anything past this is
// almost certainly not a genuine suggestion. Defense-in-depth against a
// compromised/spoofed upstream stuffing an oversized string into a corpus
// keyword: these keywords flow into synthesis LLM prompts downstream (see
// src/pipelines/ideas/), so capping length here bounds the prompt-injection
// surface at the source rather than relying solely on downstream sanitizing.
const MAX_KEYWORD_LENGTH = 80;

/**
 * Turns one seed's raw, popularity-ordered hint terms into deduped,
 * junk-filtered candidates carrying the seed's `genreZone` and each term's
 * original rank. Pure, no I/O — corpus/existing-keyword dedup happens in
 * `expandCorpus`. Keeps at most `perSeed` GOOD (post-`isJunkKeyword`,
 * post-length-cap) candidates: since Apple's response is already
 * popularity-ordered, this keeps the top-N most-popular real suggestions per
 * seed rather than an arbitrary raw slice that might be mostly junk.
 */
export function buildCandidatesFromHints(
  terms: readonly string[],
  genreZone: string,
  perSeed: number,
): readonly HintCandidate[] {
  const seen = new Set<string>();
  const candidates: HintCandidate[] = [];
  for (let i = 0; i < terms.length && candidates.length < perSeed; i++) {
    const raw = terms[i];
    if (raw === undefined) continue;
    const keyword = normalizeSuggestion(raw);
    if (keyword.length === 0 || keyword.length > MAX_KEYWORD_LENGTH) continue;
    if (seen.has(keyword)) continue;
    if (isJunkKeyword(keyword)) continue;
    seen.add(keyword);
    candidates.push({ keyword, genreZone, rank: i });
  }
  return candidates;
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

/**
 * True iff `err` is (or carries the code of) `RateLimitError` — thrown by
 * `ssrfSafeFetch` when its rate-limit backoff retries are exhausted (see
 * `fetchHintsForSeed`, which opts in via `retryOnRateLimit: true`). Mirrors
 * `keyword-gaps.ts`'s `isRateLimitError` so both this module and the SERP
 * scan sweep classify the same way — they feed the same shared throttle
 * (see scraper.ts).
 */
function isRateLimitError(err: unknown): boolean {
  if (RateLimitError && err instanceof RateLimitError) return true;
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "RATE_LIMITED"
  );
}

/**
 * Fetches Apple search-hint suggestions for a single seed keyword. Sends the
 * `X-Apple-Store-Front` header the endpoint requires (see module doc) and
 * opts into `ssrfSafeFetch`'s rate-limit-aware retry, mirroring
 * `keyword-gaps.ts`'s `fetchTopApps` — both hit an Apple search endpoint on
 * the same corpus-scan cadence. Never throws on a non-OK HTTP status (logs
 * and returns no terms); DOES rethrow on a rate-limit-exhausted
 * `RateLimitError` so the caller can count it toward the shared throttle.
 */
async function fetchHintsForSeed(
  term: string,
  storefront: string,
  useProxy: boolean,
): Promise<readonly string[]> {
  const url = `${HINTS_BASE_URL}?clientApplication=Software&term=${encodeURIComponent(term)}`;
  const res = await ssrfSafeFetch(url, {
    headers: {
      "X-Apple-Store-Front": storefront,
      "User-Agent": "OpenCrow/1.0 (App Store Scraper)",
    },
    retryOnRateLimit: true,
    timeoutMs: HINTS_FETCH_TIMEOUT_MS,
    useProxy,
  });

  if (!res.ok) {
    log.warn("Autocomplete hints fetch returned non-OK status — skipping seed", {
      term,
      status: res.status,
    });
    return [];
  }

  const body = await res.text();
  return parseHintTerms(body);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export interface ExpandCorpusOptions {
  /** Minimum opportunity score a keyword must clear to count as a "winner" seed. */
  readonly minOpportunity: number;
  /** How many high-opportunity winner keywords may seed this pass. */
  readonly winnerLimit: number;
  /** How many zone-diverse (non-winner) keywords round out the seed set. */
  readonly diverseLimit: number;
  /** Upper bound on good suggestions kept per seed (see `buildCandidatesFromHints`). */
  readonly perSeed: number;
  /** Apple `X-Apple-Store-Front` header value — see module doc. MANDATORY. */
  readonly storefront: string;
  /**
   * Lowercase iTunes storefront country code this pass targets (throughput
   * wave item 3) — tags every persisted `appstore_autocomplete_hints` row
   * (migration 049's `storefront` column). Kept separate from the raw
   * `storefront` HEADER value above (which carries an opaque
   * `"<id>-<lang>,<cap>"` format, not a plain cc) so callers don't need to
   * parse the header string back into a market code. Defaults to `"us"`
   * for backward compatibility with pre-item-3 callers.
   */
  readonly market?: string;
  /** Delay between each seed's hint request within this pass. */
  readonly delayMs: number;
  /**
   * Throughput wave item 1: route this pass's hint fetches through the
   * Webshare proxy when true. Default false (direct fetch) — see
   * `appstoreKeywordGap.autocompleteExpansion.useProxy` /
   * `...gbLane.useProxy` in src/config/schema.ts.
   */
  readonly useProxy?: boolean;
  /**
   * Prefix fan-out (2026-07-21 audit item D fix): for each seed, ALSO
   * queries `"<seed> <letter>"` for up to this many single letters (a..z, in
   * order) — Apple's search-suggest returns different, more specific
   * completions per prefix, closer to how real users actually type. Each
   * fan-out query counts toward `attempted`/`rateLimitErrors` and respects
   * the same `delayMs` pacing as the bare seed. Optional; defaults to 0
   * (bare-seed-only, the pre-fix behavior) so existing callers/tests are
   * unaffected.
   */
  readonly maxPrefixesPerSeed?: number;
}

export interface ExpandCorpusResult {
  /** Count of NEW corpus keywords upserted with `source: "autocomplete"`. */
  readonly added: number;
  readonly seedsUsed: number;
  /**
   * Total hint-fetch REQUESTS made this pass — the bare seed plus any
   * prefix-fan-out queries (2026-07-21 audit item D fix), so this can now
   * exceed `seedsUsed` when `maxPrefixesPerSeed > 0`.
   */
  readonly attempted: number;
  /** Count of requests whose hint fetch hit an exhausted rate-limit retry. */
  readonly rateLimitErrors: number;
}

const EMPTY_RESULT: ExpandCorpusResult = {
  added: 0,
  seedsUsed: 0,
  attempted: 0,
  rateLimitErrors: 0,
};

/**
 * Expands the keyword corpus from Apple search-suggest hints, seeded from a
 * mix of current high-opportunity "winners" and zone-diverse picks (see
 * `keyword-store.ts`'s `getExpansionSeeds`, now seed-rotated — 2026-07-21
 * audit item D fix). For each seed, fetches the bare-seed hints plus up to
 * `maxPrefixesPerSeed` single-letter prefix-fan-out queries, extracts up to
 * `perSeed` good (junk-filtered) candidates per query in Apple's popularity
 * order, persists every (seed, term, rank) hint to `appstore_autocomplete_
 * hints` (migration 043 — previously discarded rank entirely), marks every
 * seed drawn this pass as expanded (rotates it to the back of next pass's
 * selection order), and upserts the genuinely new terms with
 * `source: "autocomplete"` inheriting the seed's `genreZone`.
 *
 * Never throws: a single seed's fetch failure is logged and treated as zero
 * hints so one bad seed cannot abort the whole pass (mirroring the original
 * 618d9f7 implementation's per-winner isolation). Rate-limit-exhausted
 * failures are additionally counted in the returned `rateLimitErrors` so the
 * caller (scraper.ts) can feed them into the shared sweep throttle.
 */
export async function expandCorpus(opts: ExpandCorpusOptions): Promise<ExpandCorpusResult> {
  const seeds = await getExpansionSeeds({
    minOpportunity: opts.minOpportunity,
    winnerLimit: opts.winnerLimit,
    diverseLimit: opts.diverseLimit,
  });
  if (seeds.length === 0) return EMPTY_RESULT;

  const maxPrefixesPerSeed = Math.max(0, opts.maxPrefixesPerSeed ?? 0);
  const nowSeconds = Math.floor(Date.now() / 1000);
  const market = opts.market ?? "us";
  const useProxy = opts.useProxy ?? false;

  const candidates: HintCandidate[] = [];
  const hintRows: AutocompleteHintRow[] = [];
  const seen = new Set<string>();
  let attempted = 0;
  let rateLimitErrors = 0;

  for (const seed of seeds) {
    // Prefix fan-out (2026-07-21 audit item D fix): the bare seed, plus up
    // to `maxPrefixesPerSeed` single-letter-suffixed queries — see
    // `ExpandCorpusOptions` doc comment.
    const queries = [
      seed.keyword,
      ...PREFIX_FAN_OUT_LETTERS.slice(0, maxPrefixesPerSeed).map((l) => `${seed.keyword} ${l}`),
    ];

    for (const query of queries) {
      attempted++;
      let terms: readonly string[] = [];
      try {
        terms = await fetchHintsForSeed(query, opts.storefront, useProxy);
      } catch (err) {
        if (isRateLimitError(err)) rateLimitErrors++;
        log.warn("Autocomplete hints fetch failed — skipping seed", {
          keyword: query,
          error: getErrorMessage(err),
        });
      }

      const queryCandidates = buildCandidatesFromHints(terms, seed.genreZone, opts.perSeed);
      for (const c of queryCandidates) {
        hintRows.push({ seed: query, term: c.keyword, rank: c.rank, seenAt: nowSeconds, storefront: market });
        if (seen.has(c.keyword)) continue;
        seen.add(c.keyword);
        candidates.push(c);
      }

      if (opts.delayMs > 0) await delay(opts.delayMs);
    }
  }

  // Seed rotation (2026-07-21 audit item D fix): every seed drawn this pass
  // rotates to the back of `getWinnerKeywords`/`getDiverseZoneSample`'s
  // selection order for the NEXT pass, regardless of whether its fetch(es)
  // succeeded or yielded candidates — see `markSeedsExpanded`'s doc comment.
  await markSeedsExpanded(
    seeds.map((s) => s.keyword),
    nowSeconds,
  );
  // Rank hints (2026-07-21 audit item D fix): persisted regardless of
  // whether a term ends up being a genuinely NEW corpus keyword below — the
  // rank signal itself is the point, not just the term.
  if (hintRows.length > 0) await insertAutocompleteHints(hintRows);

  if (candidates.length === 0) {
    log.info("Autocomplete corpus expansion", { added: 0, seedsUsed: seeds.length, attempted, rateLimitErrors });
    return { added: 0, seedsUsed: seeds.length, attempted, rateLimitErrors };
  }

  const existing = await keywordsExist(candidates.map((c) => c.keyword));
  const newCandidates = candidates.filter((c) => !existing.has(c.keyword));

  if (newCandidates.length === 0) {
    log.info("Autocomplete corpus expansion", { added: 0, seedsUsed: seeds.length, attempted, rateLimitErrors });
    return { added: 0, seedsUsed: seeds.length, attempted, rateLimitErrors };
  }

  const newRows: readonly KeywordSeedRow[] = newCandidates.map((c) => ({
    keyword: c.keyword,
    genreZone: c.genreZone,
    source: "autocomplete",
  }));
  await upsertKeywords(newRows);

  log.info("Autocomplete corpus expansion", {
    added: newRows.length,
    seedsUsed: seeds.length,
    attempted,
    rateLimitErrors,
    // A small sample for observability — real user queries vs mined
    // fragments should be visually obvious in these (multi-word, natural
    // phrasing) vs the miner's n-grams.
    sample: newCandidates.slice(0, 5).map((c) => c.keyword),
  });
  return { added: newRows.length, seedsUsed: seeds.length, attempted, rateLimitErrors };
}
