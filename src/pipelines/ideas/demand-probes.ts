/**
 * Phase 2 — DEMAND-SIDE GROUNDING (DB-reading probes + orchestration).
 *
 * Deterministic probes over EXISTING scraped tables (license-clean: we only read
 * data we already collected). Each probe takes the candidate's CODE-extracted
 * demand keywords (from ./demand.ts) and returns CITED {@link DemandEvidence}
 * whose `count` is a real row count — never an LLM assertion. The orchestrator
 * {@link enrichDemand} runs extract → probe → aggregate into a deterministic
 * {@link DemandArtifact}.
 *
 * Graceful by construction: every probe and the orchestrator wrap their DB work
 * in try/catch and degrade to [] / an absence artifact. The demand path is
 * OPTIONAL — a failure here must NEVER break the pipeline's default path.
 *
 * Bun.sql notes honoured:
 *   - arrays interpolated with `col IN ${db(arr)}` (NOT `= ANY(...)`, broken in
 *     Bun 1.3.14).
 *   - integer-epoch columns (first_seen_at / updated_at / scraped_at) compared
 *     to epoch ints (now − windowSec), never NOW()-INTERVAL.
 */

import { getDb } from "../../store/db";
import { loadConfig } from "../../config/loader";
import { createLogger } from "../../logger";
import { getErrorMessage } from "../../lib/error-serialization";
import { parseTopComments } from "./collector-ranking";
import {
  extractDemandKeywords,
  aggregateDemand,
  distinctKeywordHits,
  matchesKeyword,
  type DemandArtifact,
  type DemandCandidateText,
  type DemandEvidence,
  type DemandProbe,
  type DemandProbeOptions,
} from "./demand";
// Shared probe helpers live in a LEAF module to break the demand-probes ↔
// semantic-demand-probe init cycle. Re-exported below so existing
// `from "./demand-probes"` importers keep working unchanged.
import {
  asText,
  buildKeywordFilter,
  queryKeywords,
  quoteAround,
  resolveOpts,
  toCount,
} from "./demand-probe-helpers";
import { SEMANTIC_PROBE_NAME, semanticDemandProbe } from "./semantic-demand-probe";
import { DEMAND_INTENT_MARKERS } from "./demand-intent-markers";
import { appstoreGapProbe } from "./appstore-gap-probe";

// Re-export the shared helpers so `./demand-probes` keeps its prior public
// surface (any existing `import { ... } from "./demand-probes"` still resolves).
export {
  asText,
  buildKeywordFilter,
  queryKeywords,
  quoteAround,
  resolveOpts,
  toCount,
} from "./demand-probe-helpers";

const logger = createLogger("ideas:demand");

// ── Intent / funding markers ───────────────────────────────────────────────────

/**
 * Reddit / HN / X demand-INTENT phrases. A row only counts as STRONG buyer-intent
 * when it pairs a candidate keyword WITH one of these intent markers — that
 * pairing separates "people discussing X" from "people who WANT a tool for X".
 * The expanded list (question / frustration / manual-workaround / willingness
 * forms) lives in ./demand-intent-markers.ts; aliased here for the probes.
 */
const REDDIT_INTENT_PATTERNS: readonly string[] = DEMAND_INTENT_MARKERS;

/** Funding / raise markers used to detect demand-validating capital in news. */
const FUNDING_PATTERNS: readonly string[] = [
  "raises",
  "raised",
  "funding round",
  "series a",
  "series b",
  "series c",
  "seed round",
  "seed funding",
  "venture",
  "valuation",
  "led the round",
  "led the investment",
];

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Find the first candidate keyword present in `haystack`. Uses fuzzy lexical
 * matching ({@link matchesKeyword}: stem + word-boundary + curated synonyms) by
 * default so it stays consistent with {@link distinctKeywordHits}; falls back to
 * legacy literal substring when `fuzzy` is false.
 */
function firstKeywordMatch(
  haystack: string,
  keywords: readonly string[],
  fuzzy = true,
): string | null {
  if (fuzzy) {
    for (const kw of keywords) {
      if (matchesKeyword(haystack, kw)) return kw;
    }
    return null;
  }
  const lower = haystack.toLowerCase();
  for (const kw of keywords) {
    if (kw.length > 0 && lower.includes(kw)) return kw;
  }
  return null;
}

/** Find the first intent/pattern marker present in `haystack`. */
function firstPatternMatch(
  haystack: string,
  patterns: readonly string[],
): string | null {
  const lower = haystack.toLowerCase();
  for (const p of patterns) {
    if (lower.includes(p)) return p;
  }
  return null;
}

