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

/**
 * Default HARD-VETO threshold (per-dimension, RAW score). A RAW moat score at or
 * above this on ANY {@link DEFAULT_HARD_VETO_DIMENSIONS} dimension is fatal —
 * the idea is hard-rejected regardless of the composite/overall and regardless of
 * any builder-profile discount. Default 4 (on the 0..5 scale).
 *
 * This is the "uncompetable for a solo/bootstrapped builder" backstop: ideas that
 * INHERENTLY require regulation/licensing, heavy capital, physical logistics, or a
 * network-effect cold-start are excluded as an OBJECTIVE property of the market,
 * not a function of how the idea is framed or how much funding the builder has.
 */
export const DEFAULT_HARD_VETO_THRESHOLD = 4;

/**
 * Default FATAL moat-dimension set for the hard veto: all four dimensions. A RAW
 * score >= {@link DEFAULT_HARD_VETO_THRESHOLD} on ANY of these vetoes the idea.
 */
export const DEFAULT_HARD_VETO_DIMENSIONS: readonly CompetabilityDimension[] = [
  "regulated",
  "capital",
  "logistics",
  "networkEffect",
];

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
 * Clamp a numeric score into the [{@link COMPETABILITY_MIN},
 * {@link COMPETABILITY_MAX}] range. Exported so the builder-profile transform
 * shares the EXACT same bounds as the gate instead of duplicating clamp logic.
 * Non-finite input collapses to the minimum. PURE.
 */
