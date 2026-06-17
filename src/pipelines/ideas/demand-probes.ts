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
import { createLogger } from "../../logger";
import { getErrorMessage } from "../../lib/error-serialization";
import { parseTopComments } from "./collector-ranking";
import {
  extractDemandKeywords,
  aggregateDemand,
  type DemandArtifact,
  type DemandCandidateText,
  type DemandEvidence,
  type DemandProbe,
  type DemandProbeOptions,
} from "./demand";

const logger = createLogger("ideas:demand");

// ── Defaults ──────────────────────────────────────────────────────────────────

/** Default look-back window for demand evidence: 180 days (buyer-intent is slow). */
const DEFAULT_WINDOW_SEC = 180 * 24 * 3600;
/** Default row scan ceiling per probe. */
const DEFAULT_LIMIT = 60;
/** Max distinct keywords actually queried (cheaper, sharper). */
const MAX_QUERY_KEYWORDS = 8;
/** Trim quotes to keep evidence compact and auditable. */
const QUOTE_MAX_LEN = 240;

/**
 * Reddit demand-INTENT phrases. A row only counts as buyer-intent when it pairs
 * a candidate keyword WITH one of these intent markers — that pairing is what
 * separates "people discussing X" from "people who WANT a tool for X".
 */
const REDDIT_INTENT_PATTERNS: readonly string[] = [
  "looking for a tool",
  "looking for an app",
  "looking for a way",
  "is there a tool",
  "is there an app",
  "is there a way",
  "is there anything",
  "i wish there was",
  "i wish there were",
  "anyone know of",
  "anyone know a",
  "does anyone know",
  "recommend a tool",
  "recommend an app",
  "willing to pay",
  "would pay for",
  "shut up and take my money",
  "alternative to",
  "any alternatives",
];

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

/** Clamp + default the probe window/limit options deterministically. */
function resolveOpts(opts: DemandProbeOptions): {
  windowSec: number;
  limit: number;
} {
  const windowSec =
    typeof opts.windowSec === "number" && opts.windowSec > 0
      ? Math.floor(opts.windowSec)
      : DEFAULT_WINDOW_SEC;
  const limit =
    typeof opts.limit === "number" && opts.limit > 0
      ? Math.floor(opts.limit)
      : DEFAULT_LIMIT;
  return { windowSec, limit };
}

/** Take the top-N keywords actually worth querying (cap cost, keep determinism). */
function queryKeywords(keywords: readonly string[]): readonly string[] {
  return keywords
    .map((k) => k.trim().toLowerCase())
    .filter((k) => k.length >= 3)
    .slice(0, MAX_QUERY_KEYWORDS);
}

