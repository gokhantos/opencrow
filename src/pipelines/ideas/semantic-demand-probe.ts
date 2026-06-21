/**
 * SEMANTIC DEMAND PROBE — embedding-similarity demand evidence.
 *
 * Fixes the "dead demand probe -> absence floor" defect. The lexical+intent
 * probes ({@link import("./demand-probes").redditIntentProbe} etc.) only fire
 * when a scraped row pairs an EXACT candidate keyword with a buyer-intent
 * phrase. A genuinely-niche pain that the community discusses in DIFFERENT words
 * (or without an explicit "is there a tool for X" marker) is invisible to them,
 * so demand was pinned at {@link import("./demand").ABSENCE_SCORE_CAP} even when
 * the corpus clearly talks about the problem.
 *
 * This probe recalls candidate rows with the SAME cheap, injection-safe SQL
 * OR-prefilter the literal probes use (bounding embedding cost to <= `limit`
 * rows), then embeds the idea text and each row ONCE and keeps the rows whose
 * cosine similarity clears {@link SEMANTIC_SIMILARITY_THRESHOLD}. Each kept row
 * becomes a `semantic_corpus` {@link DemandEvidence} with a VERBATIM quote and
 * the row id — never an invented snippet.
 *
 * Infra note: the ideas pipeline does NOT maintain a Qdrant collection over the
 * scraped corpus (deep-search rerank embeds on the fly), so this deliberately
 * uses SQL prefilter + on-the-fly embedding rather than vector search.
 *
 * Honesty + safety contract:
 *   - NOTHING clears the threshold -> [] (ideas the corpus genuinely doesn't
 *     discuss MUST still score at the absence cap).
 *   - any failure (embedder undefined/throws, DB error, rowSource throws) -> []
 *     (graceful; never breaks the pipeline's default path).
 *   - deterministic given the same corpus rows + threshold.
 */

import { getDb } from "../../store/db";
import { createLogger } from "../../logger";
import { getErrorMessage } from "../../lib/error-serialization";
import { parseTopComments } from "./collector-ranking";
// Import shared helpers from the LEAF module, NOT from ./demand-probes — that
// would re-introduce the demand-probes ↔ semantic-demand-probe init cycle that
// caused a TDZ crash when this module loaded first.
import {
  asText,
  buildKeywordFilter,
  queryKeywords,
  quoteAround,
  resolveOpts,
  toCount,
} from "./demand-probe-helpers";
import type { CrossEncoderEmbedder } from "./deep-search-rerank";
import { cosineSimilarity } from "./deep-search-rerank";
import type { DemandEvidence, DemandProbe, DemandProbeOptions } from "./demand";

const logger = createLogger("ideas:demand:semantic");

/** Probe name; used by {@link import("./demand-probes").selectProbes} routing. */
export const SEMANTIC_PROBE_NAME = "semanticCorpus";

/**
 * Cosine-similarity floor a corpus row must clear to count as semantic demand.
 *
 * EMPIRICALLY CALIBRATED (FIX B, run 2026-06-21) against the LIVE default
 * embedder (Ollama `nomic-embed-text`, 768-dim) on hand-picked pairs of a real
 * idea text + a real `reddit_posts` row expressing the matching pain in DIFFERENT
 * words, vs genuinely-unrelated rows. nomic is ASYMMETRIC, so the idea (query)
 * and corpus rows (documents) are embedded WITH `search_query:` / `search_document:`
 * prefixes (see {@link SEARCH_QUERY_PREFIX} / {@link SEARCH_DOCUMENT_PREFIX}).
 *
 * Measured prefixed cosine distributions (n_relevant=5, n_random=25):
 *   - RELEVANT (related pain, different words): min 0.651, mean 0.713, max 0.741
 *   - RANDOM   (unrelated topics):              max 0.560, mean 0.501
 * nomic compresses cosines into a high band, so the OLD GUESSED 0.58 sat almost
 * ON TOP of the random ceiling (0.560) — too low to reject unrelated chatter
 * reliably AND too tight a margin for noisier real pairs (it ran INERT in prod,
 * producing 0 evidence). 0.62 sits cleanly between the bands: ABOVE every random
 * pair (max 0.560 → 0.06 precision buffer; honest-absence preserved — unrelated
 * rows still score at the absence cap) and BELOW every relevant pair (min 0.651),
 * so genuinely-related pain in different words is admitted. Raise to tighten
 * precision further; do NOT lower past ~0.57 or random chatter starts clearing.
 */
export const SEMANTIC_SIMILARITY_THRESHOLD = 0.62;

/**
 * nomic-embed-text task prefixes. The model is asymmetric and was trained to be
 * queried with these; without them genuinely-related pairs score lower and the
 * probe went inert (FIX B). Applied ONLY in this probe's on-the-fly text prep —
 * the probe controls both sides of every comparison, so this does NOT change the
 * shared embedder's behaviour for any other caller (memory search, rerank).
 */
