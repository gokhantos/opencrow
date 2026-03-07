import { getDb } from "../../store/db";
export type {
  ProtocolRow,
  ChainTvlRow,
  ChainTvlHistoryRow,
  ChainMetricsRow,
} from "./types";
import type { ProtocolRow, ChainTvlRow, ChainTvlHistoryRow, ChainMetricsRow } from "./types";

// --- Target chains ---
export const MAJOR_CHAINS = [
  "Ethereum", "Solana", "Base", "Arbitrum", "BSC", "Polygon",
  "OP Mainnet", "Avalanche", "Sui", "Aptos", "Tron", "TON",
  "Fantom",
] as const;
export type MajorChain = (typeof MAJOR_CHAINS)[number];

// Backward compat aliases
export const TARGET_CHAINS = MAJOR_CHAINS;
export type TargetChain = MajorChain;

export function chainToId(name: string): string {
  return name.toLowerCase().replace(/\s+/g, "-");
}

// =============================================================================
// Protocol CRUD
// =============================================================================

export async function upsertProtocols(
  protocols: readonly ProtocolRow[],
): Promise<number> {
  if (protocols.length === 0) return 0;

  const db = getDb();
  let upserted = 0;

  for (const p of protocols) {
    await db`
      INSERT INTO defi_protocols (
        id, name, category, chain, chains_json, tvl, tvl_prev,
        change_1d, change_7d, url, description,
        first_seen_at, updated_at
      ) VALUES (
        ${p.id}, ${p.name}, ${p.category}, ${p.chain}, ${p.chains_json},
        ${p.tvl}, ${p.tvl_prev}, ${p.change_1d}, ${p.change_7d},
        ${p.url}, ${p.description}, ${p.first_seen_at}, ${p.updated_at}
      )
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        category = EXCLUDED.category,
        chain = EXCLUDED.chain,
        chains_json = EXCLUDED.chains_json,
        tvl_prev = defi_protocols.tvl,
        tvl = EXCLUDED.tvl,
        change_1d = EXCLUDED.change_1d,
        change_7d = EXCLUDED.change_7d,
        url = EXCLUDED.url,
        description = EXCLUDED.description,
        updated_at = EXCLUDED.updated_at
    `;
    upserted++;
  }

  return upserted;
}

// =============================================================================
// Chain TVL snapshots
// =============================================================================

export async function upsertChainTvls(
  chains: readonly ChainTvlRow[],
): Promise<number> {
  if (chains.length === 0) return 0;

  const db = getDb();
  let upserted = 0;

  for (const c of chains) {
    await db`
      INSERT INTO defi_chain_tvls (
        id, name, tvl, tvl_prev, protocols_count, updated_at
      ) VALUES (
        ${c.id}, ${c.name}, ${c.tvl}, ${c.tvl_prev},
        ${c.protocols_count}, ${c.updated_at}
      )
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        tvl_prev = defi_chain_tvls.tvl,
        tvl = EXCLUDED.tvl,
        protocols_count = EXCLUDED.protocols_count,
        updated_at = EXCLUDED.updated_at
    `;
    upserted++;
  }

  return upserted;
}

// =============================================================================
// Historical TVL (time series)
// =============================================================================

export async function upsertChainTvlHistory(
  rows: readonly ChainTvlHistoryRow[],
): Promise<number> {
  if (rows.length === 0) return 0;

  const db = getDb();
  let inserted = 0;

  // Batch insert with ON CONFLICT DO NOTHING (immutable historical data)
  const BATCH_SIZE = 500;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const values = batch.map((r) => ({
      chain_id: r.chain_id,
      date: r.date,
      tvl: r.tvl,
    }));

    const result = await db`
      INSERT INTO defi_chain_tvl_history ${db(values)}
      ON CONFLICT (chain_id, date) DO NOTHING
    `;
    inserted += result.count ?? batch.length;
  }

  return inserted;
}