/**
 * Lever 1 — derive the STRONG-vs-WEAK demand count for an intent-probe row whose
 * relevance gate + keyword already passed. PURE.
 *
 *   - marker present                          → STRONG: full `engagement` count.
 *   - no marker, weakIntent on, engagement ≥
 *     weakIntentMinEngagement                 → WEAK:   `engagement * factor`.
 *   - otherwise                               → null (skip the row).
 *
 * The evidence KIND is unchanged (no new "weak" kind); only the count is scaled,
 * so a marker-less but high-engagement niche post counts as real—but discounted—
 * demand and can't masquerade as strong buyer-intent.
 */
function intentRowCount(
  engagement: number,
  hasMarker: boolean,
  o: {
    readonly weakIntent: boolean;
    readonly weakIntentFactor: number;
    readonly weakIntentMinEngagement: number;
  },
): number | null {
  if (hasMarker) return Number(engagement.toFixed(3));
  if (!o.weakIntent) return null;
  if (engagement < o.weakIntentMinEngagement) return null;
  return Number((engagement * o.weakIntentFactor).toFixed(3));
}

// ── redditIntentProbe ─────────────────────────────────────────────────────────

/**
 * Demand-intent probe over EXISTING reddit_posts. A row qualifies only when its
 * title/selftext/top_comments pairs a candidate keyword WITH a buyer-intent
 * marker ("looking for a tool", "is there an app that", "willing to pay",
 * "alternative to", …). Match weight scales with engagement (score + comments)
 * so a loud, upvoted "is there a tool for X" counts for more than a dead one.
 *
 * Returns one {@link DemandEvidence} per qualifying row, kind "reddit_intent",
 * with a real verbatim `quote` + the post id as `sourceId`. Counts are real
 * (engagement-weighted) — never invented. Graceful: any failure → [].
 */
export const redditIntentProbe: DemandProbe = {
  name: "redditIntent",
  async probe(
    keywords: readonly string[],
    opts: DemandProbeOptions,
  ): Promise<readonly DemandEvidence[]> {
    const kws = queryKeywords(keywords);
    if (kws.length === 0) return [];
    const {
      windowSec,
      limit,
      minKeywordHits,
      fuzzy,
      weakIntent,
      weakIntentFactor,
      weakIntentMinEngagement,
    } = resolveOpts(opts);

    try {
      const db = getDb();
      const cutoff = Math.floor(Date.now() / 1000) - windowSec;
      // Filter to rows whose text actually mentions one of our keywords AT THE
      // DB level, then keep the engagement ordering + LIMIT. This is the fix for
      // the "absence floor" defect: previously we pulled the global top-N and
      // the niche keyword never appeared in it. The keyword×intent AND is still
      // enforced in CODE below. Keyword filter is parameterized (injection-safe);
      // `ILIKE ANY` over a db(arr) binding is broken in Bun 1.3.14 so we compose
      // explicit per-keyword `ILIKE $N` clauses.
      const { clause, params } = buildKeywordFilter(
        ["title", "selftext", "top_comments_json"],
        kws,
        2,
        fuzzy,
      );
      const sql = `
        SELECT id, subreddit, title, selftext, top_comments_json,
               score, num_comments, permalink
        FROM reddit_posts
        WHERE updated_at >= $1 AND ${clause}
        ORDER BY (score + num_comments * 3) DESC, updated_at DESC
        LIMIT $${2 + kws.length}
      `;
      const rows = (await db.unsafe(sql, [cutoff, ...params, limit])) as Array<
        Record<string, unknown>
      >;

      const evidence: DemandEvidence[] = [];
      for (const r of rows) {
        const title = asText(r.title);
        const selftext = asText(r.selftext);
        const comments = parseTopComments(r.top_comments_json).join(" — ");
        const haystack = `${title} ${selftext} ${comments}`;

        // RELEVANCE GATE: the row must contain ≥ minKeywordHits distinct idea
        // keywords (the DB OR-filter only guarantees one). One generic shared
        // word is not enough — the doc must be about THIS idea.
        if (distinctKeywordHits(haystack, kws, 2, fuzzy) < minKeywordHits) continue;
        const keyword = firstKeywordMatch(haystack, kws, fuzzy);
        if (!keyword) continue; // must pair an intent marker WITH our keyword
        const marker = firstPatternMatch(haystack, REDDIT_INTENT_PATTERNS);

        const score = toCount(r.score);
        const numComments = toCount(r.num_comments);
        // Engagement-weighted count: base 1 + log of community signal. Real,
        // deterministic — derived from persisted score/num_comments columns.
        const engagement = 1 + Math.log1p(Math.max(0, score) + Math.max(0, numComments));
        // Lever 1: marker → STRONG (full count); marker-less but high-engagement
        // → WEAK (discounted). null → skip.
        const count = intentRowCount(engagement, marker !== null, {
          weakIntent,
          weakIntentFactor,
          weakIntentMinEngagement,
        });
        if (count === null) continue;
        evidence.push({
          kind: "reddit_intent",
          query: keyword,
          count,
          quote: quoteAround(haystack, marker ?? keyword),
          sourceId: asText(r.id) || undefined,
        });
      }
      return evidence;
    } catch (error) {
      logger.warn("redditIntentProbe failed; returning no demand evidence", {
        error: getErrorMessage(error),
      });
      return [];
    }
  },
};

