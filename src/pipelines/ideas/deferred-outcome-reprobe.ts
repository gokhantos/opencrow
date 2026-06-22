/**
 * deferred-outcome-reprobe.ts — the PURE decision core of the deferred outcome
 * re-probe (Phase 2). Given the baseline (validation-time) and current
 * (re-probed) demand artifacts plus the configured deltas, classify how demand
 * moved and map that to a superseding outcome verdict.
 *
 * No I/O, no clock, no mem0 — the scheduler supplies both artifacts and applies
 * the result. The KEY correctness guard: a "grew"/"decayed" verdict is only
 * trustworthy when BOTH demand artifacts cleared the ABSENCE FLOOR (confidence >
 * {@link ABSENCE_CONFIDENCE_CAP}). If EITHER side is sitting at the absence floor,
 * the demand probes found ~no evidence on that side, so the delta is noise — we
 * return "inconclusive" and the scheduler records the row WITHOUT building a
 * superseding memory (the original verdict stands).
 */

import { ABSENCE_CONFIDENCE_CAP, type DemandArtifact } from "./demand";

/** How demand moved between validation and the deferred re-probe. */
export type ReprobeLabel = "grew" | "flat" | "decayed" | "inconclusive";

/** The terminal verdict a non-inconclusive re-probe maps to. */
export type ReprobeVerdict = "validated" | "archived" | "stored-pending";

/** Knobs for {@link reprobeLabelFromDelta}. */
export interface ReprobeDeltaOptions {
  /** Score delta (current − baseline) at/above which demand "grew". */
  readonly scoreDeltaGrew: number;
  /** Score delta at/below which demand "decayed". */
  readonly scoreDeltaDecayed: number;
}

/** The full classification of one re-probe. */
export interface ReprobeClassification {
  readonly label: ReprobeLabel;
  /** current.score − baseline.score (always computed, even when inconclusive). */
  readonly scoreDelta: number;
  /** The verdict to supersede with, or null when inconclusive (leave verdict intact). */
  readonly verdict: ReprobeVerdict | null;
  /** "reprobe:grew" | "reprobe:flat" | "reprobe:decayed", or null when inconclusive. */
  readonly verdictSource: string | null;
}

/**
 * Does this demand artifact clear the absence floor? A confidence at/below
 * {@link ABSENCE_CONFIDENCE_CAP} means the probes found essentially no evidence,
 * so any score it carries is the absence-regime floor, not a real measurement.
 * PURE.
 */
export function clearsAbsenceFloor(artifact: DemandArtifact | null | undefined): boolean {
  return artifact !== null && artifact !== undefined && artifact.confidence > ABSENCE_CONFIDENCE_CAP;
}

/** Map a non-inconclusive label to its superseding verdict + verdictSource. PURE. */
function verdictForLabel(label: Exclude<ReprobeLabel, "inconclusive">): {
  readonly verdict: ReprobeVerdict;
  readonly verdictSource: string;
} {
  switch (label) {
    case "grew":
      return { verdict: "validated", verdictSource: "reprobe:grew" };
    case "decayed":
      return { verdict: "archived", verdictSource: "reprobe:decayed" };
    case "flat":
      return { verdict: "stored-pending", verdictSource: "reprobe:flat" };
  }
}

/**
 * Classify how demand moved between the baseline (validation-time) and current
 * (re-probed) artifacts and map it to a superseding verdict.
 *
 *   - If EITHER artifact is at the absence floor → "inconclusive", verdict null
 *     (the original proxy verdict stands; the scheduler records the row only).
 *   - Else: grew when delta >= scoreDeltaGrew; decayed when delta <=
 *     scoreDeltaDecayed; flat otherwise.
 *
 * `scoreDelta` (current − baseline) is always returned for the audit row. PURE.
 */
export function reprobeLabelFromDelta(
  baseline: DemandArtifact | null | undefined,
  current: DemandArtifact | null | undefined,
  opts: ReprobeDeltaOptions,
): ReprobeClassification {
  const baseScore = baseline?.score ?? 0;
  const currScore = current?.score ?? 0;
  const scoreDelta = currScore - baseScore;

  // Absence-floor guard: a delta is only trustworthy when BOTH sides measured
  // real demand. Otherwise the move is noise — leave the original verdict intact.
  if (!clearsAbsenceFloor(baseline) || !clearsAbsenceFloor(current)) {
    return { label: "inconclusive", scoreDelta, verdict: null, verdictSource: null };
  }

  const label: Exclude<ReprobeLabel, "inconclusive"> =
    scoreDelta >= opts.scoreDeltaGrew ? "grew" : scoreDelta <= opts.scoreDeltaDecayed ? "decayed" : "flat";

  const { verdict, verdictSource } = verdictForLabel(label);
  return { label, scoreDelta, verdict, verdictSource };
}
