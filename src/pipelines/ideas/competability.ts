/**
 * Layer B — COMPETABILITY / MOAT GATE.
 *
 * The direct fix for "build a DoorDash" ideas: a non-compensatory gate that asks
 * "can a SMALL / solo builder realistically win this market in v1?" and rejects
 * ideas whose incumbents sit behind a moat a small team cannot overcome.
 *
 * This is the INVERSE of the GIANT `defensibility` axis (which rewards a moat the
 * IDEA can build); competability PENALIZES a moat the COMPETITION already has and
 * the small builder cannot. The two are distinct and both are kept.
 *
 * Four moat dimensions, each scored 0..5 (5 = the moat is overwhelming):
 *   - capital      : capex / sustained funding burn to even launch (logistics
 *                    fleets, hardware, content licensing, deep subsidies).
 *   - networkEffect: value depends on a critical mass of users/supply already
 *                    locked up by incumbents (two-sided marketplaces, social).
 *   - logistics    : physical ops / fulfillment / field operations at scale.
 *   - regulated    : licensing / compliance / regulatory capture as a barrier.
 *
 * Plus a single 0..5 `overall` "a small builder CAN win" score (5 = wide open).
 *
 * The Zod schema validates the structured LLM output. `decideCompetability` is the
 * PURE non-compensatory gate decision. `heuristicMoatFlags` is a cheap PURE
 * pre-filter (no LLM) that catches the obvious delivery/marketplace + named-giant
 * cases up front. Everything here is PURE (no DB / clock / rng) and unit-testable.
 */

import { z } from "zod";
import { mentionsIncumbent } from "./incumbents";

// ── Constants (exported, config-overridable) ─────────────────────────────────

/** Moat-dimension scores live in [0, 5]. */
export const COMPETABILITY_MIN = 0;
export const COMPETABILITY_MAX = 5;

/**
 * Default HARD-REJECT threshold on the overall "small builder can win" score:
 * an overall below this is uncompetable for a small builder. Default 2.0.
 */
export const DEFAULT_REJECT_THRESHOLD = 2.0;

/**
 * Default SOFT-PENALTY band ceiling: overall in [rejectThreshold, this] is
 * borderline — logged / lightly penalized but NOT rejected. Default 2.5.
 */
export const DEFAULT_SOFT_PENALTY_THRESHOLD = 2.5;

/**
 * A SINGLE moat dimension at this maximum value is, on its own, a near-fatal
 * barrier (e.g. a fully captured two-sided network). Combined with an overall
 * below {@link CLEARLY_UNCOMPETABLE_OVERALL} it triggers a hard reject even when
 * the overall sits inside the soft band.
 */
export const DOMINANT_MOAT_DIMENSION = 5;

/**
 * Overall threshold below which a dominant single moat dimension (==5) forces a
 * hard reject regardless of the soft band. Default 3.0.
 */
export const CLEARLY_UNCOMPETABLE_OVERALL = 3.0;

/**
 * An overall at or below this is ALWAYS hard-rejected (clearly uncompetable),
 * independent of the configurable reject threshold. Default 1.5.
 */
export const ALWAYS_REJECT_OVERALL = 1.5;

/** Default top-N incumbents the heuristic pre-filter checks idea text against. */
export const DEFAULT_TOP_N_INCUMBENTS = 100;

// ── Moat-keyword heuristic vocabulary ────────────────────────────────────────

/**
 * Keyword families that, on their own, signal a structurally hard-to-enter
 * market for a small builder. Conservative on purpose — a keyword ALONE is a
 * FLAG, not a rejection; the LLM score + gate make the final call.
 */
const MOAT_KEYWORDS: Readonly<Record<string, readonly RegExp[]>> = {
  logistics: [
    /\b(food|grocery|package|parcel|meal)\s+deliver(y|ies)\b/i,
    /\blast[-\s]?mile\b/i,
    /\bcourier(s)?\b/i,
    /\bfulfilment|fulfillment\b/i,
    /\bwarehous(e|ing)\b/i,
    /\bride[-\s]?(hail|shar)(ing|e)\b/i,
    /\bfleet\b/i,
  ],
  networkEffect: [
    /\b(two|2)[-\s]?sided\s+marketplace\b/i,
    /\bmarketplace\b/i,
    /\bsocial\s+network(ing)?\b/i,
    /\bdating\s+app\b/i,
    /\bgig\s+(economy|marketplace)\b/i,
  ],
  capital: [
    /\bsubsidi(s|z)e(d|s)?\b/i,
    /\bhardware\b/i,
    /\bcontent\s+licens(e|ing)\b/i,
    /\bstreaming\s+(service|platform)\b/i,
  ],
  regulated: [
    /\b(bank|banking|neobank)\b/i,
    /\binsuranc(e|er)\b/i,
    /\blicens(e|ed|ing)\b/i,
    /\b(fda|hipaa|kyc|aml)\b/i,
    /\bpharmac(y|ies)\b/i,
  ],
} as const;