// ── fundingNewsProbe ──────────────────────────────────────────────────────────

/**
 * Funding-signal probe over EXISTING news_articles. A row qualifies when it
 * pairs a candidate keyword WITH a funding/raise marker ("raises", "Series A",
 * "seed round", "valuation", …) anywhere in title/summary/body/category/section
 * — capital flowing into a space is hard buyer-intent. One {@link DemandEvidence}
 * per qualifying article (kind "funding_news"), real verbatim quote + article id.
 * Graceful: any failure → [].
 */
export const fundingNewsProbe: DemandProbe = {
  name: "fundingNews",
  async probe(
    keywords: readonly string[],
    opts: DemandProbeOptions,
  ): Promise<readonly DemandEvidence[]> {
    const kws = queryKeywords(keywords);
    if (kws.length === 0) return [];
    const { windowSec, limit, minKeywordHits, fuzzy } = resolveOpts(opts);

    try {
      const db = getDb();
      const cutoff = Math.floor(Date.now() / 1000) - windowSec;
      // Filter to articles that actually mention a keyword AT THE DB level (the
      // "absence floor" fix), then keep the funding×keyword AND in CODE below.
      // Keyword filter is parameterized (injection-safe); `ILIKE ANY` over a
      // db(arr) binding is broken in Bun 1.3.14 so we compose explicit
      // per-keyword `ILIKE $N` clauses.
      const { clause, params } = buildKeywordFilter(
        ["title", "summary", "body", "category", "section"],
        kws,
        2,
        fuzzy,
      );
      const sql = `
        SELECT id, title, summary, body, category, section, url
        FROM news_articles
        WHERE scraped_at >= $1 AND ${clause}
        ORDER BY scraped_at DESC
        LIMIT $${2 + kws.length}
      `;
      const rows = (await db.unsafe(sql, [cutoff, ...params, limit])) as Array<
        Record<string, unknown>
      >;

      const evidence: DemandEvidence[] = [];
      for (const r of rows) {
        const title = asText(r.title);
        const summary = asText(r.summary);
        const body = asText(r.body);
        const haystack = `${title} ${summary} ${body} ${asText(r.category)} ${asText(r.section)}`;

        // RELEVANCE GATE: ≥ minKeywordHits distinct idea keywords must co-occur,
        // on top of the funding×keyword AND below.
        if (distinctKeywordHits(haystack, kws, 2, fuzzy) < minKeywordHits) continue;
        const keyword = firstKeywordMatch(haystack, kws, fuzzy);
        if (!keyword) continue;
        const marker = firstPatternMatch(haystack, FUNDING_PATTERNS);
        if (!marker) continue;

        evidence.push({
          kind: "funding_news",
          query: keyword,
          count: 1,
          quote: quoteAround(`${title}. ${summary || body}`, marker),
          sourceId: asText(r.id) || undefined,
        });
      }
      return evidence;
    } catch (error) {
      logger.warn("fundingNewsProbe failed; returning no demand evidence", {
        error: getErrorMessage(error),
      });
      return [];
    }
  },
};

// ── reviewComplaintProbe ──────────────────────────────────────────────────────

/**
 * Low-rating-review demand probe over EXISTING appstore_reviews + playstore_reviews.
 *
 * A row qualifies when it is a ≤2★ review whose title/content mentions a candidate
 * keyword. DECISION: a ≤2★ review that names the keyword IS itself an expression
 * of unmet need — the low rating is the intent signal — so this probe does NOT
 * require a separate intent marker (the one principled relaxation of the
 * keyword∧intent AND that the other probes enforce). This does NOT weaken the
 * absence floor: with zero keyword-matching low-star reviews the probe returns []
 * and the candidate still falls to the absence regime.
 *
 * Engagement weight: play-store reviews carry `thumbs_up`, so a complaint that
 * many users upvoted counts more (count = 1 + log1p(thumbs_up)); app-store
 * reviews have no engagement column so count = 1. Kind "review_complaint".
 * Graceful: any failure → [].
 */
