/**
 * Tracks which source data points have been consumed by pipeline runs.
 * Consumed signals are excluded from future collector queries so each
 * run sees fresh data. Signals expire after 30 days.
 */
import { getDb } from "../../store/db";
import { createLogger } from "../../logger";

const log = createLogger("pipeline:consumption");

const EXPIRY_SECONDS = 30 * 24 * 3600; // 30 days

/**
 * Get IDs already consumed from a source table (within expiry window).
 */
export async function getConsumedIds(sourceTable: string): Promise<ReadonlySet<string>> {
  const db = getDb();
  const cutoff = Math.floor(Date.now() / 1000) - EXPIRY_SECONDS;

  try {
    const rows = await db`
      SELECT source_id FROM pipeline_consumed_signals
      WHERE source_table = ${sourceTable}
        AND consumed_at >= ${cutoff}
    ` as Array<{ source_id: string }>;

    return new Set(rows.map((r) => r.source_id));
  } catch (err) {
    log.warn("Failed to fetch consumed IDs, returning empty set", { sourceTable, err });
    return new Set();
  }
}

/**
 * Mark source IDs as consumed by a pipeline run.
 * Uses ON CONFLICT to update the run ID and timestamp if already consumed.
 */
export async function markConsumed(
  runId: string,
  sourceTable: string,
  ids: readonly string[],
): Promise<void> {
  if (ids.length === 0) return;

  const db = getDb();
  const now = Math.floor(Date.now() / 1000);

  try {
    // Batch insert with conflict handling — 50 rows per batch
    for (let i = 0; i < ids.length; i += 50) {
      const batch = ids.slice(i, i + 50);
      const values = batch.map((sourceId) => ({
        id: crypto.randomUUID(),
        pipeline_run_id: runId,
        source_table: sourceTable,
        source_id: sourceId,
        consumed_at: now,
      }));

      await db`
        INSERT INTO pipeline_consumed_signals ${db(values)}
        ON CONFLICT (source_table, source_id)
        DO UPDATE SET pipeline_run_id = EXCLUDED.pipeline_run_id, consumed_at = EXCLUDED.consumed_at
      `;
    }

    log.debug("Marked signals as consumed", { runId, sourceTable, count: ids.length });
  } catch (err) {
    log.warn("Failed to mark consumed signals (non-fatal)", { runId, sourceTable, err });
  }
}