export function clampToScoreRange(value: number): number {
  return clamp(value, COMPETABILITY_MIN, COMPETABILITY_MAX);
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

// ── Hard per-dimension veto (PURE, RAW score, overall-independent) ─────────────

/** Tunable parameters for {@link hardVetoCompetability}. */
export interface HardVetoOptions {
  /**
   * RAW per-dimension score at or above which a fatal dimension vetoes the idea
   * (default {@link DEFAULT_HARD_VETO_THRESHOLD}).
   */
  readonly threshold?: number;
  /**
   * The fatal moat-dimension set (default {@link DEFAULT_HARD_VETO_DIMENSIONS} =
   * all four). A RAW score >= `threshold` on ANY of these vetoes the idea.
   */
  readonly dimensions?: readonly CompetabilityDimension[];
}

/** Outcome of the hard per-dimension veto. */
export interface HardVetoDecision {
  /** true ⇒ a fatal dimension breached the threshold; the idea must be rejected (when enforcing). */
  readonly vetoed: boolean;
  /** The dimension that triggered the veto (the first breach), or null when none. */
  readonly dimension: CompetabilityDimension | null;
  /** The RAW score of the triggering dimension, or null when none. */
  readonly value: number | null;
  /** Human-readable reason naming the dimension + value, or "" when not vetoed. */
  readonly reason: string;
}

/**
 * HARD per-dimension veto — a non-compensatory backstop that fires INDEPENDENTLY
 * of the composite/overall score.
 *
 * CRITICAL — RAW, not discounted: this MUST be evaluated against the RAW /
 * objective incumbent-moat dimensions (the market's inherent requirement — what
 * {@link parseCompetability} produces), NOT the builder-profile-discounted
 * (effective) dimensions. "Ideas which REQUIRE regulation / heavy capital /
 * physical logistics / a network-effect cold-start" is an OBJECTIVE property of
 * the market, independent of the builder's funding or appetite. The existing
 * {@link decideCompetability} runs on the EFFECTIVE (discounted) score; this veto
 * is intentionally a SEPARATE check the call sites run on the RAW score, so it
 * cannot be discounted away.
 *
 * Vetoes when ANY fatal dimension's RAW score >= `threshold` (default 4). All four
 * dimensions are fatal by default. PURE — no IO; returns the FIRST breach so the
 * reason is deterministic.
 */
export function hardVetoCompetability(
  rawScore: CompetabilityScore,
  options: HardVetoOptions = {},
): HardVetoDecision {
  const threshold = options.threshold ?? DEFAULT_HARD_VETO_THRESHOLD;
  const dimensions = options.dimensions ?? DEFAULT_HARD_VETO_DIMENSIONS;

  for (const dim of dimensions) {
    const value = clampScore(rawScore.dimensions[dim]);
    if (value >= threshold) {
      return {
        vetoed: true,
        dimension: dim,
        value,
        reason: `hard-veto: ${dim}=${value} >= ${threshold} (uncompetable moat for a solo builder)`,
      };
    }
  }

  return { vetoed: false, dimension: null, value: null, reason: "" };
}

// ── Persisted scorecard shape (PURE builder) ──────────────────────────────────

/**
 * The competability scorecard as it is persisted on a generated_ideas row
 * (`competability_json`): the four moat dimensions, the overall score, the gate
 * decision reason, and whether the gate would/did reject the idea. Both idea
 * paths (the trend-intersection pipeline and the SIGE cross-write) round-trip
 * this exact shape so the column is uniform regardless of which path wrote it.
 */
export interface CompetabilityPersisted {
  readonly dimensions: Readonly<Record<CompetabilityDimension, number>>;
  readonly overall: number;
  readonly reason: string;
  readonly gated: boolean;
  /**
   * The RAW, profile-INDEPENDENT moat score the LLM produced, BEFORE the builder
   * profile discount. `dimensions`/`overall` above are the EFFECTIVE (decided)
   * values; `raw` preserves the objective barriers for audit / re-scoring under a
   * different profile. Optional — absent on pre-builder-profile rows.
   */
  readonly raw?: {
    readonly dimensions: Readonly<Record<CompetabilityDimension, number>>;
    readonly overall: number;
  };
  /**
   * The builder expertise domain that matched this idea's text (and therefore
   * discounted its dominant moat), or null when none matched. Optional — absent on
   * pre-builder-profile rows.
   */
  readonly matchedExpertiseDomain?: string | null;
}

/** The RAW moat slice persisted alongside the effective score. */
export interface CompetabilityRaw {
  readonly dimensions: Readonly<Record<CompetabilityDimension, number>>;
  readonly overall: number;
}

/**
 * Build the persisted competability scorecard from the EFFECTIVE score, the gate
 * reason, and the gated flag — optionally carrying the RAW (pre-profile) score
 * and the matched expertise domain. `dimensions`/`overall` are the EFFECTIVE
 * (decided) values; the `competability_overall` column mirrors `overall`. Returns
 * null when there is no score to persist (so an un-scored idea stores SQL NULL
 * rather than a hollow object). PURE.
 */
export function buildCompetabilityPersisted(
  score: CompetabilityScore | null | undefined,
  reason: string,
  gated: boolean,
  extra?: {
    readonly raw?: CompetabilityRaw | null;
    readonly matchedExpertiseDomain?: string | null;
  },
): CompetabilityPersisted | null {
  if (!score) return null;
  const raw = extra?.raw;
  return {
    dimensions: score.dimensions,
    overall: clampScore(score.overall),
    reason,
    gated,
    ...(raw
      ? {
          raw: {
            dimensions: raw.dimensions,
            overall: clampScore(raw.overall),
          },
        }
      : {}),
    ...(extra && "matchedExpertiseDomain" in extra
      ? { matchedExpertiseDomain: extra.matchedExpertiseDomain ?? null }
      : {}),
  };
}

/** The loose per-candidate competability fields carried through the pipeline. */
export interface CandidateCompetabilityFields {
  /** EFFECTIVE (profile-adjusted, decided) moat dimensions. */
  readonly competability?: Readonly<Record<CompetabilityDimension, number>>;
  /** EFFECTIVE overall "can win" score. */
  readonly competabilityOverall?: number;
  readonly competabilityGated?: boolean;
  readonly competabilityReason?: string;
  /** RAW (pre-profile) moat dimensions, when a builder profile was applied. */
  readonly competabilityRaw?: Readonly<Record<CompetabilityDimension, number>>;
  /** RAW (pre-profile) overall, when a builder profile was applied. */
  readonly competabilityRawOverall?: number;
  /** Builder expertise domain that matched this idea (or null). */
  readonly competabilityMatchedExpertiseDomain?: string | null;
}

/**
 * Reconstruct the persisted competability scorecard from the loose per-candidate
 * fields. `competability`/`competabilityOverall` are the EFFECTIVE values;
 * `competabilityRaw*` (when present) preserve the pre-profile barriers. Returns
 * null when the candidate carries no competability dims (un-scored). PURE — clamps
 * defensively and never throws.
 */
export function candidateCompetabilityPersisted(
  candidate: CandidateCompetabilityFields,
): CompetabilityPersisted | null {
  if (!candidate.competability) return null;
  const dimensions = {} as Record<CompetabilityDimension, number>;
  for (const key of COMPETABILITY_DIMENSIONS) {
    dimensions[key] = clampScore(candidate.competability[key]);
  }

  let raw: CompetabilityRaw | null = null;
  if (candidate.competabilityRaw) {
    const rawDims = {} as Record<CompetabilityDimension, number>;
    for (const key of COMPETABILITY_DIMENSIONS) {
      rawDims[key] = clampScore(candidate.competabilityRaw[key]);
    }
    raw = {
      dimensions: rawDims,
      overall: clampScore(
        candidate.competabilityRawOverall ?? COMPETABILITY_MAX / 2,
      ),
    };
  }

  return buildCompetabilityPersisted(
    {
      dimensions,
      overall: clampScore(candidate.competabilityOverall ?? COMPETABILITY_MAX / 2),
      rationale: "",
    },
    candidate.competabilityReason ?? "",
    candidate.competabilityGated === true,
    {
      raw,
      ...(candidate.competabilityMatchedExpertiseDomain !== undefined
        ? { matchedExpertiseDomain: candidate.competabilityMatchedExpertiseDomain }
        : {}),
    },
  );
}

/**
 * Lift a persisted competability scorecard (the `competability_json` column shape)
 * back into the loose per-candidate competability fields. The inverse of
 * {@link candidateCompetabilityPersisted}: lets a consumer that only has the stored
 * scorecard (e.g. the human stage-update route reading a generated_ideas row) feed
 * the SAME moat slice into the outcome-memory write-back as a run-time candidate
 * would. Returns an empty object when there is no scorecard, so an un-scored idea
 * carries no competability fields. PURE — clamps defensively, never throws.
 */
export function persistedToCandidateCompetability(
  persisted: CompetabilityPersisted | null | undefined,
): CandidateCompetabilityFields {
  if (!persisted) return {};
  const dimensions = {} as Record<CompetabilityDimension, number>;
  for (const key of COMPETABILITY_DIMENSIONS) {
    dimensions[key] = clampScore(persisted.dimensions[key]);
  }

  const raw = persisted.raw;
  const rawDims = raw
    ? (() => {
        const out = {} as Record<CompetabilityDimension, number>;
        for (const key of COMPETABILITY_DIMENSIONS) out[key] = clampScore(raw.dimensions[key]);
        return out;
      })()
    : undefined;

  return {
    competability: dimensions,
    competabilityOverall: clampScore(persisted.overall),
    competabilityGated: persisted.gated,
    competabilityReason: persisted.reason,
    ...(rawDims
      ? { competabilityRaw: rawDims, competabilityRawOverall: clampScore(raw?.overall ?? 0) }
      : {}),
    ...(persisted.matchedExpertiseDomain !== undefined
      ? { competabilityMatchedExpertiseDomain: persisted.matchedExpertiseDomain }
      : {}),
  };
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
