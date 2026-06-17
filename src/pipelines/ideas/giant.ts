/**
 * The GIANT rubric — the single shared optimization target for the ideas
 * pipeline. Every stage (synthesis, critique, validation, future SIGE) scores a
 * candidate idea against THIS scorecard so the whole pipeline pulls toward one
 * definition of a "giant" outcome.
 *
 * 7 axes, each 0..5, plus a Sequoia-style archetype tag and per-axis evidence
 * citation. Aggregation is intentionally NON-COMPENSATORY: a weighted GEOMETRIC
 * mean (so a near-zero axis can't be bought back by strong axes) layered with
 * HARD GATES and an evidence-gated demand axis.
 *
 *   1. acuteProblem    (0.22)  HARD GATE  — painkiller, not vitamin.
 *   2. whyNow          (0.18)  HARD GATE  — a dated, source-bound enabling shift.
 *   3. demand          (0.18)  EVIDENCE-GATED — capped <=2 without a cited artifact.
 *   4. nonObviousness  (0.15)  embedding-distance / anti-template.
 *   5. defensibility   (0.12)  a 6-month-uncopyable moat.
 *   6. marketShape     (0.08)  beachhead → large TAM (well, not hole).
 *   7. founderFit      (0.07)  execution difficulty vs the idea's archetype.
 *
 * Hard gates (acuteProblem<=1 OR whyNow<=1) and the demand evidence-gate set
 * `gated` and record `gateReasons` REGARDLESS of enforcement. Enforcement is
 * SHADOW-MODE by default: the CALLER decides whether to actually drop a gated
 * idea (only when smart.giant.enforceGates is true) — this module only computes
 * and reports. That keeps the live pipeline producing ideas while kill-logs are
 * reviewed.
 *
 * The aggregation + evidence-gate + tolerant parse are PURE and dependency-free
 * (no DB, clock, or rng) so they are fully unit-testable and deterministic.
 */

import { z } from "zod";

// ── Axis table ───────────────────────────────────────────────────────────────

/** The 7 GIANT axis keys, in canonical (weight-descending) order. */
export const GIANT_AXIS_KEYS = [
  "acuteProblem",
  "whyNow",
  "demand",
  "nonObviousness",
  "defensibility",
  "marketShape",
  "founderFit",
] as const;

export type GiantAxisKey = (typeof GIANT_AXIS_KEYS)[number];

/** Static descriptor for one GIANT axis: its default weight + gating semantics. */
export interface GiantAxisSpec {
  readonly key: GiantAxisKey;
  /** Default aggregation weight (the 7 sum to 1.0). */
  readonly weight: number;
  /** Hard-gate axes are rejected when their score is <= {@link HARD_GATE_THRESHOLD}. */
  readonly hardGate: boolean;
  /** The demand axis is capped at {@link DEMAND_EVIDENCE_CAP} without a cited artifact. */
  readonly evidenceGated: boolean;
  readonly description: string;
}

/**
 * The default GIANT axis table. Weights: 0.22/0.18/0.18/0.15/0.12/0.08/0.07.
 * Keyed by axis for direct lookup; iterate {@link GIANT_AXIS_KEYS} for order.
 */
export const GIANT_AXES: Readonly<Record<GiantAxisKey, GiantAxisSpec>> = {
  acuteProblem: {
    key: "acuteProblem",
    weight: 0.22,
    hardGate: true,
    evidenceGated: false,
    description:
      "Painkiller not vitamin; a nameable user wants v1 NOW; backed by complaint-cluster size/recency.",
  },
  whyNow: {
    key: "whyNow",
    weight: 0.18,
    hardGate: true,
    evidenceGated: false,
    description:
      ">=1 dated, source-bound enabling shift across {technological,regulatory,behavioral,economic}.",
  },
  demand: {
    key: "demand",
    weight: 0.18,
    hardGate: false,
    evidenceGated: true,
    description:
      "Capped LOW (<=2) unless a cited demand artifact exists (search delta, job count, funding, waitlist).",
  },
  nonObviousness: {
    key: "nonObviousness",
    weight: 0.15,
    hardGate: false,
    evidenceGated: false,
    description:
      "Embedding-distance from known-product corpus AND in-batch siblings; penalize templated 'X for Y app'.",
  },
  defensibility: {
    key: "defensibility",
    weight: 0.12,
    hardGate: false,
    evidenceGated: false,
    description:
      "A moat a fast-follower can't copy in ~6 months (counter-positioning / accruable advantage).",
  },
  marketShape: {
    key: "marketShape",
    weight: 0.08,
    hardGate: false,
    evidenceGated: false,
    description:
      "Deep beachhead user with acute need + named path to large TAM (well, not hole).",
  },
  founderFit: {
    key: "founderFit",
    weight: 0.07,
    hardGate: false,
    evidenceGated: false,
    description:
      "Execution difficulty judged AGAINST the idea's archetype, not uniformly.",
  },
};

