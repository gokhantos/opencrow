/**
 * Semantic keyword clustering — group the noisy App Store keyword corpus into
 * "app concepts" (Music, Budgeting, Sleep, Flights ...) via LOCAL embeddings +
 * greedy cosine clustering. Precomputed by a manual batch job
 * (scripts/cluster-appstore-keywords.ts) and served read-only through
 * `getOpportunityClusters` — there is NO per-request embedding.
 *
 * Split into a PURE, unit-tested core (`clusterByCosine`, `isClusterableKeyword`,
 * `pickClusterLabel`) and a thin, dependency-injected orchestrator
 * (`runKeywordClustering`). The orchestrator takes its embedding provider,
 * candidate loader, and persister as deps so it can be unit-tested end-to-end
 * with a deterministic fake embedder and no DB/network.
 *
 * Spike findings that shape this (see the design doc): local Ollama
 * `nomic-embed-text` + greedy cosine ~0.72–0.76 yields real concept groups, but
 * a generic-"app" mega-bucket and pure-noise clusters ("updated/update") form
 * unless junk is prefiltered HARD before clustering — hence
 * `isClusterableKeyword` drops sole-generic-token keywords up front.
 */

import type { EmbeddingProvider } from "../../memory/types";
import type { EmbeddingCache } from "../../memory/embedding-cache";
import { createLogger } from "../../logger";
import { getErrorMessage } from "../../lib/error-serialization";
import { CLUSTERING_JUNK_KEYWORDS } from "./keyword-junk";

const log = createLogger("appstore-keyword-clustering");

/**
 * Default cosine floor for greedy assignment. Calibrated on real data AFTER the
 * generic-modifier stripping below: nomic over-weights a shared generic token,
 * so raw-keyword embedding at 0.74 produced generic mega-buckets ("search app"
 * mixing app abc / app baby / app duo). Embedding the concept RESIDUAL and
 * raising the floor to 0.78 splits those cleanly.
 */
export const DEFAULT_CLUSTER_THRESHOLD = 0.78;

/** Default cap on candidates embedded/clustered per run (highest-demand first). */
export const DEFAULT_MAX_CANDIDATES = 20_000;

/** A keyword paired with its (raw, not-yet-normalized) embedding vector. */
export interface ClusterItem {
  readonly key: string;
  readonly vec: Float32Array;
}

/** One cluster: its 0-based id and the member keys in assignment order. */
export interface Cluster {
  readonly clusterId: number;
  readonly members: readonly string[];
}

/** A clusterable candidate keyword with the fields needed to label its cluster. */
export interface RawCandidate {
  readonly keyword: string;
  readonly demand: number;
  readonly buildability: number;
}

/** One persisted assignment row (mirrors `appstore_keyword_clusters`). */
export interface ClusterAssignmentRow {
  readonly keyword: string;
  readonly clusterId: number;
  readonly clusterLabel: string;
  /** Cosine similarity to the final cluster centroid (0..1). */
  readonly similarity: number;
}

/** Summary of a clustering run — returned for logging/verification. */
export interface ClusterRunResult {
  readonly fetched: number;
  readonly droppedAsJunk: number;
  /** Candidates whose concept residual was empty (pure generic/noise). */
  readonly droppedAsNoise: number;
  readonly capped: number;
  readonly embedded: number;
  readonly cacheHits: number;
  readonly clusterCount: number;
  readonly assignmentCount: number;
}

// ---------------------------------------------------------------------------
// Pure vector helpers
// ---------------------------------------------------------------------------

/** Dot product over the shared prefix length (defensive against dim mismatch). */
function dot(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < n; i++) sum += (a[i] as number) * (b[i] as number);
  return sum;
}

/**
 * Return an L2-normalized copy of `vec` (unit length). A zero vector is
 * returned as-is (all zeros) — its cosine with anything is 0, so it lands in
 * its own singleton cluster rather than crashing on divide-by-zero.
 */
export function l2Normalize(vec: Float32Array): Float32Array {
  let norm = 0;
  for (let i = 0; i < vec.length; i++) norm += (vec[i] as number) ** 2;
  norm = Math.sqrt(norm);
  if (norm === 0) return new Float32Array(vec);
  const out = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = (vec[i] as number) / norm;
  return out;
}

/** Mean of unit vectors, re-normalized — the running/spherical centroid. */
function centroidOf(vectors: readonly Float32Array[]): Float32Array {
  const first = vectors[0];
  if (!first) return new Float32Array(0);
  const sum = new Float32Array(first.length);
  for (const v of vectors) {
    for (let i = 0; i < sum.length; i++) sum[i] = (sum[i] as number) + (v[i] as number);
  }
  return l2Normalize(sum);
}

