/**
 * zero-yield.ts — pure detection of an ideas-pipeline run that finished
 * without producing anything, so it can stop presenting as a success.
 *
 * The failure this closes: run `2f00f949` (2026-07-19) recorded
 * `status: "completed"`, `totalIdeasGenerated: 0`, and a 824,914ms duration.
 * Every collector succeeded, the `synthesis` step burned 406s and emitted zero
 * candidates, and the dashboard rendered the run green. A total failure of the
 * consumption side was indistinguishable from a slow day — which is precisely
 * why nobody noticed the pipeline had stopped producing.
 *
 * Three distinct zero-yield shapes are separated because they have different
 * causes and different fixes:
 *   - `no_fresh_signals`   — nothing to synthesize from (all sources already
 *                            consumed). Benign-ish, but still not a success.
 *   - `synthesis_empty`    — real signals went in, zero candidates came out.
 *                            The expensive, alarming case.
 *   - `all_ideas_rejected` — synthesis produced candidates but every one was
 *                            dropped by dedup/quality gates.
 *
 * There is existing precedent in `pipeline.ts` for refusing to call an empty
 * run a success: the "Resume hollow-success guard" already calls
 * `markRunFailed` when a resume replay produces empty collectors despite
 * completed checkpoints. This module generalizes that instinct to the normal
 * (non-resume) terminal paths, using a dedicated `"empty"` terminal status
 * rather than `"failed"` so a genuine crash stays distinguishable from a run
 * that executed cleanly and simply yielded nothing.
 *
 * Pure and dependency-free so it is fully unit-testable.
 */

export type ZeroYieldReason = "no_fresh_signals" | "synthesis_empty" | "all_ideas_rejected";

/** The subset of a run's result summary this detection needs. */
export interface ZeroYieldInput {
  readonly totalIdeasGenerated: number;
  readonly totalIdeasKept: number;
  readonly totalSignalsFound: number;
  readonly durationMs: number;
}

export interface ZeroYieldVerdict {
  readonly isZeroYield: boolean;
  readonly reason: ZeroYieldReason | null;
  /** Operator-facing one-liner, suitable for the run record's `error` column. */
  readonly message: string | null;
}

const HEALTHY: ZeroYieldVerdict = Object.freeze({
  isZeroYield: false,
  reason: null,
  message: null,
});

/** Coerce a possibly-NaN/negative count to a safe non-negative integer. */
function safeCount(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/**
 * Classify a finished run's yield. A run is zero-yield when it kept no ideas —
 * the pipeline's entire contract is "produce ideas", so keeping none is the
 * outcome that matters regardless of how many intermediate candidates existed.
 */
export function detectZeroYield(input: ZeroYieldInput): ZeroYieldVerdict {
  const generated = safeCount(input.totalIdeasGenerated);
  const kept = safeCount(input.totalIdeasKept);
  const signals = safeCount(input.totalSignalsFound);

  if (kept > 0) return HEALTHY;

  if (generated > 0) {
    return {
      isZeroYield: true,
      reason: "all_ideas_rejected",
      message: `Zero-yield run: synthesis produced ${generated} candidates but 0 survived dedup/quality gates`,
    };
  }

  if (signals === 0) {
    return {
      isZeroYield: true,
      reason: "no_fresh_signals",
      message:
        "Zero-yield run: no fresh signals were available, so synthesis was skipped and 0 ideas were produced",
    };
  }

  return {
    isZeroYield: true,
    reason: "synthesis_empty",
    message: `Zero-yield run: ${signals} signals were collected but synthesis emitted 0 ideas`,
  };
}

/** Render `durationMs` as a legible minutes figure (raw ms is unreadable in an alert). */
function formatDuration(durationMs: number): string {
  const ms = Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 0;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)} min`;
}

export interface ZeroYieldAlertParams {
  readonly pipelineId: string;
  readonly runId: string;
  readonly verdict: ZeroYieldVerdict;
  readonly input: ZeroYieldInput;
}

/**
 * Render the operator notification for a zero-yield run. Returns `""` for a
 * healthy run so the caller can treat "nothing to say" uniformly (same
 * contract as `gap-alerts.ts`'s `formatGapAlertsDigest`).
 */
export function formatZeroYieldAlert(params: ZeroYieldAlertParams): string {
  const { pipelineId, runId, verdict, input } = params;
  if (!verdict.isZeroYield) return "";

  return [
    "⚠️ Ideas pipeline produced NOTHING",
    "",
    `pipeline: ${pipelineId}`,
    `run:      ${runId}`,
    `reason:   ${verdict.reason}`,
    `duration: ${formatDuration(input.durationMs)}`,
    `signals:  ${safeCount(input.totalSignalsFound)}`,
    `generated:${safeCount(input.totalIdeasGenerated)}  kept: ${safeCount(input.totalIdeasKept)}`,
    "",
    verdict.message ?? "",
  ].join("\n");
}
