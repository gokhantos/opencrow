// Autocomplete-driven corpus growth for the App Store keyword-gap scanner.
// Widens the keyword corpus by pulling Apple's search-suggest hints for the
// current high-opportunity "winner" keywords, so the scanner keeps finding
// new candidates instead of only ever scanning its fixed seed corpus.
// Gated OFF by default (`appstoreKeywordGap.autocompleteExpansion.enabled`)
// — see the call site in scraper.ts.

import { getErrorMessage } from "../../lib/error-serialization";
import { createLogger } from "../../logger";
import { ssrfSafeFetch } from "../shared/ssrf-safe-fetch";
import { getWinnerKeywords, keywordsExist, upsertKeywords } from "./keyword-store";
import type { KeywordSeedRow } from "./keyword-store";

const log = createLogger("appstore:keyword-autocomplete");

const HINTS_BASE_URL = "https://search.itunes.apple.com/WebObjects/MZSearchHints.woa/wa/hints?q=";

// How many winner keywords may seed a single expansion pass. Bounds fan-out
// (one network call per winner) independent of how many keywords happen to
// clear `minOpportunity` on a given run.
const MAX_WINNERS = 20;

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
 * Fetches Apple search-hint suggestions for a single winner keyword,
 * bounded to `perSeed` terms. Never throws — any fetch/parse failure is
 * logged and treated as zero hints so one bad winner cannot abort the
 * whole expansion pass.
 */
async function fetchHintsForWinner(keyword: string, perSeed: number): Promise<readonly string[]> {
  try {
    const url = `${HINTS_BASE_URL}${encodeURIComponent(keyword)}`;
    const res = await ssrfSafeFetch(url);
    if (!res.ok) {
      log.warn("Autocomplete hints fetch returned non-OK status — skipping winner", {
        keyword,
        status: res.status,
      });
      return [];
    }
    const body = await res.text();
    return extractHintTerms(body).slice(0, perSeed);
  } catch (err) {
    log.warn("Autocomplete hints fetch failed — skipping winner", {
      keyword,
      error: getErrorMessage(err),
    });
    return [];
  }
}

/**
 * Expands the keyword corpus from Apple search-suggest hints seeded off
 * recent high-opportunity ("winner") scans. For each winner (up to
 * `MAX_WINNERS`), fetches up to `opts.perSeed` autocomplete suggestions,
 * normalizes them, and upserts the genuinely new ones with
 * `source: "autocomplete"` inheriting the winner's `genreZone`.
 *
 * Returns the count of NEW corpus terms upserted (terms already present in
 * the corpus are not counted, even though `upsertKeywords` would no-op
 * update them idempotently).
 */
export async function expandFromWinners(opts: {
  readonly minOpportunity: number;
  readonly perSeed: number;
}): Promise<number> {
  const winners = await getWinnerKeywords(opts.minOpportunity, MAX_WINNERS);
  if (winners.length === 0) return 0;

  const candidates: KeywordSeedRow[] = [];
  const seen = new Set<string>();

  for (const winner of winners) {
    const terms = await fetchHintsForWinner(winner.keyword, opts.perSeed);
    for (const term of terms) {
      const keyword = normalizeSuggestion(term);
      if (keyword.length === 0) continue;
      if (seen.has(keyword)) continue;
      seen.add(keyword);
      candidates.push({ keyword, genreZone: winner.genreZone, source: "autocomplete" });
    }
  }

  if (candidates.length === 0) return 0;

  const existing = await keywordsExist(candidates.map((c) => c.keyword));
  const newRows = candidates.filter((c) => !existing.has(c.keyword));
  if (newRows.length === 0) return 0;

  await upsertKeywords(newRows);
  return newRows.length;
}
