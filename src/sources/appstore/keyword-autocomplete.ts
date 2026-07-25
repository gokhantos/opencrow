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
import { isPassOverBudget } from "../shared/pass-deadline";
import { RateLimitError, ssrfSafeFetch } from "../shared/ssrf-safe-fetch";
import { recordHintProbes } from "./hint-probe-store";
import type { HintProbeWrite } from "./hint-probe-store";
import { buildBrandSegmentSet, isBrandNavigationalCandidate } from "./keyword-brand";
import { isJunkKeyword } from "./keyword-junk";
import {
  getExpansionSeeds,
  getScannedAppNames,
  insertAutocompleteHints,
  keywordsExist,
  markSeedsExpanded,
  upsertKeywords,
} from "./keyword-store";
import type { AutocompleteHintRow, KeywordSeedRow, SeedRotationUpdate } from "./keyword-store";

const log = createLogger("appstore:keyword-autocomplete");

const HINTS_BASE_URL = "https://search.itunes.apple.com/WebObjects/MZSearchHints.woa/wa/hints";

/**
 * MANDATORY wall-clock budget for one expansion pass (`pass-deadline.ts` —
 * see that module's doc comment for the 2026-07-21 incident it exists for).
 * This lane runs on `scraper.ts`'s shared, single-flight `auxiliaryLanesTick`
 * alongside ~12 others, so a slow-but-not-failing Apple can wedge every lane
 * on that tick, not just this one. The risk grew with the 2026-07-26 coverage
 * wave: raising `diverseLimit` widened the seed set, and requests-per-pass is
 * `seeds x (1 + maxPrefixesPerSeed)` — at 84 seeds and a 5-letter fan-out
 * that is 504 sequential requests, so an upstream answering slowly just under
 * its own 10s per-request timeout could otherwise keep this pass alive for
 * well over an hour. 8 minutes matches `keyword-gaps.ts`'s scan-batch budget;
 * the bail is checked BETWEEN queries, so it bounds the pass, not a single
 * wedged await (the single-flight guard's own 60min budget covers that).
 */
const MAX_PASS_DURATION_MS = 8 * 60_000;

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

/**
 * How many recently-scanned app names (`getScannedAppNames`) to pull when
 * building this pass's brand-segment set (Batch A budget rescue,
 * 2026-07-22) — see `keyword-brand.ts`'s `buildBrandSegmentSet`. Matches
 * `keyword-miner.ts`'s `DEFAULT_SCANNED_APPS_LIMIT`, the same pool size
 * already proven sufficient for that module's own brand/artist filtering.
 */
const BRAND_SEGMENT_APP_NAME_LIMIT = 2000;

/**
 * Batch C1 fix ("prefix fan-out never rotates"): builds a WRAPAROUND window
 * of `count` letters starting at `offset` into the 26-letter alphabet,
 * instead of the pre-fix `PREFIX_FAN_OUT_LETTERS.slice(0, count)` — which
 * always queried the SAME leading letters ("<seed> a".."<seed> e") on every
 * pass, forever, leaving ~21/26 of the per-seed suggest space unfetched. The
 * caller (`expandCorpus`) advances each seed's own `nextPrefixOffset` cursor
 * (persisted per (keyword, storefront) in `appstore_seed_expansion_state` —
 * migration 051) by the window's length after each pass, so successive
 * passes sweep through the whole alphabet over time instead of the same
 * fixed slice.
 *
 * Pure; `offset` is normalized via a true modulo (never negative, even for a
 * negative or `>= 26` input) and `count` is clamped to `[0, 26]` so a caller
 * can never request more letters than exist or a negative-length window.
 */
export function buildPrefixFanOutWindow(offset: number, count: number): readonly string[] {
  const alphabetSize = PREFIX_FAN_OUT_LETTERS.length;
  const clampedCount = Math.max(0, Math.min(count, alphabetSize));
  const normalizedOffset = ((offset % alphabetSize) + alphabetSize) % alphabetSize;
  const letters: string[] = [];
  for (let i = 0; i < clampedCount; i++) {
    const letter = PREFIX_FAN_OUT_LETTERS[(normalizedOffset + i) % alphabetSize];
    if (letter !== undefined) letters.push(letter);
  }
  return letters;
}

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
export function normalizeSuggestion(s: string): string {
  return s.toLowerCase().trim().replace(/\s+/g, " ");
}

