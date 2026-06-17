/**
 * SIGE selection primitives — the PURE, deterministic core of the hardened
 * convergent judge. These functions are dependency-free (no DB, clock, rng, or
 * LLM) so they are fully unit-testable and so the pipeline phase can compose
 * them around the (impure) jury/evaluation calls.
 *
 * Why these exist (the failure modes they harden against):
 *
 *   • paretoFrontier — scalar "blend originality and quality" lets a
 *     generic-but-polished idea win on quality alone. A Pareto frontier over
 *     (originality × quality) rewards ideas that are ORIGINAL **and** high
 *     quality: nothing on the frontier is beaten on both axes at once.
 *
 *   • bradleyTerryRank — a stable top-K from sparse, asymmetric pairwise
 *     judgements (jury A>B votes), tolerant of missing comparisons. Used to
 *     break frontier ties and stabilise ordering against position bias.
 *
 *   • convergenceVeto — computeMetaGameHealth MEASURES convergence but nothing
 *     GATES on it. When a round converged prematurely (high convergenceRate or
 *     collapsed diversityIndex) we are at sycophancy-collapse risk: the consensus
 *     is agreement, not insight. The veto lets the pipeline fall back / widen
 *     instead of trusting a converged consensus.
 *
 *   • dissentAdjustedScore — SIGE has a Red Team + Contrarian VC, but
 *     mean-pooling averages their dissent away. This folds dissent in as a
 *     first-class term (a parameterised penalty), so principled disagreement is
 *     never silently washed out.
 *
 * All scores are treated as "higher is better". Inputs are defensively clamped.
 */

/** Minimal shape this module needs from MetaGameHealth (decoupled from SIGE). */
export interface ConvergenceSignal {
  /** 0..1 — how much candidate scores narrowed across rounds. */
  readonly convergenceRate: number;
  /** 0..1 — unique-title ratio; low ⇒ the field collapsed onto few ideas. */
  readonly diversityIndex: number;
}

/** Result of the convergence veto check. */
export interface ConvergenceVetoResult {
  /** True ⇒ the round converged prematurely; do not trust the consensus. */
  readonly vetoed: boolean;
  /** Machine-readable reasons (for logging / pipeline branching). */
  readonly reasons: readonly string[];
  readonly convergenceRate: number;
  readonly diversityIndex: number;
}

/** Thresholds for {@link convergenceVeto}. All optional with safe defaults. */
export interface ConvergenceVetoThreshold {
  /** Veto when convergenceRate >= this (default 0.85). */
  readonly maxConvergenceRate?: number;
  /** Veto when diversityIndex <= this (default 0.2). */
  readonly minDiversityIndex?: number;
}

const DEFAULT_MAX_CONVERGENCE_RATE = 0.85;
const DEFAULT_MIN_DIVERSITY_INDEX = 0.2;

/**
 * Clamp into [lo, hi]. NaN → lo (safe default). +Infinity saturates to hi,
 * -Infinity to lo — so an out-of-range sentinel is pinned to the nearest bound
 * rather than silently zeroed.
 */
function clamp(value: number, lo: number, hi: number): number {
  if (Number.isNaN(value)) return lo;
  if (value < lo) return lo;
  if (value > hi) return hi;
  return value;
}

// ─── Convergence veto ──────────────────────────────────────────────────────────

/**
 * Decide whether a round CONVERGED prematurely (sycophancy-collapse risk).
 *
 * The consensus of a converged round is agreement, not signal: the agents
 * stopped disagreeing too early, so the top idea reflects conformity. When that
 * happens we veto so the caller can fall back to the prior scalar scores or
 * widen the search instead of trusting the converged top-K.
 *
 * Pure: no I/O. Defensive against non-finite inputs.
 */
export function convergenceVeto(
  health: ConvergenceSignal,
  threshold: ConvergenceVetoThreshold = {},
): ConvergenceVetoResult {
  const maxConvergenceRate =
    threshold.maxConvergenceRate ?? DEFAULT_MAX_CONVERGENCE_RATE;
  const minDiversityIndex =
    threshold.minDiversityIndex ?? DEFAULT_MIN_DIVERSITY_INDEX;

  const convergenceRate = clamp(health.convergenceRate, 0, 1);
  const diversityIndex = clamp(health.diversityIndex, 0, 1);

  const reasons: string[] = [];
  if (convergenceRate >= maxConvergenceRate) {
    reasons.push(
      `convergenceRate ${convergenceRate.toFixed(3)} >= ${maxConvergenceRate}`,
    );
  }
  if (diversityIndex <= minDiversityIndex) {
    reasons.push(
      `diversityIndex ${diversityIndex.toFixed(3)} <= ${minDiversityIndex}`,
    );
  }

  return {
    vetoed: reasons.length > 0,
    reasons,
    convergenceRate,
    diversityIndex,
  };
}

