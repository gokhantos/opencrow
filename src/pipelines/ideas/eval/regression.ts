/**
 * Pure regression-alert comparison for the ideas eval harness.
 *
 * Compares the latest run-level aggregate against a trailing baseline (the mean
 * of the N preceding eval snapshots) and flags metrics that have regressed by
 * more than a relative/absolute tolerance. Direction-aware: for "higher is
 * better" metrics (novelty, validation rate) a DROP is a regression; for
 * "lower is better" metrics (killed rate) a RISE is a regression.
 *
 * PURE — no DB, no clock. The DB-backed harness supplies the trailing snapshots.
 */

import type { EvalAggregate } from "./aggregate";
export type { EvalAggregate } from "./aggregate";

// ── Metric direction ───────────────────────────────────────────────────────────

export type MetricDirection = "higher_is_better" | "lower_is_better";

/** A single comparable scalar extracted from an EvalAggregate. */
export interface MetricSnapshot {
  readonly key: string;
  readonly value: number | null;
  readonly direction: MetricDirection;
}

/** The set of metrics we regression-track, in a stable order. */
export const TRACKED_METRICS: readonly {
  readonly key: string;
  readonly direction: MetricDirection;
  readonly extract: (a: EvalAggregate) => number | null;
}[] = [
  { key: "meanNovelty", direction: "higher_is_better", extract: (a) => a.meanSubscores.novelty },
  { key: "meanFeasibility", direction: "higher_is_better", extract: (a) => a.meanSubscores.feasibility },
  { key: "meanSignalGrounding", direction: "higher_is_better", extract: (a) => a.meanSubscores.signalGrounding },
  { key: "validatedRate", direction: "higher_is_better", extract: (a) => a.outcomeRates.validatedRate },
  { key: "humanValidatedRate", direction: "higher_is_better", extract: (a) => a.outcomeRates.humanValidatedRate },
  { key: "killedRate", direction: "lower_is_better", extract: (a) => a.outcomeRates.killedRate },
  { key: "dedupF1", direction: "higher_is_better", extract: (a) => a.dedupQuality?.f1 ?? null },
  {
    key: "demandCoverage",
    direction: "higher_is_better",
    extract: (a) => a.demand?.demandCoverage ?? null,
  },
  {
    key: "signalRankerLift",
    direction: "higher_is_better",
    extract: (a) => a.signalRanker?.lift ?? null,
  },
  {
    key: "signalRankerHighTierRate",
    direction: "higher_is_better",
    extract: (a) => a.signalRanker?.highTierRate ?? null,
  },
  {
    // Hardened-SIGE GIANT lift vs self-critique. Higher = the jury pulls the
    // GIANT axes up; a drop relative to baseline means the SIGE advantage is
    // eroding. null on default (SIGE-off) runs so it never alerts there.
    key: "sigeLift",
    direction: "higher_is_better",
    extract: (a) => a.sigeAb?.sigeLift ?? null,
  },
  {
    // Groundedness delta (demand axis) of SIGE vs self-critique. MUST stay
    // flat-or-up: a regression here means SIGE is buying lift with hallucinated
    // demand. Tracked as higher_is_better so any drop trips an alert.
    key: "sigeGroundednessDelta",
    direction: "higher_is_better",
    extract: (a) => a.sigeAb?.groundednessDelta ?? null,
  },
];

/** Extract the tracked metric snapshots from an aggregate. */
export function extractMetrics(aggregate: EvalAggregate): readonly MetricSnapshot[] {
  return TRACKED_METRICS.map((m) => ({
    key: m.key,
    value: m.extract(aggregate),
    direction: m.direction,
  }));
}

// ── Baseline ───────────────────────────────────────────────────────────────────

/**
 * Reduce a trailing window of aggregates into a per-metric baseline mean.
 * Null metric values are skipped so a metric only baselines on runs that had it.
 * Returns a map key → { mean, count }.
 */
