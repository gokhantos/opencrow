import { getDb } from "../../store/db";
import type { YieldPoolRow } from "./types";

// =============================================================================
// Yield pools CRUD
// =============================================================================

export async function upsertYieldPools(rows: readonly YieldPoolRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  const db = getDb();
  let upserted = 0;
  for (const row of rows) {
    await db`
      INSERT INTO defi_yield_pools (
        pool_id, chain, project, symbol, tvl_usd,
        apy, apy_base, apy_reward, apy_base_7d,
        volume_usd_1d, volume_usd_7d,
        pool_meta, exposure, reward_tokens_json, updated_at
      ) VALUES (
        ${row.pool_id}, ${row.chain}, ${row.project}, ${row.symbol}, ${row.tvl_usd},
        ${row.apy}, ${row.apy_base}, ${row.apy_reward}, ${row.apy_base_7d},
        ${row.volume_usd_1d}, ${row.volume_usd_7d},
        ${row.pool_meta}, ${row.exposure}, ${row.reward_tokens_json}, ${row.updated_at}
      )
      ON CONFLICT (pool_id) DO UPDATE SET
        chain = EXCLUDED.chain,
        project = EXCLUDED.project,
        symbol = EXCLUDED.symbol,
        tvl_usd = EXCLUDED.tvl_usd,
        apy = EXCLUDED.apy,
        apy_base = EXCLUDED.apy_base,
        apy_reward = EXCLUDED.apy_reward,
        apy_base_7d = EXCLUDED.apy_base_7d,
        volume_usd_1d = EXCLUDED.volume_usd_1d,
        volume_usd_7d = EXCLUDED.volume_usd_7d,
        pool_meta = EXCLUDED.pool_meta,
        exposure = EXCLUDED.exposure,
        reward_tokens_json = EXCLUDED.reward_tokens_json,
        updated_at = EXCLUDED.updated_at
    `;
    upserted++;
  }
  return upserted;
}

export async function getYieldPools(opts?: {
  readonly chain?: string;
  readonly project?: string;
  readonly minApy?: number;
  readonly minTvl?: number;
  readonly limit?: number;
}): Promise<YieldPoolRow[]> {
  const db = getDb();
  const limit = opts?.limit ?? 100;
  const chain = opts?.chain ?? null;
  const project = opts?.project ?? null;
  const minApy = opts?.minApy ?? 0;
  const minTvl = opts?.minTvl ?? 0;

  if (chain && project) {
    const rows = await db`
      SELECT * FROM defi_yield_pools
      WHERE chain = ${chain} AND project = ${project}
        AND apy >= ${minApy} AND tvl_usd >= ${minTvl}
      ORDER BY apy DESC NULLS LAST
      LIMIT ${limit}
    `;
    return rows as YieldPoolRow[];
  }

  if (chain) {
    const rows = await db`
      SELECT * FROM defi_yield_pools
      WHERE chain = ${chain} AND apy >= ${minApy} AND tvl_usd >= ${minTvl}
      ORDER BY apy DESC NULLS LAST
      LIMIT ${limit}
    `;
    return rows as YieldPoolRow[];
  }

  if (project) {
    const rows = await db`
      SELECT * FROM defi_yield_pools
      WHERE project = ${project} AND apy >= ${minApy} AND tvl_usd >= ${minTvl}
      ORDER BY apy DESC NULLS LAST
      LIMIT ${limit}
    `;
    return rows as YieldPoolRow[];
  }

  const rows = await db`
    SELECT * FROM defi_yield_pools
    WHERE apy >= ${minApy} AND tvl_usd >= ${minTvl}
    ORDER BY apy DESC NULLS LAST
    LIMIT ${limit}
  `;
  return rows as YieldPoolRow[];
}

export async function getTopYieldPools(limit = 50): Promise<YieldPoolRow[]> {
  const db = getDb();
  const rows = await db`
    SELECT * FROM defi_yield_pools
    ORDER BY tvl_usd DESC NULLS LAST
    LIMIT ${limit}
  `;
  return rows as YieldPoolRow[];
}