// ---------------------------------------------------------------------------
// Pure clustering core (unit-tested — no I/O)
// ---------------------------------------------------------------------------

interface MutableCluster {
  readonly members: string[];
  /** Running sum of member UNIT vectors (centroid = l2Normalize(sum)). */
  sum: Float32Array;
  centroid: Float32Array;
}

/**
 * Greedy single-pass clustering by cosine similarity. Each item is normalized
 * and compared to every existing cluster's running centroid; it joins the
 * best-matching cluster whose cosine clears `threshold`, else seeds a new
 * cluster. Deterministic and order-sensitive — feed items highest-demand-first
 * so the strongest keyword seeds each cluster (and, downstream, labels it).
 *
 * Pure: no DB, no clock, no randomness. Returns clusters in creation order with
 * 0-based ids and members in assignment order.
 */
export function clusterByCosine(
  items: readonly ClusterItem[],
  threshold: number,
): Cluster[] {
  const clusters: MutableCluster[] = [];

  for (const item of items) {
    const unit = l2Normalize(item.vec);

    let bestIdx = -1;
    let bestSim = threshold;
    for (let i = 0; i < clusters.length; i++) {
      const sim = dot((clusters[i] as MutableCluster).centroid, unit);
      if (sim >= bestSim) {
        bestSim = sim;
        bestIdx = i;
      }
    }

    if (bestIdx >= 0) {
      const cluster = clusters[bestIdx] as MutableCluster;
      cluster.members.push(item.key);
      const sum = cluster.sum;
      for (let i = 0; i < sum.length; i++) sum[i] = (sum[i] as number) + (unit[i] as number);
      cluster.centroid = l2Normalize(sum);
    } else {
      clusters.push({ members: [item.key], sum: new Float32Array(unit), centroid: unit });
    }
  }

  return clusters.map((c, clusterId) => ({ clusterId, members: c.members }));
}

// ---------------------------------------------------------------------------
// Pure candidate prefilter (unit-tested)
// ---------------------------------------------------------------------------

const CLUSTERING_JUNK_SET: ReadonlySet<string> = new Set(
  CLUSTERING_JUNK_KEYWORDS.map((w) => w.toLowerCase()),
);

// Numeric / punctuation / whitespace-only keywords carry no concept signal.
const NUMERIC_OR_PUNCT_ONLY = /^[0-9\s\p{P}]+$/u;

/**
 * True when a keyword is worth clustering: at least 3 chars, not purely
 * numeric/punctuation, and NOT composed solely of generic junk tokens
 * (`CLUSTERING_JUNK_KEYWORDS`). A sole generic word ("updated", "app") is
 * dropped; a real multi-word concept ("budget planner", "flight tracker")
 * survives even when one token is generic. Pure — no I/O.
 */
export function isClusterableKeyword(keyword: string): boolean {
  const trimmed = keyword.trim().toLowerCase();
  if (trimmed.length < 3) return false;
  if (NUMERIC_OR_PUNCT_ONLY.test(trimmed)) return false;
  const tokens = trimmed.split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return false;
  if (tokens.every((t) => CLUSTERING_JUNK_SET.has(t))) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Concept-residual stripping (embed-input preprocessing, unit-tested)
// ---------------------------------------------------------------------------

/**
 * Generic modifier tokens stripped from a keyword BEFORE embedding, so nomic
 * embeds the CONCEPT residual instead of a shared generic token. Validated on
 * real data: leaving these in produced generic mega-buckets (a "search app"
 * cluster mixing app abc / app baby / app duo, because nomic over-weights the
 * shared "app"/"search" token). This is EMBED-INPUT ONLY — the original keyword
 * is still what gets clustered, stored, and used as the label.
 *
 * Broader than `CLUSTERING_JUNK_KEYWORDS` (which drops CANDIDATES): it also
 * strips real-but-generic app-suffix words ("tracker", "editor", "maker",
 * "widget", "simulator", ...) that carry no cross-app concept signal on their
 * own but shouldn't disqualify a keyword outright.
 */
export const GENERIC_MODIFIERS: ReadonlySet<string> = new Set([
  "app",
  "apps",
  "free",
  "pro",
  "premium",
  "best",
  "top",
  "new",
  "online",
  "mobile",
  "hd",
  "lite",
  "plus",
  "my",
  "the",
  "a",
  "an",
  "for",
  "and",
  "more",
  "all",
  "get",
  "official",
  "full",
  "popular",
  "download",
  "downloader",
  "maker",
  "editor",
  "tracker",
  "widget",
  "widgets",
  "game",
  "games",
  "simulator",
  "ios",
  "iphone",
  "ipad",
  "android",
  "updated",
  "update",
  "updating",
  "updates",
  "what",
  "whats",
  "application",
  "applications",
]);

/**
 * The concept residual of a keyword: lowercased, whitespace-split, with every
 * `GENERIC_MODIFIERS` token dropped, rejoined by single spaces. A keyword made
 * entirely of generic tokens ("free app", "the app", "updated", "ios", "what")
 * yields "" — the caller treats that as pure noise and drops it from
 * clustering. Pure — no I/O.
 */
export function stripToConceptResidual(keyword: string): string {
  return keyword
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => token.length > 0 && !GENERIC_MODIFIERS.has(token))
    .join(" ");
}