export function computeBaseline(
  trailing: readonly EvalAggregate[],
): ReadonlyMap<string, { readonly mean: number; readonly count: number }> {
  const buckets = new Map<string, number[]>();

  for (const agg of trailing) {
    for (const snap of extractMetrics(agg)) {
      if (snap.value === null) continue;
      const arr = buckets.get(snap.key) ?? [];
      arr.push(snap.value);
      buckets.set(snap.key, arr);
    }
  }

  const out = new Map<string, { mean: number; count: number }>();
  for (const [key, values] of buckets) {
    if (values.length === 0) continue;
    const mean = values.reduce((s, v) => s + v, 0) / values.length;
    out.set(key, { mean, count: values.length });
  }
  return out;
}

// ── Alert detection ────────────────────────────────────────────────────────────

export interface RegressionAlert {
  readonly metric: string;
  readonly direction: MetricDirection;
  readonly current: number;
  readonly baseline: number;
  /** Signed delta = current - baseline. */
  readonly delta: number;
  /** Relative change vs baseline (|delta| / |baseline|); null when baseline≈0. */
  readonly relativeChange: number | null;
  readonly severity: "warning" | "critical";
}

export interface RegressionOptions {
  /**
   * Minimum absolute worsening to flag (guards against noise on tiny scales).
   * Default 0.05.
   */
  readonly minAbsoluteDrop?: number;
  /**
   * Minimum relative worsening (fraction of baseline) to flag. Default 0.1 (10%).
   * A metric must breach BOTH the absolute and relative thresholds to alert.
   */
  readonly minRelativeDrop?: number;
  /** Relative worsening at/above which the alert is 'critical'. Default 0.25. */
  readonly criticalRelativeDrop?: number;
  /** Minimum trailing observations a metric needs before it can alert. Default 1. */
  readonly minBaselineCount?: number;
}

const DEFAULT_REGRESSION_OPTIONS: Required<RegressionOptions> = {
  minAbsoluteDrop: 0.05,
  minRelativeDrop: 0.1,
  criticalRelativeDrop: 0.25,
  minBaselineCount: 1,
};

/**
 * Signed "worsening" amount for a metric given its direction. A POSITIVE result
 * means the metric got worse by that much; <= 0 means it improved or held.
 */
function worsening(
  direction: MetricDirection,
  current: number,
  baseline: number,
): number {
  // higher_is_better: worse when current < baseline → baseline - current
  // lower_is_better:  worse when current > baseline → current - baseline
  return direction === "higher_is_better"
    ? baseline - current
    : current - baseline;
}

/**
 * Compare a current aggregate against a trailing baseline window and return the
 * list of regressed metrics. Empty list = no regression. Pure.
 */
export function detectRegressions(
  current: EvalAggregate,
  trailing: readonly EvalAggregate[],
  options?: RegressionOptions,
): readonly RegressionAlert[] {
  const opts = { ...DEFAULT_REGRESSION_OPTIONS, ...options };
  const baseline = computeBaseline(trailing);
  const alerts: RegressionAlert[] = [];

  for (const snap of extractMetrics(current)) {
    if (snap.value === null) continue;
    const base = baseline.get(snap.key);
    if (!base || base.count < opts.minBaselineCount) continue;

    const worse = worsening(snap.direction, snap.value, base.mean);
    if (worse <= 0) continue; // improved or flat

    const relative =
      Math.abs(base.mean) > 1e-9 ? worse / Math.abs(base.mean) : null;

    const absoluteBreached = worse >= opts.minAbsoluteDrop;
    // When baseline≈0 there is no meaningful relative scale; rely on absolute.
    const relativeBreached =
      relative === null ? true : relative >= opts.minRelativeDrop;

    if (!absoluteBreached || !relativeBreached) continue;

    const severity: RegressionAlert["severity"] =
      relative !== null && relative >= opts.criticalRelativeDrop
        ? "critical"
        : "warning";

    alerts.push({
      metric: snap.key,
      direction: snap.direction,
      current: snap.value,
      baseline: round4(base.mean),
      delta: round4(snap.value - base.mean),
      relativeChange: relative === null ? null : round4(relative),
      severity,
    });
  }

  return alerts;
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}