export const reviewComplaintProbe: DemandProbe = {
  name: "reviewComplaint",
  async probe(
    keywords: readonly string[],
    opts: DemandProbeOptions,
  ): Promise<readonly DemandEvidence[]> {
    const kws = queryKeywords(keywords);
    if (kws.length === 0) return [];
    const { windowSec, limit, minKeywordHits, fuzzy } = resolveOpts(opts);

    try {
      const db = getDb();
      const cutoff = Math.floor(Date.now() / 1000) - windowSec;
      const evidence: DemandEvidence[] = [];

      // App Store: rating <= 2, keyword in title/content. No engagement column.
      const appFilter = buildKeywordFilter(["title", "content"], kws, 2, fuzzy);
      const appSql = `
        SELECT id, app_name, rating, title, content
        FROM appstore_reviews
        WHERE rating <= 2 AND first_seen_at >= $1 AND ${appFilter.clause}
        ORDER BY first_seen_at DESC
        LIMIT $${2 + kws.length}
      `;
      const appRows = (await db.unsafe(appSql, [
        cutoff,
        ...appFilter.params,
        limit,
      ])) as Array<Record<string, unknown>>;
      for (const r of appRows) {
        const title = asText(r.title);
        const content = asText(r.content);
        const haystack = `${title} ${content}`;
        // RELEVANCE GATE (the main false-positive source): the ≤2★ rating
        // replaces the intent marker, but the review must STILL contain ≥
        // minKeywordHits distinct idea keywords — a delivery review sharing the
        // single word "restaurant" must not count as scheduling demand.
        if (distinctKeywordHits(haystack, kws, 2, fuzzy) < minKeywordHits) continue;
        const keyword = firstKeywordMatch(haystack, kws, fuzzy);
        if (!keyword) continue; // the low rating is the intent — no marker needed
        evidence.push({
          kind: "review_complaint",
          query: keyword,
          count: 1,
          quote: quoteAround(`${title}. ${content}`, keyword),
          sourceId: asText(r.id) || undefined,
        });
      }

      // Play Store: rating <= 2, keyword in title/content; thumbs_up weights it.
      const playFilter = buildKeywordFilter(["title", "content"], kws, 2, fuzzy);
      const playSql = `
        SELECT id, app_name, rating, title, content, thumbs_up
        FROM playstore_reviews
        WHERE rating <= 2 AND first_seen_at >= $1 AND ${playFilter.clause}
        ORDER BY thumbs_up DESC, first_seen_at DESC
        LIMIT $${2 + kws.length}
      `;
      const playRows = (await db.unsafe(playSql, [
        cutoff,
        ...playFilter.params,
        limit,
      ])) as Array<Record<string, unknown>>;
      for (const r of playRows) {
        const title = asText(r.title);
        const content = asText(r.content);
        const haystack = `${title} ${content}`;
        // RELEVANCE GATE: same ≥ minKeywordHits distinct-keyword requirement.
        if (distinctKeywordHits(haystack, kws, 2, fuzzy) < minKeywordHits) continue;
        const keyword = firstKeywordMatch(haystack, kws, fuzzy);
        if (!keyword) continue;
        const thumbsUp = Math.max(0, toCount(r.thumbs_up));
        // Engagement-weighted count: base 1 + log of upvotes. Real + deterministic.
        const engagement = 1 + Math.log1p(thumbsUp);
        evidence.push({
          kind: "review_complaint",
          query: keyword,
          count: Number(engagement.toFixed(3)),
          quote: quoteAround(`${title}. ${content}`, keyword),
          sourceId: asText(r.id) || undefined,
        });
      }

      return evidence;
    } catch (error) {
      logger.warn("reviewComplaintProbe failed; returning no demand evidence", {
        error: getErrorMessage(error),
      });
      return [];
    }
  },
};

// ── hnProbe ───────────────────────────────────────────────────────────────────

/**
 * Hacker News buyer-intent probe over EXISTING hn_stories. Same semantics as
 * {@link redditIntentProbe}: a row qualifies only when its title/description/
 * top_comments pairs a candidate keyword WITH a buyer-intent marker (HN is
 * discussion, not pain reviews, so the intent-marker AND is KEPT). Match weight
 * scales with engagement (points + comment_count). Kind "hn_intent".
 * Graceful: any failure → [].
 */