// ---------------------------------------------------------------------------
// Pure labeling (unit-tested)
// ---------------------------------------------------------------------------

/**
 * Pick a cluster's label: the member keyword with the highest `demand`, with
 * `buildability` as the tiebreaker, and first-seen order as the final
 * tiebreaker (stable). Pure — no I/O.
 */
export function pickClusterLabel(
  members: readonly string[],
  byKeyword: ReadonlyMap<string, RawCandidate>,
): string {
  let best: string | undefined;
  let bestDemand = Number.NEGATIVE_INFINITY;
  let bestBuild = Number.NEGATIVE_INFINITY;
  for (const member of members) {
    const meta = byKeyword.get(member);
    const demand = meta?.demand ?? 0;
    const build = meta?.buildability ?? 0;
    if (demand > bestDemand || (demand === bestDemand && build > bestBuild)) {
      best = member;
      bestDemand = demand;
      bestBuild = build;
    }
  }
  return best ?? members[0] ?? "";
}

// ---------------------------------------------------------------------------
// Orchestrator (dependency-injected — unit-testable with a fake embedder)
// ---------------------------------------------------------------------------

export interface KeywordClusteringDeps {
  /** Local (Ollama) OpenAI-compatible embedding provider. */
  readonly embedder: EmbeddingProvider;
  /** Loads clusterable candidate rows (highest-demand-first). */
  readonly loadCandidates: () => Promise<readonly RawCandidate[]>;
  /** Replaces the entire prior assignment set (delete-all-then-insert). */
  readonly persist: (rows: readonly ClusterAssignmentRow[], now: number) => Promise<void>;
  /** Cosine floor. Default {@link DEFAULT_CLUSTER_THRESHOLD}. */
  readonly threshold?: number;
  /** Max candidates embedded/clustered. Default {@link DEFAULT_MAX_CANDIDATES}. */
  readonly maxCandidates?: number;
  /** Optional embedding cache to front the provider. */
  readonly cache?: EmbeddingCache;
  /** Injectable clock (epoch seconds). Defaults to real time. */
  readonly now?: () => number;
}

/**
 * Embed `keywords` through `embedder`, consulting `cache` first when supplied.
 * Returns vectors aligned 1:1 with `keywords`, plus the cache-hit count.
 */
async function embedWithCache(
  embedder: EmbeddingProvider,
  keywords: readonly string[],
  cache: EmbeddingCache | undefined,
): Promise<{ vectors: (Float32Array | undefined)[]; cacheHits: number }> {
  const vectors: (Float32Array | undefined)[] = new Array(keywords.length);
  const missIndexes: number[] = [];
  const missKeywords: string[] = [];
  let cacheHits = 0;

  for (let i = 0; i < keywords.length; i++) {
    const key = keywords[i] as string;
    const cached = cache?.get(key) ?? null;
    if (cached) {
      vectors[i] = cached;
      cacheHits++;
    } else {
      missIndexes.push(i);
      missKeywords.push(key);
    }
  }

  if (missKeywords.length > 0) {
    const embedded = await embedder.embed(missKeywords);
    for (let j = 0; j < missIndexes.length; j++) {
      const idx = missIndexes[j] as number;
      const vec = embedded[j];
      vectors[idx] = vec;
      if (vec && cache) cache.set(keywords[idx] as string, vec);
    }
  }

  return { vectors, cacheHits };
}

/**
 * Run one clustering pass end to end: load candidates → prefilter junk → cap
 * highest-demand-first → strip each keyword to its concept RESIDUAL and drop
 * pure-generic residuals as noise → embed the RESIDUAL (cached) → L2-normalize
 * → greedy cosine cluster (keyed by the ORIGINAL keyword) → compute each
 * member's similarity to its cluster centroid → label each cluster by its
 * highest-demand ORIGINAL member → persist (replacing the prior run).
 *
 * The residual is EMBED-INPUT ONLY: cluster members, the stored assignments,
 * and the label are always the ORIGINAL keyword. Logs every drop/cap/count so
 * nothing is silently truncated. Throws (after logging) if the embedder or
 * persister fails — the caller (the batch script) exits non-zero.
 */
