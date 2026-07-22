// Batch C4 ("mine keywords from review complaint language") — THIRD
// corpus-discovery source, modeled on keyword-miner.ts's app-name/ranking
// miner. Nothing else in the corpus mines what USERS actually SAY: the seed
// corpus is human-curated, autocomplete mines Apple's popularity-ordered
// search-suggest, and keyword-miner.ts mines app titles/categories — none of
// them touches the 50k+ low-star reviews the review-harvester (Stage 4,
// migration 047) already collects across its enrolled app population.
// Complaint language ("wish it had X", "missing Y", "no Z option") is a
// direct, unfiltered statement of unmet market need that no other source
// surfaces.
//
// Extraction is a PURE function (`extractComplaintCandidates`): normalize +
// stopword-filter each review's title+content (reusing keyword-miner.ts's
// `normalizeText`/`tokenize`/`filterJunkTokens`/`filterStopwords` — same
// text-cleaning rules apply to review prose as to app titles), build 2-3
// token n-grams, and keep only n-grams that are either NEED-shaped (contain
// an anchor token like "want"/"need"/"wish"/"missing"/"without"/"no") or
// repeat across at least `MIN_CROSS_APP_REPEAT` DISTINCT apps — cross-app
// repetition of the same phrase is itself evidence of a shared market need,
// not one reviewer's pet peeve about one app. Every n-gram is additionally
// checked against `isJunkKeyword` before being kept.
//
// The review pool is enrollment-gated to whatever population
// `review-harvester.ts` currently tracks (a few hundred apps at a time — see
// `appstoreReviewHarvest`'s cohort caps), so this deepens ALREADY-TRACKED
// niches rather than discovering brand-new ones the way autocomplete/mined
// do — a narrower, more speculative source, hence default OFF (see
// `corpusDiscovery.reviewMining` in src/config/schema.ts). Many phrases will
// legitimately prune back out via the shared mined/review deactivation rule
// (`keyword-deactivation.ts`'s `shouldDeactivateMinedKeyword`) once scanned
// and found to have low demand — that self-pruning is intentional, not a
// bug to route around.

import { createLogger } from "../../logger";
import { isJunkKeyword } from "./keyword-junk";
import {
  DEFAULT_ZONE,
  filterJunkTokens,
  filterStopwords,
  mapCategoryToZone,
  normalizeText,
  tokenize,
} from "./keyword-miner";
import { keywordsExist, upsertKeywords } from "./keyword-store";
import type { KeywordSeedRow } from "./keyword-store";
import { getAppMetaBatch } from "./app-meta-store";
import { getRecentComplaintReviews } from "./store";

const log = createLogger("appstore:keyword-review-miner");

/** How many recent complaint (rating <= 3) reviews to scan per mining pass, by default. */
const DEFAULT_REVIEW_SCAN_LIMIT = 5000;

/**
 * Upper bound on a single cleaned token's length. Review text is fully
 * attacker-controlled (anyone can post a review), and the shared
 * `filterJunkTokens`/`isJunkKeyword` filters have no upper length bound — so
 * without this, one hostile review containing a single very long no-space
 * run of letters would pass through as a multi-thousand-character "keyword"
 * that gets upserted to the corpus and later used as a literal search-suggest
 * / iTunes query string. 30 comfortably covers real English words/short
 * phrases while rejecting pathological input.
 */
const MAX_REVIEW_TOKEN_LENGTH = 30;

/**
 * Upper bound on how many cleaned tokens from a single review are turned
 * into n-grams. Without this, one abnormally long review (however many
 * tokens survive cleaning) would blow up the per-pass working set (`hits`
 * array + `appsByNgram` map) in memory. 200 comfortably covers a real review
 * body.
 */
const MAX_REVIEW_TOKENS_PER_REVIEW = 200;

