/**
 * MAIN-pipeline independent-jury penalty.
 *
 * `quality_score` is otherwise a pure pass-through of the giant composite that
 * the SAME LLM that wrote the idea emitted in Pass-3 self-critique — a
 * self-serving grade with no independent check. This module wires the existing
 * cross-family jury (jury.ts) into the MAIN pipeline (the SIGE path already has
 * its own jury merge in pipeline-runner.ts; this is the non-SIGE counterpart)
 * and blends the jury verdict into `quality_score` under a ONE-SIDED min-lean
 * rule: the jury may only PENALIZE a self-inflated idea, never INFLATE one.
 *
 * The penalty MATH is a pure, deterministic, exported function
 * ({@link applyMinLeanPenalty}) so it is unit-testable without any LLM call.
 * The orchestration ({@link applyIndependentJuryPenalty}) anonymizes, judges,
 * fuses, and re-derives each candidate's quality — and is a graceful no-op when
 * no judge provider key is configured (the common local case): it returns the
 * candidates UNCHANGED, never zeroed, and never throws.
 */

import { createLogger } from "../../logger";
import {
  type JudgeModel,
  type JudgeWithJuryOptions,
  anonymizeCandidates,
  fuseJury,
  judgeWithJury,
} from "./jury";
import { candidateJoinId } from "./pipeline-sige-math";
import { compositeToQualityScore } from "./synthesizer";
import type { GeneratedIdeaCandidate } from "./types";

const log = createLogger("ideas-jury");

/** Default min-lean penalty weight λ (see {@link applyMinLeanPenalty}). */
export const DEFAULT_JURY_PENALTY_WEIGHT = 0.7;

/**
 * The giant composite that backs a candidate's current `qualityScore`, on a
 * 0..5 scale. `giantComposite` is the canonical field; fall back to the
 * already-clamped `qualityScore` when an older candidate lacks it.
 */
export function giantCompositeOf(c: GeneratedIdeaCandidate): number {
  const composite = c.giantComposite ?? c.qualityScore;
  return Number.isFinite(composite) ? composite : 0;
}

/**
 * One-sided MIN-LEAN penalty (PURE, deterministic). The independent jury may
 * only pull a self-inflated quality score DOWN toward its own verdict, never
 * up:
 *
 *   penalized = giant − λ · agreementWeight · max(0, giant − jury)
 *
 * - When `jury >= giant` the `max(0, …)` term is 0 ⇒ result === giant (NO
 *   inflation, even if the jury rates the idea higher).
 * - The pull is PROPORTIONAL to the gap `(giant − jury)` and WEIGHTED by the
 *   jury's confidence `agreementWeight` (juryAgreement ∈ [0,1]): a unanimous
 *   jury penalizes at full strength, a split jury penalizes weakly.
 * - λ (default {@link DEFAULT_JURY_PENALTY_WEIGHT}) tunes the maximum pull: at
 *   λ=1 and full agreement the score is pulled all the way to the jury; at the
 *   0.7 default a confident jury closes 70% of the gap.
 * - Result is clamped to 0..5 (same range {@link compositeToQualityScore}
 *   guarantees), and non-finite inputs degrade to a safe value rather than NaN.
 */
export function applyMinLeanPenalty(
  giantComposite: number,
  juryScore: number,
  juryAgreement: number,
  lambda: number = DEFAULT_JURY_PENALTY_WEIGHT,
): number {
  const giant = Number.isFinite(giantComposite) ? giantComposite : 0;
  // A non-finite jury score (parse failure) must NOT move the giant composite.
  if (!Number.isFinite(juryScore)) return compositeToQualityScore(giant);

  const agreementWeight = Number.isFinite(juryAgreement)
    ? Math.min(1, Math.max(0, juryAgreement))
    : 0;
  const lam = Number.isFinite(lambda) ? Math.max(0, lambda) : DEFAULT_JURY_PENALTY_WEIGHT;

  // One-sided: only the SHORTFALL (giant above the jury) is penalized.
  const shortfall = Math.max(0, giant - juryScore);
  const penalized = giant - lam * agreementWeight * shortfall;
  return compositeToQualityScore(penalized);
}