/** Default per-axis weights, derived from {@link GIANT_AXES}. */
export const GIANT_DEFAULT_WEIGHTS: Readonly<Record<GiantAxisKey, number>> = {
  acuteProblem: GIANT_AXES.acuteProblem.weight,
  whyNow: GIANT_AXES.whyNow.weight,
  demand: GIANT_AXES.demand.weight,
  nonObviousness: GIANT_AXES.nonObviousness.weight,
  defensibility: GIANT_AXES.defensibility.weight,
  marketShape: GIANT_AXES.marketShape.weight,
  founderFit: GIANT_AXES.founderFit.weight,
};

// ── Constants ────────────────────────────────────────────────────────────────

/** Axis scores live in [0, 5]. */
export const AXIS_MIN = 0;
export const AXIS_MAX = 5;

/**
 * Hard-gate axes (acuteProblem, whyNow) gate the idea out when scored at or
 * below this. <=1 means "missing/borderline".
 */
export const HARD_GATE_THRESHOLD = 1;

/**
 * The demand axis is clamped to at most this in aggregation when no cited demand
 * artifact is present (evidence-gate). The raw asserted score is preserved on
 * the scorecard; only the value FED INTO the geomean is capped.
 */
export const DEMAND_EVIDENCE_CAP = 2;

/**
 * Small epsilon the axes are clamped to before the geometric mean so a literal
 * 0 doesn't make the whole composite collapse to exactly 0 (and so log() is
 * defined). A near-zero axis still tanks the composite hard — that's the point
 * of the non-compensatory geomean — but stays a finite number.
 */
export const GEOMEAN_EPSILON = 0.01;

// ── Types ────────────────────────────────────────────────────────────────────

/** The 7 axis scores, each a number in [0, 5]. */
export type GiantAxisScores = Record<GiantAxisKey, number>;

/** Sequoia-style archetype tag for the idea. */
export type Archetype = "hair-on-fire" | "hard-fact" | "future-vision";

export const ARCHETYPES: readonly Archetype[] = [
  "hair-on-fire",
  "hard-fact",
  "future-vision",
] as const;

/** The four families an enabling "why now" shift can belong to. */
export type WhyNowAxis = "technological" | "regulatory" | "behavioral" | "economic";

export const WHY_NOW_AXES: readonly WhyNowAxis[] = [
  "technological",
  "regulatory",
  "behavioral",
  "economic",
] as const;

/** One dated, source-bound enabling shift backing the whyNow axis. */
export interface WhyNowShift {
  readonly axis: WhyNowAxis;
  readonly claim: string;
  /** Signal-citation token binding the claim to a real scraped row, when present. */
  readonly boundSignalId?: string;
  /** ISO-ish date string of the shift, when datable. */
  readonly date?: string;
  /** Model-asserted strength of the shift in [0, 1]. */
  readonly strength: number;
}

/** The full ordered list of why-now shifts backing the whyNow axis. */
export type WhyNow = readonly WhyNowShift[];

/** The aggregated, non-compensatory verdict over the 7 axes. */
export interface GiantAggregate {
  /** Weighted geometric mean over the 7 (evidence-adjusted) axes, in [0, 5]. */
  readonly composite: number;
  /** true when any hard gate fired (set REGARDLESS of enforcement). */
  readonly gated: boolean;
  /** Human-readable reasons for each gate/cap that fired. */
  readonly gateReasons: readonly string[];
}

/** The complete GIANT scorecard for one idea. */
export interface GiantEvaluation {
  readonly scores: GiantAxisScores;
  readonly archetype: Archetype;
  readonly whyNow: WhyNow;
  /** Per-axis evidence citation (free text / signal tokens). */
  readonly evidence: Readonly<Record<GiantAxisKey, string>>;
  readonly composite: number;
  readonly gated: boolean;
  readonly gateReasons: readonly string[];
}

// ── Aggregation (PURE) ───────────────────────────────────────────────────────

/** Clamp a value into [min, max]; non-finite → min. */
function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/** Clamp a raw asserted axis score into the [0, 5] axis range. */
export function clampAxisScore(value: number): number {
  return clamp(value, AXIS_MIN, AXIS_MAX);
}

