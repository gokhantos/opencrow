// Autocomplete-driven corpus growth for the App Store keyword-gap scanner.
// Widens the keyword corpus by pulling Apple's search-suggest hints for a
// broadened seed set — current high-opportunity "winner" keywords PLUS a
// diverse, zone-spread sample — so the scanner keeps finding new candidates
// instead of only ever amplifying whatever's already winning (rich-get-
// richer monoculture). Gated OFF by default
// (`appstoreKeywordGap.autocompleteExpansion.enabled`) — see the call site
// in scraper.ts.

import { getErrorMessage } from "../../lib/error-serialization";
import { createLogger } from "../../logger";
import { ssrfSafeFetch } from "../shared/ssrf-safe-fetch";
import { getExpansionSeeds, keywordsExist, upsertKeywords } from "./keyword-store";
import type { KeywordSeedRow } from "./keyword-store";

const log = createLogger("appstore:keyword-autocomplete");

const HINTS_BASE_URL = "https://search.itunes.apple.com/WebObjects/MZSearchHints.woa/wa/hints?q=";

// How many high-opportunity "winner" keywords seed a single expansion pass.
const WINNER_SEED_LIMIT = 12;
// How many round-robin, zone-spread keywords (see `getDiverseZoneSample`)
// seed the same pass, independent of whether they've ever won a scan.
// WINNER_SEED_LIMIT + DIVERSE_SEED_LIMIT (20) matches the pre-broadening
// MAX_WINNERS cap, so widening the seed mix doesn't increase fan-out
// (one network call per seed) against Apple's search-suggest endpoint.
const DIVERSE_SEED_LIMIT = 8;

/**
 * Extracts hint "term" phrases from an Apple MZSearchHints plist XML
 * response. The payload is an `<array>` of `<dict>` entries, each carrying
 * a `<key>term</key><string>PHRASE</string>` pair among other keys (e.g.
 * `kind`). Parsed defensively via a targeted regex rather than a full plist
 * parser: an unexpected or malformed body simply yields no matches instead
 * of throwing.
 */
function extractHintTerms(body: string): readonly string[] {
  const terms: string[] = [];
  const termPattern = /<key>term<\/key>\s*<string>([^<]*)<\/string>/g;
  let match: RegExpExecArray | null = termPattern.exec(body);
  while (match !== null) {
    const raw = match[1];
    if (raw !== undefined) terms.push(decodeXmlEntities(raw));
    match = termPattern.exec(body);
  }
  return terms;
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

/** Lowercase, trim, and collapse internal whitespace to single spaces. */
function normalizeSuggestion(s: string): string {
  return s.toLowerCase().trim().replace(/\s+/g, " ");
}

/**
 * Fetches Apple search-hint suggestions for a single seed keyword, bounded
 * to `perSeed` terms. Never throws — any fetch/parse failure is logged and
 * treated as zero hints so one bad seed cannot abort the whole expansion
 * pass.
 */
async function fetchHintsForSeed(keyword: string, perSeed: number): Promise<readonly string[]> {
  try {
    const url = `${HINTS_BASE_URL}${encodeURIComponent(keyword)}`;
    const res = await ssrfSafeFetch(url);
    if (!res.ok) {
      log.warn("Autocomplete hints fetch returned non-OK status — skipping seed", {
        keyword,
        status: res.status,
      });
      return [];
    }
    const body = await res.text();
    return extractHintTerms(body).slice(0, perSeed);
  } catch (err) {
    log.warn("Autocomplete hints fetch failed — skipping seed", {
      keyword,
      error: getErrorMessage(err),
    });
    return [];
  }
}

/**
 * Expands the keyword corpus from Apple search-suggest hints seeded off a
 * broadened mix (see `getExpansionSeeds`): up to `WINNER_SEED_LIMIT` recent
 * high-opportunity "winner" scans PLUS up to `DIVERSE_SEED_LIMIT` keywords
 * spread round-robin across genre zones, so expansion doesn't purely
 * amplify whatever's already winning. For each seed, fetches up to
 * `opts.perSeed` autocomplete suggestions, normalizes them, and upserts the
 * genuinely new ones with `source: "autocomplete"` inheriting the seed's
 * `genreZone`.
 *
 * Returns the count of NEW corpus terms upserted (terms already present in
 * the corpus are not counted, even though `upsertKeywords` would no-op
 * update them idempotently).
 */
export async function expandCorpus(opts: {
  readonly minOpportunity: number;
  readonly perSeed: number;
}): Promise<number> {
  const seeds = await getExpansionSeeds({
    minOpportunity: opts.minOpportunity,
    winnerLimit: WINNER_SEED_LIMIT,
    diverseLimit: DIVERSE_SEED_LIMIT,
  });
  if (seeds.length === 0) return 0;

  const candidates: KeywordSeedRow[] = [];
  const seen = new Set<string>();

  for (const seed of seeds) {
    const terms = await fetchHintsForSeed(seed.keyword, opts.perSeed);
    for (const term of terms) {
      const keyword = normalizeSuggestion(term);
      if (keyword.length === 0) continue;
      if (seen.has(keyword)) continue;
      seen.add(keyword);
      candidates.push({ keyword, genreZone: seed.genreZone, source: "autocomplete" });
    }
  }

  if (candidates.length === 0) return 0;

  const existing = await keywordsExist(candidates.map((c) => c.keyword));
  const newRows = candidates.filter((c) => !existing.has(c.keyword));
  if (newRows.length === 0) return 0;

  await upsertKeywords(newRows);
  return newRows.length;
}