/**
 * A review n-gram counts as NEED-shaped if it contains any of these tokens —
 * direct linguistic markers of an unmet want, independent of how many other
 * apps' reviewers happen to use the same phrase. Deliberately narrow (a few
 * common inflections of "want"/"need"/"wish"/"missing"/"without"/"no")
 * rather than an exhaustive sentiment lexicon — precision over recall, since
 * the cross-app-repetition path (`MIN_CROSS_APP_REPEAT`) independently
 * catches genuine need-signals this list misses.
 */
const NEED_ANCHOR_TOKENS: ReadonlySet<string> = new Set([
  "want",
  "wants",
  "wanted",
  "wanting",
  "need",
  "needs",
  "needed",
  "needing",
  "wish",
  "wishes",
  "wished",
  "wishing",
  "missing",
  "without",
  "no",
]);

/** An n-gram with no anchor token must repeat across at least this many DISTINCT apps to qualify — see module doc. */
export const MIN_CROSS_APP_REPEAT = 3;

export interface ReviewMinerInput {
  readonly appId: string;
  readonly title: string;
  readonly content: string;
}

export interface ReviewComplaintCandidate {
  readonly keyword: string;
  /** The app whose review FIRST produced this n-gram — used to resolve `genreZone` (first-app-seen wins, same convention as keyword-miner.ts's `extractCandidates`). */
  readonly appId: string;
}

/** Builds every 2-token and 3-token (never 1-token) n-gram from a cleaned token sequence, in order. */
function buildComplaintNGrams(tokens: readonly string[]): readonly string[] {
  const grams: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const a = tokens[i];
    const b = tokens[i + 1];
    if (a === undefined || b === undefined) continue;
    grams.push(`${a} ${b}`);
    const c = tokens[i + 2];
    if (c !== undefined) grams.push(`${a} ${b} ${c}`);
  }
  return grams;
}

/** True iff any token in `gram` (space-split) is a NEED_ANCHOR_TOKENS member. */
function hasNeedAnchor(gram: string): boolean {
  return gram.split(" ").some((t) => NEED_ANCHOR_TOKENS.has(t));
}

/**
 * Extracts complaint-shaped keyword candidates across a batch of reviews.
 * Pure — no I/O, no Date. Two passes over the cleaned n-grams: the first
 * builds every candidate n-gram per review plus a running distinct-app-count
 * per n-gram; the second keeps only n-grams that are NEED-shaped OR that
 * cleared `MIN_CROSS_APP_REPEAT` distinct apps, deduped keyword-first (the
 * FIRST review to produce a given n-gram wins its `appId` — mirrors
 * `keyword-miner.ts`'s `extractCandidates` "first app wins the zone"
 * convention). Within a single review, a repeated n-gram is only counted
 * once toward the distinct-app tally (so one verbose review can't fake
 * cross-app repetition on its own).
 */
export function extractComplaintCandidates(
  reviews: readonly ReviewMinerInput[],
): readonly ReviewComplaintCandidate[] {
  interface RawHit {
    readonly keyword: string;
    readonly appId: string;
    readonly hasAnchor: boolean;
  }

  const hits: RawHit[] = [];
  const appsByNgram = new Map<string, Set<string>>();

  for (const review of reviews) {
    const normalized = normalizeText(`${review.title} ${review.content}`);
    const cleanedTokens = filterStopwords(filterJunkTokens(tokenize(normalized)))
      .filter((t) => t.length <= MAX_REVIEW_TOKEN_LENGTH)
      .slice(0, MAX_REVIEW_TOKENS_PER_REVIEW);
    if (cleanedTokens.length === 0) continue;

    const seenInReview = new Set<string>();
    for (const gram of buildComplaintNGrams(cleanedTokens)) {
      if (isJunkKeyword(gram)) continue;
      if (seenInReview.has(gram)) continue;
      seenInReview.add(gram);

      hits.push({ keyword: gram, appId: review.appId, hasAnchor: hasNeedAnchor(gram) });
      let apps = appsByNgram.get(gram);
      if (!apps) {
        apps = new Set();
        appsByNgram.set(gram, apps);
      }
      apps.add(review.appId);
    }
  }

  const seen = new Map<string, ReviewComplaintCandidate>();
  for (const hit of hits) {
    if (seen.has(hit.keyword)) continue;
    const distinctApps = appsByNgram.get(hit.keyword)?.size ?? 0;
    const qualifies = hit.hasAnchor || distinctApps >= MIN_CROSS_APP_REPEAT;
    if (!qualifies) continue;
    seen.set(hit.keyword, { keyword: hit.keyword, appId: hit.appId });
  }
  return Array.from(seen.values());
}