/**
 * Options for {@link aggregateGiant}.
 *
 * `enforceGates` is accepted for symmetry with the config flag but does NOT
 * change `composite`, `gated`, or `gateReasons` — gating is always computed and
 * reported; enforcement (dropping) is the caller's decision. It is surfaced here
 * so callers can thread the flag through one place.
 */
export interface AggregateGiantOptions {
  /** Per-axis weight overrides; missing axes fall back to the default weight. */
  readonly weights?: Partial<Record<GiantAxisKey, number>>;
  /** Shadow-mode marker (does not affect the returned math — see note above). */
  readonly enforceGates?: boolean;
  /**
   * Whether a cited demand artifact exists. When false (default), the demand
   * axis fed into the geomean is capped at {@link DEMAND_EVIDENCE_CAP}.
   */
  readonly hasDemandEvidence?: boolean;
}

/**
 * Aggregate the 7 GIANT axis scores into a non-compensatory composite, applying
 * the hard gates and the demand evidence-gate. PURE — deterministic, no DB /
 * clock / rng.
 *
 *   composite  = weighted GEOMETRIC mean over the 7 evidence-adjusted axes,
 *                each clamped to >= {@link GEOMEAN_EPSILON} so a 0 axis tanks
 *                (but doesn't NaN) the result.
 *   gated      = true when acuteProblem<=1 OR whyNow<=1 (hard gates).
 *   gateReasons= one entry per gate/cap that fired (hard gates + demand cap).
 *
 * `gated` reflects gate violations regardless of `opts.enforceGates`; the caller
 * decides whether to drop the idea based on enforcement.
 */
export function aggregateGiant(
  scores: GiantAxisScores,
  opts: AggregateGiantOptions = {},
): GiantAggregate {
  const hasDemandEvidence = opts.hasDemandEvidence === true;
  const weights = opts.weights ?? {};

  const gateReasons: string[] = [];
  let gated = false;

  // Hard gates: acuteProblem / whyNow at or below the threshold reject.
  for (const key of GIANT_AXIS_KEYS) {
    const spec = GIANT_AXES[key];
    if (!spec.hardGate) continue;
    const raw = clampAxisScore(scores[key]);
    if (raw <= HARD_GATE_THRESHOLD) {
      gated = true;
      gateReasons.push(
        `hard-gate:${key} score ${raw} <= ${HARD_GATE_THRESHOLD}`,
      );
    }
  }

  // Demand evidence-gate: without a cited artifact, cap the demand value used
  // in aggregation (the raw asserted score is preserved on the scorecard).
  if (!hasDemandEvidence) {
    const rawDemand = clampAxisScore(scores.demand);
    if (rawDemand > DEMAND_EVIDENCE_CAP) {
      gateReasons.push(
        `demand-evidence-gate: demand ${rawDemand} capped to ${DEMAND_EVIDENCE_CAP} (no cited demand artifact)`,
      );
    }
  }

  // Build the evidence-adjusted, epsilon-clamped axis vector for the geomean.
  let weightedLogSum = 0;
  let weightSum = 0;
  for (const key of GIANT_AXIS_KEYS) {
    let axisValue = clampAxisScore(scores[key]);
    if (key === "demand" && !hasDemandEvidence) {
      axisValue = Math.min(axisValue, DEMAND_EVIDENCE_CAP);
    }
    const effective = Math.max(axisValue, GEOMEAN_EPSILON);

    const rawWeight = weights[key];
    const weight =
      typeof rawWeight === "number" && Number.isFinite(rawWeight) && rawWeight >= 0
        ? rawWeight
        : GIANT_AXES[key].weight;

    weightedLogSum += weight * Math.log(effective);
    weightSum += weight;
  }

  const composite =
    weightSum > 0 ? Math.exp(weightedLogSum / weightSum) : GEOMEAN_EPSILON;

  return {
    composite: clamp(composite, AXIS_MIN, AXIS_MAX),
    gated,
    gateReasons,
  };
}

// ── Zod schema for the raw LLM output ────────────────────────────────────────

/** A lenient axis-score schema: accepts any number, clamped later. */
const rawAxisScoreSchema = z.number();