export const hnProbe: DemandProbe = {
  name: "hnIntent",
  async probe(
    keywords: readonly string[],
    opts: DemandProbeOptions,
  ): Promise<readonly DemandEvidence[]> {
    const kws = queryKeywords(keywords);
    if (kws.length === 0) return [];
    const {
      windowSec,
      limit,
      minKeywordHits,
      fuzzy,
      weakIntent,
      weakIntentFactor,
      weakIntentMinEngagement,
    } = resolveOpts(opts);

    try {
      const db = getDb();
      const cutoff = Math.floor(Date.now() / 1000) - windowSec;
      const { clause, params } = buildKeywordFilter(
        ["title", "description", "top_comments_json"],
        kws,
        2,
        fuzzy,
      );
      const sql = `
        SELECT id, title, description, top_comments_json,
               points, comment_count, hn_url
        FROM hn_stories
        WHERE updated_at >= $1 AND ${clause}
        ORDER BY (points + comment_count * 3) DESC, updated_at DESC
        LIMIT $${2 + kws.length}
      `;
      const rows = (await db.unsafe(sql, [cutoff, ...params, limit])) as Array<
        Record<string, unknown>
      >;

      const evidence: DemandEvidence[] = [];
      for (const r of rows) {
        const title = asText(r.title);
        const description = asText(r.description);
        const comments = parseTopComments(r.top_comments_json).join(" — ");
        const haystack = `${title} ${description} ${comments}`;

        // RELEVANCE GATE: ≥ minKeywordHits distinct idea keywords must co-occur,
        // on top of the keyword×intent AND below.
        if (distinctKeywordHits(haystack, kws, 2, fuzzy) < minKeywordHits) continue;
        const keyword = firstKeywordMatch(haystack, kws, fuzzy);
        if (!keyword) continue; // must pair an intent marker WITH our keyword
        const marker = firstPatternMatch(haystack, REDDIT_INTENT_PATTERNS);

        const points = toCount(r.points);
        const commentCount = toCount(r.comment_count);
        const engagement =
          1 + Math.log1p(Math.max(0, points) + Math.max(0, commentCount));
        // Lever 1: STRONG when a marker is present, WEAK (discounted) when a
        // high-engagement row names the keyword but lacks a marker.
        const count = intentRowCount(engagement, marker !== null, {
          weakIntent,
          weakIntentFactor,
          weakIntentMinEngagement,
        });
        if (count === null) continue;
        evidence.push({
          kind: "hn_intent",
          query: keyword,
          count,
          quote: quoteAround(haystack, marker ?? keyword),
          sourceId: asText(r.id) || undefined,
        });
      }
      return evidence;
    } catch (error) {
      logger.warn("hnProbe failed; returning no demand evidence", {
        error: getErrorMessage(error),
      });
      return [];
    }
  },
};

// ── xIntentProbe ──────────────────────────────────────────────────────────────

/**
 * X/Twitter buyer-intent probe over EXISTING x_scraped_tweets. Same semantics as
 * {@link redditIntentProbe}: a row qualifies only when its `text` pairs a
 * candidate keyword (relevance gate ≥ minKeywordHits) WITH a buyer-intent marker
 * (STRONG), or — under Lever 1 — names the keyword with enough engagement but no
 * marker (WEAK, discounted). Engagement-weighted count from the tweet's
 * likes/retweets/replies columns. Kind "x_intent".
 *
 * x_scraped_tweets columns used (verified against the baseline migration):
 *   text (content), likes, retweets, replies (engagement), scraped_at (epoch int
 *   window), id (sourceId). A tweet has no title/comments — `text` is the only
 *   text column. Graceful: any failure or absent table/columns → [].
 */
export const xIntentProbe: DemandProbe = {
  name: "xIntent",
  async probe(
    keywords: readonly string[],
    opts: DemandProbeOptions,
  ): Promise<readonly DemandEvidence[]> {
    const kws = queryKeywords(keywords);
    if (kws.length === 0) return [];
    const {
      windowSec,
      limit,
      minKeywordHits,
      fuzzy,
      weakIntent,
      weakIntentFactor,
      weakIntentMinEngagement,
    } = resolveOpts(opts);

    try {
      const db = getDb();
      const cutoff = Math.floor(Date.now() / 1000) - windowSec;
      // Only `text` carries tweet content; prefilter on it at the DB level.
      const { clause, params } = buildKeywordFilter(["text"], kws, 2, fuzzy);
      const sql = `
        SELECT id, text, likes, retweets, replies
        FROM x_scraped_tweets
        WHERE scraped_at >= $1 AND ${clause}
        ORDER BY (likes + retweets * 3 + replies) DESC, scraped_at DESC
        LIMIT $${2 + kws.length}
      `;
      const rows = (await db.unsafe(sql, [cutoff, ...params, limit])) as Array<
        Record<string, unknown>
      >;

      const evidence: DemandEvidence[] = [];
      for (const r of rows) {
        const haystack = asText(r.text);

        // RELEVANCE GATE: ≥ minKeywordHits distinct idea keywords must co-occur.
        if (distinctKeywordHits(haystack, kws, 2, fuzzy) < minKeywordHits) continue;
        const keyword = firstKeywordMatch(haystack, kws, fuzzy);
        if (!keyword) continue;
        const marker = firstPatternMatch(haystack, REDDIT_INTENT_PATTERNS);

        const likes = Math.max(0, toCount(r.likes));
        const retweets = Math.max(0, toCount(r.retweets));
        const replies = Math.max(0, toCount(r.replies));
        // Engagement-weighted count: base 1 + log of community signal. Real,
        // deterministic — derived from persisted engagement columns.
        const engagement = 1 + Math.log1p(likes + retweets + replies);
        // Lever 1: STRONG when a marker is present, WEAK (discounted) otherwise.
        const count = intentRowCount(engagement, marker !== null, {
          weakIntent,
          weakIntentFactor,
          weakIntentMinEngagement,
        });
        if (count === null) continue;
        evidence.push({
          kind: "x_intent",
          query: keyword,
          count,
          quote: quoteAround(haystack, marker ?? keyword),
          sourceId: asText(r.id) || undefined,
        });
      }
      return evidence;
    } catch (error) {
      logger.warn("xIntentProbe failed; returning no demand evidence", {
        error: getErrorMessage(error),
      });
      return [];
    }
  },
};

