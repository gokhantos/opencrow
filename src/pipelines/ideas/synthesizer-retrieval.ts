/**
 * Retrieval layer for the trend-intersection synthesizer.
 *
 * Owns the optional Qdrant enrichment (`deepSearch`), the over-fetch rerankers
 * (`rerankHits`), the knowledge-graph evidence branch (`graphEvidence`), and the
 * signal-ranking importance-floor + calibration boost (`prioritizeByRanking`)
 * plus its facet loader and the `evidence_strength` label mapping.
 *
 * Extracted verbatim from synthesizer.ts as a behavior-preserving structural
 * refactor; every public symbol is re-exported from "./synthesizer".
 */

import type { MemoryManager, SearchResult } from "../../memory/types";
import { createLogger } from "../../logger";
import { loadConfig } from "../../config/loader";
import type { SmartIdeasConfig } from "../../config/schema";
import type { Mem0Client } from "../../sige/knowledge/mem0-client";
import type { ModelProvider } from "../../store/model-routing";
import { insightForge, panoramaSearch } from "../../sige/memory/retrieval-modes";
import { sanitizeScrapedField, wrapUntrusted } from "../../sige/untrusted";
import {
  candidateText,
  embeddingRerank,
  llmListwiseRerank,
  type CrossEncoderEmbedder,
  type RerankCandidate,
} from "./deep-search-rerank";
import { getDb } from "../../store/db";
import {
  isSignalKind,
  meetsImportanceFloor,
} from "../../memory/signal-enrichment";
import type { SignalFacets, SignalImportance } from "../../memory/signal-facets";
import {
  calibratedRelevance,
  loadSignalCalibration,
  type SignalCalibration,
} from "./signal-calibration";

const log = createLogger("pipeline:synthesizer");

// ── Deep Search (optional Qdrant enrichment) ────────────────────────────

const DEEP_SEARCH_KINDS = [
  "hackernews_story", "reddit_post", "producthunt_product",
  "github_repo", "x_post", "reuters_news", "cointelegraph_news",
  "cryptopanic_news", "investingnews_news", "appstore_review",
  "appstore_app", "playstore_review", "playstore_app",
] as const;

/**
 * Map an aggregate retrieval score in [0,1] to a coarse, human-legible
 * evidence-strength label that the synthesis prompt can reason over.
 */
export function evidenceStrengthLabel(meanScore: number): string {
  if (meanScore >= 0.6) return "strong";
  if (meanScore >= 0.45) return "moderate";
  if (meanScore >= 0.3) return "weak";
  return "minimal";
}

// ── Signal-ranking retrieval (importance floor + calibration boost) ─────────
//
// When `smart.signalRanking` is ON (layered on `smart.signalFacets`), retrieved
// scraped-signal hits are RE-PRIORITISED by their learned usefulness for idea
// generation instead of raw cosine similarity alone:
//   1. IMPORTANCE FLOOR — drop hits whose KNOWN importance bucket is below
//      `smart.signalImportanceFloor`. Un-ranked hits (no facet row) and
//      non-signal kinds are NEVER dropped — they survive with a neutral score so
//      a missing/failed rank can't silently lose a signal (soft-prioritise, do
//      NOT hard-drop at retrieval).
//   2. CALIBRATION BOOST — re-order survivors by a blend of the cosine score and
//      `calibratedRelevance(facets, calibration)` so buckets that historically
//      produce VALIDATED ideas float up even at equal similarity.
// All of this degrades to the legacy cosine ordering on any failure or when the
// flag is off, and the `evidence_strength` annotation is preserved.

/** Minimal facet projection needed for the importance floor + calibration boost. */
type RankFacets = Pick<SignalFacets, "importance" | "relevanceToIdeas">;

/** Weight of the calibrated relevance vs. raw cosine score in the boost blend. */
const CALIBRATION_BLEND = 0.5;

/**
 * Load the ranking facets (importance + relevanceToIdeas) for a set of retrieved
 * hits, keyed by their memory source id. signal_facets is keyed by
 * (source_table = kind, source_id = memory_sources.id); only signal kinds are
 * ever ranked. Returns an empty map on any failure so retrieval degrades to the
 * legacy cosine ordering. Never throws.
 */
