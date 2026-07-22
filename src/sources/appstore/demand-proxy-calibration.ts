/**
 * Batch E — calibration: how well does the ratings/day demand proxy
 * (`appstore_keyword_scans.demand`) track Apple's own ground-truth
 * `searchPopularity` score (`appstore_search_popularity`, `source='asa'`)?
 *
 * The 2026-07-20 28-term US ASA sweep found 27/28 terms at popularity 1,
 * contradicting the demand proxy for most of them — this module computes the
 * actual Spearman rank correlation over whatever keywords have BOTH a demand
 * scan and a manually-probed ASA reading, so the mismatch is a measured
 * number instead of a one-off anecdote. Pure/DB-free — the DB join lives in
 * `scripts/calibrate-demand-proxy.ts`.
 */

export interface CalibrationSample {
  readonly keyword: string;
  /** `appstore_keyword_scans.demand` — ratings/day proxy. */
  readonly demand: number;
  /** `appstore_search_popularity.value` — Apple's 0..5 ground truth. */
  readonly asaPopularity: number;
}

export interface CalibrationResult {
  readonly sampleSize: number;
  /**
   * Spearman rank correlation coefficient (-1..1), or `null` if there are
   * fewer than 2 samples, or either variable has zero variance (e.g. every
   * sampled popularity reading is identical — correlation is undefined, not
   * zero, in that case).
   */
  readonly spearmanRho: number | null;
  readonly samples: readonly CalibrationSample[];
}

/**
 * 1-based ranks with ties resolved to the average rank of the tied group
 * (the standard Spearman tie-handling convention) — e.g. `[10, 20, 20, 30]`
 * ranks to `[1, 2.5, 2.5, 4]`.
 */
function rankOf(values: readonly number[]): readonly number[] {
  const indexed = values.map((v, i) => ({ v, i }));
  indexed.sort((a, b) => a.v - b.v);

  const ranks = new Array<number>(values.length).fill(0);
  let i = 0;
  while (i < indexed.length) {
    let j = i;
    while (j + 1 < indexed.length && indexed[j + 1]?.v === indexed[i]?.v) j++;
    const avgRank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) {
      const entry = indexed[k];
      if (entry) ranks[entry.i] = avgRank;
    }
    i = j + 1;
  }
  return ranks;
}

/** Pearson correlation over two equal-length numeric series. `null` if undefined (n<2 or zero variance). */
function pearson(x: readonly number[], y: readonly number[]): number | null {
  const n = x.length;
  if (n < 2 || y.length !== n) return null;

  const meanX = x.reduce((a, b) => a + b, 0) / n;
  const meanY = y.reduce((a, b) => a + b, 0) / n;

  let numerator = 0;
  let denomX = 0;
  let denomY = 0;
  for (let i = 0; i < n; i++) {
    const dx = (x[i] ?? 0) - meanX;
    const dy = (y[i] ?? 0) - meanY;
    numerator += dx * dy;
    denomX += dx * dx;
    denomY += dy * dy;
  }
  if (denomX === 0 || denomY === 0) return null;
  return numerator / Math.sqrt(denomX * denomY);
}

/**
 * Spearman rank correlation between `demand` and `asaPopularity` over
 * `samples` — Pearson correlation of the two variables' ranks. `samples` is
 * echoed back unchanged for the caller's own reporting (e.g. printing the
 * worst-disagreeing rows).
 */
export function computeSpearmanCorrelation(
  samples: readonly CalibrationSample[],
): CalibrationResult {
  if (samples.length < 2) {
    return { sampleSize: samples.length, spearmanRho: null, samples };
  }
  const demandRanks = rankOf(samples.map((s) => s.demand));
  const popularityRanks = rankOf(samples.map((s) => s.asaPopularity));
  return {
    sampleSize: samples.length,
    spearmanRho: pearson(demandRanks, popularityRanks),
    samples,
  };
}

const STRONG_THRESHOLD = 0.5;
const WEAK_THRESHOLD = 0.2;

function verdictFor(rho: number | null): string {
  if (rho === null) {
    return "Undefined (fewer than 2 samples, or no variance in one variable — cannot compute a correlation).";
  }
  const magnitude = Math.abs(rho);
  if (magnitude >= STRONG_THRESHOLD) {
    return `${rho > 0 ? "Positive" : "Negative"} and reasonably strong — the demand proxy tracks ASA ground truth over this sample.`;
  }
  if (magnitude >= WEAK_THRESHOLD) {
    return "Weak — the demand proxy only loosely tracks ASA ground truth over this sample.";
  }
  return "Near zero — the demand proxy shows essentially NO relationship to ASA ground truth over this sample. Treat ratings/day-derived demand as an unvalidated proxy, not a trustworthy volume signal, until coverage grows.";
}

/** Human-readable report for CLI output — table of samples + the correlation + a plain-English verdict. */
export function formatCalibrationReport(result: CalibrationResult): string {
  const header = `Demand-proxy vs ASA-popularity calibration — ${result.sampleSize} probed keyword(s)`;
  const rho =
    result.spearmanRho === null ? "n/a" : result.spearmanRho.toFixed(3);
  const rows = [...result.samples]
    .sort((a, b) => b.demand - a.demand)
    .map(
      (s) =>
        `  ${s.keyword.padEnd(30)} demand=${s.demand.toFixed(2).padStart(8)}  asa=${s.asaPopularity}/5`,
    );

  return [
    header,
    `Spearman rho: ${rho}`,
    verdictFor(result.spearmanRho),
    "",
    ...rows,
  ].join("\n");
}