// ── ph_products supply density (NOT demand) ───────────────────────────────────

/**
 * ProductHunt supply-density default ceiling. ph_products represents SUPPLY
 * (existing competing launches), NOT demand, so it is deliberately NOT a
 * {@link DemandProbe} — counting it as demand evidence would inflate the score.
 * Instead it feeds `aggregateDemand`'s `supplyDensity` knob: more keyword-matching
 * launches → higher supply density → lower whitespace.
 */
const PH_SUPPLY_SATURATION = 12;
/** Conservative cap on the PH-derived supply density (keep its weight low). */
const PH_SUPPLY_MAX = 0.6;

/**
 * Compute a conservative supply density in [0, PH_SUPPLY_MAX] from keyword-matching
 * ph_products. Log-scaled so a few competitors register but a flood saturates.
 * Returns 0 on any failure or when no keyword matches (never raises supply on
 * absence). This is intentionally low-weight: it only DISCOUNTS whitespace, it
 * never contributes to the demand score.
 */
export async function computePhSupplyDensity(
  keywords: readonly string[],
  opts: DemandProbeOptions,
): Promise<number> {
  const kws = queryKeywords(keywords);
  if (kws.length === 0) return 0;
  const { windowSec, limit, minKeywordHits, fuzzy } = resolveOpts(opts);

  try {
    const db = getDb();
    const cutoff = Math.floor(Date.now() / 1000) - windowSec;
    const { clause, params } = buildKeywordFilter(
      ["name", "tagline", "description", "topics_json"],
      kws,
      2,
      fuzzy,
    );
    const sql = `
      SELECT id, name, tagline, description, topics_json
      FROM ph_products
      WHERE updated_at >= $1 AND ${clause}
      LIMIT $${2 + kws.length}
    `;
    const rows = (await db.unsafe(sql, [cutoff, ...params, limit])) as Array<
      Record<string, unknown>
    >;

    // Apply the same RELEVANCE GATE as the demand probes: a launch only counts
    // as competing supply when it is actually about THIS idea (≥ minKeywordHits
    // distinct keywords), not when it merely shares one generic word.
    let matched = 0;
    for (const r of rows) {
      const haystack = `${asText(r.name)} ${asText(r.tagline)} ${asText(
        r.description,
      )} ${asText(r.topics_json)}`;
      if (distinctKeywordHits(haystack, kws, 2, fuzzy) >= minKeywordHits) matched += 1;
    }
    if (matched <= 0) return 0;

    const density =
      (PH_SUPPLY_MAX * Math.log1p(matched)) / Math.log1p(PH_SUPPLY_SATURATION);
    return Math.min(PH_SUPPLY_MAX, Math.max(0, Number(density.toFixed(4))));
  } catch (error) {
    logger.warn("computePhSupplyDensity failed; defaulting supply density to 0", {
      error: getErrorMessage(error),
    });
    return 0;
  }
}

// ── externalTrendsProbe (stubbed, license-clean) ──────────────────────────────

/**
 * Pluggable external search-volume / trends probe. We do NOT build paid scrapers
 * — this is the seam where a search-volume vendor WOULD plug in. It is gated
 * behind `opts.externalTrends` and defaults to a graceful no-op returning [], so
 * the demand path stays license-clean and free by default. A real vendor
 * implementation can replace this object without touching the orchestrator.
 */