async function loadRankFacetsForHits(
  hits: readonly SearchResult[],
): Promise<ReadonlyMap<string, RankFacets>> {
  const out = new Map<string, RankFacets>();

  // Only signal kinds carry ranking rows; skip everything else up front.
  const ids = [
    ...new Set(
      hits
        .filter((h) => isSignalKind(h.source.kind))
        .map((h) => h.source.id),
    ),
  ];
  if (ids.length === 0) return out;

  try {
    const db = getDb();
    const rows = (await db`
      SELECT source_id, importance, relevance_to_ideas
      FROM signal_facets
      WHERE source_id IN ${db(ids as string[])}
        AND importance IS NOT NULL
    `) as Array<{
      source_id: string;
      importance: string | null;
      relevance_to_ideas: number | string | null;
    }>;

    for (const row of rows) {
      if (!row.importance) continue;
      const relevance = Number(row.relevance_to_ideas);
      out.set(row.source_id, {
        importance: row.importance as SignalImportance,
        relevanceToIdeas: Number.isFinite(relevance) ? relevance : 0.5,
      });
    }
  } catch (err) {
    log.warn("signal-ranking facet load failed; using cosine order", { err });
    return new Map();
  }

  return out;
}

/**
 * Apply the importance-floor filter + calibration boost to a deduped hit set.
 *
 * Pure given its inputs (facets map + calibration are injected). Hits with a
 * KNOWN importance below `floor` are dropped; un-ranked / non-signal hits are
 * kept (neutral). Survivors are re-ordered by a blend of cosine score and the
 * calibrated relevance. Stable: equal scores preserve input order.
 */
export function prioritizeByRanking(
  hits: readonly SearchResult[],
  facetsById: ReadonlyMap<string, RankFacets>,
  floor: SignalImportance,
  calibration: SignalCalibration,
): readonly SearchResult[] {
  const scored = hits
    .map((hit, index) => {
      const facets = facetsById.get(hit.source.id);
      const cosine = hit.score ?? 0;
      if (!facets) {
        // Un-ranked / non-signal: keep, no boost (soft-prioritise, never drop).
        return { hit, index, keep: true, rankScore: cosine };
      }
      if (!meetsImportanceFloor(facets.importance, floor)) {
        return { hit, index, keep: false, rankScore: cosine };
      }
      const calibrated = calibratedRelevance(facets, calibration);
      const rankScore =
        (1 - CALIBRATION_BLEND) * cosine + CALIBRATION_BLEND * calibrated;
      return { hit, index, keep: true, rankScore };
    })
    .filter((s) => s.keep);

  scored.sort((a, b) =>
    b.rankScore === a.rankScore ? a.index - b.index : b.rankScore - a.rankScore,
  );

  return scored.map((s) => s.hit);
}

/**
 * Optional dependencies for deepSearch. All fields are OPTIONAL and default to
 * the legacy Qdrant-only behaviour:
 *  - `model`     — chat model id used by the LLM listwise reranker.
 *  - `rerankEmbedder` — injected embedder for cross-encoder-style rerank.
 *  - `mem0` / `userId` — Mem0 graph client + user for knowledge-graph retrieval
 *    (the graph branch is skipped entirely when either is absent).
 */
export interface DeepSearchOptions {
  readonly model?: string;
  /**
   * Provider for the LLM listwise reranker. REQUIRED — threaded from the routed
   * `pipeline.generator` provider so a non-Anthropic route (e.g. alibaba)
   * dispatches the rerank call to that provider. No Claude default: a missing
   * provider used to fall through to "anthropic" in buildChatOptions, silently
   * billing the user's Claude OAuth.
   */
  readonly provider: ModelProvider;
  readonly rerankEmbedder?: CrossEncoderEmbedder;
  readonly mem0?: Mem0Client;
  readonly userId?: string;
}