// ── Structured LLM output schema (validated with Zod) ─────────────────────────

/** A lenient 0..5 score schema; clamped downstream. */
const rawScoreSchema = z.number();

/** Zod schema for the structured competability LLM output. */
export const rawCompetabilitySchema = z.object({
  dimensions: z.object({
    capital: rawScoreSchema,
    networkEffect: rawScoreSchema,
    logistics: rawScoreSchema,
    regulated: rawScoreSchema,
  }),
  /** 0..5 "a small builder can realistically win v1" (5 = wide open). */
  overall: rawScoreSchema,
  rationale: z.string().optional().default(""),
});

export type RawCompetability = z.infer<typeof rawCompetabilitySchema>;

/** The four moat-dimension keys. */
export const COMPETABILITY_DIMENSIONS = [
  "capital",
  "networkEffect",
  "logistics",
  "regulated",
] as const;

export type CompetabilityDimension = (typeof COMPETABILITY_DIMENSIONS)[number];

/** Normalized, clamped competability score. */
export interface CompetabilityScore {
  readonly dimensions: Readonly<Record<CompetabilityDimension, number>>;
  readonly overall: number;
  readonly rationale: string;
}

// ── Tolerant parse / coerce (PURE, never throws) ──────────────────────────────

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function clampScore(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return clamp(n, COMPETABILITY_MIN, COMPETABILITY_MAX);
}

/**
 * Tolerantly parse a raw LLM competability blob into a normalized, clamped
 * {@link CompetabilityScore}. Missing dimensions default to a NEUTRAL midpoint
 * (so a malformed output doesn't spuriously reject); the `overall` defaults to
 * the soft-pass midpoint. PURE — never throws.
 */
export function parseCompetability(input: unknown): CompetabilityScore {
  const source =
    input !== null && typeof input === "object"
      ? (input as Record<string, unknown>)
      : {};
  const dimsSource =
    source.dimensions !== null && typeof source.dimensions === "object"
      ? (source.dimensions as Record<string, unknown>)
      : {};

  const dimensions = {} as Record<CompetabilityDimension, number>;
  for (const key of COMPETABILITY_DIMENSIONS) {
    // Neutral default 2.5 (midpoint) when the model omitted a dimension.
    dimensions[key] =
      key in dimsSource ? clampScore(dimsSource[key]) : COMPETABILITY_MAX / 2;
  }

  const overall =
    "overall" in source ? clampScore(source.overall) : COMPETABILITY_MAX / 2;
  const rationale =
    typeof source.rationale === "string" ? source.rationale.trim() : "";

  return { dimensions, overall, rationale };
}

// ── Gate decision (PURE, non-compensatory) ────────────────────────────────────

/** Tunable thresholds for {@link decideCompetability}. */
export interface CompetabilityThresholds {
  /** Overall below this → hard reject (default {@link DEFAULT_REJECT_THRESHOLD}). */
  readonly rejectThreshold?: number;
  /** Overall in [reject, this] → soft-penalize (default {@link DEFAULT_SOFT_PENALTY_THRESHOLD}). */
  readonly softPenaltyThreshold?: number;
}

/** Outcome of the competability gate. */
export interface CompetabilityDecision {
  /** false ⇒ uncompetable for a small builder; the caller should reject (when enforcing). */
  readonly pass: boolean;
  /** true ⇒ inside the borderline soft band (pass=true but flagged). */
  readonly soft: boolean;
  /** Human-readable reason for the decision. */
  readonly reason: string;
}