export const externalTrendsProbe: DemandProbe = {
  name: "externalTrends",
  async probe(
    _keywords: readonly string[],
    opts: DemandProbeOptions,
  ): Promise<readonly DemandEvidence[]> {
    if (opts.externalTrends !== true) return [];
    // No vendor wired up: stay a graceful no-op rather than fabricate a trend.
    logger.debug(
      "externalTrendsProbe enabled but no vendor is configured; no-op",
    );
    return [];
  },
};

/**
 * The default, license-clean probe set: reddit-intent + funding-news +
 * review-complaint + hn-intent (all internal-DB, no external API / cost) plus
 * the stubbed external-trends seam. ph_products is NOT here — it is supply, not
 * demand, and is routed through supplyDensity by {@link enrichDemand}.
 */
export const DEFAULT_DEMAND_PROBES: readonly DemandProbe[] = [
  redditIntentProbe,
  fundingNewsProbe,
  reviewComplaintProbe,
  hnProbe,
  xIntentProbe,
  externalTrendsProbe,
  // Embedding-similarity probe — catches niche pains the lexical+intent probes
  // miss (the "dead demand probe -> absence floor" fix). Default ON; degrades to
  // [] when no embedder is configured.
  semanticDemandProbe,
  // Measured App Store supply/demand gap from appstore_keyword_scans — real
  // scanned opportunity/demand numbers, not an LLM assertion. Degrades to []
  // when no scan exists for the candidate's keywords.
  appstoreGapProbe,
];

// ── Orchestration ─────────────────────────────────────────────────────────────

/** Config consumed by {@link enrichDemand} (mirrors smart.demand). */
export interface EnrichDemandConfig {
  /** Master switch; when false the orchestrator skips probing entirely. */
  readonly enabled?: boolean;
  /** Run the reddit buyer-intent probe. */
  readonly redditIntent?: boolean;
  /** Run the funding-news probe. */
  readonly fundingSignal?: boolean;
  /** Run the low-star review-complaint probe (appstore + playstore). Default ON. */
  readonly reviewComplaint?: boolean;
  /** Run the Hacker News buyer-intent probe. Default ON. */
  readonly hnIntent?: boolean;
  /** Run the X/Twitter buyer-intent probe over x_scraped_tweets. Default ON. */
  readonly xIntent?: boolean;
  /**
   * Lever 1 — count marker-less but high-engagement keyword rows as WEAK
   * (discounted) demand evidence in the reddit/HN/X intent probes. Default ON.
   */
  readonly weakIntent?: boolean;
  /** Multiplier applied to a WEAK row's engagement count. Default 0.35 (0..1). */
  readonly weakIntentFactor?: number;
  /** Engagement-weighted count a marker-less row must reach to count as weak. Default 1.5. */
  readonly weakIntentMinEngagement?: number;
  /**
   * Lever 3 — fuzzy lexical keyword matching (stem + word-boundary + curated
   * synonyms). Default ON; set false to restore legacy literal substring matching.
   */
  readonly fuzzyMatch?: boolean;
  /**
   * Run the embedding-similarity corpus probe (`semantic_corpus` evidence).
   * Default ON. Catches niche demand the lexical+intent probes miss because the
   * pain is discussed in different words than the candidate keywords. Degrades
   * to [] when no embedding provider is configured.
   */
  readonly semanticDemand?: boolean;
  /**
   * Use keyword-matching ph_products to discount whitespace via supplyDensity.
   * Default ON; internal-DB only. Has NO effect on the demand score — it only
   * lowers whitespace when competing launches exist.
   */
  readonly phSupply?: boolean;
  /** Allow the external (paid) trends probe to run (still stubbed). */
  readonly externalTrends?: boolean;
  /** Minimum matched rows before evidence is treated as corroborated. */
  readonly minMatches?: number;
  /**
   * RELEVANCE GATE — minimum number of DISTINCT idea keywords that must co-occur
   * in a document for it to count as demand evidence. Default
   * {@link DEFAULT_MIN_KEYWORD_HITS}. Raise to tighten precision (fewer, more
   * topical matches); the DB OR-filter stays the cheap candidate prefilter and
   * this gate is applied per row in code.
   */
  readonly minKeywordHits?: number;
  /** Look-back window in seconds for the DB probes. */
  readonly windowSec?: number;
  /** Per-probe row scan ceiling. */
  readonly limit?: number;
  /**
   * Optional caller-supplied supply density (0..1) for the whitespace
   * computation. When `phSupply` is enabled and this is unset, the orchestrator
   * derives supply density from keyword-matching ph_products instead.
   */
  readonly supplyDensity?: number;
}

