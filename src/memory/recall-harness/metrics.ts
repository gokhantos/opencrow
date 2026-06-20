/**
 * Pure recall-comparison metrics for the offline mem0-vs-Qdrant harness.
 *
 * Every function here is side-effect-free and operates on already-resolved
 * "ranked id lists" (the cross-backend join key per result, in rank order) plus
 * raw score arrays. Keeping them pure makes them the unit-testable core of the
 * harness — the runner only orchestrates I/O around these.
 *
 * Terminology:
 *  - `reference` is the Qdrant top-k (the incumbent we measure parity against).
 *  - `candidate` is the mem0 top-k.
 *  - An "id" is the harness's cross-backend match key for a result (see
 *    `runner.ts`: the corpus item id when resolvable, else a content hash).
 */

/** Summary statistics for a backend's score distribution over one query. */
export interface ScoreStats {
  readonly count: number;
  readonly min: number;
  readonly mean: number;
  readonly median: number;
  readonly max: number;
}

/** Per-query comparison between the reference (Qdrant) and candidate (mem0). */
export interface QueryMetrics {
  readonly query: string;
  /** |topK_ref ∩ topK_cand| / k (k = the configured cutoff, not list length). */
  readonly overlapAtK: number;
  /** |∩| / |topK_ref| — recall treating Qdrant as ground truth. */
  readonly recallAtK: number;
  /**
   * Mean absolute rank delta over the intersection (0 = identical ranks).
   * `null` when the intersection is empty (undefined, not 0 — no displacement
   * can be measured).
   */
  readonly meanRankDisplacement: number | null;
  /**
   * Spearman rank correlation over the intersection in [-1, 1]. `null` when the
   * intersection has fewer than two shared ids (ρ is undefined for n < 2).
   */
  readonly spearman: number | null;
  /** Ids present in the reference top-k but absent from the candidate top-k. */
  readonly referenceOnly: readonly string[];
  /** Ids present in the candidate top-k but absent from the reference top-k. */
  readonly candidateOnly: readonly string[];
  readonly referenceScores: ScoreStats;
  readonly candidateScores: ScoreStats;
  readonly referenceCount: number;
  readonly candidateCount: number;
}

/** Aggregate (mean + median) of the per-query metrics across the query set. */
export interface AggregateMetrics {
  readonly queryCount: number;
  readonly meanOverlapAtK: number;
  readonly medianOverlapAtK: number;
  readonly meanRecallAtK: number;
  readonly medianRecallAtK: number;
  /** Mean of the per-query meanRankDisplacement values that are defined. */
  readonly meanRankDisplacement: number | null;
  /** Mean of the per-query Spearman values that are defined. */
  readonly meanSpearman: number | null;
  /** Total reference-only / candidate-only hits summed across all queries. */
  readonly totalReferenceOnly: number;
  readonly totalCandidateOnly: number;
}

/** Compute min/mean/median/max for a list of scores (empty → all zero). */
export function scoreStats(scores: readonly number[]): ScoreStats {
  if (scores.length === 0) {
    return { count: 0, min: 0, mean: 0, median: 0, max: 0 };
  }
  const sorted = [...scores].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  return {
    count: sorted.length,
    min: sorted[0] ?? 0,
    mean: sum / sorted.length,
    median: medianOf(sorted),
    max: sorted[sorted.length - 1] ?? 0,
  };
}

/**
 * overlap@k = |ref ∩ cand| / k, where both lists are TRUNCATED to k first.
 * `k` is the configured cutoff (a fixed denominator), so a backend returning
 * fewer than k results is penalised — that is the intent for parity scoring.
 * Ids are de-duplicated within each list before intersecting.
 */
export function overlapAtK(
  reference: readonly string[],
  candidate: readonly string[],
  k: number,
): number {
  if (k <= 0) return 0;
  const refSet = new Set(reference.slice(0, k));
  const candSet = new Set(candidate.slice(0, k));
  let shared = 0;
  for (const id of refSet) {
    if (candSet.has(id)) shared += 1;
  }
  return shared / k;
}

/**
 * recall@k treating the reference as ground truth = |ref ∩ cand| / |ref|, with
 * both lists truncated to k. Returns 0 when the reference top-k is empty (no
 * ground truth to recall).
 */
export function recallAtK(
  reference: readonly string[],
  candidate: readonly string[],
  k: number,
): number {
  const refIds = [...new Set(reference.slice(0, k))];
  if (refIds.length === 0) return 0;
  const candSet = new Set(candidate.slice(0, k));
  let shared = 0;
  for (const id of refIds) {
    if (candSet.has(id)) shared += 1;
  }
  return shared / refIds.length;
}

/** First-occurrence rank (0-based) of each id in a list. */
function rankMap(ids: readonly string[]): Map<string, number> {
  const m = new Map<string, number>();
  ids.forEach((id, i) => {
    if (!m.has(id)) m.set(id, i);
  });
  return m;
}