/**
 * Retrieve supporting evidence for a set of themes from the indexed corpus.
 *
 * Backward-compatible: called with just (themes, memoryManager) it behaves like
 * the legacy implementation PLUS a per-theme `evidence_strength` annotation
 * (retrieval scores are no longer discarded).
 *
 * Gated, opt-in enrichments (all default OFF, all degrade to the Qdrant path on
 * any error):
 *  - smart.deepSearchReranker: over-fetch `rerankFetchK` hits then rerank down
 *    to `rerankTopK` via an injected embedder (cross-encoder-style) or an LLM
 *    listwise rerank through the project chat path.
 *  - smart.knowledgeGraphRetrieval: when a Mem0 client + userId are supplied,
 *    add a graph branch (insightForge/panoramaSearch) and append relation-path
 *    facts to the context.
 *  - smart.signalRanking (layered on smart.signalFacets): re-prioritise retrieved
 *    scraped-signal hits by their learned usefulness for idea generation — apply
 *    the smart.signalImportanceFloor floor (drop KNOWN-low signals, keep un-ranked
 *    ones) and re-order survivors by calibrated relevance (idea_feedback loop) on
 *    top of raw cosine. Off → identical legacy cosine ordering.
 */
export async function deepSearch(
  themes: readonly string[],
  memoryManager: MemoryManager,
  options?: DeepSearchOptions,
): Promise<string> {
  if (themes.length === 0) return "";

  const smart = loadConfig().pipelines.ideas.smart;
  const rerankEnabled = smart.deepSearchReranker;
  // Importance/relevance re-ranking is layered on facet extraction.
  const signalRankingEnabled = smart.signalFacets && smart.signalRanking;
  const importanceFloor = smart.signalImportanceFloor as SignalImportance;
  // When ranking is on, the floor may DROP hits — over-fetch so the post-filter
  // topK still has candidates (best-effort; bounded). Otherwise legacy fetchK.
  const baseFetchK = rerankEnabled ? smart.rerankFetchK : 3;
  const fetchK = signalRankingEnabled ? Math.max(baseFetchK, 8) : baseFetchK;
  const topK = rerankEnabled ? smart.rerankTopK : 3;

  // Load the feedback-loop calibration once per call (cached + gated internally;
  // returns a neutral map when ranking is off, so this is always safe to call).
  const calibration = signalRankingEnabled
    ? await loadSignalCalibration().catch(() => null)
    : null;

  const searchQueries = themes.slice(0, 6);

  const results = await Promise.all(
    searchQueries.map((query) =>
      memoryManager
        .search("shared", query, {
          limit: fetchK,
          minScore: 0.3,
          kinds: [...DEEP_SEARCH_KINDS],
        })
        .catch(() => [] as readonly SearchResult[]),
    ),
  );

  const seen = new Set<string>();
  const entries: string[] = [];

  for (let i = 0; i < searchQueries.length; i++) {
    const theme = searchQueries[i] ?? "";
    let deduped = (results[i] ?? []).filter((h) => {
      if (seen.has(h.source.id)) return false;
      seen.add(h.source.id);
      return true;
    });
    if (deduped.length === 0) continue;

    // SIGNAL-RANKING: importance-floor filter + calibration boost (opt-in). Runs
    // BEFORE the topK slice so the floor/boost shape which hits survive. Degrades
    // to the cosine order on any failure or when calibration is unavailable.
    if (signalRankingEnabled && calibration) {
      const facetsById = await loadRankFacetsForHits(deduped);
      const prioritized = prioritizeByRanking(
        deduped,
        facetsById,
        importanceFloor,
        calibration,
      );
      // Keep the (possibly filtered) set; never let the floor empty out a theme
      // that had un-ranked-but-relevant hits — prioritize keeps those.
      if (prioritized.length > 0) deduped = [...prioritized];
    }

    // QUICK WIN: retain retrieval scores → per-theme evidence strength.
    const meanScore =
      deduped.reduce((sum, h) => sum + (h.score ?? 0), 0) / deduped.length;

    let hits: readonly SearchResult[] = deduped;
    if (rerankEnabled) {
      hits = await rerankHits(theme, deduped, topK, options);
    } else {
      hits = deduped.slice(0, topK);
    }

    const formatted = hits.map((h) => {
      const meta = h.source.metadata;
      const url = meta.url ?? meta.hn_url ?? meta.store_url ?? "";
      const score = typeof h.score === "number" ? ` (score ${h.score.toFixed(2)})` : "";
      return `  [${h.source.kind}]${score} ${meta.title ?? ""}${url ? ` — ${url}` : ""}\n    ${h.chunk.content.slice(0, 200)}`;
    });

    const strength = evidenceStrengthLabel(meanScore);
    entries.push(
      `Theme: "${theme}" (evidence_strength: ${strength}, mean_score ${meanScore.toFixed(2)})\n${formatted.join("\n")}`,
    );
  }

  // #13 KNOWLEDGE-GRAPH RETRIEVAL: optional relation-path facts from Mem0.
  const graphSection = await graphEvidence(searchQueries, smart, options);

  const corpusSection =
    entries.length > 0
      ? `\n\n=== DEEP SEARCH (supporting evidence from indexed corpus) ===\n${entries.join("\n\n")}`
      : "";

  if (!corpusSection && !graphSection) return "";
  return `${corpusSection}${graphSection}`;
}

