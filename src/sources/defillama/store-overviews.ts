import { getDb } from "../../store/db";
import type {
  ProtocolDetailRow,
  CategoryRow,
  GlobalMetricsRow,
  ProtocolMetricsRow,
} from "./types";

// =============================================================================
// Protocol detail CRUD
// =============================================================================

export async function upsertProtocolDetail(row: ProtocolDetailRow): Promise<void> {
  const db = getDb();
  await db`
    INSERT INTO defi_protocol_detail (
      id, symbol, logo, twitter, description_full, mcap,
      chains_json, current_chain_tvls_json, raises_json,
      fees_24h, fees_7d, revenue_24h, revenue_7d, updated_at
    ) VALUES (
      ${row.id}, ${row.symbol}, ${row.logo}, ${row.twitter},
      ${row.description_full}, ${row.mcap},
      ${row.chains_json}, ${row.current_chain_tvls_json}, ${row.raises_json},
      ${row.fees_24h}, ${row.fees_7d}, ${row.revenue_24h}, ${row.revenue_7d},
      ${row.updated_at}
    )
    ON CONFLICT (id) DO UPDATE SET
      symbol = EXCLUDED.symbol,
      logo = EXCLUDED.logo,
      twitter = EXCLUDED.twitter,
      description_full = EXCLUDED.description_full,
      mcap = EXCLUDED.mcap,
      chains_json = EXCLUDED.chains_json,
      current_chain_tvls_json = EXCLUDED.current_chain_tvls_json,
      raises_json = EXCLUDED.raises_json,
      fees_24h = EXCLUDED.fees_24h,
      fees_7d = EXCLUDED.fees_7d,
      revenue_24h = EXCLUDED.revenue_24h,
      revenue_7d = EXCLUDED.revenue_7d,
      updated_at = EXCLUDED.updated_at
  `;
}

export async function upsertProtocolDetails(rows: readonly ProtocolDetailRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  let upserted = 0;
  for (const row of rows) {
    await upsertProtocolDetail(row);
    upserted++;
  }
  return upserted;
}

export async function getProtocolDetail(id: string): Promise<ProtocolDetailRow | null> {
  const db = getDb();
  const rows = await db`
    SELECT * FROM defi_protocol_detail WHERE id = ${id}
  `;
  return (rows[0] as ProtocolDetailRow) ?? null;
}

export async function getProtocolDetails(opts?: {
  readonly limit?: number;
  readonly minMcap?: number;
}): Promise<ProtocolDetailRow[]> {
  const db = getDb();
  const limit = opts?.limit ?? 50;
  const minMcap = opts?.minMcap ?? 0;

  if (minMcap > 0) {
    const rows = await db`
      SELECT * FROM defi_protocol_detail
      WHERE mcap >= ${minMcap}
      ORDER BY mcap DESC NULLS LAST
      LIMIT ${limit}
    `;
    return rows as ProtocolDetailRow[];
  }

  const rows = await db`
    SELECT * FROM defi_protocol_detail
    ORDER BY mcap DESC NULLS LAST
    LIMIT ${limit}
  `;
  return rows as ProtocolDetailRow[];
}

/**
 * Returns protocol IDs (slugs) from defi_protocols where either:
 * - No matching row exists in defi_protocol_detail, or
 * - The detail's updated_at is older than maxAgeSeconds ago.
 */
export async function getStaleProtocolIds(
  maxAgeSeconds: number,
  limit: number,
): Promise<string[]> {
  const db = getDb();
  const cutoff = Math.floor(Date.now() / 1000) - maxAgeSeconds;
  const rows = await db`
    SELECT p.id FROM defi_protocols p
    LEFT JOIN defi_protocol_detail d ON d.id = p.id
    WHERE d.id IS NULL OR d.updated_at < ${cutoff}
    ORDER BY p.tvl DESC
    LIMIT ${limit}
  `;
  return rows.map((r: { id: string }) => r.id);
}

// =============================================================================
// Categories
// =============================================================================

export async function upsertCategories(rows: readonly CategoryRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  const db = getDb();
  let upserted = 0;
  for (const row of rows) {
    await db`
      INSERT INTO defi_categories (name, tvl, percentage, protocol_count, updated_at)
      VALUES (${row.name}, ${row.tvl}, ${row.percentage}, ${row.protocol_count}, ${row.updated_at})
      ON CONFLICT (name) DO UPDATE SET
        tvl = EXCLUDED.tvl,
        percentage = EXCLUDED.percentage,
        protocol_count = EXCLUDED.protocol_count,
        updated_at = EXCLUDED.updated_at
    `;
    upserted++;
  }
  return upserted;
}

export async function getCategories(): Promise<CategoryRow[]> {
  const db = getDb();
  const rows = await db`
    SELECT * FROM defi_categories ORDER BY tvl DESC
  `;
  return rows as CategoryRow[];
}

// =============================================================================
// Global metrics
// =============================================================================

export async function upsertGlobalMetrics(row: GlobalMetricsRow): Promise<void> {
  const db = getDb();
  await db`
    INSERT INTO defi_global_metrics (
      metric_type, metric_date, total_24h, total_7d, change_1d, extra_json, updated_at
    ) VALUES (
      ${row.metric_type}, ${row.metric_date}, ${row.total_24h}, ${row.total_7d},
      ${row.change_1d}, ${row.extra_json}, ${row.updated_at}
    )
    ON CONFLICT (metric_type, metric_date) DO UPDATE SET
      total_24h = EXCLUDED.total_24h,
      total_7d = EXCLUDED.total_7d,
      change_1d = EXCLUDED.change_1d,
      extra_json = EXCLUDED.extra_json,
      updated_at = EXCLUDED.updated_at
  `;
}

export async function getLatestGlobalMetrics(): Promise<GlobalMetricsRow[]> {
  const db = getDb();
  const rows = await db`
    SELECT DISTINCT ON (metric_type) *
    FROM defi_global_metrics
    ORDER BY metric_type, metric_date DESC
  `;
  return rows as GlobalMetricsRow[];
}

// =============================================================================
// Protocol metrics
// =============================================================================

export async function upsertProtocolMetrics(rows: readonly ProtocolMetricsRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  const db = getDb();
  let upserted = 0;
  for (const row of rows) {
    await db`
      INSERT INTO defi_protocol_metrics (
        protocol_id, metric_type, value_24h, value_7d, change_1d, chains_json, updated_at
      ) VALUES (
        ${row.protocol_id}, ${row.metric_type}, ${row.value_24h}, ${row.value_7d},
        ${row.change_1d}, ${row.chains_json}, ${row.updated_at}
      )
      ON CONFLICT (protocol_id, metric_type) DO UPDATE SET
        value_24h = EXCLUDED.value_24h,
        value_7d = EXCLUDED.value_7d,
        change_1d = EXCLUDED.change_1d,
        chains_json = EXCLUDED.chains_json,
        updated_at = EXCLUDED.updated_at
    `;
    upserted++;
  }
  return upserted;
}

export async function getProtocolMetricsByType(
  metricType: string,
  opts?: { readonly limit?: number },
): Promise<ProtocolMetricsRow[]> {
  const db = getDb();
  const limit = opts?.limit ?? 100;
  const rows = await db`
    SELECT * FROM defi_protocol_metrics
    WHERE metric_type = ${metricType}
    ORDER BY value_24h DESC NULLS LAST
    LIMIT ${limit}
  `;
  return rows as ProtocolMetricsRow[];
}
