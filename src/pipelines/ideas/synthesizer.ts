/**
 * Trend-intersection idea synthesizer.
 *
 * 3-pass synthesis approach:
 * 1. Intersection Discovery — find 15-20 non-obvious intersection hypotheses
 * 2. Idea Development — develop top 10 hypotheses into full idea candidates
 * 3. Idea Critique — score each idea on specificity, signal grounding,
 *    differentiation, and buildability; kill weak ones
 *
 * Falls back to single-pass synthesis if Pass 1 fails.
 */

import { chat } from "../../agent/chat";
import type { ConversationMessage } from "../../agent/types";
import type { MemoryManager, SearchResult } from "../../memory/types";
// SearchResult is reused below to adapt idea candidates for the MMR diversity pass.
import { createLogger } from "../../logger";
import { loadConfig } from "../../config/loader";
import type { SmartIdeasConfig } from "../../config/schema";
import type { Mem0Client } from "../../sige/knowledge/mem0-client";
import { insightForge, panoramaSearch } from "../../sige/memory/retrieval-modes";
import {
  candidateText,
  embeddingRerank,
  llmListwiseRerank,
  type CrossEncoderEmbedder,
  type RerankCandidate,
} from "./deep-search-rerank";
import type { IdeaCategory } from "../types";
import type {
  TrendData,
  ClusteredPains,
  CapabilityScan,
  Capability,
  GeneratedIdeaCandidate,
  IntersectionHypothesis,
  SynthesisResult,
} from "./types";
import { applyMmr } from "../../memory/mmr";
import { getAllExistingIdeas } from "../../sources/ideas/store";
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
import {
  parseGiant,
  aggregateGiant,
  type ParsedGiant,
} from "./giant";
import type { GiantConfig, GenerateWideConfig } from "../../config/schema";
import { inferSegment, type SegmentId } from "./segments";
import {
  parseVerbalizedSeeds,
  planSegmentDirectives,
  renderSegmentSpread,
  selectWithNoveltyReserve,
  type VerbalizedSeed,
} from "./generate-wide";

const log = createLogger("pipeline:synthesizer");

// ── Shared helpers ───────────────────────────────────────────────────────