export async function runKeywordClustering(
  deps: KeywordClusteringDeps,
): Promise<ClusterRunResult> {
  const threshold = deps.threshold ?? DEFAULT_CLUSTER_THRESHOLD;
  const maxCandidates = deps.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
  const now = deps.now ? deps.now() : Math.floor(Date.now() / 1000);

  const emptyResult = (
    fetched: number,
    droppedAsJunk: number,
    droppedAsNoise: number,
    capped: number,
  ): ClusterRunResult => ({
    fetched,
    droppedAsJunk,
    droppedAsNoise,
    capped,
    embedded: 0,
    cacheHits: 0,
    clusterCount: 0,
    assignmentCount: 0,
  });

  try {
    const fetched = await deps.loadCandidates();
    log.info("Loaded cluster candidates", { fetched: fetched.length });

    const clusterable = fetched.filter((c) => isClusterableKeyword(c.keyword));
    const droppedAsJunk = fetched.length - clusterable.length;

    // Highest-demand-first so the strongest keyword seeds (and labels) each
    // cluster, and the cap keeps the most in-demand keywords.
    const ranked = [...clusterable].sort((a, b) => b.demand - a.demand);
    const candidates = ranked.slice(0, maxCandidates);
    const capped = ranked.length - candidates.length;

    // Strip each keyword to its concept residual for embedding; drop any whose
    // residual is pure generic/noise (empty), keeping the ORIGINAL keyword for
    // every survivor.
    const kept = candidates
      .map((candidate) => ({ candidate, residual: stripToConceptResidual(candidate.keyword) }))
      .filter((k) => k.residual.length >= 2);
    const droppedAsNoise = candidates.length - kept.length;

    log.info("Prefiltered cluster candidates", {
      clusterable: clusterable.length,
      droppedAsJunk,
      droppedAsNoise,
      capped,
      willCluster: kept.length,
      threshold,
    });

    if (kept.length === 0) {
      log.warn("No clusterable candidates — persisting empty assignment set");
      await deps.persist([], now);
      return emptyResult(fetched.length, droppedAsJunk, droppedAsNoise, capped);
    }

    const byKeyword = new Map<string, RawCandidate>(kept.map((k) => [k.candidate.keyword, k.candidate]));
    const keywords = kept.map((k) => k.candidate.keyword);
    const residuals = kept.map((k) => k.residual);

    // Embed the concept RESIDUAL, but key every vector back to its ORIGINAL
    // keyword — that original is what gets clustered, stored, and labeled.
    const { vectors, cacheHits } = await embedWithCache(deps.embedder, residuals, deps.cache);

    const items: ClusterItem[] = [];
    const unitByKeyword = new Map<string, Float32Array>();
    for (let i = 0; i < keywords.length; i++) {
      const vec = vectors[i];
      if (!vec) continue;
      const unit = l2Normalize(vec);
      const key = keywords[i] as string;
      items.push({ key, vec: unit });
      unitByKeyword.set(key, unit);
    }

    if (items.length < keywords.length) {
      log.warn("Some candidates were not embedded", {
        requested: keywords.length,
        embedded: items.length,
      });
    }

    const clusters = clusterByCosine(items, threshold);

    const assignments: ClusterAssignmentRow[] = [];
    for (const cluster of clusters) {
      const memberUnits = cluster.members
        .map((m) => unitByKeyword.get(m))
        .filter((v): v is Float32Array => v !== undefined);
      const centroid = centroidOf(memberUnits);
      const label = pickClusterLabel(cluster.members, byKeyword);
      for (const member of cluster.members) {
        const unit = unitByKeyword.get(member);
        const similarity = unit ? dot(unit, centroid) : 0;
        assignments.push({
          keyword: member,
          clusterId: cluster.clusterId,
          clusterLabel: label,
          // Clamp to [0,1] — floating-point can nudge a self-similarity to 1.0000001.
          similarity: Math.max(0, Math.min(1, similarity)),
        });
      }
    }

    await deps.persist(assignments, now);

    log.info("Clustering complete", {
      clusters: clusters.length,
      assignments: assignments.length,
      embedded: items.length,
      cacheHits,
    });

    return {
      fetched: fetched.length,
      droppedAsJunk,
      droppedAsNoise,
      capped,
      embedded: items.length,
      cacheHits,
      clusterCount: clusters.length,
      assignmentCount: assignments.length,
    };
  } catch (error) {
    log.error("Keyword clustering failed", { error: getErrorMessage(error) });
    throw new Error(`Keyword clustering failed: ${getErrorMessage(error)}`);
  }
}