export const SEARCH_QUERY_PREFIX = "search_query: ";
export const SEARCH_DOCUMENT_PREFIX = "search_document: ";

/** Trim quotes to keep evidence compact and auditable (mirrors demand-probes). */
const QUOTE_MAX_LEN = 240;

/** Max chars embedded per candidate row, mirroring `embeddingRerank`. */
const EMBED_TEXT_MAX_LEN = 500;

/** A scraped corpus row reduced to what the probe needs to embed + cite. */
export interface SemanticCandidateRow {
  /** Stable source id, surfaced as `DemandEvidence.sourceId`. */
  readonly id: string;
  /** The text to embed and quote from (title + body + top comments). */
  readonly text: string;
  /** Engagement signal (e.g. score + comments) used to weight `count`. */
  readonly engagement: number;
}

/** Injectable corpus reader — defaulted to a reddit_posts SQL prefilter. */
export interface SemanticRowSource {
  fetchCandidates(
    keywords: readonly string[],
    opts: DemandProbeOptions,
  ): Promise<readonly SemanticCandidateRow[]>;
}

/**
 * An embedder, or a (sync) factory returning one (or undefined when none can be
 * built). The factory form lets the default DEFER embedder construction until
 * the first probe call, and degrade to [] when no provider is configured.
 */
type EmbedderInput =
  | CrossEncoderEmbedder
  | (() => CrossEncoderEmbedder | undefined | Promise<CrossEncoderEmbedder | undefined>);

export interface SemanticDemandProbeDeps {
  readonly embedder?: EmbedderInput;
  readonly rowSource?: SemanticRowSource;
  /** Override the cosine floor (tests). Defaults to {@link SEMANTIC_SIMILARITY_THRESHOLD}. */
  readonly threshold?: number;
}

/**
 * Default corpus reader: the SAME OR-prefilter + window + engagement ordering as
 * the reddit literal probe, but WITHOUT the `distinctKeywordHits >= 2` lexical
 * gate — semantic similarity replaces that gate. Reads `reddit_posts` only
 * (the highest-volume buyer-discussion corpus and the lowest-risk single-table
 * scope); HN can be added later behind the same shape if needed.
 */
function createDefaultRowSource(): SemanticRowSource {
  return {
    async fetchCandidates(
      keywords: readonly string[],
      opts: DemandProbeOptions,
    ): Promise<readonly SemanticCandidateRow[]> {
      const { windowSec, limit } = resolveOpts(opts);
      const db = getDb();
      const cutoff = Math.floor(Date.now() / 1000) - windowSec;
      // OR-prefilter (parameterized ILIKE, injection-safe) bounds the row set —
      // and therefore embedding cost — to <= limit candidate rows. No
      // distinct-keyword gate: that is exactly the lexical constraint we are
      // relaxing in favour of embedding similarity below.
      const { clause, params } = buildKeywordFilter(
        ["title", "selftext", "top_comments_json"],
        keywords,
        2,
      );
      const sql = `
        SELECT id, title, selftext, top_comments_json, score, num_comments
        FROM reddit_posts
        WHERE updated_at >= $1 AND ${clause}
        ORDER BY (score + num_comments * 3) DESC, updated_at DESC
        LIMIT $${2 + keywords.length}
      `;
      const rows = (await db.unsafe(sql, [cutoff, ...params, limit])) as Array<
        Record<string, unknown>
      >;
      return rows.map((r) => {
        const title = asText(r.title);
        const selftext = asText(r.selftext);
        const comments = parseTopComments(r.top_comments_json).join(" — ");
        const score = Math.max(0, toCount(r.score));
        const numComments = Math.max(0, toCount(r.num_comments));
        return {
          id: asText(r.id),
          text: `${title} ${selftext} ${comments}`.trim(),
          engagement: score + numComments,
        };
      });
    },
  };
}

/**
 * Default embedder factory: lazily build the configured (Ollama / OpenAI-
 * compatible) embedding provider on first use — the SAME provider the rerank
 * path uses. Returns undefined (=> probe yields []) if none can be constructed,
 * so an unconfigured embedder degrades gracefully instead of throwing. Built
 * once and memoised across probe calls.
 */