/** Ids in both lists (after truncation to k), in reference order. */
function intersectionInRefOrder(
  reference: readonly string[],
  candidate: readonly string[],
  k: number,
): readonly string[] {
  const candSet = new Set(candidate.slice(0, k));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of reference.slice(0, k)) {
    if (candSet.has(id) && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/**
 * Mean absolute rank displacement over the intersection: average of
 * |rank_ref(id) - rank_cand(id)| for every id in both top-k lists. `null` when
 * the intersection is empty (no displacement is defined).
 */
export function meanRankDisplacement(
  reference: readonly string[],
  candidate: readonly string[],
  k: number,
): number | null {
  const shared = intersectionInRefOrder(reference, candidate, k);
  if (shared.length === 0) return null;
  const refRank = rankMap(reference.slice(0, k));
  const candRank = rankMap(candidate.slice(0, k));
  let total = 0;
  for (const id of shared) {
    total += Math.abs((refRank.get(id) ?? 0) - (candRank.get(id) ?? 0));
  }
  return total / shared.length;
}

/**
 * Spearman rank correlation ρ over the intersection of the two top-k lists.
 * Ranks are recomputed WITHIN the shared set (dense, 0-based) so the coefficient
 * measures relative ordering agreement among the commonly-retrieved ids.
 *
 * Returns `null` for n < 2 (ρ undefined). For n ≥ 2 with zero rank variance
 * (cannot occur for distinct dense ranks, but guarded) returns 1.
 */
export function spearman(
  reference: readonly string[],
  candidate: readonly string[],
  k: number,
): number | null {
  const shared = intersectionInRefOrder(reference, candidate, k);
  const n = shared.length;
  if (n < 2) return null;

  const refRank = rankMap(reference.slice(0, k));
  const candRank = rankMap(candidate.slice(0, k));

  // Dense ranks within the shared set, ordered by each backend's absolute rank.
  const byRef = [...shared].sort(
    (a, b) => (refRank.get(a) ?? 0) - (refRank.get(b) ?? 0),
  );
  const byCand = [...shared].sort(
    (a, b) => (candRank.get(a) ?? 0) - (candRank.get(b) ?? 0),
  );
  const denseRef = new Map<string, number>();
  byRef.forEach((id, i) => denseRef.set(id, i));
  const denseCand = new Map<string, number>();
  byCand.forEach((id, i) => denseCand.set(id, i));

  let dSquared = 0;
  for (const id of shared) {
    const d = (denseRef.get(id) ?? 0) - (denseCand.get(id) ?? 0);
    dSquared += d * d;
  }
  // Standard Spearman with distinct ranks: ρ = 1 - 6·Σd² / (n·(n²-1)).
  return 1 - (6 * dSquared) / (n * (n * n - 1));
}

/** Ids in `a` (truncated to k) not present in `b` (truncated to k), a-order. */
export function setDifference(
  a: readonly string[],
  b: readonly string[],
  k: number,
): readonly string[] {
  const bSet = new Set(b.slice(0, k));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of a.slice(0, k)) {
    if (!bSet.has(id) && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/** Compute the full per-query metric row. */
export function computeQueryMetrics(args: {
  readonly query: string;
  readonly referenceIds: readonly string[];
  readonly candidateIds: readonly string[];
  readonly referenceScores: readonly number[];
  readonly candidateScores: readonly number[];
  readonly k: number;
}): QueryMetrics {
  const { query, referenceIds, candidateIds, k } = args;
  return {
    query,
    overlapAtK: overlapAtK(referenceIds, candidateIds, k),
    recallAtK: recallAtK(referenceIds, candidateIds, k),
    meanRankDisplacement: meanRankDisplacement(referenceIds, candidateIds, k),
    spearman: spearman(referenceIds, candidateIds, k),
    referenceOnly: setDifference(referenceIds, candidateIds, k),
    candidateOnly: setDifference(candidateIds, referenceIds, k),
    referenceScores: scoreStats(args.referenceScores.slice(0, k)),
    candidateScores: scoreStats(args.candidateScores.slice(0, k)),
    referenceCount: Math.min(referenceIds.length, k),
    candidateCount: Math.min(candidateIds.length, k),
  };
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, v) => a + v, 0) / values.length;
}

/** Median of an ALREADY-SORTED ascending array (empty → 0). */
function medianOf(sorted: readonly number[]): number {
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
  }
  return sorted[mid] ?? 0;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return medianOf([...values].sort((a, b) => a - b));
}

/** Mean over only the defined (non-null) values; `null` when none are defined. */
function meanDefined(values: readonly (number | null)[]): number | null {
  const defined = values.filter((v): v is number => v !== null);
  return defined.length === 0 ? null : mean(defined);
}

/** Aggregate per-query rows into the headline summary. */
export function aggregateMetrics(
  rows: readonly QueryMetrics[],
): AggregateMetrics {
  const overlaps = rows.map((r) => r.overlapAtK);
  const recalls = rows.map((r) => r.recallAtK);
  return {
    queryCount: rows.length,
    meanOverlapAtK: mean(overlaps),
    medianOverlapAtK: median(overlaps),
    meanRecallAtK: mean(recalls),
    medianRecallAtK: median(recalls),
    meanRankDisplacement: meanDefined(rows.map((r) => r.meanRankDisplacement)),
    meanSpearman: meanDefined(rows.map((r) => r.spearman)),
    totalReferenceOnly: rows.reduce((a, r) => a + r.referenceOnly.length, 0),
    totalCandidateOnly: rows.reduce((a, r) => a + r.candidateOnly.length, 0),
  };
}