// ─── Dissent-adjusted score ─────────────────────────────────────────────────────

/**
 * Fold a first-class dissent term into a base score.
 *
 * `dissent` (0..1) is how strongly the Red Team / Contrarian VC pushed back. We
 * never mean-pool it away: high dissent shaves the score by up to `weight`
 * (multiplicatively, so a strong-but-controversial idea is dampened rather than
 * eliminated). With weight 0 this is a no-op; with weight 1 a fully-dissented
 * idea collapses to 0.
 *
 *   adjusted = base * (1 - weight * dissent)
 *
 * Monotonic: for fixed base/weight, more dissent ⇒ lower (or equal) score.
 * Pure. Defensive against non-finite inputs.
 */
export function dissentAdjustedScore(
  base: number,
  dissent: number,
  weight = 0.3,
): number {
  const b = clamp(base, 0, Number.POSITIVE_INFINITY);
  const d = clamp(dissent, 0, 1);
  const w = clamp(weight, 0, 1);
  return b * (1 - w * d);
}

// ─── Pareto frontier selection ──────────────────────────────────────────────────

/** A scored point on the (originality × quality) plane. */
export interface ParetoPoint<T> {
  readonly item: T;
  readonly originality: number;
  readonly quality: number;
}

export interface ParetoResult<T> {
  /** The non-dominated set, ranked (best-first). */
  readonly frontier: readonly ParetoPoint<T>[];
  /** All points, ranked: frontier first (by rank walk), then dominated ones. */
  readonly ranked: readonly ParetoPoint<T>[];
}

/**
 * Does `a` dominate `b`? `a` dominates `b` iff it is >= on both axes and
 * strictly > on at least one. (Maximisation on both originality and quality.)
 */
function dominates<T>(a: ParetoPoint<T>, b: ParetoPoint<T>): boolean {
  const ge = a.originality >= b.originality && a.quality >= b.quality;
  const gt = a.originality > b.originality || a.quality > b.quality;
  return ge && gt;
}

/**
 * Compute the Pareto frontier over (originality × quality) and a ranked walk of
 * the whole set. Selection rewards ideas that are ORIGINAL **and** high quality
 * — a generic-but-polished idea (high quality, low originality) can be dominated
 * off the frontier by anything that matches its quality with more originality.
 *
 * Ranking within the frontier walks from the "high-both" corner: we sort by the
 * minimum of the two normalised axes (the weakest axis — favouring balance),
 * then by their sum as a tie-break. Dominated points are appended afterwards by
 * the same key, so callers can take a stable top-K that degrades gracefully when
 * the frontier is smaller than K.
 *
 * Pure: no I/O. Defensive against non-finite axis values (treated as 0).
 */
export function paretoFrontier<T>(
  items: readonly T[],
  originalityOf: (item: T) => number,
  qualityOf: (item: T) => number,
): ParetoResult<T> {
  const points: ParetoPoint<T>[] = items.map((item) => ({
    item,
    originality: clamp(originalityOf(item), 0, Number.POSITIVE_INFINITY),
    quality: clamp(qualityOf(item), 0, Number.POSITIVE_INFINITY),
  }));

  if (points.length === 0) {
    return { frontier: [], ranked: [] };
  }

  const frontier = points.filter(
    (p) => !points.some((other) => other !== p && dominates(other, p)),
  );
  const dominated = points.filter((p) => frontier.indexOf(p) === -1);

  // Normalisation bounds (per-axis max over the whole set) for the balance key.
  const maxOrig = Math.max(...points.map((p) => p.originality), 0);
  const maxQual = Math.max(...points.map((p) => p.quality), 0);
  const norm = (p: ParetoPoint<T>): { min: number; sum: number } => {
    const o = maxOrig > 0 ? p.originality / maxOrig : 0;
    const q = maxQual > 0 ? p.quality / maxQual : 0;
    return { min: Math.min(o, q), sum: o + q };
  };

  const byBalance = (a: ParetoPoint<T>, b: ParetoPoint<T>): number => {
    const na = norm(a);
    const nb = norm(b);
    if (nb.min !== na.min) return nb.min - na.min; // favour high-on-weakest-axis
    return nb.sum - na.sum; // then high-on-both
  };

  const rankedFrontier = [...frontier].sort(byBalance);
  const rankedDominated = [...dominated].sort(byBalance);

  return {
    frontier: rankedFrontier,
    ranked: [...rankedFrontier, ...rankedDominated],
  };
}