export function sanitizeForPrompt(text: string): string {
  return text
    .replace(/`{3,}/g, "'''")
    .replace(/\b(ignore|disregard|forget)\s+(all\s+)?(previous|above|prior)\s+(instructions?|context|prompts?)\b/gi, "[filtered]")
    .replace(/<\/?(?:system|assistant|user|human)>/gi, "[filtered]")
    .slice(0, 80000);
}

export function buildChatOptions(model: string) {
  return {
    systemPrompt: "",
    model,
    provider: "anthropic" as const,
    agentId: "idea-pipeline",
    usageContext: { channel: "pipeline" as const, chatId: "ideas", source: "workflow" as const },
  };
}

export function parseJsonFromResponse<T>(text: string, fallback: T): T {
  const jsonMatch =
    text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/) ??
    text.match(/(\[[\s\S]*\]|\{[\s\S]*\})/);

  if (!jsonMatch?.[1]) return fallback;

  try {
    return JSON.parse(jsonMatch[1].trim()) as T;
  } catch {
    log.warn("Failed to parse AI response as JSON", {
      preview: text.slice(0, 200),
    });
    return fallback;
  }
}

/**
 * Truncation-tolerant parser for a JSON array of objects. The wide
 * over-generation can emit a response large enough to hit the model's
 * output-token cap, leaving the array unterminated — standard JSON.parse then
 * yields NOTHING and the pool silently collapses. This walks the array body and
 * recovers every COMPLETE top-level element, discarding only an incomplete
 * trailing one. Returns [] when no array is present.
 */
export function parseJsonArrayLenient(text: string): unknown[] {
  const fenced = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  const body = fenced?.[1] ?? text;
  const start = body.indexOf("[");
  if (start === -1) return [];

  const out: unknown[] = [];
  let depth = 0;
  let inString = false;
  let escape = false;
  let elemStart = -1;

  for (let i = start + 1; i < body.length; i++) {
    const ch = body[i]!;
    if (inString) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      if (depth === 0 && elemStart === -1) elemStart = i;
      inString = true;
      continue;
    }
    if (ch === "{" || ch === "[") {
      if (depth === 0 && elemStart === -1) elemStart = i;
      depth++;
      continue;
    }
    if (ch === "}" || ch === "]") {
      if (ch === "]" && depth === 0) break; // end of the outer array
      depth--;
      if (depth === 0 && elemStart !== -1) {
        try {
          out.push(JSON.parse(body.slice(elemStart, i + 1)));
        } catch {
          /* skip a malformed element, keep the rest */
        }
        elemStart = -1;
      }
      continue;
    }
  }
  return out;
}

// ── Signal citation tokens (chain-of-evidence #8 part2) ─────────────────

/**
 * Build a stable, prompt-safe citation token for a capability so the model can
 * cite it as `[id:<token>]` and the Pipeline-phase verifier can bind the idea
 * back to its grounding signal. Deterministic per (source, index) within a run.
 *
 * Example: source "producthunt", index 2 → "producthunt_2".
 */
export function signalCitationToken(source: string, index: number): string {
  const safeSource = (source || "src")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 24) || "src";
  return `${safeSource}_${index}`;
}

/**
 * Extract emitted `[id:<token>]` citation tokens from a model field value.
 * Returns a deduped, order-preserving list. Accepts either a delimited string
 * or an already-parsed array (the model occasionally emits either shape).
 */
export function extractSignalIds(raw: unknown): readonly string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (token: string) => {
    const cleaned = token.trim().replace(/^\[?id:?/i, "").replace(/\]$/, "").trim();
    if (!cleaned) return;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(cleaned);
  };

  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item === "string") push(item);
    }
    return out;
  }

  if (typeof raw === "string") {
    const tokenMatches = raw.match(/\[id:[^\]]+\]/gi);
    if (tokenMatches) {
      for (const m of tokenMatches) push(m);
      return out;
    }
    for (const part of raw.split(/[,\s]+/)) push(part);
  }
  return out;
}

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
      const ranked = await llmListwiseRerank(theme, candidates, topK, options.model);
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
      blocks.push(
        `Theme: "${themes[i]}" (graph_strength: ${strength})\n${facts.map((f) => `  • ${f}`).join("\n")}`,
      );
    }

    if (blocks.length === 0) return "";
    return `\n\n=== KNOWLEDGE GRAPH (relation-path facts) ===\n${blocks.join("\n\n")}`;
  } catch (err) {
    log.warn("deepSearch knowledge-graph branch failed, skipping", { err });
    return "";
  }
}

// ── Schlep / defensibility instruction (shared by generation + critique) ───
//
// Steers generation toward HARD, UNGLAMOROUS, DEFENSIBLE ideas (the kind that
// score high on the GIANT defensibility / nonObviousness axes) and away from
// the templated "X for Y app" clones that pattern-match a top-ideas list but
// have no moat. Injected into both generation prompts (Pass 2 + single-pass).
const SCHLEP_INSTRUCTION = `SCHLEP & DEFENSIBILITY (CRITICAL):
- Prefer HARD, UNGLAMOROUS, DEFENSIBLE ideas — the unsexy "schlep" work most builders avoid (gnarly integrations, regulated workflows, ops/back-office, vertical depth, data plumbing). The hard part IS the moat.
- A fast-follower should NOT be able to copy the core in ~6 months. Reward counter-positioning and accruable advantages (proprietary data, hard-won integrations, trust/compliance, deep workflow lock-in).
- PENALIZE templated "X for Y app" clones, thin ChatGPT wrappers, and ideas a weekend hacker reproduces. If it would appear on a generic "top AI app ideas" list, it is too obvious.
- Anchor every idea in an ACUTE problem a nameable user wants solved NOW (a painkiller, not a vitamin) and a DATED "why now" shift — not "AI is hot" hand-waving.`;

// ── Category Context ─────────────────────────────────────────────────────

const CATEGORY_CONTEXT: Record<IdeaCategory, string> = {
  mobile_app: `Generate mobile app ideas for iOS and Android.

WHAT MAKES A GREAT MOBILE APP IDEA:
- Solves a daily friction (something people do 3+ times/week on their phone)
- Has a natural distribution channel (social sharing, word-of-mouth trigger, app store search term)
- Can deliver value in the first 30 seconds of use (no complex onboarding)
- Has a "10x moment" — a specific use case where it's 10x better than the current workaround
- Revenue model works at mobile scale (freemium, subscription, or transaction-based)

NOTE: B2B, vertical, ops/back-office, and devtools ideas are WELCOME when they have a deep, defensible wedge — do not discourage them. A gnarly integration or regulated workflow is often the moat, not a reason to avoid.

AVOID: ideas that need a two-sided marketplace to even function (chicken-and-egg with no seed side), thin clones with no defensible wedge.`,

  crypto_project: `Generate crypto/blockchain project ideas (DeFi, infrastructure, tooling, consumer).

WHAT MAKES A GREAT CRYPTO PROJECT IDEA:
- Leverages on-chain properties that can't be replicated off-chain (composability, permissionless access, programmable money, credible neutrality)
- Solves a problem that CURRENT crypto users have (not hypothetical mainstream users)
- Has a clear token utility or business model that doesn't depend on speculation
- Can launch on existing infrastructure (EVM, Solana, etc.) without building a new chain
- Has distribution via existing DeFi protocols, wallets, or communities

AVOID: "Blockchain for X" where X doesn't need a blockchain, ideas that require mass consumer adoption to work, ideas that are just a token wrapper around a centralized service.`,

  ai_app: `Generate AI application ideas powered by LLMs, vision models, or other ML capabilities.

WHAT MAKES A GREAT AI APP IDEA:
- Uses AI for a specific, narrow task where it's demonstrably better than manual work (not "AI-powered everything")
- The AI capability that enables it only became good enough in the last 12 months (why NOW?)
- Has a clear feedback loop — user corrections make it better over time
- Works even when the AI is 80% accurate (the UX handles errors gracefully)
- Can be built on top of existing model APIs (OpenAI, Anthropic, open source) — no custom training needed for v1

AVOID: "ChatGPT wrapper" ideas with no unique data or workflow, ideas where AI accuracy needs to be 99%+ to be useful, ideas that compete directly with foundation model providers.`,

  open_source: `Generate open source project ideas (developer tools, libraries, frameworks, infrastructure).

WHAT MAKES A GREAT OPEN SOURCE IDEA:
- Solves a pain that developers experience weekly and currently hack around with scripts/glue code
- Has a clear "aha moment" in the README — one code example that shows why this is better
- Can be adopted incrementally (doesn't require ripping out existing tools)
- Has a natural community of contributors (people who want this to exist for their own use)
- Business model path: hosting, enterprise features, support, or SaaS layer on top

AVOID: "Better version of X" where X is already good enough, frameworks that require full buy-in, tools that only matter at massive scale.`,

  general: `Generate tech product ideas across any category.

WHAT MAKES A GREAT PRODUCT IDEA:
- Addresses a specific pain point evidenced in the data (not assumed)
- Has identifiable first users who you could reach today
- Can deliver core value with a small team in 4-8 weeks (MVP scope)
- Has a clear "why now" — something changed recently that makes this possible or necessary
- The one-line pitch makes someone say "I need that" not just "that's interesting"

NOTE: Non-consumer-app categories are fully in scope — defensible B2B, devtools, ops, infrastructure, and vertical SaaS ideas are encouraged when they target an acute, deep need. The unglamorous, hard-to-copy idea often wins.

AVOID: two-sided platform plays with no path to seed the first side, ideas where the main value is aggregation without unique insight or defensibility.`,
};

// ── Insights section builder ──────────────────────────────────────────────

/**
 * Build a citation token per capability and a human-legible suffix carrying the
 * `[id:<token>]` (chain-of-evidence #8 part2) and corroboration count (#10).
 *
 * The map is keyed by the lowercased capability title so the insight lines
 * (which only carry titles) can be annotated. Returns an empty map / no-op
 * annotations when chainOfEvidence is off, keeping legacy prompt output stable.
 */
function buildCapabilityEvidence(
  capabilities: CapabilityScan,
  chainOfEvidence: boolean,
): {
  readonly annotate: (title: string, source: string) => string;
  readonly tokenLegend: readonly string[];
} {
  const byTitle = new Map<string, { token: string; corroboration?: number }>();
  const legend: string[] = [];

  capabilities.capabilities.forEach((cap: Capability, index: number) => {
    const token = signalCitationToken(cap.source, index);
    const key = cap.title.toLowerCase().trim();
    if (!byTitle.has(key)) {
      byTitle.set(key, { token, corroboration: cap.corroborationCount });
    }
    if (chainOfEvidence) {
      legend.push(`  [id:${token}] ${cap.title} (${cap.source})`);
    }
  });

  const annotate = (title: string, source: string): string => {
    const entry = byTitle.get(title.toLowerCase().trim());
    const suffixes: string[] = [];
    if (chainOfEvidence) {
      const token = entry?.token ?? signalCitationToken(source, byTitle.size);
      suffixes.push(`[id:${token}]`);
    }
    // #10: emphasize high-corroboration (multi-source) signals.
    const corroboration = entry?.corroboration;
    if (typeof corroboration === "number" && corroboration > 1) {
      suffixes.push(`(corroborated ×${corroboration})`);
    }
    return suffixes.length > 0 ? ` ${suffixes.join(" ")}` : "";
  };

  return { annotate, tokenLegend: legend };
}

function buildInsightsSection(
  trends: TrendData,
  pains: ClusteredPains,
  capabilities: CapabilityScan,
  chainOfEvidence = false,
): string {
  const parts: string[] = [];
  const capEvidence = buildCapabilityEvidence(capabilities, chainOfEvidence);

  if (trends.insights) {
    const { underservedSegments, workingPatterns, whiteSpaces } = trends.insights;
    const segmentLines = underservedSegments
      .slice(0, 8)
      .map((s) => `  • [${s.category}] ${s.gap} — ${s.evidence}`);
    const patternLines = workingPatterns
      .slice(0, 5)
      .map((p) => `  • ${p.pattern} — ${p.evidence}`);
    const spaceLines = whiteSpaces
      .slice(0, 5)
      .map((w) => `  • ${w.description} (adjacent: ${w.adjacentCategories.join(", ")}) — ${w.reason}`);

    parts.push(
      "=== LANDSCAPE INSIGHTS ===",
      "Underserved segments:",
      ...segmentLines,
      "Working patterns:",
      ...patternLines,
      "White spaces:",
      ...spaceLines,
    );
  } else {
    parts.push(
      "=== APP LANDSCAPE (raw) ===",
      sanitizeForPrompt(trends.summary || "No landscape data").slice(0, 20000),
    );
  }

  if (pains.insights) {
    const { painThemes, workaroundSignals, loveSignals } = pains.insights;
    const themeLines = painThemes
      .slice(0, 8)
      .map((t) => `  • [${t.frequency}] ${t.name}: ${t.description} (apps: ${t.affectedApps.slice(0, 3).join(", ")})`);
    const workaroundLines = workaroundSignals
      .slice(0, 5)
      .map((w) => `  • ${w.description} — current fix: ${w.currentSolution}`);
    const loveLines = loveSignals
      .slice(0, 5)
      .map((l) => `  • [${l.category}] ${l.feature}: ${l.whyUsersLoveIt}`);

    parts.push(
      "",
      "=== REVIEW INSIGHTS ===",
      "Pain themes:",
      ...themeLines,
      "Workaround signals (jobs-to-be-done):",
      ...workaroundLines,
      "Love signals (what to amplify):",
      ...loveLines,
    );
  } else {
    parts.push(
      "",
      "=== USER REVIEWS (raw) ===",
      sanitizeForPrompt(pains.summary || "No review data").slice(0, 20000),
    );
  }

  if (capabilities.insights) {
    const { genuinelyNew, technologyWaves, painCapabilityLinks } = capabilities.insights;
    const capLines = genuinelyNew
      .slice(0, 8)
      .map((c) => `  • [${c.classification}] ${c.title} (${c.source})${capEvidence.annotate(c.title, c.source)}: ${c.whyNew}`);
    const waveLines = technologyWaves
      .slice(0, 5)
      .map((w) => `  • ${w.name}: ${w.implication}`);
    const linkLines = painCapabilityLinks
      .slice(0, 8)
      .map((l) => `  • Pain "${l.painTheme}" × Capability "${l.capability}": ${l.connectionReason}`);

    parts.push(
      "",
      "=== CAPABILITY INSIGHTS ===",
      "Genuinely new capabilities:",
      ...capLines,
      "Technology waves:",
      ...waveLines,
      "Pain × Capability links:",
      ...linkLines,
    );
  } else {
    parts.push(
      "",
      "=== NEW CAPABILITIES (raw) ===",
      sanitizeForPrompt(capabilities.summary || "No capability data").slice(0, 20000),
    );
  }

  // #8 part2: expose the full citation legend so the model can reference signals
  // it did not see annotated inline (e.g. raw-summary fallback paths).
  if (chainOfEvidence && capEvidence.tokenLegend.length > 0) {
    parts.push(
      "",
      "=== SIGNAL CITATIONS (cite these tokens as supporting evidence) ===",
      ...capEvidence.tokenLegend,
    );
  }

  return parts.join("\n");
}

// ── Pass 1: Intersection Discovery ──────────────────────────────────────

async function discoverIntersections(
  trends: TrendData,
  pains: ClusteredPains,
  capabilities: CapabilityScan,
  model: string,
  chainOfEvidence: boolean,
): Promise<readonly IntersectionHypothesis[]> {
  const insightsSection = buildInsightsSection(trends, pains, capabilities, chainOfEvidence);

  const prompt = `You have structured market intelligence from three sources. Find the non-obvious intersections.

${insightsSection}

Generate 15-20 intersection hypotheses. Each hypothesis should represent a SPECIFIC opportunity where:
- A real pain or gap in the market (from the landscape/review data) meets
- A new capability that just became available (from the capability data) and
- A market timing signal that makes this the RIGHT MOMENT

Return ONLY a JSON array:
[
  {
    "title": "string — 3-5 word hypothesis name",
    "painSignal": "string — which specific pain/gap/workaround this addresses",
    "capabilitySignal": "string — which new capability enables a fundamentally better solution",
    "marketSignal": "string — which trend or timing signal makes this opportune NOW",
    "hypothesis": "string — 2-sentence description: what becomes possible and why it matters",
    "signalStrength": number
  }
]

signalStrength is 0.0-1.0: how strongly the data supports this intersection (not how excited you are). High scores require all three signals to be clearly present in the data above.`;

  const messages: ConversationMessage[] = [
    { role: "user", content: prompt, timestamp: Date.now() },
  ];

  const response = await chat(messages, {
    ...buildChatOptions(model),
    systemPrompt: "You are a product opportunity spotter. Find non-obvious intersections between market pain points and new capabilities. Output only valid JSON arrays.",
  });

  log.info("Pass 1 (intersections) raw response", {
    length: response.text.length,
    preview: response.text.slice(0, 200),
  });

  const intersections = parseJsonFromResponse<IntersectionHypothesis[]>(response.text, []);

  log.info("Pass 1 complete", { count: intersections.length });
  return intersections;
}

// ── Existing Ideas Context (dedup at LLM level) ─────────────────────────

async function buildExistingIdeasContext(): Promise<string> {
  try {
    const existing = await getAllExistingIdeas();
    if (existing.length === 0) return "";

    const lines = existing.slice(0, 200).map(
      (idea) => `- [${sanitizeForPrompt(idea.category)}] ${sanitizeForPrompt(idea.title)}: ${sanitizeForPrompt(idea.summary.slice(0, 100))}`,
    );

    return `\n\n=== EXISTING IDEAS (DO NOT generate anything similar to these — strict dedup) ===\n${lines.join("\n")}`;
  } catch {
    return "";
  }
}

// ── Validated-exemplar few-shot (#5) ─────────────────────────────────────

/** Minimal shape of a human-validated idea used as a positive few-shot example. */
export interface ValidatedExemplar {
  readonly title: string;
  readonly summary: string;
  readonly category?: string;
}

/**
 * #5 VALIDATED-EXEMPLAR FEW-SHOT: build a positive few-shot block from ideas
 * that humans validated, symmetric to the negative saturation block. Injected
 * into Pass 2 / single-pass prompts so the model produces "more like these".
 *
 * Returns "" when there are no exemplars, so callers can inject unconditionally.
 * The block is pure formatting — gating happens at the call site via
 * smart.validatedExemplars (the Pipeline phase passes "" when the flag is off).
 */
export function buildValidatedExemplars(
  exemplars: readonly ValidatedExemplar[],
  max = 6,
): string {
  if (exemplars.length === 0) return "";

  const lines = exemplars.slice(0, max).map((ex) => {
    const category = ex.category ? `[${sanitizeForPrompt(ex.category)}] ` : "";
    return `  • ${category}${sanitizeForPrompt(ex.title)}: ${sanitizeForPrompt(ex.summary.slice(0, 160))}`;
  });

  return [
    "",
    "=== HUMAN-VALIDATED IDEAS (produce MORE like these — same quality bar, NOT duplicates) ===",
    "These ideas passed human review. Match their specificity, grounding, and concreteness.",
    "Do NOT copy them; generate fundamentally new ideas that share their rigor.",
    ...lines,
  ].join("\n");
}

/**
 * Render the positive validated-exemplar block at a saturatedSection seam.
 * Empty string in → empty string out (legacy prompt unchanged).
 */
function validatedExemplarSection(validatedExemplars: string): string {
  return validatedExemplars ? `\n${validatedExemplars}` : "";
}

// ── Pass 2: Idea Development ─────────────────────────────────────────────

async function developIdeas(
  topIntersections: readonly IntersectionHypothesis[],
  category: IdeaCategory,
  saturatedThemes: string,
  deepSearchContext: string,
  model: string,
  validatedExemplars: string,
  chainOfEvidence: boolean,
): Promise<readonly GeneratedIdeaCandidate[]> {
  const intersectionLines = topIntersections.map((h, i) =>
    `${i + 1}. "${h.title}"\n   Pain: ${h.painSignal}\n   Capability: ${h.capabilitySignal}\n   Market: ${h.marketSignal}\n   Hypothesis: ${h.hypothesis}\n   Signal strength: ${h.signalStrength.toFixed(2)}`,
  ).join("\n\n");

  const saturatedSection = saturatedThemes
    ? `\nPREVIOUSLY GENERATED (avoid these themes):\n${saturatedThemes}`
    : "";

  const exemplarSection = validatedExemplarSection(validatedExemplars);

  const evidenceInstruction = chainOfEvidence
    ? `\n- supportingSignalIds: array of [id:...] tokens from the SIGNAL CITATIONS / capability annotations above that ground THIS idea (e.g. ["hackernews_3","producthunt_1"]). Cite only signals you actually used.`
    : "";

  const evidenceField = chainOfEvidence
    ? `,\n    "supportingSignalIds": ["string"]`
    : "";

  const existingIdeasContext = await buildExistingIdeasContext();

  const prompt = `You are developing the following validated market intersection hypotheses into concrete product ideas.

DIVERSITY REQUIREMENT (CRITICAL):
- Each idea MUST target a DIFFERENT market category and user segment
- No two ideas should address the same pain point or use the same technology
- If two ideas sound similar, DISCARD the weaker one and think of something completely different
- Spread across: consumer apps, B2B tools, developer tools, health/wellness, education, finance, creative tools, logistics

${CATEGORY_CONTEXT[category]}

${SCHLEP_INSTRUCTION}

=== VALIDATED INTERSECTION HYPOTHESES (ranked by signal strength) ===
${intersectionLines}
${sanitizeForPrompt(deepSearchContext)}
${exemplarSection}
${saturatedSection}
${existingIdeasContext}

For EACH hypothesis, develop a full product idea. Ground every field in the hypothesis signals above.

Each idea requires:
- title: Creative 2-3 word name
- summary: Full paragraph (4-6 sentences). What is it? Who specifically uses it? What is the "10x moment"? Why is timing perfect?
- reasoning: Full paragraph. Trace each signal: which specific pain + which capability + which market shift. Why couldn't this exist 12 months ago?
- trendIntersection: One sentence — "Trending X + Pain Y + Capability Z = this idea"
- designDescription: Full paragraph. Key screens, core user journey, visual style.
- monetizationDetail: Full paragraph. Pricing tiers, TAM estimate, path to $1M ARR, comparable comps.
- sourceLinks: References traceable to real data signals (can be [])
- sourcesUsed: Which data sources provided evidence for each signal
- category: "${category}"
- qualityScore: 1.0-5.0 (self-assessed — will be overridden by critique pass)
- targetAudience: Specific person (job title, age, situation, location if relevant)
- keyFeatures: 5-7 specific features (not generic, tied to the hypothesis signals)
- revenueModel: One-line summary${evidenceInstruction}

Return ONLY a JSON array of ${topIntersections.length} ideas:
[
  {
    "title": "string",
    "summary": "string",
    "reasoning": "string",
    "trendIntersection": "string",
    "designDescription": "string",
    "monetizationDetail": "string",
    "sourceLinks": [{"title": "string", "url": "string", "source": "string"}],
    "sourcesUsed": "string",
    "category": "${category}",
    "qualityScore": number,
    "targetAudience": "string",
    "keyFeatures": ["string"],
    "revenueModel": "string"${evidenceField}
  }
]`;

  const messages: ConversationMessage[] = [
    { role: "user", content: prompt, timestamp: Date.now() },
  ];

  const response = await chat(messages, {
    ...buildChatOptions(model),
    systemPrompt: "You are a product strategist turning validated market opportunities into concrete product ideas. Output only valid JSON arrays.",
  });

  log.info("Pass 2 (development) raw response", {
    length: response.text.length,
    preview: response.text.slice(0, 200),
  });

  let candidates = parseJsonFromResponse<GeneratedIdeaCandidate[]>(response.text, []);

  if (candidates.length === 0 && response.text.length > 0) {
    log.warn("Pass 2 returned no parseable JSON, retrying");
    const retryPrompt = `Generate ${topIntersections.length} product ideas as a JSON array. Each needs: title, summary, reasoning, trendIntersection, designDescription, monetizationDetail, sourceLinks (can be []), sourcesUsed, category ("${category}"), qualityScore (1-5), targetAudience, keyFeatures (array), revenueModel. Respond with ONLY the JSON array:`;

    const retryResponse = await chat(
      [{ role: "user", content: retryPrompt, timestamp: Date.now() }],
      { ...buildChatOptions(model), systemPrompt: "Output only valid JSON. No other text." },
    );

    candidates = parseJsonFromResponse<GeneratedIdeaCandidate[]>(retryResponse.text, []);
  }

  const normalized = chainOfEvidence
    ? candidates.map(normalizeSignalIds)
    : candidates;

  log.info("Pass 2 complete", { count: normalized.length });
  return normalized;
}

/**
 * Normalize a candidate's emitted `supportingSignalIds` into a clean string[]
 * regardless of whether the model returned a string or array. Immutable.
 */
function normalizeSignalIds(
  candidate: GeneratedIdeaCandidate,
): GeneratedIdeaCandidate {
  const ids = extractSignalIds(
    (candidate as { supportingSignalIds?: unknown }).supportingSignalIds,
  );
  if (ids.length === 0) {
    // Drop a possibly-malformed field rather than carry junk forward.
    const { supportingSignalIds: _omit, ...rest } = candidate as GeneratedIdeaCandidate & {
      supportingSignalIds?: unknown;
    };
    return rest;
  }
  return { ...candidate, supportingSignalIds: ids };
}

// ── Pass 2 (wide): Verbalized-Sampling over-generation ──────────────────────
//
// Phase 1 "generate-wide": instead of ONE idea per intersection (single-category,
// novelty-hostile), ask the model for a DISTRIBUTION of `seedsPerIntersection`
// DISTINCT candidate ideas — each as an {idea, probability} pair (Verbalized
// Sampling). The self-reported probability is captured as a diversity/coverage
// prior ONLY (verbalizedProb), never as the quality score (qualityScore stays
// owned by the GIANT critique). Every seed MUST keep its supportingSignalIds so
// breadth never drifts off the grounding signals (groundedness is the gate).
//
// When multiSegment is on, the prompt also carries a per-segment spread quota so
// the pool SPANS opportunity spaces (consumer/b2b_saas/devtools/...) instead of
// collapsing to consumer-mobile. Every candidate is tagged with its segment.
//
// Backward-compatible + graceful: any failure here is caught by the caller, which
// falls back to the legacy single-idea developIdeas path.

/**
 * Coerce a free-text/unknown segment value emitted by the model into a known
 * SegmentId, inferring from the idea text when the emitted value is missing or
 * not a recognized id. Pure.
 */
function resolveSegment(
  emitted: unknown,
  candidate: GeneratedIdeaCandidate,
): SegmentId {
  if (typeof emitted === "string") {
    const normalized = emitted.toLowerCase().trim().replace(/[\s-]+/g, "_");
    const match = SEGMENT_IDS_SET.has(normalized)
      ? (normalized as SegmentId)
      : null;
    if (match) return match;
  }
  return inferSegment(
    `${candidate.category} ${candidate.title} ${candidate.summary}`,
  );
}

const SEGMENT_IDS_SET: ReadonlySet<string> = new Set([
  "consumer",
  "b2b_saas",
  "devtools",
  "fintech",
  "healthcare",
  "vertical_ops",
  "marketplace",
  "infrastructure",
  "ai_native",
]);

/**
 * Turn a parsed VerbalizedSeed into a GeneratedIdeaCandidate, carrying the
 * verbalized probability (diversity prior) and a resolved segment tag. Tolerant
 * of missing fields (the critique/normalize passes backfill / validate). Pure.
 */
function seedToCandidate(
  seed: VerbalizedSeed,
  category: IdeaCategory,
  multiSegment: boolean,
  chainOfEvidence: boolean,
): GeneratedIdeaCandidate {
  const idea = seed.idea;
  const str = (v: unknown, fallback = ""): string =>
    typeof v === "string" ? v : fallback;
  const arr = (v: unknown): readonly string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

  const base: GeneratedIdeaCandidate = {
    title: str(idea.title),
    summary: str(idea.summary),
    reasoning: str(idea.reasoning),
    designDescription: str(idea.designDescription),
    monetizationDetail: str(idea.monetizationDetail),
    sourceLinks: Array.isArray(idea.sourceLinks)
      ? (idea.sourceLinks as GeneratedIdeaCandidate["sourceLinks"])
      : [],
    sourcesUsed: str(idea.sourcesUsed),
    category: str(idea.category, category),
    qualityScore:
      typeof idea.qualityScore === "number" ? idea.qualityScore : 0,
    targetAudience: str(idea.targetAudience),
    keyFeatures: arr(idea.keyFeatures),
    revenueModel: str(idea.revenueModel),
    trendIntersection: str(idea.trendIntersection),
    verbalizedProb: seed.probability,
  };

  const withSignals = chainOfEvidence
    ? normalizeSignalIds({
        ...base,
        supportingSignalIds: (idea as { supportingSignalIds?: unknown })
          .supportingSignalIds as readonly string[] | undefined,
      })
    : base;

  if (!multiSegment) return withSignals;
  return { ...withSignals, segment: resolveSegment(idea.segment, withSignals) };
}

/**
 * VERBALIZED-SAMPLING over-generation for ONE batch of intersections. Asks the
 * model for `seedsPerIntersection` distinct {idea, probability} seeds per
 * intersection, parses + tags them, and caps to `maxCandidates`. Never throws on
 * a parse miss (returns []), but a chat() failure propagates so the caller can
 * fall back to the legacy path.
 */
async function developIdeasWide(
  topIntersections: readonly IntersectionHypothesis[],
  category: IdeaCategory,
  saturatedThemes: string,
  deepSearchContext: string,
  model: string,
  validatedExemplars: string,
  chainOfEvidence: boolean,
  generateWide: GenerateWideConfig,
): Promise<readonly GeneratedIdeaCandidate[]> {
  const intersectionLines = topIntersections
    .map(
      (h, i) =>
        `${i + 1}. "${h.title}"\n   Pain: ${h.painSignal}\n   Capability: ${h.capabilitySignal}\n   Market: ${h.marketSignal}\n   Hypothesis: ${h.hypothesis}\n   Signal strength: ${h.signalStrength.toFixed(2)}`,
    )
    .join("\n\n");

  const seedsPer = generateWide.seedsPerIntersection;
  // Plan the segment spread over the FULL over-generated target so the pool spans
  // opportunity spaces (multiSegment only — empty block otherwise).
  const target = Math.min(
    topIntersections.length * seedsPer,
    generateWide.maxCandidates,
  );
  const segmentSpread = generateWide.multiSegment
    ? renderSegmentSpread(planSegmentDirectives(target))
    : "";

  const saturatedSection = saturatedThemes
    ? `\nPREVIOUSLY GENERATED (avoid these themes):\n${saturatedThemes}`
    : "";
  const exemplarSection = validatedExemplarSection(validatedExemplars);

  const evidenceInstruction = chainOfEvidence
    ? `\n  - supportingSignalIds: array of [id:...] tokens from the SIGNAL CITATIONS / capability annotations above that ground THIS idea. Cite only signals you actually used. EVERY seed MUST stay bound to its grounding signals.`
    : "";
  const evidenceField = chainOfEvidence
    ? `,\n      "supportingSignalIds": ["string"]`
    : "";
  const segmentField = generateWide.multiSegment
    ? `,\n      "segment": "string — one of: consumer, b2b_saas, devtools, fintech, healthcare, vertical_ops, marketplace, infrastructure, ai_native"`
    : "";

  const existingIdeasContext = await buildExistingIdeasContext();

  const prompt = `You are developing validated market intersection hypotheses into a DIVERSE DISTRIBUTION of concrete product ideas (Verbalized Sampling).

OVER-GENERATION REQUIREMENT (CRITICAL):
- For EACH hypothesis below, propose ${seedsPer} DISTINCT product ideas — not one. Cover genuinely different angles, buyers, and wedges for the same underlying signals.
- Return a DISTRIBUTION: each idea carries a self-reported "probability" (0.0-1.0) = how likely YOU think this specific framing is the strongest realization of the signals. The probabilities across a hypothesis's seeds need not sum to 1; treat them as relative confidence. We use them ONLY for coverage/diversity, so DO include lower-probability "long-shot" framings — do not collapse to the single safest idea.
- Every seed MUST stay grounded in the SAME intersection signals. Breadth must NOT drift off the evidence.

DIVERSITY REQUIREMENT (CRITICAL):
- Spread ideas across DIFFERENT market segments and user types — not all consumer mobile apps.
- No two seeds should be near-duplicates; if two sound similar, replace the weaker with a fundamentally different angle.

${CATEGORY_CONTEXT[category]}

${SCHLEP_INSTRUCTION}
${segmentSpread}

=== VALIDATED INTERSECTION HYPOTHESES (ranked by signal strength) ===
${intersectionLines}
${sanitizeForPrompt(deepSearchContext)}
${exemplarSection}
${saturatedSection}
${existingIdeasContext}

For EACH seed, develop a full product idea grounded in the hypothesis signals above. Each idea requires:
  - title: Creative 2-3 word name
  - summary: Full paragraph (4-6 sentences). What is it? Who specifically uses it? The "10x moment"? Why is timing perfect?
  - reasoning: Full paragraph tracing each signal (pain + capability + market shift). Why couldn't this exist 12 months ago?
  - trendIntersection: One sentence — "Trending X + Pain Y + Capability Z = this idea"
  - designDescription: Full paragraph. Key screens, core user journey, visual style.
  - monetizationDetail: Full paragraph. Pricing tiers, TAM estimate, path to $1M ARR, comps.
  - sourceLinks: References traceable to real data signals (can be [])
  - sourcesUsed: Which data sources provided evidence for each signal
  - category: "${category}"
  - qualityScore: 1.0-5.0 (self-assessed — will be overridden by critique pass)
  - targetAudience: Specific person (job title, age, situation)
  - keyFeatures: 5-7 specific features tied to the hypothesis signals
  - revenueModel: One-line summary${evidenceInstruction}

Return ONLY a JSON array of {idea, probability} seeds (${seedsPer} per hypothesis):
[
  {
    "probability": number,
    "idea": {
      "title": "string",
      "summary": "string",
      "reasoning": "string",
      "trendIntersection": "string",
      "designDescription": "string",
      "monetizationDetail": "string",
      "sourceLinks": [{"title": "string", "url": "string", "source": "string"}],
      "sourcesUsed": "string",
      "category": "${category}",
      "qualityScore": number,
      "targetAudience": "string",
      "keyFeatures": ["string"],
      "revenueModel": "string"${segmentField}${evidenceField}
    }
  }
]`;

  const messages: ConversationMessage[] = [
    { role: "user", content: prompt, timestamp: Date.now() },
  ];

  const response = await chat(messages, {
    ...buildChatOptions(model),
    // Over-generating N seeds per intersection is a large response; the default
    // 16k output cap truncates the JSON array mid-stream. Raise the budget and
    // pair it with the truncation-tolerant parser below so the pool never
    // silently collapses to the single-idea fallback.
    maxOutputTokens: 32000,
    systemPrompt:
      "You are a product strategist emitting a DIVERSE DISTRIBUTION of grounded product ideas via Verbalized Sampling. Each idea is a {idea, probability} pair. Output only a valid JSON array.",
  });

  log.info("Pass 2 (wide over-generation) raw response", {
    length: response.text.length,
    preview: response.text.slice(0, 200),
  });

  // Truncation-tolerant: recover every complete element even if the array was
  // cut off at the token cap (standard parse would yield 0 and force fallback).
  const parsed = parseJsonArrayLenient(response.text);
  const seeds = parseVerbalizedSeeds(parsed, generateWide.maxCandidates);

  const candidates = seeds
    .map((seed) =>
      seedToCandidate(seed, category, generateWide.multiSegment, chainOfEvidence),
    )
    // Drop empty-title noise (a seed with no idea payload is unusable).
    .filter((c) => c.title.trim().length > 0)
    .slice(0, generateWide.maxCandidates);

  log.info("Pass 2 (wide) complete", {
    seeds: seeds.length,
    candidates: candidates.length,
    seedsPerIntersection: seedsPer,
    multiSegment: generateWide.multiSegment,
  });

  return candidates;
}

// ── Pass 3: GIANT Critique ─────────────────────────────────────────────────
//
// The critique LLM pass now scores each idea against THE GIANT RUBRIC — the
// single shared 7-axis optimization target (acuteProblem, whyNow, demand,
// nonObviousness, defensibility, marketShape, founderFit, each 0..5) plus a
// Sequoia archetype tag, a structured dated whyNow array, and a painSeverity.
// It is still a SINGLE LLM call (no added cost) — only WHAT it scores changed.
//
// Aggregation is non-compensatory (weighted geometric mean) and runs in
// SHADOW MODE: aggregateGiant always computes `gated` from the hard gates +
// demand evidence-gate, but ideas are only actually dropped when
// smart.giant.enforceGates is true. The composite (0..5) becomes qualityScore
// so existing downstream code keeps working.

/** Strong per-axis anchors for the GIANT critique prompt (high vs low). */
const GIANT_RUBRIC_PROMPT = `Score each idea against THE GIANT RUBRIC — 7 axes, each 0..5. Be ruthless; reserve 4-5 for genuine outliers. Reward HARD, UNGLAMOROUS, DEFENSIBLE ideas; penalize templated "X for Y app" clones.

1. acuteProblem (0..5) — Is this a PAINKILLER a nameable user wants v1 NOW, backed by complaint-cluster size/recency? HIGH(5): a specific user is bleeding from this today and hacking a workaround. LOW(0-1): a "nice to have" vitamin, no one is actively hurting. SCORE <=1 IS A HARD GATE — reject-worthy.
2. whyNow (0..5) — Is there >=1 DATED, source-bound enabling shift (technological/regulatory/behavioral/economic) that makes this possible/necessary NOW? HIGH(5): a concrete dated shift you can cite. LOW(0-1): "AI is hot" hand-waving, nothing recent actually changed. SCORE <=1 IS A HARD GATE.
3. demand (0..5) — MUST cite a real demand artifact (search-volume delta, job-posting count, funding round, waitlist size, "looking for a tool that..." posts). HIGH(5): a quantified, cited artifact. LOW(<=2): no cited artifact — if you cannot cite one, score this <=2. Never free-score demand on vibes.
4. nonObviousness (0..5) — How far is this from the known-product corpus AND its in-batch siblings? HIGH(5): unsexy-but-defensible, would NOT show up on a "top AI app ideas" list. LOW(0-1): an obvious template ("Notion for X", "Uber for Y", "ChatGPT wrapper for Z").
5. defensibility (0..5) — Is there a moat a fast-follower CANNOT copy in ~6 months (counter-positioning, accruable advantage, hard-won data/integration)? HIGH(5): a structural advantage. LOW(0-1): a thin UI a weekend hacker reproduces.
6. marketShape (0..5) — Is there a deep BEACHHEAD user with an acute need plus a named path to a large TAM (a well, not a hole)? HIGH(5): narrow wedge → big market. LOW(0-1): a shallow hole with no expansion path.
7. founderFit (0..5) — Execution difficulty judged AGAINST THE IDEA'S ARCHETYPE (not uniformly). A hard-fact idea SHOULD be hard; reward ideas whose difficulty matches a defensible archetype rather than easy-but-trivial.

Also tag ARCHETYPE: "hair-on-fire" (acute pain, sell aspirin today) | "hard-fact" (a non-obvious truth about the world) | "future-vision" (bet on where things are going).
Provide a structured whyNow array of dated, source-bound enabling shifts.
Provide painSeverity = the acuteProblem axis value (0..5), for fast pain filtering.`;

/** One parsed GIANT critique entry, keyed back to its idea by title. */
interface GiantCritiqueEntry {
  readonly title: string;
  readonly parsed: ParsedGiant;
  readonly painSeverity: number;
  readonly verdict: string;
}

/**
 * Whether the parsed GIANT carries a cited demand artifact, so the demand
 * evidence-gate can decide whether to cap the demand axis. Heuristic + tolerant:
 * a demand artifact is present when the demand evidence citation is non-empty OR
 * any whyNow shift is bound to a real signal id. Errs toward NOT capping only
 * when there is concrete evidence — un-evidenced demand stays capped (the GIANT
 * default). Pure.
 */
export function hasDemandEvidence(parsed: ParsedGiant): boolean {
  const demandEvidence = parsed.evidence.demand?.trim() ?? "";
  if (demandEvidence.length > 0) return true;
  return parsed.whyNow.some(
    (shift) =>
      typeof shift.boundSignalId === "string" &&
      shift.boundSignalId.trim().length > 0,
  );
}

/**
 * Map a GIANT composite (0..5, weighted geometric mean) onto the legacy
 * qualityScore scale (the rest of the pipeline reads qualityScore for sort /
 * MMR / persistence). The composite IS a 0..5 scale already, so this is an
 * identity clamp into [0, 5] — kept as a named seam so the derivation is
 * explicit and testable. Pure.
 */
export function compositeToQualityScore(composite: number): number {
  if (!Number.isFinite(composite)) return 0;
  return Math.min(5, Math.max(0, composite));
}

/**
 * Score candidates against the GIANT rubric in a single LLM call, then aggregate
 * each into the non-compensatory composite. Shadow-mode by default: gated ideas
 * are KEPT (with their GIANT scorecard attached) and merely logged unless
 * `giant.enforceGates` is true, in which case gated ideas are dropped.
 *
 * Backward-compatible: on any parse/LLM failure the original candidates are
 * returned unchanged so the optional GIANT path can't break the pipeline.
 */
async function critiqueIdeas(
  candidates: readonly GeneratedIdeaCandidate[],
  trendsSummary: string,
  painsSummary: string,
  capabilitiesSummary: string,
  model: string,
  giant: GiantConfig,
): Promise<readonly GeneratedIdeaCandidate[]> {
  const ideaList = candidates.map((c, i) =>
    `${i + 1}. "${c.title}"\n   Summary: ${c.summary.slice(0, 300)}\n   Reasoning: ${c.reasoning.slice(0, 200)}\n   Target: ${c.targetAudience}\n   Features: ${c.keyFeatures.slice(0, 4).join(", ")}`,
  ).join("\n\n");

  const rawContext = [
    "=== RAW TRENDS SUMMARY ===",
    sanitizeForPrompt(trendsSummary || "").slice(0, 8000),
    "=== RAW PAINS SUMMARY ===",
    sanitizeForPrompt(painsSummary || "").slice(0, 8000),
    "=== RAW CAPABILITIES SUMMARY ===",
    sanitizeForPrompt(capabilitiesSummary || "").slice(0, 8000),
  ].join("\n");

  const prompt = `You are a ruthless product idea critic. Score each idea honestly against the raw market data.

${rawContext}

=== IDEAS TO CRITIQUE ===
${ideaList}

${GIANT_RUBRIC_PROMPT}

Return ONLY a JSON array with one entry per idea (in the same order):
[
  {
    "title": "string — must match exactly",
    "scores": {
      "acuteProblem": number,
      "whyNow": number,
      "demand": number,
      "nonObviousness": number,
      "defensibility": number,
      "marketShape": number,
      "founderFit": number
    },
    "archetype": "hair-on-fire" | "hard-fact" | "future-vision",
    "painSeverity": number,
    "whyNow": [
      {
        "axis": "technological" | "regulatory" | "behavioral" | "economic",
        "claim": "string — the dated enabling shift",
        "boundSignalId": "string — a [id:...] token if this is bound to a real signal (optional)",
        "date": "string — ISO-ish date of the shift (optional)",
        "strength": number
      }
    ],
    "evidence": {
      "acuteProblem": "string — per-axis evidence citation",
      "whyNow": "string",
      "demand": "string — MUST cite a demand artifact or leave empty (demand is then capped low)",
      "nonObviousness": "string",
      "defensibility": "string",
      "marketShape": "string",
      "founderFit": "string"
    },
    "verdict": "string — one sentence on the idea's core strength or fatal flaw"
  }
]`;

  const messages: ConversationMessage[] = [
    { role: "user", content: prompt, timestamp: Date.now() },
  ];

  const response = await chat(messages, {
    ...buildChatOptions(model),
    systemPrompt:
      "You are a ruthless product idea critic scoring ideas against the GIANT rubric. Score honestly; cite per-axis evidence. Output only valid JSON arrays.",
  });

  log.info("Pass 3 (GIANT critique) raw response", {
    length: response.text.length,
    preview: response.text.slice(0, 200),
  });

  const rawCritiques = parseJsonFromResponse<unknown[]>(response.text, []);

  if (rawCritiques.length === 0) {
    log.warn("Pass 3 returned no parseable critiques, returning candidates as-is");
    return candidates;
  }

  // Tolerantly parse each raw critique into a normalized GIANT entry, keyed by
  // title. parseGiant never throws, so a malformed row degrades to safe defaults
  // rather than killing the whole pass.
  const critiqueByTitle = new Map<string, GiantCritiqueEntry>();
  for (const raw of rawCritiques) {
    if (raw === null || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const title = typeof r.title === "string" ? r.title : "";
    if (title.trim().length === 0) continue;
    const parsed = parseGiant(raw);
    const painSeverity =
      typeof r.painSeverity === "number"
        ? Math.min(5, Math.max(0, r.painSeverity))
        : parsed.scores.acuteProblem;
    critiqueByTitle.set(title.toLowerCase().trim(), {
      title,
      parsed,
      painSeverity,
      verdict: typeof r.verdict === "string" ? r.verdict : "",
    });
  }

  const enforceGates = giant.enforceGates === true;
  const survived: GeneratedIdeaCandidate[] = [];

  for (const candidate of candidates) {
    const critique = critiqueByTitle.get(candidate.title.toLowerCase().trim());

    if (!critique) {
      // No critique found — keep with original score (degrade gracefully).
      log.warn("No GIANT critique found for idea, keeping with original score", {
        title: candidate.title,
      });
      survived.push(candidate);
      continue;
    }

    const { parsed, painSeverity } = critique;
    const demandEvidence = hasDemandEvidence(parsed);
    const aggregate = aggregateGiant(parsed.scores, {
      weights: giant.weights,
      enforceGates,
      hasDemandEvidence: demandEvidence,
    });

    const qualityScore = compositeToQualityScore(aggregate.composite);

    const scored: GeneratedIdeaCandidate = {
      ...candidate,
      qualityScore,
      giant: parsed.scores,
      giantEvidence: parsed.evidence,
      archetype: parsed.archetype,
      whyNow: parsed.whyNow,
      painSeverity,
      giantComposite: aggregate.composite,
      giantGated: aggregate.gated,
      giantGateReasons: aggregate.gateReasons,
    };

    // SHADOW MODE: gating is always computed + stored; the idea is only actually
    // dropped when enforcement is on. Otherwise we keep it and log the would-kill.
    if (aggregate.gated) {
      if (enforceGates) {
        log.info("Idea KILLED by GIANT hard gate (enforced)", {
          title: candidate.title,
          composite: aggregate.composite,
          gateReasons: aggregate.gateReasons,
          verdict: critique.verdict,
        });
        continue;
      }
      log.info("Idea WOULD-KILL by GIANT gate (shadow mode, kept)", {
        title: candidate.title,
        composite: aggregate.composite,
        gateReasons: aggregate.gateReasons,
        verdict: critique.verdict,
      });
    }

    survived.push(scored);
  }

  log.info("Pass 3 (GIANT) complete", {
    input: candidates.length,
    survived: survived.length,
    dropped: candidates.length - survived.length,
    enforceGates,
  });

  return survived;
}

// ── Fallback: Single-pass synthesis ──────────────────────────────────────

async function singlePassSynthesis(input: {
  readonly trends: TrendData;
  readonly pains: ClusteredPains;
  readonly capabilities: CapabilityScan;
  readonly deepSearchContext: string;
  readonly saturatedThemes: string;
  readonly category: IdeaCategory;
  readonly maxIdeas: number;
  readonly model: string;
  readonly validatedExemplars?: string;
}): Promise<SynthesisResult> {
  const { trends, pains, capabilities, deepSearchContext, saturatedThemes, category, maxIdeas, model } = input;

  const saturatedSection = saturatedThemes
    ? `\nPREVIOUSLY GENERATED (avoid these themes):\n${saturatedThemes}`
    : "";

  const exemplarSection = validatedExemplarSection(input.validatedExemplars ?? "");

  const existingIdeasContext = await buildExistingIdeasContext();

  const prompt = `You are a product strategist analyzing REAL market data. You have three data sets:

1. THE APP LANDSCAPE — what 4000+ existing apps offer, their satisfaction scores, and which categories are underserved
2. USER VOICES — what users hate AND what they love (both complaints and praises tell you what matters)
3. NEW CAPABILITIES — what new tech, open source tools, and behavior shifts just became available

Your job: Find opportunities where existing apps FAIL to deliver what users clearly want, and where new capabilities make a BETTER solution possible now.

${CATEGORY_CONTEXT[category]}

${SCHLEP_INSTRUCTION}

=== APP LANDSCAPE (4000+ apps across 28 categories — satisfaction scores, what they offer) ===
${sanitizeForPrompt(trends.summary || "No landscape data")}

=== USER REVIEWS (what people HATE and what they LOVE — both matter) ===
${sanitizeForPrompt(pains.summary || "No review data")}

=== NEW CAPABILITIES (emerging tech, open source, behavior shifts) ===
${sanitizeForPrompt(capabilities.summary || "No capability data")}
${sanitizeForPrompt(deepSearchContext)}
${exemplarSection}
${saturatedSection}
${existingIdeasContext}

Generate ${maxIdeas} ideas. Return ONLY a JSON array:
[
  {
    "title": "string",
    "summary": "string",
    "reasoning": "string",
    "trendIntersection": "string",
    "designDescription": "string",
    "monetizationDetail": "string",
    "sourceLinks": [{"title": "string", "url": "string", "source": "string"}],
    "sourcesUsed": "string",
    "category": "${category}",
    "qualityScore": number,
    "targetAudience": "string",
    "keyFeatures": ["string"],
    "revenueModel": "string"
  }
]`;

  const messages: ConversationMessage[] = [
    { role: "user", content: prompt, timestamp: Date.now() },
  ];

  const response = await chat(messages, {
    ...buildChatOptions(model),
    systemPrompt:
      "You are a JSON API. You ONLY output valid JSON arrays. No markdown, no explanations, no preamble. Start your response with [ and end with ].",
  });

  log.info("Fallback single-pass raw response", {
    length: response.text.length,
    preview: response.text.slice(0, 300),
  });

  let candidates = parseJsonFromResponse<GeneratedIdeaCandidate[]>(response.text, []);

  if (candidates.length === 0 && response.text.length > 0) {
    log.warn("Fallback synthesis returned no parseable JSON, retrying");
    const retryPrompt = `Generate ${maxIdeas} product ideas as a JSON array. Each needs: title, summary, reasoning, trendIntersection, designDescription, monetizationDetail, sourceLinks (can be []), sourcesUsed, category ("${category}"), qualityScore (1-5), targetAudience, keyFeatures (array), revenueModel. Respond with ONLY the JSON array:`;

    const retryResponse = await chat(
      [{ role: "user", content: retryPrompt, timestamp: Date.now() }],
      { ...buildChatOptions(model), systemPrompt: "Output only valid JSON. No other text." },
    );

    candidates = parseJsonFromResponse<GeneratedIdeaCandidate[]>(retryResponse.text, []);
  }

  return { candidates, totalGenerated: candidates.length };
}

// ── Main Synthesis ───────────────────────────────────────────────────────

export async function synthesizeFromTrends(input: {
  readonly trends: TrendData;
  readonly pains: ClusteredPains;
  readonly capabilities: CapabilityScan;
  readonly deepSearchContext: string;
  readonly saturatedThemes: string;
  readonly category: IdeaCategory;
  readonly maxIdeas: number;
  readonly model: string;
  /**
   * #5 Positive few-shot block of human-validated ideas (built by the Pipeline
   * phase via buildValidatedExemplars). Optional — backward-compatible; injected
   * only when smart.validatedExemplars is on AND the caller supplies it.
   */
  readonly validatedExemplars?: string;
  /**
   * Phase 1 "generate-wide" SIGE divergent merge (flag-gated, default OFF): extra
   * UNSCORED candidates produced by the SIGE divergent-generation pool that the
   * Pipeline phase folds into the synthesizer pool. They are merged BEFORE Pass 3
   * so they flow through the SAME GIANT critique + novelty-reserve selection as
   * the over-generated candidates (keeping the whole pool evidence-tethered and
   * comparably scored). Optional — backward-compatible; empty/absent → today's
   * behavior. The total pool (over-generated + extra) is capped at
   * smart.generateWide.maxCandidates.
   */
  readonly extraCandidates?: readonly GeneratedIdeaCandidate[];
}): Promise<SynthesisResult> {
  const { trends, pains, capabilities, deepSearchContext, saturatedThemes, category, maxIdeas, model } = input;

  const smart = loadConfig().pipelines.ideas.smart;
  const chainOfEvidence = smart.chainOfEvidence;
  const generateWide = smart.generateWide;
  // Gate the positive few-shot: only inject when the flag is ON.
  const validatedExemplars = smart.validatedExemplars ? input.validatedExemplars ?? "" : "";

  // ── Pass 1: Discover intersections ──────────────────────────────────
  let intersections: readonly IntersectionHypothesis[];

  try {
    intersections = await discoverIntersections(trends, pains, capabilities, model, chainOfEvidence);
  } catch (err) {
    log.error("Pass 1 failed, falling back to single-pass synthesis", { err });
    return singlePassSynthesis({ ...input, validatedExemplars });
  }

  if (intersections.length === 0) {
    log.warn("No intersections found in Pass 1, falling back to single-pass synthesis");
    return singlePassSynthesis({ ...input, validatedExemplars });
  }

  // Deduplicate by capabilitySignal — if 3+ hypotheses cite the same capability, keep only the best
  const capabilityCounts = new Map<string, number>();
  for (const h of intersections) {
    const key = h.capabilitySignal.toLowerCase().trim();
    capabilityCounts.set(key, (capabilityCounts.get(key) ?? 0) + 1);
  }

  const dedupedIntersections = intersections.filter((h) => {
    const key = h.capabilitySignal.toLowerCase().trim();
    const count = capabilityCounts.get(key) ?? 0;
    if (count <= 2) return true;
    // Keep only the highest signalStrength for over-represented capabilities
    const best = intersections
      .filter((x) => x.capabilitySignal.toLowerCase().trim() === key)
      .sort((a, b) => b.signalStrength - a.signalStrength)[0];
    return h === best;
  });

  log.info("Capability dedup complete", {
    before: intersections.length,
    after: dedupedIntersections.length,
  });

  // Take top 10 by signal strength from deduped set
  const topIntersections = [...dedupedIntersections]
    .sort((a, b) => b.signalStrength - a.signalStrength)
    .slice(0, Math.min(maxIdeas * 2, 10));

  log.info("Pass 1 complete — proceeding to Pass 2", {
    totalIntersections: intersections.length,
    selectedForDevelopment: topIntersections.length,
  });

  // ── Pass 2: Develop ideas from intersections ─────────────────────────
  // Phase 1 "generate-wide": when overGenerate is ON, request a DISTRIBUTION of
  // seeds per intersection (verbalized sampling) + segment spread to WIDEN the
  // pool. Any failure degrades to the legacy single-idea path, then to single-
  // pass — so the optional widening can never break the pipeline.
  let rawCandidates: readonly GeneratedIdeaCandidate[];

  try {
    if (generateWide.overGenerate) {
      try {
        rawCandidates = await developIdeasWide(
          topIntersections,
          category,
          saturatedThemes,
          deepSearchContext,
          model,
          validatedExemplars,
          chainOfEvidence,
          generateWide,
        );
        if (rawCandidates.length === 0) {
          log.warn(
            "Over-generation produced no candidates, falling back to single-idea developIdeas",
          );
          rawCandidates = await developIdeas(
            topIntersections,
            category,
            saturatedThemes,
            deepSearchContext,
            model,
            validatedExemplars,
            chainOfEvidence,
          );
        }
      } catch (wideErr) {
        log.warn(
          "Over-generation path failed, falling back to single-idea developIdeas",
          { err: wideErr },
        );
        rawCandidates = await developIdeas(
          topIntersections,
          category,
          saturatedThemes,
          deepSearchContext,
          model,
          validatedExemplars,
          chainOfEvidence,
        );
      }
    } else {
      rawCandidates = await developIdeas(
        topIntersections,
        category,
        saturatedThemes,
        deepSearchContext,
        model,
        validatedExemplars,
        chainOfEvidence,
      );
    }
  } catch (err) {
    log.error("Pass 2 failed, falling back to single-pass synthesis", { err });
    return singlePassSynthesis({ ...input, validatedExemplars });
  }

  if (rawCandidates.length === 0) {
    log.warn("No ideas developed in Pass 2, returning empty result");
    return { candidates: [], totalGenerated: 0 };
  }

  // SIGE DIVERGENT MERGE (generate-wide, flag-gated by the Pipeline phase): fold
  // any extra UNSCORED candidates into the pool BEFORE Pass 3 so they flow through
  // the SAME GIANT critique + novelty-reserve selection. Title-dedup against the
  // over-generated set, then cap the merged pool at maxCandidates so cost stays
  // bounded. No-op when the caller supplies none (default path).
  rawCandidates = mergeExtraCandidates(
    rawCandidates,
    input.extraCandidates ?? [],
    generateWide.maxCandidates,
  );

  log.info("Pass 2 complete — proceeding to Pass 3", { count: rawCandidates.length });

  // ── Pass 3: Critique and score ───────────────────────────────────────
  let critiquedCandidates: readonly GeneratedIdeaCandidate[];

  try {
    critiquedCandidates = await critiqueIdeas(
      rawCandidates,
      trends.summary,
      pains.summary,
      capabilities.summary,
      model,
      smart.giant,
    );
  } catch (err) {
    log.error("Pass 3 failed, returning uncritiqued candidates", { err });
    critiquedCandidates = rawCandidates;
  }

  // ── QUICK WIN: sort by quality desc, then MMR diversity before slicing ──
  // Phase 1 "generate-wide": when over-generating, reserve a slice of the final
  // slots for high-novelty / high-originality candidates so the widened pool is
  // not collapsed back to the highest-self-reported-signal lookalikes.
  const finalCandidates = sortAndDiversify(
    critiquedCandidates,
    maxIdeas,
    generateWide.overGenerate,
  );

  return {
    candidates: finalCandidates,
    totalGenerated: rawCandidates.length,
  };
}

/**
 * QUICK WIN — sort + MMR. Sort critiqued candidates by qualityScore desc, then
 * run an intra-batch MMR diversity pass (Jaccard over title+summary) so the
 * top `maxIdeas` are both high-quality AND mutually distinct.
 *
 * Adapts candidates to the existing src/memory/mmr.ts applyMmr via minimal
 * SearchResult-shaped objects ({ chunk: { content: title+summary }, score }).
 * Falls back to a plain quality sort + slice on any error (never throws).
 */
/**
 * Merge extra (SIGE-divergent) candidates into the primary pool, deduping by
 * lowercased title against the primary set, then cap the combined pool at
 * `maxCandidates`. Primary candidates always take precedence on a title clash.
 * Pure + immutable; returns the primary set unchanged when there is nothing to
 * merge. The cap protects total cost (more candidates → more critique tokens).
 */
function mergeExtraCandidates(
  primary: readonly GeneratedIdeaCandidate[],
  extra: readonly GeneratedIdeaCandidate[],
  maxCandidates: number,
): readonly GeneratedIdeaCandidate[] {
  if (extra.length === 0) return primary.slice(0, maxCandidates);

  const seen = new Set(primary.map((c) => c.title.toLowerCase().trim()));
  const merged: GeneratedIdeaCandidate[] = [...primary];
  for (const candidate of extra) {
    const key = candidate.title.toLowerCase().trim();
    if (key.length === 0 || seen.has(key)) continue;
    seen.add(key);
    merged.push(candidate);
  }

  log.info("SIGE-divergent merge complete", {
    primary: primary.length,
    extra: extra.length,
    merged: merged.length,
    capped: Math.min(merged.length, maxCandidates),
  });

  return merged.slice(0, maxCandidates);
}

function sortAndDiversify(
  candidates: readonly GeneratedIdeaCandidate[],
  maxIdeas: number,
  reserveNovelty = false,
): readonly GeneratedIdeaCandidate[] {
  if (candidates.length <= 1 || maxIdeas <= 0) {
    return candidates.slice(0, maxIdeas);
  }

  const sorted = [...candidates].sort((a, b) => b.qualityScore - a.qualityScore);
  if (sorted.length <= maxIdeas) return sorted;

  // NOVELTY-RESERVE (generate-wide): reserve final slots for high-surprise /
  // high-originality candidates so the quality sort cannot starve out the
  // surprising ideas the widening produced. This narrows to exactly `maxIdeas`
  // candidates that MUST be kept; the MMR pass below then only REORDERS that set
  // (k === set size cannot drop a reserved member). Pure + total — degrades to
  // the plain quality sort on any issue. When off, MMR runs over the full sort.
  const mmrInput = reserveNovelty
    ? selectWithNoveltyReserve(sorted, maxIdeas)
    : sorted;
  const targetCount = Math.min(maxIdeas, mmrInput.length);

  try {
    // Adapt to SearchResult shape; applyMmr only reads `chunk.content` + `score`
    // and maps back by index, so a minimal structural object is sufficient.
    const adapted = mmrInput.map((c) => ({
      chunk: { content: `${c.title}\n${c.summary}` },
      score: c.qualityScore,
    })) as unknown as readonly SearchResult[];

    const diversified = applyMmr(adapted, 0.7, targetCount);
    const byContent = new Map<string, GeneratedIdeaCandidate>();
    mmrInput.forEach((c) => byContent.set(`${c.title}\n${c.summary}`, c));

    const result: GeneratedIdeaCandidate[] = [];
    for (const r of diversified) {
      const match = byContent.get(r.chunk.content);
      if (match) result.push(match);
    }
    // Safety: if mapping lost entries, fall back to the (novelty-reserved or
    // quality-sorted) slice.
    return result.length === targetCount
      ? result
      : mmrInput.slice(0, maxIdeas);
  } catch (err) {
    log.warn("sort+MMR diversity pass failed, using quality sort", { err });
    return mmrInput.slice(0, maxIdeas);
  }
}
