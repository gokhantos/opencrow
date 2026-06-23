/**
 * The GIANT rubric — the single shared optimization target for the ideas
 * pipeline. Every stage (synthesis, critique, validation, future SIGE) scores a
 * candidate idea against THIS scorecard so the whole pipeline pulls toward one
 * definition of a "giant" outcome.
 *
 * 9 axes, each 0..5, plus a Sequoia-style archetype tag and per-axis evidence
 * citation. Aggregation is intentionally NON-COMPENSATORY: a weighted GEOMETRIC
 * mean (so a near-zero axis can't be bought back by strong axes) layered with
 * HARD GATES and an evidence-gated demand axis.
 *
 *   1. acuteProblem    (0.20)  HARD GATE  — painkiller, not vitamin.
 *   2. whyNow          (0.15)  HARD GATE  — a dated, source-bound enabling shift.
 *   3. demand          (0.15)  EVIDENCE-GATED — capped <=2 without a cited artifact.
 *   4. monetization    (0.13)  HARD GATE  — credible who-pays + how-much + ARR path.
 *   5. feasibility     (0.12)  HARD GATE  — buildable today (no fictional data/compute).
 *   6. nonObviousness  (0.10)  embedding-distance / anti-template.
 *   7. defensibility   (0.07)  a 6-month-uncopyable moat.
 *   8. marketShape     (0.04)  beachhead → large TAM (well, not hole).
 *   9. founderFit      (0.04)  execution difficulty vs the idea's archetype.
 *
 * Hard gates (acuteProblem/whyNow/monetization/feasibility <=1) and the demand
 * evidence-gate set
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

/** The 9 GIANT axis keys, in canonical (weight-descending) order. */
export const GIANT_AXIS_KEYS = [
  "acuteProblem",
  "whyNow",
  "demand",
  "monetization",
  "feasibility",
  "nonObviousness",
  "defensibility",
  "marketShape",
  "founderFit",
] as const;

export type GiantAxisKey = (typeof GIANT_AXIS_KEYS)[number];

/** Static descriptor for one GIANT axis: its default weight + gating semantics. */
export interface GiantAxisSpec {
  readonly key: GiantAxisKey;
  /** Default aggregation weight (the 9 sum to 1.0). */
  readonly weight: number;
  /** Hard-gate axes are rejected when their score is <= {@link HARD_GATE_THRESHOLD}. */
  readonly hardGate: boolean;
  /** The demand axis is capped at {@link DEMAND_EVIDENCE_CAP} without a cited artifact. */
  readonly evidenceGated: boolean;
  readonly description: string;
}

/**
 * The default GIANT axis table.
 * Weights: 0.20/0.15/0.15/0.13/0.12/0.10/0.07/0.04/0.04 (sum 1.0).
 * Keyed by axis for direct lookup; iterate {@link GIANT_AXIS_KEYS} for order.
 */
