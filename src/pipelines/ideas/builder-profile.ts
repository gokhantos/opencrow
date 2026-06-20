/**
 * BUILDER PROFILE — make the competability gate RELATIVE to who is building.
 *
 * The LLM still scores the RAW, profile-INDEPENDENT incumbent moats (0..5 per
 * dimension + an overall "a small builder can win" score), exactly as before.
 * This module applies a configurable {@link BuilderProfile} as a DETERMINISTIC,
 * PURE transform at DECISION time: it DISCOUNTS the raw barriers a given builder
 * can actually absorb (capital, ops headcount, regulatory appetite, domain
 * expertise), raising the EFFECTIVE "can win" score accordingly.
 *
 * Key invariants:
 *   - The transform ONLY discounts — it never raises a barrier. Worst case the
 *     effective score equals the raw score (a profile cannot make an idea look
 *     LESS competable than the objective moats say).
 *   - The DEFAULT profile (solo bootstrapper) is the IDENTITY transform: zero
 *     discount on every dimension, so effective == raw and the existing gate
 *     behavior is preserved bit-for-bit (all prior tests pass unchanged).
 *   - PURE — no Date.now / Math.random / IO. Fully unit-testable.
 *
 * networkEffect is deliberately the HARDEST barrier to discount: a captured
 * two-sided network or social graph does not yield to capital alone — at most a
 * funded builder buys a tiny edge ({@link NETWORK_FUNDED_DISCOUNT}). Capital can
 * buy logistics/ops and absorb regulatory burden; it cannot buy an installed base.
 */

import {
  COMPETABILITY_DIMENSIONS,
  COMPETABILITY_MIN,
  type CompetabilityDecision,
  type CompetabilityDimension,
  type CompetabilityScore,
  type CompetabilityThresholds,
  clampToScoreRange,
  decideCompetability,
} from "./competability";
import { MIN_INCUMBENT_NAME_LENGTH, normalizeName } from "./incumbents";

// ── Profile value types ──────────────────────────────────────────────────────

/** How much sustained capital the builder can deploy. */
export type BuilderCapital = "none" | "bootstrap" | "seed" | "funded";
/** Appetite for entering a licensed / regulated market. */
export type RegulatoryAppetite = "none" | "low" | "high";
/** Appetite for running physical ops / fulfillment / field operations. */
export type OpsAppetite = "none" | "low" | "high";

/**
 * The builder the competability gate is evaluated FOR. All fields default to the
 * solo-bootstrapper baseline (see {@link DEFAULT_BUILDER_PROFILE}).
 */
export interface BuilderProfile {
  readonly capital: BuilderCapital;
  readonly teamSize: number;
  readonly expertiseDomains: readonly string[];
  readonly regulatoryAppetite: RegulatoryAppetite;
  readonly opsAppetite: OpsAppetite;
}

/**
 * The DEFAULT builder: a solo bootstrapper with no domain expertise, low
 * regulatory / ops appetite. This profile yields ZERO discount on every
 * dimension, so {@link applyBuilderProfile} is the IDENTITY transform for it and
 * the gate behaves exactly as it did before builder profiles existed.
 */
export const DEFAULT_BUILDER_PROFILE: BuilderProfile = {
  capital: "bootstrap",
  teamSize: 1,
  expertiseDomains: [],
  regulatoryAppetite: "low",
  opsAppetite: "low",
};

// ── Named discount constants (NO magic numbers) ──────────────────────────────
// All discounts are SUBTRACTED from a raw barrier. A larger discount LOWERS the
// barrier, which RAISES the effective "can win" overall. "bootstrap" is the
// baseline => 0 discount; "none" cannot go below baseline => also 0.

/** Capital discount applied to the `capital` moat dimension. */
export const CAPITAL_DISCOUNT: Record<BuilderCapital, number> = {
  none: 0,
  bootstrap: 0,
  seed: 1.0,
  funded: 2.5,
};

/** Regulatory-appetite discount applied to the `regulated` moat dimension. */
export const REGULATED_DISCOUNT: Record<RegulatoryAppetite, number> = {
  none: 0,
  low: 0,
  high: 2.0,
};

/** Ops-appetite discount applied to the `logistics` moat dimension. */
export const OPS_DISCOUNT: Record<OpsAppetite, number> = {
  none: 0,
  low: 0,
  high: 2.0,
};

/**
 * Extra `logistics` discount from capital alone — funded builders can BUY some
 * operational scale (3PLs, contractors). Light, and 0 for the default builder.
 */
