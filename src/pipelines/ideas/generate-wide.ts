/**
 * Phase 1 "generate-wide" — PURE helpers that widen + diversify the synthesizer
 * candidate pool before selection.
 *
 * The synthesizer historically generated exactly ONE idea per trend intersection
 * (single-category), so downstream could only SELECT from a starved, homogeneous
 * pool. These helpers support:
 *
 *  1. VERBALIZED SAMPLING — parse a model-emitted {idea, probability} distribution
 *     into normalized seeds, tagging each with its self-reported probability used
 *     ONLY as a diversity/coverage prior (never as the quality score).
 *  2. SEGMENT SPREAD — turn a {@link segmentQuota} into a per-segment instruction
 *     so generation SPANS opportunity spaces instead of collapsing to consumer.
 *  3. NOVELTY-RESERVE SELECTION — when slicing to the final set, reserve slots for
 *     high-surprise / high-originality candidates so the pool is not collapsed to
 *     the highest-self-reported-signal lookalikes.
 *
 * Everything here is PURE and dependency-free (no DB, clock, rng, LLM) so it is
 * deterministic and fully unit-testable. The synthesizer wires these into its
 * optional, flag-gated paths.
 */

import type { GeneratedIdeaCandidate } from "./types";
import {
  SEGMENT_BY_ID,
  segmentQuota,
  type SegmentId,
  type SegmentQuota,
} from "./segments";

// ── Verbalized probability parsing ─────────────────────────────────────────

/**
 * Coerce a model-emitted "probability" value into a clamped [0,1] number.
 *
 * Tolerant of the shapes models actually emit: a real number, a numeric string
 * ("0.3"), a percent string ("30%"), or a bare percent-like integer in (1,100]
 * which is treated as a percentage (e.g. 30 -> 0.30). Non-finite / missing /
 * garbage falls back to {@link fallback} (default 0). PURE.
 */
export function parseVerbalizedProb(raw: unknown, fallback = 0): number {
  const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) return fallback;
    // A value in (1, 100] is almost certainly a percentage point.
    return raw > 1 && raw <= 100 ? clamp01(raw / 100) : clamp01(raw);
  }

  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.length === 0) return fallback;
    const isPercent = trimmed.endsWith("%");
    const num = Number.parseFloat(trimmed.replace(/%$/, "").trim());
    if (!Number.isFinite(num)) return fallback;
    if (isPercent) return clamp01(num / 100);
    return num > 1 && num <= 100 ? clamp01(num / 100) : clamp01(num);
  }

  return fallback;
}

/** One parsed verbalized-sampling seed: a candidate idea + its self-reported prob. */
export interface VerbalizedSeed {
  /** The raw idea object the model emitted (shape validated downstream). */
  readonly idea: Record<string, unknown>;
  /** Self-reported probability in [0,1] (diversity prior ONLY, not quality). */
  readonly probability: number;
}

/**
 * Parse a Verbalized-Sampling response into normalized seeds.
 *
 * Accepts the distribution shapes models emit for "return N {idea, probability}
 * pairs": an array of `{ idea, probability }`, an array of `{ candidate, prob }`,
 * or a bare array of idea objects (probability defaults to 0). Entries that are
 * not objects, or whose idea payload is not an object, are skipped. PURE +
 * total: never throws.
 *
 * @param raw   already-parsed JSON (caller owns JSON.parse + its fallback)
 * @param limit optional cap on returned seeds (applied after parsing, in order)
 */