export async function getChainTvlHistory(
  chainId: string,
  opts?: { readonly daysBack?: number; readonly limit?: number },
): Promise<ChainTvlHistoryRow[]> {
  const db = getDb();
  const limit = opts?.limit ?? 365;

  if (opts?.daysBack) {
    const cutoff = Math.floor(Date.now() / 1000) - opts.daysBack * 86400;
    const rows = await db`
      SELECT * FROM defi_chain_tvl_history
      WHERE chain_id = ${chainId} AND date >= ${cutoff}
      ORDER BY date DESC
      LIMIT ${limit}
    `;
    return rows as ChainTvlHistoryRow[];
  }

  const rows = await db`
    SELECT * FROM defi_chain_tvl_history
    WHERE chain_id = ${chainId}
    ORDER BY date DESC
    LIMIT ${limit}
  `;
  return rows as ChainTvlHistoryRow[];
}

export async function getLatestHistoryDate(
  chainId: string,
): Promise<number | null> {
  const db = getDb();
  const rows = await db`
    SELECT MAX(date) as max_date FROM defi_chain_tvl_history
    WHERE chain_id = ${chainId}
  `;
  return (rows[0]?.max_date as number) ?? null;
}

// =============================================================================
// Chain metrics (fees, revenue, DEX volume, stablecoins)
// =============================================================================

export async function upsertChainMetrics(
  row: ChainMetricsRow,
): Promise<void> {
  const db = getDb();
  await db`
    INSERT INTO defi_chain_metrics (
      chain_id, metric_date,
      fees_24h, fees_7d, fees_30d, fees_change_1d,
      revenue_24h, revenue_7d, revenue_30d, revenue_change_1d,
      dex_volume_24h, dex_volume_7d, dex_volume_30d, dex_volume_change_1d,
      stablecoin_mcap, updated_at
    ) VALUES (
      ${row.chain_id}, ${row.metric_date},
      ${row.fees_24h}, ${row.fees_7d}, ${row.fees_30d}, ${row.fees_change_1d},
      ${row.revenue_24h}, ${row.revenue_7d}, ${row.revenue_30d}, ${row.revenue_change_1d},
      ${row.dex_volume_24h}, ${row.dex_volume_7d}, ${row.dex_volume_30d}, ${row.dex_volume_change_1d},
      ${row.stablecoin_mcap}, ${row.updated_at}
    )
    ON CONFLICT (chain_id, metric_date) DO UPDATE SET
      fees_24h = EXCLUDED.fees_24h,
      fees_7d = EXCLUDED.fees_7d,
      fees_30d = EXCLUDED.fees_30d,
      fees_change_1d = EXCLUDED.fees_change_1d,
      revenue_24h = EXCLUDED.revenue_24h,
      revenue_7d = EXCLUDED.revenue_7d,
      revenue_30d = EXCLUDED.revenue_30d,
      revenue_change_1d = EXCLUDED.revenue_change_1d,
      dex_volume_24h = EXCLUDED.dex_volume_24h,
      dex_volume_7d = EXCLUDED.dex_volume_7d,
      dex_volume_30d = EXCLUDED.dex_volume_30d,
      dex_volume_change_1d = EXCLUDED.dex_volume_change_1d,
      stablecoin_mcap = EXCLUDED.stablecoin_mcap,
      updated_at = EXCLUDED.updated_at
  `;
}

export async function getLatestChainMetrics(
  chainId: string,
): Promise<ChainMetricsRow | null> {
  const db = getDb();
  const rows = await db`
    SELECT * FROM defi_chain_metrics
    WHERE chain_id = ${chainId}
    ORDER BY metric_date DESC
    LIMIT 1
  `;
  return (rows[0] as ChainMetricsRow) ?? null;
}

export async function getChainMetricsHistory(
  chainId: string,
  daysBack = 30,
): Promise<ChainMetricsRow[]> {
  const db = getDb();
  const cutoff = Math.floor(Date.now() / 1000) - daysBack * 86400;
  const rows = await db`
    SELECT * FROM defi_chain_metrics
    WHERE chain_id = ${chainId} AND metric_date >= ${cutoff}
    ORDER BY metric_date DESC
  `;
  return rows as ChainMetricsRow[];
}