export const CAPITAL_LOGISTICS_DISCOUNT: Record<BuilderCapital, number> = {
  none: 0,
  bootstrap: 0,
  seed: 0,
  funded: 0.5,
};

/**
 * Tiny `networkEffect` discount available ONLY to a funded builder. Network /
 * scale moats do NOT yield to capital — a captured installed base cannot be
 * bought — so capital buys at most a marginal edge here, and nothing for any
 * non-funded builder. Default => 0.
 */
export const NETWORK_FUNDED_DISCOUNT = 0.5;

/** Team-size baseline; a solo builder (teamSize 1) earns no team discount. */
export const TEAM_SIZE_BASELINE = 1;
/** `logistics` discount earned per head ABOVE the baseline. */
export const TEAM_PER_HEAD_LOGISTICS_DISCOUNT = 0.25;
/** Cap on the cumulative team-size logistics discount. */
export const TEAM_LOGISTICS_DISCOUNT_CAP = 1.5;

/**
 * Discount applied to the DOMINANT (highest raw) moat dimension when the idea's
 * text matches one of the builder's expertise domains. Default builder has no
 * expertise domains, so this never fires for the default.
 */
export const EXPERTISE_DISCOUNT = 1.5;

/**
 * How much each point of EFFECTIVE barrier reduction lifts the overall "can win"
 * score. Total lift = (sum of per-dimension reductions) * this factor. With the
 * default (identity) profile the total reduction is 0, so the overall is
 * unchanged.
 */
export const OVERALL_LIFT_PER_BARRIER_POINT = 0.25;

// ── Effective (profile-adjusted) competability ───────────────────────────────

/** The profile-adjusted competability, alongside the raw score it derives from. */
export interface EffectiveCompetability {
  readonly dimensions: Record<CompetabilityDimension, number>;
  readonly overall: number;
  readonly raw: CompetabilityScore;
  readonly matchedExpertiseDomain: string | null;
}

/** The dominant raw moat dimension (highest raw score; ties → first in order). */
function dominantDimension(
  raw: CompetabilityScore,
): CompetabilityDimension {
  let best: CompetabilityDimension = COMPETABILITY_DIMENSIONS[0];
  let bestVal = Number.NEGATIVE_INFINITY;
  for (const dim of COMPETABILITY_DIMENSIONS) {
    const v = raw.dimensions[dim] ?? COMPETABILITY_MIN;
    if (v > bestVal) {
      bestVal = v;
      best = dim;
    }
  }
  return best;
}

/** Per-head logistics discount from team size (clamped to its cap). */
function teamLogisticsDiscount(teamSize: number): number {
  const extraHeads = Math.max(0, teamSize - TEAM_SIZE_BASELINE);
  return Math.min(
    TEAM_LOGISTICS_DISCOUNT_CAP,
    extraHeads * TEAM_PER_HEAD_LOGISTICS_DISCOUNT,
  );
}

/**
 * Apply a {@link BuilderProfile} to a RAW competability score, producing the
 * EFFECTIVE (profile-adjusted) score. PURE.
 *
 * Each dimension's effective barrier = clamp(raw - totalDiscount, 0, 5), where
 * the per-dimension discount is the sum of the applicable named constants above.
 * The effective overall = clamp(raw.overall + totalReduction * lift, 0, 5),
 * where totalReduction is the (non-negative) sum of per-dimension barrier drops.
 *
 * With {@link DEFAULT_BUILDER_PROFILE} every discount is 0, so the effective
 * dimensions and overall equal the raw ones (IDENTITY).
 */