/** Find the first candidate keyword present (case-insensitive) in `haystack`. */
function firstKeywordMatch(
  haystack: string,
  keywords: readonly string[],
): string | null {
  const lower = haystack.toLowerCase();
  for (const kw of keywords) {
    if (lower.includes(kw)) return kw;
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

/** Build a compact, verbatim quote around the matched marker for auditability. */
function quoteAround(text: string, marker: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  const idx = collapsed.toLowerCase().indexOf(marker.toLowerCase());
  if (idx < 0) return collapsed.slice(0, QUOTE_MAX_LEN);
  const start = Math.max(0, idx - 60);
  return collapsed.slice(start, start + QUOTE_MAX_LEN).trim();
}

/** Coerce an unknown DB cell to a trimmed string (empty when absent). */
function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
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
    const { windowSec, limit } = resolveOpts(opts);

    try {
      const db = getDb();
      const cutoff = Math.floor(Date.now() / 1000) - windowSec;
      // Pull the recent, high-engagement window (bounded by window + LIMIT,
      // mirroring collectors.ts) and do the intent×keyword pairing in CODE. This
      // keeps matching fully deterministic and avoids `= ANY` / `ILIKE ANY` over
      // a db(arr) binding (broken in Bun 1.3.14). Cost stays bounded by LIMIT.
      const rows = (await db`
        SELECT id, subreddit, title, selftext, top_comments_json,
               score, num_comments, permalink
        FROM reddit_posts
        WHERE updated_at >= ${cutoff}
        ORDER BY (score + num_comments * 3) DESC, updated_at DESC
        LIMIT ${limit}
      `) as Array<Record<string, unknown>>;

      const evidence: DemandEvidence[] = [];
      for (const r of rows) {
        const title = asText(r.title);
        const selftext = asText(r.selftext);
        const comments = parseTopComments(r.top_comments_json).join(" — ");
        const haystack = `${title} ${selftext} ${comments}`;

        const keyword = firstKeywordMatch(haystack, kws);
        if (!keyword) continue; // must pair an intent marker WITH our keyword
        const marker = firstPatternMatch(haystack, REDDIT_INTENT_PATTERNS);
        if (!marker) continue;

        const score = toCount(r.score);
        const numComments = toCount(r.num_comments);
        // Engagement-weighted count: base 1 + log of community signal. Real,
        // deterministic — derived from persisted score/num_comments columns.
        const engagement = 1 + Math.log1p(Math.max(0, score) + Math.max(0, numComments));
        evidence.push({
          kind: "reddit_intent",
          query: keyword,
          count: Number(engagement.toFixed(3)),
          quote: quoteAround(haystack, marker),
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
    const { windowSec, limit } = resolveOpts(opts);

    try {
      const db = getDb();
      const cutoff = Math.floor(Date.now() / 1000) - windowSec;
      // Pull the recent news window and do funding×keyword pairing in CODE
      // (deterministic; avoids `ILIKE ANY` over a db(arr) binding broken in Bun
      // 1.3.14). Cost is bounded by the scraped_at window + LIMIT.
      const rows = (await db`
        SELECT id, title, summary, body, category, section, url
        FROM news_articles
        WHERE scraped_at >= ${cutoff}
        ORDER BY scraped_at DESC
        LIMIT ${limit}
      `) as Array<Record<string, unknown>>;

      const evidence: DemandEvidence[] = [];
      for (const r of rows) {
        const title = asText(r.title);
        const summary = asText(r.summary);
        const body = asText(r.body);
        const haystack = `${title} ${summary} ${body} ${asText(r.category)} ${asText(r.section)}`;

        const keyword = firstKeywordMatch(haystack, kws);
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

/** The default, license-clean probe set (reddit-intent + funding-news + stub). */
export const DEFAULT_DEMAND_PROBES: readonly DemandProbe[] = [
  redditIntentProbe,
  fundingNewsProbe,
  externalTrendsProbe,
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
  /** Allow the external (paid) trends probe to run (still stubbed). */
  readonly externalTrends?: boolean;
  /** Minimum matched rows before evidence is treated as corroborated. */
  readonly minMatches?: number;
  /** Look-back window in seconds for the DB probes. */
  readonly windowSec?: number;
  /** Per-probe row scan ceiling. */
  readonly limit?: number;
  /** Optional supply density (0..1) for the whitespace computation. */
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
    if (p.name === "externalTrends") return cfg.externalTrends === true;
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
  const aggregateOpts = {
    minMatches: cfg.minMatches,
    supplyDensity: cfg.supplyDensity,
  };

  // Disabled → explicit absence artifact (no silent neutral).
  if (cfg.enabled === false) {
    return aggregateDemand([], aggregateOpts);
  }

  const keywords = extractDemandKeywords(candidate);
  if (keywords.length === 0) {
    return aggregateDemand([], aggregateOpts);
  }

  const probeOpts: DemandProbeOptions = {
    windowSec: cfg.windowSec,
    limit: cfg.limit,
    externalTrends: cfg.externalTrends === true,
  };

  const active = selectProbes(probes, cfg);

  try {
    const results = await Promise.all(
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
    );
    const evidence = results.flat();
    return aggregateDemand(evidence, aggregateOpts);
  } catch (error) {
    logger.warn("enrichDemand failed; returning absence artifact", {
      error: getErrorMessage(error),
    });
    return aggregateDemand([], aggregateOpts);
  }
}

// ── Small numeric coercion (local, DB cells are unknown) ───────────────────────

/** Coerce an unknown DB numeric cell to a finite non-negative number. */
function toCount(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}