/** Zod schema for the raw 7-axis + archetype + whyNow LLM output. */
export const rawGiantSchema = z.object({
  scores: z.object({
    acuteProblem: rawAxisScoreSchema,
    whyNow: rawAxisScoreSchema,
    demand: rawAxisScoreSchema,
    nonObviousness: rawAxisScoreSchema,
    defensibility: rawAxisScoreSchema,
    marketShape: rawAxisScoreSchema,
    founderFit: rawAxisScoreSchema,
  }),
  archetype: z.string(),
  whyNow: z
    .array(
      z.object({
        axis: z.string(),
        claim: z.string(),
        boundSignalId: z.string().optional(),
        date: z.string().optional(),
        strength: z.number().optional(),
      }),
    )
    .optional()
    .default([]),
  evidence: z.record(z.string(), z.string()).optional().default({}),
});

export type RawGiant = z.infer<typeof rawGiantSchema>;

// ── Tolerant parse / coerce ──────────────────────────────────────────────────

function coerceArchetype(value: unknown): Archetype {
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    const match = ARCHETYPES.find((a) => a === normalized);
    if (match) return match;
  }
  return "hair-on-fire";
}

function coerceWhyNowAxis(value: unknown): WhyNowAxis {
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    const match = WHY_NOW_AXES.find((a) => a === normalized);
    if (match) return match;
  }
  return "technological";
}

function coerceWhyNow(value: unknown): WhyNow {
  if (!Array.isArray(value)) return [];
  const out: WhyNowShift[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const claim = typeof e.claim === "string" ? e.claim.trim() : "";
    if (claim.length === 0) continue;
    out.push({
      axis: coerceWhyNowAxis(e.axis),
      claim,
      ...(typeof e.boundSignalId === "string" && e.boundSignalId.trim().length > 0
        ? { boundSignalId: e.boundSignalId.trim() }
        : {}),
      ...(typeof e.date === "string" && e.date.trim().length > 0
        ? { date: e.date.trim() }
        : {}),
      strength: clamp(typeof e.strength === "number" ? e.strength : 0, 0, 1),
    });
  }
  return out;
}

function coerceEvidence(value: unknown): Record<GiantAxisKey, string> {
  const source =
    value !== null && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const out = {} as Record<GiantAxisKey, string>;
  for (const key of GIANT_AXIS_KEYS) {
    const v = source[key];
    out[key] = typeof v === "string" ? v.trim() : "";
  }
  return out;
}

function coerceScores(value: unknown): GiantAxisScores {
  const source =
    value !== null && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const out = {} as GiantAxisScores;
  for (const key of GIANT_AXIS_KEYS) {
    const raw = source[key];
    out[key] = clampAxisScore(typeof raw === "number" ? raw : Number(raw));
  }
  return out;
}

/** Pieces produced by {@link parseGiant} before aggregation. */
export interface ParsedGiant {
  readonly scores: GiantAxisScores;
  readonly archetype: Archetype;
  readonly whyNow: WhyNow;
  readonly evidence: Readonly<Record<GiantAxisKey, string>>;
}

/**
 * Tolerantly parse a raw LLM GIANT output into normalized pieces, defaulting and
 * clamping bad values rather than throwing. Accepts unknown input (e.g. a parsed
 * JSON blob); always returns a usable {@link ParsedGiant} with all 7 axes
 * present, clamped to [0, 5], a valid archetype, and a cleaned whyNow list.
 *
 * PURE — never throws, never touches IO. The optional GIANT path failing must
 * not break the pipeline default path, so this degrades to safe defaults.
 */
export function parseGiant(input: unknown): ParsedGiant {
  const source =
    input !== null && typeof input === "object"
      ? (input as Record<string, unknown>)
      : {};
  return {
    scores: coerceScores(source.scores),
    archetype: coerceArchetype(source.archetype),
    whyNow: coerceWhyNow(source.whyNow),
    evidence: coerceEvidence(source.evidence),
  };
}

/**
 * Convenience: parse a raw LLM output AND aggregate it into a full
 * {@link GiantEvaluation}. The demand evidence flag is derived from the parsed
 * whyNow/evidence when not supplied — but callers with a real demand artifact
 * check should pass `hasDemandEvidence` explicitly. PURE.
 */
export function evaluateGiant(
  input: unknown,
  opts: AggregateGiantOptions = {},
): GiantEvaluation {
  const parsed = parseGiant(input);
  const aggregate = aggregateGiant(parsed.scores, opts);
  return {
    scores: parsed.scores,
    archetype: parsed.archetype,
    whyNow: parsed.whyNow,
    evidence: parsed.evidence,
    composite: aggregate.composite,
    gated: aggregate.gated,
    gateReasons: aggregate.gateReasons,
  };
}