export async function getAllTargetChainMetrics(): Promise<ChainMetricsRow[]> {
  const db = getDb();
  const ids = MAJOR_CHAINS.map(chainToId);
  const rows = await db`
    SELECT DISTINCT ON (chain_id) *
    FROM defi_chain_metrics
    WHERE chain_id IN ${db(ids)}
    ORDER BY chain_id, metric_date DESC
  `;
  return rows as ChainMetricsRow[];
}

// =============================================================================
// Protocol queries
// =============================================================================

export async function getProtocols(opts?: {
  readonly category?: string;
  readonly chain?: string;
  readonly limit?: number;
  readonly minTvl?: number;
}): Promise<ProtocolRow[]> {
  const db = getDb();
  const limit = opts?.limit ?? 50;
  const minTvl = opts?.minTvl ?? 0;

  if (opts?.category && opts?.chain) {
    const rows = await db`
      SELECT * FROM defi_protocols
      WHERE category = ${opts.category}
        AND (chain = ${opts.chain} OR chains_json::jsonb ? ${opts.chain})
        AND tvl >= ${minTvl}
      ORDER BY tvl DESC
      LIMIT ${limit}
    `;
    return rows as ProtocolRow[];
  }

  if (opts?.category) {
    const rows = await db`
      SELECT * FROM defi_protocols
      WHERE category = ${opts.category}
        AND tvl >= ${minTvl}
      ORDER BY tvl DESC
      LIMIT ${limit}
    `;
    return rows as ProtocolRow[];
  }

  if (opts?.chain) {
    const rows = await db`
      SELECT * FROM defi_protocols
      WHERE (chain = ${opts.chain} OR chains_json::jsonb ? ${opts.chain})
        AND tvl >= ${minTvl}
      ORDER BY tvl DESC
      LIMIT ${limit}
    `;
    return rows as ProtocolRow[];
  }

  const rows = await db`
    SELECT * FROM defi_protocols
    WHERE tvl >= ${minTvl}
    ORDER BY tvl DESC
    LIMIT ${limit}
  `;
  return rows as ProtocolRow[];
}

export async function getTopMovers(limit = 20): Promise<ProtocolRow[]> {
  const db = getDb();
  const rows = await db`
    SELECT * FROM defi_protocols
    WHERE change_1d IS NOT NULL
    ORDER BY ABS(change_1d) DESC
    LIMIT ${limit}
  `;
  return rows as ProtocolRow[];
}

export async function getNewProtocols(
  daysBack = 7,
  limit = 50,
): Promise<ProtocolRow[]> {
  const db = getDb();
  const cutoff = Math.floor(Date.now() / 1000) - daysBack * 86400;
  const rows = await db`
    SELECT * FROM defi_protocols
    WHERE first_seen_at > ${cutoff}
    ORDER BY tvl DESC
    LIMIT ${limit}
  `;
  return rows as ProtocolRow[];
}

export async function getChainTvls(limit = 50): Promise<ChainTvlRow[]> {
  const db = getDb();
  const rows = await db`
    SELECT * FROM defi_chain_tvls
    ORDER BY tvl DESC
    LIMIT ${limit}
  `;
  return rows as ChainTvlRow[];
}

export async function getUnindexedProtocols(
  limit = 200,
): Promise<ProtocolRow[]> {
  const db = getDb();
  const rows = await db`
    SELECT * FROM defi_protocols
    WHERE indexed_at IS NULL
    ORDER BY tvl DESC
    LIMIT ${limit}
  `;
  return rows as ProtocolRow[];
}

export async function markProtocolsIndexed(
  ids: readonly string[],
): Promise<void> {
  if (ids.length === 0) return;
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  await db`
    UPDATE defi_protocols SET indexed_at = ${now}
    WHERE id IN ${db(ids)}
  `;
}