/**
 * Rerank an over-fetched hit set down to `topK`. Prefers the injected embedder
 * (cross-encoder-style); falls back to an LLM listwise rerank when a model is
 * provided; otherwise returns the first `topK` of input order. Never throws.
 */
async function rerankHits(
  theme: string,
  hits: readonly SearchResult[],
  topK: number,
  options: DeepSearchOptions | undefined,
): Promise<readonly SearchResult[]> {
  try {
    if (hits.length <= topK) return hits;
    const candidates: readonly RerankCandidate[] = hits.map((hit) => ({
      hit,
      text: candidateText(hit),
    }));

    if (options?.rerankEmbedder) {
      const ranked = await embeddingRerank(theme, candidates, topK, options.rerankEmbedder);
      return ranked.map((c) => c.hit);
    }
    if (options?.model) {
      const ranked = await llmListwiseRerank(
        theme,
        candidates,
        topK,
        options.model,
        options.provider,
      );
      return ranked.map((c) => c.hit);
    }
    return hits.slice(0, topK);
  } catch (err) {
    log.warn("deepSearch rerank failed, using input order", { err });
    return hits.slice(0, topK);
  }
}

/**
 * Build the optional knowledge-graph evidence section. Returns "" when the
 * feature is off, when no Mem0 client/userId is supplied, or on any error.
 */
async function graphEvidence(
  themes: readonly string[],
  smart: SmartIdeasConfig,
  options: DeepSearchOptions | undefined,
): Promise<string> {
  if (!smart.knowledgeGraphRetrieval) return "";
  const mem0 = options?.mem0;
  const userId = options?.userId;
  if (!mem0 || !userId || themes.length === 0) return "";

  try {
    const retrievals = await Promise.all(
      themes.slice(0, 3).map((theme) =>
        insightForge(mem0, userId, theme, { maxResults: 8 }).catch(() =>
          panoramaSearch(mem0, userId, theme, { maxResults: 8 }).catch(() => null),
        ),
      ),
    );

    const seenFacts = new Set<string>();
    const blocks: string[] = [];
    for (let i = 0; i < retrievals.length; i++) {
      const result = retrievals[i];
      if (!result) continue;
      const facts = result.facts
        .filter((f) => {
          const key = f.trim().toLowerCase();
          if (!key || seenFacts.has(key)) return false;
          seenFacts.add(key);
          return true;
        })
        .slice(0, 6);
      if (facts.length === 0) continue;
      const strength = evidenceStrengthLabel(result.score);
      // mem0 graph facts are derived from scraped/LLM-authored idea text and are
      // therefore UNTRUSTED on read. Sanitize the theme + each fact (strip control
      // chars / role-markers, cap length) before they touch the prompt — mirrors
      // the outcome-memory bullet() discipline. The whole block is untrusted-fenced
      // below so a poisoned fact can't smuggle instructions into synthesis.
      const safeTheme = sanitizeScrapedField(themes[i] ?? "", 160).replace(/"/g, "'");
      const safeFacts = facts.map((f) => `  • ${sanitizeScrapedField(f, 240)}`).join("\n");
      blocks.push(`Theme: "${safeTheme}" (graph_strength: ${strength})\n${safeFacts}`);
    }

    if (blocks.length === 0) return "";
    const fenced = wrapUntrusted("knowledge-graph", blocks.join("\n\n"));
    return `\n\n=== KNOWLEDGE GRAPH (relation-path facts) ===\n${fenced}`;
  } catch (err) {
    log.warn("deepSearch knowledge-graph branch failed, skipping", { err });
    return "";
  }
}