function createLazyDefaultEmbedder(): () => Promise<CrossEncoderEmbedder | undefined> {
  let cached: CrossEncoderEmbedder | undefined;
  let attempted = false;
  return async () => {
    if (attempted) return cached;
    attempted = true;
    try {
      const { loadConfig } = await import("../../config/loader");
      const { getSecret } = await import("../../config/secrets");
      const { embeddingsConfigSchema } = await import("../../config/schema");
      const { getOverride } = await import("../../store/config-overrides");
      const { createEmbeddingProviderFromConfig } = await import("../../memory/embeddings");

      const override = await getOverride("features", "embeddings");
      const cfg = embeddingsConfigSchema.parse(override ?? loadConfig().embeddings ?? {});
      const apiKey =
        (await getSecret("OPENROUTER_API_KEY")) ??
        (await getSecret("VOYAGE_API_KEY")) ??
        undefined;
      // EmbeddingProvider.embed is structurally a CrossEncoderEmbedder.
      cached = createEmbeddingProviderFromConfig(cfg, apiKey) ?? undefined;
      if (!cached) {
        logger.warn("semanticDemandProbe: no embedding provider configured; probe disabled");
      }
    } catch (error) {
      logger.warn("semanticDemandProbe: failed to build default embedder; probe disabled", {
        error: getErrorMessage(error),
      });
      cached = undefined;
    }
    return cached;
  };
}

async function resolveEmbedder(
  input: EmbedderInput | undefined,
): Promise<CrossEncoderEmbedder | undefined> {
  if (!input) return undefined;
  if (typeof input === "function") {
    return (await input()) ?? undefined;
  }
  return input;
}

/**
 * Build a {@link DemandProbe} that emits `semantic_corpus` evidence.
 *
 * DI-friendly: inject a fake `embedder` and `rowSource` in tests to control
 * cosine + rows without a DB or a real model (keeps the test in the unit lane —
 * no module mocks). With no deps it self-provisions the default reddit
 * row-source and the lazily-built configured embedder.
 */
export function createSemanticDemandProbe(deps: SemanticDemandProbeDeps = {}): DemandProbe {
  const rowSource = deps.rowSource ?? createDefaultRowSource();
  const embedderInput: EmbedderInput = deps.embedder ?? createLazyDefaultEmbedder();
  const threshold =
    typeof deps.threshold === "number" ? deps.threshold : SEMANTIC_SIMILARITY_THRESHOLD;

  return {
    name: SEMANTIC_PROBE_NAME,
    async probe(
      keywords: readonly string[],
      opts: DemandProbeOptions,
    ): Promise<readonly DemandEvidence[]> {
      const kws = queryKeywords(keywords);
      if (kws.length === 0) return [];

      try {
        const embedder = await resolveEmbedder(embedderInput);
        if (!embedder) return [];

        const rows = await rowSource.fetchCandidates(kws, opts);
        const candidates = rows.filter((r) => r.text.length > 0);
        if (candidates.length === 0) return [];

        // The idea text the corpus rows are compared against. Joining the
        // extracted demand keywords is deterministic and provider-agnostic.
        const ideaText = kws.join(" ");

        // ONE batched embed call: [idea, ...rows]. Apply nomic's asymmetric task
        // prefixes — search_query: on the idea, search_document: on each row — AFTER
        // the EMBED_TEXT_MAX_LEN slice so the prefix is never truncated and never
        // eats into the row's content budget. The bare `ideaText` (no prefix) is
        // what gets quoted/stored; the prefix lives only inside the embed input.
        const vectors = await embedder.embed([
          `${SEARCH_QUERY_PREFIX}${ideaText}`,
          ...candidates.map((c) => `${SEARCH_DOCUMENT_PREFIX}${c.text.slice(0, EMBED_TEXT_MAX_LEN)}`),
        ]);
        const ideaVec = vectors[0];
        if (!ideaVec) return [];

        const evidence: DemandEvidence[] = [];
        for (let i = 0; i < candidates.length; i++) {
          const candidate = candidates[i];
          const vec = vectors[i + 1];
          if (!candidate || !vec) continue;
          const sim = cosineSimilarity(ideaVec, vec);
          if (sim < threshold) continue;

          // Engagement-weighted count, mirroring the reddit literal probe so the
          // pure scorer treats both kinds consistently.
          const engagement = 1 + Math.log1p(Math.max(0, candidate.engagement));
          evidence.push({
            kind: "semantic_corpus",
            query: ideaText,
            count: Number(engagement.toFixed(3)),
            // Verbatim snippet from the row — real text, never invented. Anchor
            // on the first idea keyword present (relevant region); quoteAround
            // falls back to the head of the text when the marker is absent.
            quote: quoteAround(candidate.text, kws[0] ?? candidate.text).slice(0, QUOTE_MAX_LEN),
            sourceId: candidate.id || undefined,
          });
        }
        return evidence;
      } catch (error) {
        logger.warn("semanticDemandProbe failed; returning no demand evidence", {
          error: getErrorMessage(error),
        });
        return [];
      }
    },
  };
}

/** Default-deps instance registered in DEFAULT_DEMAND_PROBES. */
export const semanticDemandProbe: DemandProbe = createSemanticDemandProbe();