export function parseVerbalizedSeeds(
  raw: unknown,
  limit?: number,
): readonly VerbalizedSeed[] {
  if (!Array.isArray(raw)) return [];

  const seeds: VerbalizedSeed[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;

    // Prefer an explicit nested idea/candidate payload; otherwise treat the
    // whole row as the idea (a bare idea object with no probability wrapper).
    const nested =
      isPlainObject(row.idea)
        ? (row.idea as Record<string, unknown>)
        : isPlainObject(row.candidate)
          ? (row.candidate as Record<string, unknown>)
          : null;

    const idea = nested ?? row;
    // A bare idea row must look like an idea (have a title), else it is noise.
    if (nested === null && typeof row.title !== "string") continue;

    const probability = parseVerbalizedProb(
      row.probability ?? row.prob ?? row.p,
      0,
    );

    seeds.push({ idea, probability });
  }

  if (typeof limit === "number" && limit >= 0) {
    return seeds.slice(0, Math.floor(limit));
  }
  return seeds;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// ── Segment-spread planning ────────────────────────────────────────────────

/** A per-segment generation directive derived from a {@link segmentQuota}. */
export interface SegmentDirective {
  readonly segmentId: SegmentId;
  readonly label: string;
  readonly buyer: string;
  readonly description: string;
  /** How many seeds the model should bias toward this segment. */
  readonly count: number;
}

/**
 * Build per-segment generation directives that force the over-generated pool to
 * SPREAD across opportunity spaces. Wraps {@link segmentQuota} (counts sum
 * exactly to targetCount, flat distribution) and joins each non-zero quota with
 * its segment descriptor so the prompt can steer generation. Zero-count segments
 * are dropped (no point instructing the model to make 0). PURE.
 */
export function planSegmentDirectives(
  targetCount: number,
  segmentIds?: readonly SegmentId[],
): readonly SegmentDirective[] {
  const quotas: readonly SegmentQuota[] = segmentQuota(targetCount, segmentIds);
  return quotas
    .filter((q) => q.count > 0)
    .map((q) => {
      const seg = SEGMENT_BY_ID[q.segmentId];
      return {
        segmentId: q.segmentId,
        label: seg.label,
        buyer: seg.buyer,
        description: seg.description,
        count: q.count,
      };
    });
}

/**
 * Render the segment-spread directives as a human-legible prompt block. Returns
 * "" for an empty plan so callers can inject unconditionally (legacy prompt
 * unchanged when multiSegment is off). PURE.
 */
export function renderSegmentSpread(
  directives: readonly SegmentDirective[],
): string {
  if (directives.length === 0) return "";
  const lines = directives.map(
    (d) =>
      `  • [${d.segmentId}] ${d.label} (target ~${d.count}) — buyer: ${d.buyer} ${d.description}`,
  );
  return [
    "",
    "=== SEGMENT SPREAD (CRITICAL — span these opportunity spaces, do NOT collapse to consumer-mobile) ===",
    "Distribute your ideas across the following distinct markets. Each is a different buyer / economic model.",
    "Tag every idea with its segment id from this list.",
    ...lines,
  ].join("\n");
}

// ── Novelty-reserve selection ──────────────────────────────────────────────

/**
 * A candidate's surprise/novelty signal in [0,1]: the diversity prior used to
 * reserve final-pool slots for high-surprise ideas the quality sort would drop.
 *
 * Prefers the validate-phase `originality` annotation when present; otherwise
 * falls back to the verbalized probability INVERTED (a low self-reported
 * probability ≈ a rarer / more surprising seed) so over-generation still yields
 * a usable surprise signal before originality is computed. Neutral 0 when
 * neither is available. PURE.
 */
export function noveltyScore(candidate: GeneratedIdeaCandidate): number {
  const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));
  if (typeof candidate.originality === "number") {
    return clamp01(candidate.originality);
  }
  if (typeof candidate.verbalizedProb === "number") {
    // Rare seeds (low self-reported prob) are MORE surprising.
    return clamp01(1 - candidate.verbalizedProb);
  }
  return 0;
}

/** Tunables for {@link selectWithNoveltyReserve}. All defaulted. */
export interface NoveltyReserveOptions {
  /**
   * Fraction (0..1) of the final slots reserved for the highest-novelty
   * candidates that the pure quality sort would have dropped. Default 0.25.
   */
  readonly reserveFraction?: number;
}

/**
 * Select the final `limit` candidates with a NOVELTY RESERVE.
 *
 * Today selection prunes by self-reported quality (novelty-hostile): the highest
 * qualityScore lookalikes win and surprising ideas are dropped. This reserves a
 * fraction of the slots for the highest-novelty candidates (originality, or
 * inverted verbalized prob) EVEN IF their qualityScore is lower:
 *
 *   1. Sort by qualityScore desc (stable); take the top `quality` slots.
 *   2. From the REMAINDER, take the top `reserve` slots by noveltyScore desc.
 *   3. Concatenate (quality block first), preserving uniqueness.
 *
 * Falls back to a plain quality slice when limit >= pool size or the reserve
 * rounds to 0. PURE + deterministic (stable tie-breaks by input index).
 */
export function selectWithNoveltyReserve(
  candidates: readonly GeneratedIdeaCandidate[],
  limit: number,
  options?: NoveltyReserveOptions,
): readonly GeneratedIdeaCandidate[] {
  if (limit <= 0) return [];
  if (candidates.length <= limit) return [...candidates];

  const reserveFraction = clampFraction(options?.reserveFraction ?? 0.25);
  const reserveSlots = Math.min(
    Math.floor(limit * reserveFraction),
    limit - 1, // always keep at least one quality slot
  );
  const qualitySlots = limit - reserveSlots;

  // Stable index-tagged sort by qualityScore desc.
  const byQuality = candidates
    .map((candidate, index) => ({ candidate, index }))
    .sort((a, b) =>
      b.candidate.qualityScore === a.candidate.qualityScore
        ? a.index - b.index
        : b.candidate.qualityScore - a.candidate.qualityScore,
    );

  if (reserveSlots <= 0) {
    return byQuality.slice(0, limit).map((e) => e.candidate);
  }

  const qualityBlock = byQuality.slice(0, qualitySlots);
  const remainder = byQuality.slice(qualitySlots);

  // From the remainder, reserve the highest-novelty candidates. Stable tie-break
  // by original index keeps this deterministic.
  const reserveBlock = [...remainder]
    .sort((a, b) => {
      const na = noveltyScore(a.candidate);
      const nb = noveltyScore(b.candidate);
      return nb === na ? a.index - b.index : nb - na;
    })
    .slice(0, reserveSlots);

  return [...qualityBlock, ...reserveBlock].map((e) => e.candidate);
}

function clampFraction(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}