export function applyBuilderProfile(
  rawScore: CompetabilityScore,
  profile: BuilderProfile,
  opts?: { readonly matchedExpertiseDomain?: string | null },
): EffectiveCompetability {
  const matchedExpertiseDomain = opts?.matchedExpertiseDomain ?? null;
  const dominant = dominantDimension(rawScore);

  // Per-dimension discount accumulator.
  const discount: Record<CompetabilityDimension, number> = {
    capital: CAPITAL_DISCOUNT[profile.capital] ?? 0,
    networkEffect:
      profile.capital === "funded" ? NETWORK_FUNDED_DISCOUNT : 0,
    logistics:
      (OPS_DISCOUNT[profile.opsAppetite] ?? 0) +
      (CAPITAL_LOGISTICS_DISCOUNT[profile.capital] ?? 0) +
      teamLogisticsDiscount(profile.teamSize),
    regulated: REGULATED_DISCOUNT[profile.regulatoryAppetite] ?? 0,
  };

  // Expertise discount lands on the dominant raw moat dimension, only on a match.
  if (matchedExpertiseDomain !== null) {
    discount[dominant] = (discount[dominant] ?? 0) + EXPERTISE_DISCOUNT;
  }

  const dimensions = {} as Record<CompetabilityDimension, number>;
  let totalReduction = 0;
  for (const dim of COMPETABILITY_DIMENSIONS) {
    const rawDim = clampToScoreRange(rawScore.dimensions[dim] ?? COMPETABILITY_MIN);
    const effDim = clampToScoreRange(rawDim - (discount[dim] ?? 0));
    dimensions[dim] = effDim;
    totalReduction += rawDim - effDim; // >= 0 (discounts only lower the barrier)
  }

  const overall = clampToScoreRange(
    clampToScoreRange(rawScore.overall) +
      totalReduction * OVERALL_LIFT_PER_BARRIER_POINT,
  );

  return { dimensions, overall, raw: rawScore, matchedExpertiseDomain };
}

// ── Expertise matching (PURE) ────────────────────────────────────────────────

/**
 * Whether `ideaText` matches one of the builder's `expertiseDomains`. Matching is
 * case-insensitive and whole-word (reuses {@link normalizeName} + the same
 * space-padding technique as `mentionsIncumbent`), so "fintech" matches
 * "A fintech tool" but not "unfintechy". Returns the FIRST matching domain in its
 * ORIGINAL casing, or null. Trivially-short / empty domains never match. PURE.
 */
export function matchExpertiseDomain(
  ideaText: string,
  expertiseDomains: readonly string[],
): string | null {
  if (expertiseDomains.length === 0) return null;
  const normalized = normalizeName(ideaText);
  if (normalized.length < MIN_INCUMBENT_NAME_LENGTH) return null;
  const padded = ` ${normalized} `;
  for (const domain of expertiseDomains) {
    const term = normalizeName(domain);
    if (term.length < MIN_INCUMBENT_NAME_LENGTH) continue;
    if (padded.includes(` ${term} `)) return domain;
  }
  return null;
}

// ── Human-readable description for the LLM prompt (CONTEXT only) ──────────────

function joinWithAnd(items: readonly string[]): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * A short, NEUTRAL one-sentence description of the builder, for injection as
 * CONTEXT into the scoring prompt. It does NOT instruct the model to do profile
 * math — the model still scores objective, profile-independent barriers; this
 * just tells it WHO the gate is for. PURE / deterministic.
 */
export function describeBuilderProfile(profile: BuilderProfile): string {
  const team =
    profile.teamSize <= 1
      ? "solo"
      : `a team of ${profile.teamSize}`;
  const capital =
    profile.capital === "bootstrap"
      ? "bootstrapper"
      : profile.capital === "none"
        ? "unfunded builder"
        : `${profile.capital}-funded builder`;

  const lead =
    profile.teamSize <= 1 && profile.capital === "bootstrap"
      ? "a solo bootstrapper"
      : `${team} ${capital}`;

  const clauses: string[] = [];
  if (profile.expertiseDomains.length > 0) {
    clauses.push(
      `domain expertise in ${joinWithAnd(profile.expertiseDomains)}`,
    );
  }
  if (profile.regulatoryAppetite === "high") {
    clauses.push("a high regulatory appetite");
  }
  if (profile.opsAppetite === "high") {
    clauses.push("a high operations appetite");
  }

  const tail = clauses.length > 0 ? ` with ${joinWithAnd(clauses)}` : "";
  return `The builder is ${lead}${tail}.`;
}

// ── Convenience: decide directly on the effective score ──────────────────────

/**
 * Apply the profile then run the non-compensatory gate decision on the EFFECTIVE
 * score. Used at BOTH gate call sites so the pipeline and SIGE stay consistent.
 * Returns the effective score (for persistence) alongside the decision.
 */
export function decideCompetabilityForProfile(
  rawScore: CompetabilityScore,
  profile: BuilderProfile,
  thresholds: CompetabilityThresholds = {},
  opts?: { readonly matchedExpertiseDomain?: string | null },
): {
  readonly effective: EffectiveCompetability;
  readonly decision: CompetabilityDecision;
} {
  const effective = applyBuilderProfile(rawScore, profile, opts);
  const effectiveScore: CompetabilityScore = {
    dimensions: effective.dimensions,
    overall: effective.overall,
    rationale: rawScore.rationale,
  };
  const decision = decideCompetability(effectiveScore, thresholds);
  return { effective, decision };
}