/** Filter the probe set down to the ones enabled by `cfg` (deterministic). */
function selectProbes(
  probes: readonly DemandProbe[],
  cfg: EnrichDemandConfig,
): readonly DemandProbe[] {
  return probes.filter((p) => {
    if (p.name === "redditIntent") return cfg.redditIntent !== false;
    if (p.name === "fundingNews") return cfg.fundingSignal !== false;
    if (p.name === "reviewComplaint") return cfg.reviewComplaint !== false;
    if (p.name === "hnIntent") return cfg.hnIntent !== false;
    if (p.name === SEMANTIC_PROBE_NAME) return cfg.semanticDemand !== false;
    if (p.name === "xIntent") return cfg.xIntent !== false;
    if (p.name === "externalTrends") return cfg.externalTrends === true;
    // Measured App Store supply/demand gap probe — reads appstore_keyword_scans,
    // a table that is only ever populated when the standalone scanner feature is
    // enabled. Gate it on the feature's own master switch (default OFF) so it
    // never runs a wasted query when the feature is disabled.
    if (p.name === "appstoreGap") return loadConfig().appstoreKeywordGap.enabled === true;
    return true; // unknown custom probes run by default
  });
}

/**
 * Orchestrate the full demand-grounding for one candidate:
 *   extract keywords (CODE) → run enabled probes → aggregate (deterministic).
 *
 * Returns a {@link DemandArtifact}. When demand is disabled, no keywords can be
 * extracted, or every probe fails, it returns the ABSENCE artifact (low score /
 * low confidence) — never a neutral one. Graceful: probe failures are caught per
 * probe AND at the top level so this can never throw into the pipeline.
 */
export async function enrichDemand(
  candidate: DemandCandidateText,
  probes: readonly DemandProbe[] = DEFAULT_DEMAND_PROBES,
  cfg: EnrichDemandConfig = {},
): Promise<DemandArtifact> {
  // Base aggregate options; supplyDensity may be refined from ph_products below.
  // `appstore_gap`'s weight is resolved HERE (not hardcoded in demand.ts's
  // DEMAND_KIND_WEIGHTS) from the live `appstoreKeywordGap.demandWeight`
  // config knob — see AggregateDemandOptions.kindWeightOverrides' doc comment.
  const baseAggregateOpts = {
    minMatches: cfg.minMatches,
    supplyDensity: cfg.supplyDensity,
    kindWeightOverrides: { appstore_gap: loadConfig().appstoreKeywordGap.demandWeight },
  };

  // Disabled → explicit absence artifact (no silent neutral).
  if (cfg.enabled === false) {
    return aggregateDemand([], baseAggregateOpts);
  }

  const keywords = extractDemandKeywords(candidate);
  if (keywords.length === 0) {
    return aggregateDemand([], baseAggregateOpts);
  }

  const probeOpts: DemandProbeOptions = {
    windowSec: cfg.windowSec,
    limit: cfg.limit,
    minKeywordHits: cfg.minKeywordHits,
    externalTrends: cfg.externalTrends === true,
    fuzzyMatch: cfg.fuzzyMatch,
    weakIntent: cfg.weakIntent,
    weakIntentFactor: cfg.weakIntentFactor,
    weakIntentMinEngagement: cfg.weakIntentMinEngagement,
  };

  const active = selectProbes(probes, cfg);

  try {
    // ph_products supply density is computed alongside the demand probes (NOT as
    // a probe — it is supply). It only fires when phSupply is on AND the caller
    // did not already supply an explicit supplyDensity. It can only LOWER
    // whitespace; it never feeds the demand score.
    const usePhSupply = cfg.phSupply !== false && cfg.supplyDensity === undefined;

    const [probeResults, phSupplyDensity] = await Promise.all([
      Promise.all(
        active.map(async (p) => {
          try {
            return await p.probe(keywords, probeOpts);
          } catch (error) {
            logger.warn("demand probe threw; skipping", {
              probe: p.name,
              error: getErrorMessage(error),
            });
            return [] as readonly DemandEvidence[];
          }
        }),
      ),
      usePhSupply
        ? computePhSupplyDensity(keywords, probeOpts)
        : Promise.resolve(undefined),
    ]);

    const evidence = probeResults.flat();
    const aggregateOpts =
      phSupplyDensity !== undefined
        ? { ...baseAggregateOpts, supplyDensity: phSupplyDensity }
        : baseAggregateOpts;
    return aggregateDemand(evidence, aggregateOpts);
  } catch (error) {
    logger.warn("enrichDemand failed; returning absence artifact", {
      error: getErrorMessage(error),
    });
    return aggregateDemand([], baseAggregateOpts);
  }
}