// ─── Bradley–Terry pairwise ranking ─────────────────────────────────────────────

/** A pairwise outcome: `winner` beat `loser` (one comparison). */
export interface PairwiseWin {
  readonly winner: string;
  readonly loser: string;
}

export interface BradleyTerryResult {
  /** itemId → strength score (higher is better). Sums are not normalised. */
  readonly strengths: ReadonlyMap<string, number>;
  /** Item ids ranked best-first (strength desc, then id asc for stability). */
  readonly ranking: readonly string[];
}

/**
 * Bradley–Terry strength estimation from pairwise wins via the standard MM /
 * minorisation–maximisation update, tolerant of sparse and asymmetric data.
 *
 *   p_i  ←  w_i / Σ_j ( n_ij / (p_i + p_j) )
 *
 * where w_i is i's total wins and n_ij the number of i-vs-j comparisons. We add
 * a tiny smoothing prior so items that never appear, or that won/lost every
 * game, still receive a finite, ordered strength (avoids div-by-zero and the
 * classic "undefeated player → infinite strength" blow-up).
 *
 * Pure & deterministic: fixed iteration count, no rng. Returns equal strengths
 * when there is no comparison data.
 */
export function bradleyTerryRank(
  pairwiseWins: readonly PairwiseWin[],
  options: { readonly iterations?: number; readonly smoothing?: number } = {},
): BradleyTerryResult {
  const iterations = options.iterations ?? 50;
  const smoothing = options.smoothing ?? 0.5;

  const items = new Set<string>();
  for (const { winner, loser } of pairwiseWins) {
    items.add(winner);
    items.add(loser);
  }
  const ids = [...items].sort();

  if (ids.length === 0) {
    return { strengths: new Map(), ranking: [] };
  }
  if (ids.length === 1) {
    return { strengths: new Map([[ids[0]!, 1]]), ranking: [ids[0]!] };
  }

  // wins[i] = total wins; games[i][j] = comparisons between i and j.
  const index = new Map(ids.map((id, i) => [id, i] as const));
  const n = ids.length;
  const wins = new Array<number>(n).fill(smoothing);
  const games: number[][] = ids.map(() => new Array<number>(n).fill(0));

  for (const { winner, loser } of pairwiseWins) {
    const wi = index.get(winner)!;
    const li = index.get(loser)!;
    if (wi === li) continue; // ignore self-comparisons
    wins[wi]! += 1;
    games[wi]![li]! += 1;
    games[li]![wi]! += 1;
  }

  // Symmetric smoothing prior: pretend everyone played a half-game vs everyone.
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i !== j) games[i]![j]! += smoothing / (n - 1);
    }
  }

  let strength = new Array<number>(n).fill(1);
  for (let iter = 0; iter < iterations; iter++) {
    const next = new Array<number>(n).fill(0);
    for (let i = 0; i < n; i++) {
      let denom = 0;
      for (let j = 0; j < n; j++) {
        if (i === j) continue;
        const nij = games[i]![j]!;
        if (nij <= 0) continue;
        denom += nij / (strength[i]! + strength[j]!);
      }
      next[i] = denom > 0 ? wins[i]! / denom : strength[i]!;
    }
    // Normalise to keep the geometric scale stable (avoids drift / overflow).
    const sum = next.reduce((s, v) => s + v, 0);
    strength = sum > 0 ? next.map((v) => (v / sum) * n) : next;
  }

  const strengths = new Map<string, number>(
    ids.map((id, i) => [id, strength[i]!]),
  );

  const ranking = [...ids].sort((a, b) => {
    const diff = strengths.get(b)! - strengths.get(a)!;
    if (Math.abs(diff) > 1e-9) return diff;
    return a < b ? -1 : a > b ? 1 : 0; // stable tie-break
  });

  return { strengths, ranking };
}
