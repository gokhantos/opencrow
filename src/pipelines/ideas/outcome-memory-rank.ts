/**
 * outcome-memory-rank.ts — pure ranking helpers for the outcome-memory recall path.
 *
 * Extracted from outcome-memory.ts so the read-side hygiene (relevance/recency
 * weighting, prompt-version staleness penalty, MMR diversity, dedup-then-cap on
 * the RANKED list, and recall-query construction) lives in one small, fully
 * testable module with NO I/O and NO clock — every caller passes `now` (epoch
 * seconds) explicitly.
 *
 * Design contract: at no-op defaults (halfLifeDays<=0, stalePromptPenalty=1,
 * mmrLambda>=1) the composite collapses to the raw relevance and MMR is a
 * passthrough, so a ranked-then-capped list degrades to the same ordering the
 * old first-N dedupAndCap produced when the upstream order is already by
 * relevance. New behavior only activates at non-default knobs.
 */

import { applyTemporalDecay } from "../../memory/temporal-decay";

/** Minimal item shape the ranker needs — a subset of RetrievedOutcome. */
export interface RankableOutcome {
  /** Untrusted body text used for MMR token overlap + dedup fallback key. */
  readonly memory: string;
  /** Raw mem0 relevance score for this hit (already captured on read). */
  readonly relevance: number;
  readonly metadata: {
    readonly ideaId: string | null;
    readonly createdAtSec: number;
    readonly promptVersion: string;
    readonly model: string;
  };
}

/** Knobs for {@link rankOutcomes}. */
export interface RankOptions {
  /** Epoch seconds; passed by the caller (this module has no clock). */
  readonly now: number;
  /** Recency half-life in days. <=0 → temporal decay is identity. */
  readonly halfLifeDays: number;
  /** Multiplier (0..1) applied when promptVersion/model differ from current. */
  readonly stalePromptPenalty: number;
  /** Current synthesis prompt version; a memory not matching is "stale". */
  readonly currentPromptVersion: string;
  /** Current model id; a memory not matching is "stale". */
  readonly currentModel: string;
}

/** A ranked item: the original item plus its composite score (for diagnostics). */
export interface RankedOutcome<T extends RankableOutcome> {
  readonly item: T;
  readonly composite: number;
}

/**
 * Rank items by a composite of decayed relevance × staleness factor.
 *
 * composite = applyTemporalDecay(relevance, createdAtSec, now, halfLifeDays)
 *             × (promptVersion===current && model===current ? 1 : stalePromptPenalty)
 *
 * Sort is descending by composite and STABLE (ties keep input order). When
 * halfLifeDays<=0 the decay is identity, so composite is relevance×stalenessFactor.
 */
export function rankOutcomes<T extends RankableOutcome>(
  items: readonly T[],
  opts: RankOptions,
): readonly RankedOutcome<T>[] {
  const scored = items.map((item, index) => {
    const decayed = applyTemporalDecay(
      item.relevance,
      item.metadata.createdAtSec,
      opts.now,
      opts.halfLifeDays,
    );
    const fresh =
      item.metadata.promptVersion === opts.currentPromptVersion &&
      item.metadata.model === opts.currentModel;
    const composite = decayed * (fresh ? 1 : opts.stalePromptPenalty);
    return { item, composite, index };
  });
  // Stable descending sort: break composite ties by original index.
  return [...scored]
    .sort((a, b) => b.composite - a.composite || a.index - b.index)
    .map(({ item, composite }) => ({ item, composite }));
}

/**
 * Dedup an ALREADY-RANKED list by ideaId (fallback to memory text), then cap.
 * Replaces the old first-N dedupAndCap semantics but operating post-rank.
 */
