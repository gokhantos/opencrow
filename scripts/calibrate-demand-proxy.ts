/**
 * Batch E, item E4 — reports the Spearman rank correlation between the
 * ratings/day demand proxy (`appstore_keyword_scans.demand`) and the
 * manually-imported ASA ground truth (`appstore_search_popularity`,
 * `source='asa'`) over every keyword that has BOTH. Read-only; safe to
 * re-run any time as more ASA rows get manually imported (see `POST
 * /appstore/search-popularity`) — coverage only grows.
 *
 * The 2026-07-20 28-term US sweep found 27/28 terms at ASA popularity 1,
 * contradicting the demand proxy for most of them; this script turns that
 * anecdote into a measured number instead of leaving the proxy trusted
 * blind.
 *
 * Usage:
 *   bun run scripts/calibrate-demand-proxy.ts
 */

import { loadConfig } from "../src/config/loader";
import { initDb, getDb } from "../src/store/db";
import { createLogger } from "../src/logger";
import { getErrorMessage } from "../src/lib/error-serialization";
import {
  computeSpearmanCorrelation,
  formatCalibrationReport,
  type CalibrationSample,
} from "../src/sources/appstore/demand-proxy-calibration";

const log = createLogger("calibrate-demand-proxy");

interface CalibrationRow {
  readonly keyword: string;
  readonly demand: number | string;
  readonly asa_popularity: number | string;
}

/**
 * One row per keyword that has both an ASA popularity reading (any
 * storefront — most recent by `checked_at` wins) and a latest 'app'-store
 * demand scan. `DISTINCT ON (p.keyword)` collapses multi-storefront ASA
 * readings to the freshest one per keyword.
 */
async function loadCalibrationSamples(): Promise<readonly CalibrationSample[]> {
  const db = getDb();
  const rows = await db`
    SELECT DISTINCT ON (p.keyword) p.keyword, s.demand, p.value AS asa_popularity
    FROM appstore_search_popularity p
    JOIN LATERAL (
      SELECT demand FROM appstore_keyword_scans
      WHERE keyword = p.keyword AND store = 'app'
      ORDER BY scanned_at DESC
      LIMIT 1
    ) s ON true
    WHERE p.source = 'asa'
    ORDER BY p.keyword, p.checked_at DESC
  `;
  return (rows as CalibrationRow[]).map((r) => ({
    keyword: r.keyword,
    demand: Number(r.demand),
    asaPopularity: Number(r.asa_popularity),
  }));
}

async function main(): Promise<void> {
  log.info("Calibration script starting");

  const config = loadConfig();
  await initDb(config.postgres.url, { max: config.postgres.max });
  getDb();

  const samples = await loadCalibrationSamples();
  if (samples.length === 0) {
    console.log(
      "No keywords have both a demand scan and a manually-imported ASA popularity reading yet.\n" +
        "Import some via POST /appstore/search-popularity, then re-run this script.",
    );
    process.exit(0);
  }

  const result = computeSpearmanCorrelation(samples);
  console.log(formatCalibrationReport(result));

  log.info("Calibration complete", { sampleSize: result.sampleSize, rho: result.spearmanRho });
  process.exit(0);
}

main().catch((err) => {
  log.error("Calibration script failed", { error: getErrorMessage(err) });
  process.exit(1);
});