export interface MineReviewKeywordsOptions {
  /** How many recent complaint reviews to scan. Default `DEFAULT_REVIEW_SCAN_LIMIT`. */
  readonly reviewLimit?: number;
  /** Only reviews first seen at or after this epoch-seconds timestamp are scanned. */
  readonly sinceSeconds: number;
  /** Upper bound on newly-added corpus keywords for this cycle. */
  readonly maxNew: number;
}

export interface MineReviewKeywordsResult {
  /** Count of NEW corpus keywords upserted with `source: "review"`. */
  readonly added: number;
  /** Count of complaint reviews scanned this pass. */
  readonly scanned: number;
}

const EMPTY_RESULT = (scanned: number): MineReviewKeywordsResult => ({ added: 0, scanned });

/**
 * Mines new keyword candidates from recent low-star (`rating <= 3`) review
 * text (`store.ts`'s `getRecentComplaintReviews`). Dedupes against the
 * existing corpus, bounds growth to `opts.maxNew` per cycle, resolves each
 * new candidate's `genreZone` from its originating app's REAL registry
 * category (`app-meta-store.ts`'s `getAppMetaBatch` + `mapCategoryToZone` —
 * never a blind `DEFAULT_ZONE`-by-omission the way the app-name miner's
 * scanned-name path does; `DEFAULT_ZONE` is only used here as a genuine
 * last-resort when the app has no registry row / no genre name yet), and
 * upserts the genuinely new ones with `source: "review"`. Never throws on
 * empty input — callers (scraper.ts) still wrap this in a try/catch since DB
 * calls can fail transiently.
 */
export async function mineReviewKeywords(
  opts: MineReviewKeywordsOptions,
): Promise<MineReviewKeywordsResult> {
  const reviewLimit = opts.reviewLimit ?? DEFAULT_REVIEW_SCAN_LIMIT;
  const reviews = await getRecentComplaintReviews(reviewLimit, opts.sinceSeconds);
  if (reviews.length === 0) return EMPTY_RESULT(0);

  const inputs: readonly ReviewMinerInput[] = reviews.map((r) => ({
    appId: r.app_id,
    title: r.title,
    content: r.content,
  }));

  const candidates = extractComplaintCandidates(inputs);
  if (candidates.length === 0) return EMPTY_RESULT(reviews.length);

  const existing = await keywordsExist(candidates.map((c) => c.keyword));
  const newCandidates = candidates.filter((c) => !existing.has(c.keyword)).slice(0, opts.maxNew);
  if (newCandidates.length === 0) return EMPTY_RESULT(reviews.length);

  const appIds = Array.from(new Set(newCandidates.map((c) => c.appId)));
  const metaByApp = await getAppMetaBatch(appIds);

  const rows: readonly KeywordSeedRow[] = newCandidates.map((c) => {
    const genreName = metaByApp.get(c.appId)?.genreName;
    const genreZone = genreName ? mapCategoryToZone(genreName) : DEFAULT_ZONE;
    return { keyword: c.keyword, genreZone, source: "review" };
  });
  await upsertKeywords(rows);

  log.info("Review-complaint keyword mining", { added: rows.length, scanned: reviews.length });
  return { added: rows.length, scanned: reviews.length };
}