export function dedupRankedAndCap<T extends RankableOutcome>(
  rankedItems: readonly RankedOutcome<T>[],
  cap: number,
): readonly T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const { item } of rankedItems) {
    if (out.length >= cap) break;
    const key = item.metadata.ideaId ?? item.memory;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function tokenize(text: string): ReadonlySet<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/\W+/)
      .filter((w) => w.length > 2),
  );
}

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const word of a) {
    if (b.has(word)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Local Jaccard MMR over the item's memory text. Mirrors src/memory/mmr.ts but
 * operates on the already-relevance-ranked list (so index 0 is the top hit) and
 * uses each item's composite-ranked relevance via list position.
 *
 * lambda>=1 (pure relevance) or a single item → passthrough (truncated to cap).
 */
export function mmrSelectOutcomes<T extends RankableOutcome>(
  ranked: readonly T[],
  lambda: number,
  cap: number,
): readonly T[] {
  if (cap <= 0) return [];
  if (lambda >= 1 || ranked.length <= 1) return ranked.slice(0, cap);

  const tokenSets = ranked.map((r) => tokenize(r.memory));
  // Relevance proxy = list position (already ranked desc): linear 1..0 ramp so
  // MMR balances rank order against diversity without re-passing the composite.
  const relevance = ranked.map((_, i) => (ranked.length <= 1 ? 1 : 1 - i / (ranked.length - 1)));

  const selected: number[] = [0];
  const remaining = new Set(ranked.map((_, i) => i));
  remaining.delete(0);

  while (selected.length < cap && remaining.size > 0) {
    let bestIdx = -1;
    let bestMmr = Number.NEGATIVE_INFINITY;
    for (const idx of remaining) {
      let maxSim = 0;
      for (const selIdx of selected) {
        const sim = jaccard(tokenSets[idx]!, tokenSets[selIdx]!);
        if (sim > maxSim) maxSim = sim;
      }
      const mmr = lambda * relevance[idx]! - (1 - lambda) * maxSim;
      if (mmr > bestMmr) {
        bestMmr = mmr;
        bestIdx = idx;
      }
    }
    if (bestIdx < 0) break;
    selected.push(bestIdx);
    remaining.delete(bestIdx);
  }

  return selected.map((i) => ranked[i]!);
}

/**
 * Ranking knobs for the relevance/recency-aware recall path. Mirrors
 * {@link RankOptions} plus the MMR lambda. Absent at the call site → legacy
 * first-N selection.
 */
export interface BlockRankOptions extends RankOptions {
  /** MMR diversity lambda (1 → passthrough, no diversification). */
  readonly mmrLambda: number;
}

/**
 * Relevance/recency-aware sublist selection: rank → dedup (post-rank) → MMR →
 * cap. Applied INDEPENDENTLY to each verdict sublist (REINFORCE / AVOID).
 */
export function selectRankedOutcomes<T extends RankableOutcome>(
  items: readonly T[],
  cap: number,
  opts: BlockRankOptions,
): readonly T[] {
  const ranked = rankOutcomes(items, opts);
  const deduped = dedupRankedAndCap(ranked, cap);
  return mmrSelectOutcomes(deduped, opts.mmrLambda, cap);
}

/** Structured inputs for {@link buildRecallQuery}. */
export interface RecallQueryInputs {
  /** Pain-cluster themes (most specific signal — leads). */
  readonly painThemes?: readonly string[];
  readonly trendingCategories?: readonly string[];
  /** Under-explored seed segments to bias recall toward. */
  readonly targetSegments?: readonly string[];
  /** The pipeline's configured category (broadest — trails). */
  readonly category?: string | null;
}

/**
 * Compact phrase blend for the mem0 recall query. Segment/theme terms FIRST
 * (most specific), category LAST (broadest). De-duped, empties dropped, joined
 * with ", ". Pure string — no I/O.
 */
export function buildRecallQuery(inputs: RecallQueryInputs): string {
  const ordered: string[] = [
    ...(inputs.targetSegments ?? []),
    ...(inputs.painThemes ?? []),
    ...(inputs.trendingCategories ?? []),
    ...(inputs.category ? [inputs.category] : []),
  ];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of ordered) {
    const term = raw.trim();
    if (term === "") continue;
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(term);
  }
  return out.join(", ");
}