/**
 * The 0-based rank at which `query` appears in its OWN suggestion list, or
 * `null` if Apple did not suggest the exact phrase back. Compared after
 * `normalizeSuggestion` on both sides so casing/whitespace differences in
 * Apple's echo don't read as a miss.
 *
 * This is the `self_rank` column of the probe ledger (migration 057). For a
 * DIRECT corpus-keyword probe it is the keyword's own popularity rank —
 * "Apple treats this exact phrase as a real query, at position N" — and a
 * `null` alongside a non-empty response is the cleanest negative the endpoint
 * can give: Apple answered, and the phrase was not in the answer. For a
 * prefix-fan-out query (`"budget a"`) a self-match is not expected and `null`
 * carries no such meaning, which is why only the direct-probe pass reads it as
 * evidence about a keyword.
 *
 * Pure; ranks against the RAW parsed terms (pre junk/length/dedup filter) so
 * the rank is gapless and comparable with `appstore_autocomplete_hints.rank` —
 * see `classifyHintTerms`.
 */
export function findSelfRank(query: string, terms: readonly string[]): number | null {
  const needle = normalizeSuggestion(query);
  if (needle.length === 0) return null;
  for (let i = 0; i < terms.length; i++) {
    const term = terms[i];
    if (term !== undefined && normalizeSuggestion(term) === needle) return i;
  }
  return null;
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
 * One raw parsed term, classified: `kept` mirrors exactly what
 * `buildCandidatesFromHints` would have selected as a genuine expansion
 * candidate (same junk/length/dedup/perSeed-cap predicate — the two are
 * implemented via the SAME underlying pass, see `classifyHintTerms`, so they
 * can never drift out of sync). `rank` is the term's 0-based position in the
 * RAW (pre-filter) `terms` array — this is what makes rank gapless across
 * the whole persisted hint log (Batch D item D1): every parsed term gets a
 * row, not just the ones that passed the filter.
 */
export interface HintLogEntry {
  readonly term: string;
  readonly rank: number;
  readonly kept: boolean;
}

/**
 * Classifies EVERY raw, popularity-ordered hint term Apple returned — unlike
 * the pre-Batch-D `buildCandidatesFromHints`, this does NOT stop iterating
 * once `perSeed` good candidates are found; it walks the whole array so
 * every term gets a logged verdict (Batch D item D1: "log ALL parsed terms
 * pre-filter with kept=false/true so ranks are gapless"). A term is `kept`
 * iff it survives normalization/length, is not a duplicate of an
 * already-kept term THIS call, is not junk (`isJunkKeyword`), AND the
 * running kept-count is still under `perSeed` at the time it's reached (in
 * original rank order) — i.e. exactly `buildCandidatesFromHints`' old
 * predicate, just computed without early-exiting.
 *
 * `HintLogEntry.term` is capped to `MAX_KEYWORD_LENGTH` before being
 * returned — every parsed term is logged now (Batch D item D1), including
 * ones that fail the length check, and `appstore_autocomplete_hints.term`
 * is an unconstrained TEXT column (migration 043) with no DB-side bound.
 * Previously an over-length term was simply dropped (`continue`) before
 * anything was persisted; logging it verbatim now would let an
 * unbounded, upstream-influenced string reach the column. Truncating here
 * keeps the rank slot occupied (the gapless-rank goal) while restoring the
 * length invariant `buildCandidatesFromHints` always enforced for KEPT
 * candidates. `kept` still reflects the ORIGINAL (pre-truncation) length
 * check — a term that only fits after truncation is still `kept: false`,
 * exactly as `buildCandidatesFromHints` would have dropped it.
 */
export function classifyHintTerms(
  terms: readonly string[],
  perSeed: number,
): readonly HintLogEntry[] {
  const seen = new Set<string>();
  let keptCount = 0;
  const entries: HintLogEntry[] = [];
  for (let i = 0; i < terms.length; i++) {
    const raw = terms[i];
    if (raw === undefined) continue;
    const keyword = normalizeSuggestion(raw);
    const validLength = keyword.length > 0 && keyword.length <= MAX_KEYWORD_LENGTH;
    const isDuplicate = validLength && seen.has(keyword);
    const isJunk = validLength && !isDuplicate && isJunkKeyword(keyword);
    const withinCap = keptCount < perSeed;
    const kept = validLength && !isDuplicate && !isJunk && withinCap;
    if (kept) {
      seen.add(keyword);
      keptCount++;
    }
    const persistedTerm = keyword.slice(0, MAX_KEYWORD_LENGTH);
    entries.push({ term: persistedTerm, rank: i, kept });
  }
  return entries;
}

/**
 * Turns one seed's raw, popularity-ordered hint terms into deduped,
 * junk-filtered candidates carrying the seed's `genreZone` and each term's
 * original rank. Pure, no I/O — corpus/existing-keyword dedup happens in
 * `expandCorpus`. Keeps at most `perSeed` GOOD (post-`isJunkKeyword`,
 * post-length-cap) candidates: since Apple's response is already
 * popularity-ordered, this keeps the top-N most-popular real suggestions per
 * seed rather than an arbitrary raw slice that might be mostly junk.
 * Implemented via `classifyHintTerms` so the candidate set and the FULL
 * per-term hint log (`expandCorpus`) share the exact same predicate.
 */
export function buildCandidatesFromHints(
  terms: readonly string[],
  genreZone: string,
  perSeed: number,
): readonly HintCandidate[] {
  return classifyHintTerms(terms, perSeed)
    .filter((e) => e.kept)
    .map((e) => ({ keyword: e.term, genreZone, rank: e.rank }));
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
 * The result of one hint fetch. A discriminated union rather than a bare
 * `readonly string[]` because the coverage wave (2026-07-26) made the
 * difference between "Apple answered with nothing" and "we never got an
 * answer" load-bearing, and the old signature collapsed BOTH into `[]`.
 *
 * That collapse is exactly how the probe ledger could be poisoned: a
 * rate-limited or 403'd request recorded as `returned_any = false` would
 * manufacture a confirmed "Apple has no suggestions for this phrase" out of a
 * request Apple never served — turning a transport failure into a permanent
 * false negative in the one incumbent-independent demand signal we have. With
 * this type the caller CANNOT write a probe row for a failure without first
 * narrowing on `ok`, so the invariant is enforced by the compiler rather than
 * by a comment.
 */
export type HintFetchOutcome =
  | { readonly ok: true; readonly terms: readonly string[] }
  | { readonly ok: false; readonly rateLimited: boolean };

/**
 * Fetches Apple search-hint suggestions for a single query. Sends the
 * `X-Apple-Store-Front` header the endpoint requires (see module doc) and
 * opts into `ssrfSafeFetch`'s rate-limit-aware retry, mirroring
 * `keyword-gaps.ts`'s `fetchTopApps` — both hit an Apple search endpoint on
 * the same corpus-scan cadence.
 *
 * NEVER THROWS. A non-OK status, a transport error, and a rate-limit-exhausted
 * `RateLimitError` all return `{ ok: false }`, with `rateLimited` set so the
 * caller can keep counting rate-limit failures into the shared throttle
 * exactly as before (the old contract rethrew `RateLimitError` for that
 * purpose; the count is unchanged, only the mechanism differs). Bare-403
 * semantics are preserved via `treat403AsRateLimit` — counted, and
 * non-retryable beyond `ssrfSafeFetch`'s own exhausted backoff.
 */
export async function fetchHintTerms(
  term: string,
  storefront: string,
  useProxy: boolean,
): Promise<HintFetchOutcome> {
  const url = `${HINTS_BASE_URL}?clientApplication=Software&term=${encodeURIComponent(term)}`;
  try {
    // `treat403AsRateLimit: true` — `search.itunes.apple.com` is the same
    // Apple-enforced per-IP burst ceiling as the other direct iTunes JSON
    // lanes, signaled with a bare 403 (no `Retry-After`) rather than
    // 429/503. See `rate-limit-error.ts`'s
    // `RateLimitStatusOptions.treat403AsRateLimit`.
    const res = await ssrfSafeFetch(url, {
      headers: {
        "X-Apple-Store-Front": storefront,
        "User-Agent": "OpenCrow/1.0 (App Store Scraper)",
      },
      retryOnRateLimit: true,
      treat403AsRateLimit: true,
      timeoutMs: HINTS_FETCH_TIMEOUT_MS,
      useProxy,
    });

    if (!res.ok) {
      log.warn("Autocomplete hints fetch returned non-OK status — skipping seed", {
        term,
        status: res.status,
      });
      return { ok: false, rateLimited: false };
    }

    const body = await res.text();
    return { ok: true, terms: parseHintTerms(body) };
  } catch (err) {
    const rateLimited = isRateLimitError(err);
    log.warn("Autocomplete hints fetch failed — skipping seed", {
      keyword: term,
      rateLimited,
      error: getErrorMessage(err),
    });
    return { ok: false, rateLimited };
  }
}

/**
 * Builds the probe-ledger row for ONE successful query (migration 057). Pure,
 * and only reachable from an `ok: true` outcome by construction — see
 * `HintFetchOutcome`.
 */
export function buildProbeWrite(args: {
  readonly query: string;
  readonly storefront: string;
  readonly probedAt: number;
  readonly terms: readonly string[];
}): HintProbeWrite {
  return {
    query: args.query,
    storefront: args.storefront,
    probedAt: args.probedAt,
    returnedAny: args.terms.length > 0,
    termCount: args.terms.length,
    selfRank: findSelfRank(args.query, args.terms),
  };
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
   * Prefix fan-out (2026-07-21 audit item D fix, wraparound-windowed as of
   * Batch C1): for each seed, ALSO queries `"<seed> <letter>"` for up to
   * this many single letters — Apple's search-suggest returns different,
   * more specific completions per prefix, closer to how real users actually
   * type. As of Batch C1 (migration 051) the letters queried are a
   * WRAPAROUND WINDOW of this size starting at the seed's own
   * `nextPrefixOffset` cursor (`buildPrefixFanOutWindow`), not always the
   * same fixed `a..e`-style leading slice — each pass advances every drawn
   * seed's cursor by however many letters it queried, so successive passes
   * sweep the whole 26-letter alphabet over time. Each fan-out query counts
   * toward `attempted`/`rateLimitErrors` and respects the same `delayMs`
   * pacing as the bare seed. Optional; defaults to 0 (bare-seed-only, the
   * pre-fix behavior) so existing callers/tests are unaffected.
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
  /**
   * Count of otherwise-new candidates dropped by the insert-time
   * brand-navigational filter (Batch A budget rescue, 2026-07-22 — see
   * `keyword-brand.ts`'s `isBrandNavigationalCandidate`), mirroring the
   * `evaluated`/`deactivated` observability `keyword-store.ts`'s
   * `deactivateJunkKeywords` call site logs for junk deactivation.
   */
  readonly brandFiltered: number;
  /**
   * Total RAW terms Apple returned across every query this pass, summed
   * BEFORE any junk/length/dedup filtering (B2 flatline detector). This is
   * the signal the caller (`scraper.ts`'s flatline check) uses to tell
   * "endpoint/header broke" (rawTermCount === 0 despite attempted > 0 — the
   * exact shape of the silent 2026-07-18 header-change incident) apart from
   * "Apple answered but everything was junk/already-known" (rawTermCount > 0,
   * added possibly 0). `added` alone can't distinguish these — an all-junk or
   * all-existing pass and a dead-endpoint pass both log `added: 0`.
   */
  readonly rawTermCount: number;
  /**
   * Coverage wave (2026-07-26): how many queries this pass recorded into the
   * probe ledger (`appstore_autocomplete_probes`, migration 057) — i.e. how
   * many of `attempted` actually got an ANSWER from Apple. `attempted -
   * probesRecorded` is the pass's transport-failure count, which is
   * deliberately NOT written to the ledger: a failed request teaches us
   * nothing about demand, and recording it would fabricate a confirmed zero.
   */
  readonly probesRecorded: number;
  /**
   * Of `probesRecorded`, how many came back with an EMPTY suggestion list.
   * This is the datum that was previously unrepresentable — Apple answering
   * "nothing for that phrase" left no trace at all, which is why hint absence
   * could not be used as a signal. A healthy pass has some of these
   * (specific prefixes genuinely have no completions); ALL of them empty
   * while `rateLimitErrors` is 0 is the shape of a header/endpoint break, and
   * is already covered by the `rawTermCount === 0` flatline detector.
   */
  readonly emptyResponses: number;
}

const EMPTY_RESULT: ExpandCorpusResult = {
  added: 0,
  seedsUsed: 0,
  attempted: 0,
  rateLimitErrors: 0,
  brandFiltered: 0,
  rawTermCount: 0,
  probesRecorded: 0,
  emptyResponses: 0,
};

/**
 * Expands the keyword corpus from Apple search-suggest hints, seeded from a
 * mix of current high-opportunity "winners" and zone-diverse picks (see
 * `keyword-store.ts`'s `getExpansionSeeds`, now seed-rotated — 2026-07-21
 * audit item D fix — and storefront-scoped, Batch C2). For each seed,
 * fetches the bare-seed hints plus up to `maxPrefixesPerSeed` prefix-fan-out
 * queries drawn from a WRAPAROUND WINDOW over the seed's own rotation cursor
 * (Batch C1 — see `buildPrefixFanOutWindow`), extracts up to `perSeed` good
 * (junk-filtered) candidates per query in Apple's popularity order, persists
 * every (seed, term, rank) hint to `appstore_autocomplete_hints` (migration
 * 043 — previously discarded rank entirely), marks every seed drawn this
 * pass as expanded (rotates it to the back of next pass's selection order
 * AND advances its prefix-window cursor — both keyed per (keyword,
 * `opts.market`), migration 051), and upserts the genuinely new terms with
 * `source: "autocomplete"` inheriting the seed's `genreZone`.
 *
 * Never throws: a single seed's fetch failure is logged and treated as zero
 * hints so one bad seed cannot abort the whole pass (mirroring the original
 * 618d9f7 implementation's per-winner isolation). Rate-limit-exhausted
 * failures are additionally counted in the returned `rateLimitErrors` so the
 * caller (scraper.ts) can feed them into the shared sweep throttle.
 */
export async function expandCorpus(opts: ExpandCorpusOptions): Promise<ExpandCorpusResult> {
  const market = opts.market ?? "us";
  const seeds = await getExpansionSeeds({
    minOpportunity: opts.minOpportunity,
    winnerLimit: opts.winnerLimit,
    diverseLimit: opts.diverseLimit,
    market,
  });
  if (seeds.length === 0) return EMPTY_RESULT;

  const maxPrefixesPerSeed = Math.max(0, opts.maxPrefixesPerSeed ?? 0);
  const nowSeconds = Math.floor(Date.now() / 1000);
  const useProxy = opts.useProxy ?? false;
  const passStartedAtMs = Date.now();

  const candidates: HintCandidate[] = [];
  const hintRows: AutocompleteHintRow[] = [];
  const seedUpdates: SeedRotationUpdate[] = [];
  const probeWrites: HintProbeWrite[] = [];
  const seen = new Set<string>();
  let attempted = 0;
  let rateLimitErrors = 0;
  // B2 flatline: total raw terms Apple returned this pass, summed BEFORE the
  // junk/length/dedup filter — see `ExpandCorpusResult.rawTermCount`.
  let rawTermCount = 0;
  let emptyResponses = 0;
  let overBudget = false;

  for (const seed of seeds) {
    // MANDATORY wall-clock bail (`pass-deadline.ts`) — checked per SEED as
    // well as per query so a wide seed set can't outrun the budget. Seeds not
    // reached simply stay at the front of next pass's rotation order
    // (`getExpansionSeeds` orders by `last_expanded_at ASC NULLS FIRST`), so
    // bailing loses no work — it defers it.
    if (isPassOverBudget(passStartedAtMs, MAX_PASS_DURATION_MS)) {
      overBudget = true;
      break;
    }
    // Prefix fan-out (Batch C1 — wraparound window): the bare seed, plus a
    // window of up to `maxPrefixesPerSeed` letters starting at this seed's
    // OWN `nextPrefixOffset` cursor — see `ExpandCorpusOptions` doc comment
    // and `buildPrefixFanOutWindow`.
    const window = buildPrefixFanOutWindow(seed.nextPrefixOffset, maxPrefixesPerSeed);
    const queries = [seed.keyword, ...window.map((l) => `${seed.keyword} ${l}`)];
    // How many of `window`'s letters this seed actually got through — the
    // cursor must advance by THIS, not by `window.length`, or a mid-seed
    // wall-clock bail would silently skip the unqueried letters forever (the
    // exact class of "the fan-out never covers the alphabet" bug Batch C1
    // fixed).
    let lettersQueried = 0;

    for (const query of queries) {
      if (isPassOverBudget(passStartedAtMs, MAX_PASS_DURATION_MS)) {
        overBudget = true;
        break;
      }
      // `queries[0]` is the bare seed; every later entry consumed one letter.
      if (query !== seed.keyword) lettersQueried++;
      attempted++;
      const outcome = await fetchHintTerms(query, opts.storefront, useProxy);
      if (!outcome.ok) {
        if (outcome.rateLimited) rateLimitErrors++;
        // No probe row: a failed request is not evidence of absence. See
        // `HintFetchOutcome` / `recordHintProbes`' doc comments.
        if (opts.delayMs > 0) await delay(opts.delayMs);
        continue;
      }
      const terms = outcome.terms;
      // Probe ledger (coverage wave, migration 057): record that this exact
      // query WAS issued and what came back — including the empty case, which
      // is the observation the pre-057 schema could not represent at all.
      probeWrites.push(
        buildProbeWrite({ query, storefront: market, probedAt: nowSeconds, terms }),
      );
      if (terms.length === 0) emptyResponses++;
      // B2: count raw terms BEFORE junk-filtering (`buildCandidatesFromHints`
      // below), so an all-junk response is still distinguishable from a
      // dead-endpoint (zero-term) one.
      rawTermCount += terms.length;

      // Batch D item D1: log EVERY parsed term (kept or not), not just the
      // ones that became candidates — see `classifyHintTerms`'s doc comment
      // for why this matters (gapless ranks, sound absence reasoning).
      const entries = classifyHintTerms(terms, opts.perSeed);
      for (const e of entries) {
        hintRows.push({
          seed: query,
          term: e.term,
          rank: e.rank,
          seenAt: nowSeconds,
          storefront: market,
          kept: e.kept,
        });
        if (!e.kept) continue;
        // Cross-query (bare seed + prefix fan-out) dedup for the CANDIDATE
        // set feeding corpus expansion below — distinct from
        // `classifyHintTerms`' own per-query dedup.
        if (seen.has(e.term)) continue;
        seen.add(e.term);
        candidates.push({ keyword: e.term, genreZone: seed.genreZone, rank: e.rank });
      }

      if (opts.delayMs > 0) await delay(opts.delayMs);
    }

    // Advance THIS seed's cursor by however many prefix letters were
    // actually queried this pass (`lettersQueried`, not the nominal
    // `maxPrefixesPerSeed` — those differ when the window was clamped, e.g. a
    // caller passing > 26, or when the wall-clock bail cut the seed short) —
    // wraps at 26 via the same modulo `buildPrefixFanOutWindow` uses
    // internally.
    seedUpdates.push({
      keyword: seed.keyword,
      storefront: market,
      nextPrefixOffset: (seed.nextPrefixOffset + lettersQueried) % PREFIX_FAN_OUT_LETTERS.length,
    });

    if (overBudget) break;
  }

  if (overBudget) {
    log.warn("Autocomplete expansion pass bailing early — exceeded wall-clock budget", {
      market,
      maxDurationMs: MAX_PASS_DURATION_MS,
      elapsedMs: Date.now() - passStartedAtMs,
      seedsProcessed: seedUpdates.length,
      seedsPlanned: seeds.length,
      attempted,
    });
  }

  // Seed rotation (2026-07-21 audit item D fix, widened Batch C1+C2): every
  // seed drawn this pass rotates to the back of
  // `getWinnerKeywords`/`getDiverseZoneSample`'s selection order for the
  // NEXT pass AND has its prefix-window cursor advanced, regardless of
  // whether its fetch(es) succeeded or yielded candidates — see
  // `markSeedsExpanded`'s doc comment.
  await markSeedsExpanded(seedUpdates, nowSeconds);
  // Rank hints (2026-07-21 audit item D fix): persisted regardless of
  // whether a term ends up being a genuinely NEW corpus keyword below — the
  // rank signal itself is the point, not just the term.
  if (hintRows.length > 0) await insertAutocompleteHints(hintRows);
  // Probe ledger (coverage wave, migration 057): persisted on the SAME
  // unconditional path as the hint rows and for the same reason — the record
  // of what we ASKED is the signal, independent of whether anything new made
  // it into the corpus. Failure-only passes write nothing here (see the
  // `!outcome.ok` branch above), so an empty `probeWrites` is normal.
  if (probeWrites.length > 0) await recordHintProbes(probeWrites);

  /**
   * All five exit paths return the same counter set, so build it once —
   * previously four near-identical 6-field literals that had to be edited in
   * lockstep every time a counter was added (and that had already drifted:
   * `seedsUsed` reported the PLANNED seed count, which a wall-clock bail now
   * makes wrong — it reports seeds actually processed).
   */
  const result = (added: number, brandFiltered: number): ExpandCorpusResult => ({
    added,
    seedsUsed: seedUpdates.length,
    attempted,
    rateLimitErrors,
    brandFiltered,
    rawTermCount,
    probesRecorded: probeWrites.length,
    emptyResponses,
  });

  if (candidates.length === 0) {
    log.info("Autocomplete corpus expansion", result(0, 0));
    return result(0, 0);
  }

  const existing = await keywordsExist(candidates.map((c) => c.keyword));
  const nonExisting = candidates.filter((c) => !existing.has(c.keyword));

  if (nonExisting.length === 0) {
    log.info("Autocomplete corpus expansion", result(0, 0));
    return result(0, 0);
  }

  // Insert-time brand-navigational filter (Batch A budget rescue,
  // 2026-07-22 — see `keyword-brand.ts` module doc, layer 1): applied AFTER
  // the corpus-existence check (no point classifying a candidate that's
  // already excluded) but BEFORE `upsertKeywords` — a candidate dropped here
  // never occupies a corpus/tier-1 slot in the first place. The brand
  // segment set is built ONCE per pass from the same broad, continuously-
  // refreshed `getScannedAppNames` pool `keyword-miner.ts` already mines
  // from, not re-fetched per candidate.
  const scannedAppNames = await getScannedAppNames(BRAND_SEGMENT_APP_NAME_LIMIT);
  const brandSegments = buildBrandSegmentSet(scannedAppNames);
  const newCandidates = nonExisting.filter(
    (c) => !isBrandNavigationalCandidate(c.keyword, brandSegments),
  );
  const brandFiltered = nonExisting.length - newCandidates.length;

  if (newCandidates.length === 0) {
    log.info("Autocomplete corpus expansion", result(0, brandFiltered));
    return result(0, brandFiltered);
  }

  const newRows: readonly KeywordSeedRow[] = newCandidates.map((c) => ({
    keyword: c.keyword,
    genreZone: c.genreZone,
    source: "autocomplete",
  }));
  await upsertKeywords(newRows);

  log.info("Autocomplete corpus expansion", {
    ...result(newRows.length, brandFiltered),
    // A small sample for observability — real user queries vs mined
    // fragments should be visually obvious in these (multi-word, natural
    // phrasing) vs the miner's n-grams.
    sample: newCandidates.slice(0, 5).map((c) => c.keyword),
  });
  return result(newRows.length, brandFiltered);
}
