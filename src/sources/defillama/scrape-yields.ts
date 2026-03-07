import { createLogger } from "../../logger";
import { fetchJson, YIELDS_URL } from "./api";
import { upsertYieldPools } from "./store-yields";
import type { RawYieldPool, YieldPoolRow } from "./types";

const log = createLogger("defillama:yields");

function toRow(raw: RawYieldPool, updatedAt: number): YieldPoolRow {
  return {
    pool_id: raw.pool ?? "",
    chain: raw.chain ?? "",
    project: raw.project ?? "",
    symbol: raw.symbol ?? "",
    tvl_usd: raw.tvlUsd ?? 0,
    apy: raw.apy ?? null,
    apy_base: raw.apyBase ?? null,
    apy_reward: raw.apyReward ?? null,
    apy_base_7d: raw.apyBase7d ?? null,
    volume_usd_1d: raw.volumeUsd1d ?? null,
    volume_usd_7d: raw.volumeUsd7d ?? null,
    pool_meta: raw.poolMeta ?? "",
    exposure: raw.exposure ?? "",
    reward_tokens_json: JSON.stringify(raw.rewardTokens ?? []),
    updated_at: updatedAt,
  };
}

export async function scrapeYieldPools(): Promise<number> {
  log.info("Fetching yield pools");

  const response = await fetchJson<{ status: string; data: RawYieldPool[] }>(YIELDS_URL);
  const raw = response.data ?? [];

  const filtered = raw.filter(
    (p) =>
      (p.tvlUsd ?? 0) >= 100_000 &&
      p.apy !== undefined &&
      p.apy !== null &&
      p.apy > 0,
  );

  const now = Math.floor(Date.now() / 1000);
  const rows = filtered.map((raw) => toRow(raw, now)).filter((r) => r.pool_id !== "");
  const count = await upsertYieldPools(rows);

  log.info("Yield pools scraped", { total: raw.length, filtered: filtered.length, upserted: count });
  return count;
}