export const GIANT_AXES: Readonly<Record<GiantAxisKey, GiantAxisSpec>> = {
  acuteProblem: {
    key: "acuteProblem",
    weight: 0.2,
    hardGate: true,
    evidenceGated: false,
    description:
      "Painkiller not vitamin; a nameable user wants v1 NOW; backed by complaint-cluster size/recency.",
  },
  whyNow: {
    key: "whyNow",
    weight: 0.15,
    hardGate: true,
    evidenceGated: false,
    description:
      ">=1 dated, source-bound enabling shift across {technological,regulatory,behavioral,economic}.",
  },
  demand: {
    key: "demand",
    weight: 0.15,
    hardGate: false,
    evidenceGated: true,
    description:
      "Capped LOW (<=2) unless a cited demand artifact exists (search delta, job count, funding, waitlist).",
  },
  monetization: {
    key: "monetization",
    weight: 0.13,
    hardGate: true,
    evidenceGated: false,
    description:
      "Credible who-pays + how-much + path to revenue (pricing, buyer, ARR path). HARD GATE: score <=1 when free-only, 'ads/enterprise/tokens someday', or no nameable buyer.",
  },
  feasibility: {
    key: "feasibility",
    weight: 0.12,
    hardGate: true,
    evidenceGated: false,
    description:
      "Buildable & shippable by a small team with APIs/data/compute that EXIST TODAY. HARD GATE: score <=1 when it needs private app-data exports (DoorDash/Uber/bank), impractical on-device compute (e.g. running an LLM locally on a phone), or integrations/data access that don't exist.",
  },
  nonObviousness: {
    key: "nonObviousness",
    weight: 0.1,
    hardGate: false,
    evidenceGated: false,
    description:
      "Embedding-distance from known-product corpus AND in-batch siblings; penalize templated 'X for Y app'.",
  },
  defensibility: {
    key: "defensibility",
    weight: 0.07,
    hardGate: false,
    evidenceGated: false,
    description:
      "A moat a fast-follower can't copy in ~6 months (counter-positioning / accruable advantage).",
  },
  marketShape: {
    key: "marketShape",
    weight: 0.04,
    hardGate: false,
    evidenceGated: false,
    description:
      "Deep beachhead user with acute need + named path to large TAM (well, not hole).",
  },
  founderFit: {
    key: "founderFit",
    weight: 0.04,
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
  monetization: GIANT_AXES.monetization.weight,
  feasibility: GIANT_AXES.feasibility.weight,
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

/**
 * Safety valve for the missing-axis leniency. A model that OMITS a hard-gate
 * axis (a formatting failure, not a real signal) should NOT be falsely rejected,
 * so a MISSING hard-gate axis is treated as "not scored" (skip its gate, drop it
 * from the geomean) — but ONLY when the rest of the response is substantially
 * complete. A garbage / near-empty response must NOT slip through as a perfect
 * idea, so leniency is granted only when BOTH original-required hard gates
 * (acuteProblem AND whyNow) were emitted AND at least this many of the 9 axes are
 * present. Below the bar we keep today's strict behavior: missing → 0 → gates /
 * tanks. 5 of 9 = a strict majority of the rubric was actually scored.
 */
export const MIN_PRESENT_AXES_FOR_LENIENCY = 5;

// ── Types ────────────────────────────────────────────────────────────────────

/** The 9 axis scores, each a number in [0, 5]. */
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

/** The aggregated, non-compensatory verdict over the 9 axes. */
export interface GiantAggregate {
  /** Weighted geometric mean over the 9 (evidence-adjusted) axes, in [0, 5]. */
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
  /**
   * Axes the model did NOT emit (already passed the safety valve — see
   * {@link parseGiant} / {@link MIN_PRESENT_AXES_FOR_LENIENCY}). A missing axis is
   * "not scored": its hard gate is SKIPPED and it is EXCLUDED from the weighted
   * geomean (its weight is dropped from the denominator) so an omission neither
   * gates nor depresses the composite. A non-gating note is recorded so the
   * omission stays observable. The CALLER is responsible for only listing axes
   * that earned leniency; aggregateGiant honors exactly what it's given.
   */
  readonly missingAxes?: readonly GiantAxisKey[];
}

/**
 * Aggregate the 9 GIANT axis scores into a non-compensatory composite, applying
 * the hard gates and the demand evidence-gate. PURE — deterministic, no DB /
 * clock / rng.
 *
 *   composite  = weighted GEOMETRIC mean over the PRESENT evidence-adjusted axes
 *                (axes in `opts.missingAxes` are excluded — their weight is
 *                dropped from the denominator), each clamped to >=
 *                {@link GEOMEAN_EPSILON} so a 0 axis tanks (but doesn't NaN) it.
 *   gated      = true when any PRESENT hard-gate axis (acuteProblem / whyNow /
 *                monetization / feasibility) is <=1. A MISSING hard-gate axis
 *                does NOT gate (it was not scored — see `opts.missingAxes`).
 *   gateReasons= one entry per gate/cap that fired, plus a non-gating
 *                `missing-axis:<key> (not scored)` note for each omitted axis.
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
  const missing = new Set<GiantAxisKey>(opts.missingAxes ?? []);

  const gateReasons: string[] = [];
  let gated = false;

  // Hard gates: a hard-gate axis at or below the threshold rejects — UNLESS the
  // axis was not emitted (missing). A MISSING hard-gate axis is "not scored": it
  // skips the gate and records a non-gating note instead of a false rejection.
  for (const key of GIANT_AXIS_KEYS) {
    const spec = GIANT_AXES[key];
    if (!spec.hardGate) continue;
    if (missing.has(key)) {
      gateReasons.push(`missing-axis:${key} (not scored)`);
      continue;
    }
    const raw = clampAxisScore(scores[key]);
    if (raw <= HARD_GATE_THRESHOLD) {
      gated = true;
      gateReasons.push(
        `hard-gate:${key} score ${raw} <= ${HARD_GATE_THRESHOLD}`,
      );
    }
  }

  // Non-gating note for any MISSING non-hard-gate axis too, so every omission is
  // observable (the hard-gate ones were already noted above).
  for (const key of GIANT_AXIS_KEYS) {
    if (missing.has(key) && !GIANT_AXES[key].hardGate) {
      gateReasons.push(`missing-axis:${key} (not scored)`);
    }
  }

  // Demand evidence-gate: without a cited artifact, cap the demand value used in
  // aggregation (the raw asserted score is preserved on the scorecard). Skipped
  // when demand itself was not emitted (it is excluded from the geomean below).
  if (!hasDemandEvidence && !missing.has("demand")) {
    const rawDemand = clampAxisScore(scores.demand);
    if (rawDemand > DEMAND_EVIDENCE_CAP) {
      gateReasons.push(
        `demand-evidence-gate: demand ${rawDemand} capped to ${DEMAND_EVIDENCE_CAP} (no cited demand artifact)`,
      );
    }
  }

  // Build the evidence-adjusted, epsilon-clamped axis vector for the geomean. A
  // MISSING axis is EXCLUDED entirely (its weight is dropped from the
  // denominator) so the composite is the weighted geomean over PRESENT axes only
  // — an omission neither gates nor depresses the score.
  let weightedLogSum = 0;
  let weightSum = 0;
  for (const key of GIANT_AXIS_KEYS) {
    if (missing.has(key)) continue;
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

/** Zod schema for the raw 9-axis + archetype + whyNow LLM output. */
export const rawGiantSchema = z.object({
  scores: z.object({
    acuteProblem: rawAxisScoreSchema,
    whyNow: rawAxisScoreSchema,
    demand: rawAxisScoreSchema,
    monetization: rawAxisScoreSchema,
    feasibility: rawAxisScoreSchema,
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

/**
 * True when a raw axis value was actually EMITTED by the model: a finite number,
 * or a non-empty string that parses to a finite number. A missing key,
 * null/undefined, or a non-numeric string is NOT present ("not scored"). This is
 * the distinction that lets a hard-gate axis the model simply OMITTED be treated
 * as un-scored (skip gate, drop from the geomean) rather than as a genuine 0.
 */
export function isAxisValuePresent(raw: unknown): boolean {
  if (typeof raw === "number") return Number.isFinite(raw);
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.length === 0) return false;
    return Number.isFinite(Number(trimmed));
  }
  return false;
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

/**
 * The set of axes the model did NOT emit (per {@link isAxisValuePresent}). The
 * `scores` vector still fills these with 0 for type completeness; this set
 * records WHICH of those zeros are "not scored" vs a genuine asserted 0 — used
 * by the safety valve + {@link aggregateGiant}'s missing-axis leniency.
 */
function detectMissingAxes(value: unknown): readonly GiantAxisKey[] {
  const source =
    value !== null && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  return GIANT_AXIS_KEYS.filter((key) => !isAxisValuePresent(source[key]));
}

/** Pieces produced by {@link parseGiant} before aggregation. */
export interface ParsedGiant {
  readonly scores: GiantAxisScores;
  readonly archetype: Archetype;
  readonly whyNow: WhyNow;
  readonly evidence: Readonly<Record<GiantAxisKey, string>>;
  /**
   * Axes the model OMITTED that are eligible for lenient ("not scored")
   * treatment in {@link aggregateGiant} (skip hard gate, drop from the geomean).
   * The safety valve is already applied here: this is EMPTY for a malformed /
   * near-empty response (see {@link MIN_PRESENT_AXES_FOR_LENIENCY}), so such a
   * response keeps today's strict behavior (missing → 0 → gates / tanks). The
   * `scores` vector still fills omitted axes with 0 for type completeness.
   */
  readonly missingAxes: readonly GiantAxisKey[];
}

/**
 * Decide which OMITTED axes earn lenient ("not scored") treatment, applying the
 * safety valve. Leniency is granted ONLY when the response is substantially
 * complete: BOTH original-required hard gates (acuteProblem, whyNow) were
 * emitted AND at least {@link MIN_PRESENT_AXES_FOR_LENIENCY} of the 9 axes are
 * present. Otherwise returns [] so the strict missing→0 behavior holds. PURE.
 */
function lenientMissingAxes(rawMissing: readonly GiantAxisKey[]): readonly GiantAxisKey[] {
  if (rawMissing.length === 0) return [];
  const presentCount = GIANT_AXIS_KEYS.length - rawMissing.length;
  const missingSet = new Set<GiantAxisKey>(rawMissing);
  const spineEmitted = !missingSet.has("acuteProblem") && !missingSet.has("whyNow");
  if (!spineEmitted || presentCount < MIN_PRESENT_AXES_FOR_LENIENCY) {
    return [];
  }
  return rawMissing;
}

/**
 * Tolerantly parse a raw LLM GIANT output into normalized pieces, defaulting and
 * clamping bad values rather than throwing. Accepts unknown input (e.g. a parsed
 * JSON blob); always returns a usable {@link ParsedGiant} with all 9 axes
 * present, clamped to [0, 5], a valid archetype, and a cleaned whyNow list.
 *
 * MISSING vs LOW: an axis the model did not emit is recorded in `missingAxes`
 * (subject to the safety valve) so aggregation can treat it as "not scored"
 * rather than a genuine 0 — a formatting omission must not falsely trip a hard
 * gate or tank the composite. A GENUINE low score (the model emitted 0 or 1) is
 * NOT missing and still gates / counts as today.
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
    missingAxes: lenientMissingAxes(detectMissingAxes(source.scores)),
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
  // Honor the model's omitted axes (safety-valve-filtered by parseGiant) unless
  // the caller explicitly supplies its own missingAxes.
  const aggregate = aggregateGiant(parsed.scores, {
    ...opts,
    missingAxes: opts.missingAxes ?? parsed.missingAxes,
  });
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