/**
 * Decide whether a competability score PASSES (a small builder can win) or is
 * REJECTED. Non-compensatory — a single dominant moat dimension can sink an idea
 * even when the overall sits in the soft band.
 *
 * Hard-reject when ANY of:
 *   - overall <= {@link ALWAYS_REJECT_OVERALL} (clearly uncompetable), OR
 *   - overall <  rejectThreshold, OR
 *   - any dimension == {@link DOMINANT_MOAT_DIMENSION} AND
 *     overall < {@link CLEARLY_UNCOMPETABLE_OVERALL}.
 *
 * Soft-penalize (pass=true, soft=true) when overall is in
 * [rejectThreshold, softPenaltyThreshold]. Otherwise a clean pass. PURE.
 */
export function decideCompetability(
  score: CompetabilityScore,
  thresholds: CompetabilityThresholds = {},
): CompetabilityDecision {
  const reject = thresholds.rejectThreshold ?? DEFAULT_REJECT_THRESHOLD;
  const soft = thresholds.softPenaltyThreshold ?? DEFAULT_SOFT_PENALTY_THRESHOLD;
  const overall = clampScore(score.overall);

  if (overall <= ALWAYS_REJECT_OVERALL) {
    return {
      pass: false,
      soft: false,
      reason: `overall ${overall} <= always-reject ${ALWAYS_REJECT_OVERALL} (clearly uncompetable)`,
    };
  }

  const dominant = COMPETABILITY_DIMENSIONS.find(
    (k) => clampScore(score.dimensions[k]) >= DOMINANT_MOAT_DIMENSION,
  );
  if (dominant && overall < CLEARLY_UNCOMPETABLE_OVERALL) {
    return {
      pass: false,
      soft: false,
      reason: `dominant moat ${dominant}=${DOMINANT_MOAT_DIMENSION} with overall ${overall} < ${CLEARLY_UNCOMPETABLE_OVERALL}`,
    };
  }

  if (overall < reject) {
    return {
      pass: false,
      soft: false,
      reason: `overall ${overall} < reject-threshold ${reject}`,
    };
  }

  if (overall <= soft) {
    return {
      pass: true,
      soft: true,
      reason: `overall ${overall} in soft band [${reject}, ${soft}] — penalize/log`,
    };
  }

  return { pass: true, soft: false, reason: `overall ${overall} >= ${soft}` };
}

// ── Cheap heuristic pre-filter (PURE, no LLM) ─────────────────────────────────

/** Result of {@link heuristicMoatFlags}. */
export interface HeuristicMoatVerdict {
  /** Moat-keyword families the text triggered (e.g. ["logistics"]). */
  readonly flags: readonly CompetabilityDimension[];
  /** Whether the text PROMINENTLY names a top-N incumbent. */
  readonly namesIncumbent: boolean;
  /**
   * true ⇒ an OBVIOUS uncompetable shell: a moat-keyword family AND a named
   * incumbent both present. The caller can short-circuit the LLM call and reject
   * (when enforcing) on this alone.
   */
  readonly obvious: boolean;
  readonly reason: string;
}

/**
 * Cheap PURE pre-filter that catches the obvious uncompetable cases WITHOUT an
 * LLM call: scan idea text for moat-keyword families and for a prominently-named
 * top-N incumbent. An idea is `obvious`ly uncompetable when it hits a moat
 * keyword AND names an incumbent (e.g. "a food delivery app to rival DoorDash").
 *
 * Conservative: keywords alone or an incumbent alone is a FLAG, not an obvious
 * rejection — the LLM score / gate make the final call. PURE — no IO.
 */
export function heuristicMoatFlags(
  ideaText: string | null | undefined,
  incumbentSet: ReadonlySet<string>,
): HeuristicMoatVerdict {
  const text = typeof ideaText === "string" ? ideaText : "";
  const flags: CompetabilityDimension[] = [];
  for (const dim of COMPETABILITY_DIMENSIONS) {
    const patterns = MOAT_KEYWORDS[dim];
    if (patterns && patterns.some((re) => re.test(text))) flags.push(dim);
  }
  const namesIncumbent = mentionsIncumbent(text, incumbentSet);
  const obvious = flags.length > 0 && namesIncumbent;

  const parts: string[] = [];
  if (flags.length > 0) parts.push(`moat keywords: ${flags.join(", ")}`);
  if (namesIncumbent) parts.push("names a top-N incumbent");
  const reason = obvious
    ? `obvious uncompetable shell — ${parts.join(" + ")}`
    : parts.join("; ");

  return { flags, namesIncumbent, obvious, reason };
}