/** Per-run stats for observability (logged by the caller). */
export interface JuryPenaltyStats {
  /** Number of judge providers that actually returned a verdict. */
  readonly judges: number;
  /** How many distinct candidates received a fused verdict. */
  readonly verdicts: number;
  /** Mean inter-judge agreement across verdicts, [0,1]. */
  readonly meanAgreement: number;
  /** How many candidates had their quality pulled DOWN by the jury. */
  readonly penalized: number;
  /** Mean DOWNWARD penalty (giant − penalized) over penalized candidates. */
  readonly meanPenalty: number;
}

const EMPTY_STATS: JuryPenaltyStats = {
  judges: 0,
  verdicts: 0,
  meanAgreement: 0,
  penalized: 0,
  meanPenalty: 0,
};

export interface ApplyJuryPenaltyResult {
  readonly candidates: readonly GeneratedIdeaCandidate[];
  readonly stats: JuryPenaltyStats;
}

export interface ApplyJuryPenaltyOptions extends JudgeWithJuryOptions {
  /** Min-lean penalty weight λ. Defaults to {@link DEFAULT_JURY_PENALTY_WEIGHT}. */
  readonly lambda?: number;
}

/**
 * Run the independent cross-family jury over `candidates` and apply the
 * one-sided min-lean penalty to each candidate's `qualityScore`. Returns NEW
 * candidate objects (immutable); inputs are never mutated.
 *
 * Graceful degradation (never throws, never zeroes):
 * - Empty `panel` ⇒ candidates returned UNCHANGED.
 * - No judge provider key (jury returns no verdicts) ⇒ UNCHANGED.
 * - Any judging/parsing error ⇒ UNCHANGED.
 *
 * Reuses {@link candidateJoinId} / {@link anonymizeCandidates} so the verdicts
 * join back to the caller's candidates exactly as the SIGE path does.
 */
export async function applyIndependentJuryPenalty(
  candidates: readonly GeneratedIdeaCandidate[],
  panel: readonly JudgeModel[],
  opts: ApplyJuryPenaltyOptions = {},
): Promise<ApplyJuryPenaltyResult> {
  if (candidates.length === 0 || panel.length === 0) {
    return { candidates, stats: EMPTY_STATS };
  }

  const lambda = opts.lambda ?? DEFAULT_JURY_PENALTY_WEIGHT;
  const { lambda: _omit, ...juryOpts } = opts;
  void _omit;

  try {
    const rawCands = candidates.map((c) => ({
      id: candidateJoinId(c.title),
      title: c.title,
      description: c.summary,
    }));
    const juryRaw = await judgeWithJury(anonymizeCandidates(rawCands), panel, juryOpts);

    if (juryRaw.length === 0) {
      log.info("independent jury: no judge available — quality unchanged", {
        candidates: candidates.length,
      });
      return { candidates, stats: EMPTY_STATS };
    }

    const verdicts = fuseJury(juryRaw);
    const verdictById = new Map(verdicts.map((v) => [v.candidateId, v] as const));

    let penalizedCount = 0;
    let penaltySum = 0;

    const updated = candidates.map((c) => {
      const verdict = verdictById.get(candidateJoinId(c.title));
      if (verdict === undefined) return c;

      const giant = giantCompositeOf(c);
      const next = applyMinLeanPenalty(giant, verdict.juryScore, verdict.juryAgreement, lambda);
      const delta = compositeToQualityScore(giant) - next;
      // Strictly-downward moves only (the rule is one-sided); ignore float noise.
      if (delta > 1e-9) {
        penalizedCount += 1;
        penaltySum += delta;
      }
      return next === c.qualityScore ? c : { ...c, qualityScore: next };
    });

    const meanAgreement =
      verdicts.length > 0 ? verdicts.reduce((s, v) => s + v.juryAgreement, 0) / verdicts.length : 0;

    const stats: JuryPenaltyStats = {
      judges: juryRaw.length,
      verdicts: verdicts.length,
      meanAgreement: Number(meanAgreement.toFixed(3)),
      penalized: penalizedCount,
      meanPenalty: penalizedCount > 0 ? Number((penaltySum / penalizedCount).toFixed(3)) : 0,
    };

    log.info("independent jury penalty applied", {
      candidates: candidates.length,
      ...stats,
      lambda,
    });

    return { candidates: updated, stats };
  } catch (err) {
    log.warn("independent jury failed — quality unchanged", { err });
    return { candidates, stats: EMPTY_STATS };
  }
}
