import { createLogger } from "../../logger";
import {
  upsertChainTvls,
  upsertChainTvlHistory,
  upsertChainMetrics,
  getLatestHistoryDate,
  chainToId,
  MAJOR_CHAINS,
} from "./store";
import {
  fetchJson,
  delay,
  formatTvl,
  CHAINS_URL,
  HISTORICAL_CHAIN_TVL_URL,
  FEES_URL,
  DEX_VOLUMES_URL,
  STABLECOIN_CHAINS_URL,
  REQUEST_DELAY_MS,
} from "./api";
import type {
  RawChain,
  RawHistoricalTvlPoint,
  RawChainFees,
  RawChainDexVolume,
  RawStablecoinChain,
  ChainTvlRow,
  ChainTvlHistoryRow,
  ChainMetricsRow,
} from "./types";

const log = createLogger("defillama-chains");

// --- Mappers ---

export function rawChainToRow(raw: RawChain): ChainTvlRow {
  const now = Math.floor(Date.now() / 1000);
  return {
    id: chainToId(raw.name),
    name: raw.name ?? "",
    tvl: raw.tvl ?? 0,
    tvl_prev: null,
    protocols_count: raw.protocols ?? 0,
    updated_at: now,
  };
}

// --- Fetchers ---

export async function fetchChains(): Promise<readonly ChainTvlRow[]> {
  try {
    const raw = await fetchJson<readonly RawChain[]>(CHAINS_URL);
    return raw
      .filter((c) => c.name && c.tvl !== undefined && c.tvl > 0)
      .map(rawChainToRow);
  } catch (err) {
    log.error("Failed to fetch chains", {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

export async function fetchHistoricalChainTvl(
  chainName: string,
): Promise<readonly ChainTvlHistoryRow[]> {
  try {
    const raw = await fetchJson<readonly RawHistoricalTvlPoint[]>(
      `${HISTORICAL_CHAIN_TVL_URL}/${chainName}`,
    );

    const cid = chainToId(chainName);

    return raw
      .filter((p) => p.date && p.tvl > 0)
      .map((p) => ({
        chain_id: cid,
        date: p.date,
        tvl: p.tvl,
      }));
  } catch (err) {
    log.error("Failed to fetch historical TVL", {
      chain: chainName,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

export async function fetchChainFees(
  chainName: string,
): Promise<RawChainFees | null> {
  try {
    const url = `${FEES_URL}/${chainName}?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true`;
    return await fetchJson<RawChainFees>(url);
  } catch (err) {
    log.error("Failed to fetch chain fees", {
      chain: chainName,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export async function fetchChainDexVolumes(
  chainName: string,
): Promise<RawChainDexVolume | null> {
  try {
    const url = `${DEX_VOLUMES_URL}/${chainName}?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true`;
    return await fetchJson<RawChainDexVolume>(url);
  } catch (err) {
    log.error("Failed to fetch chain DEX volumes", {
      chain: chainName,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export async function fetchStablecoinsByChain(): Promise<
  ReadonlyMap<string, number>
> {
  try {
    const raw =
      await fetchJson<readonly RawStablecoinChain[]>(STABLECOIN_CHAINS_URL);

    const map = new Map<string, number>();
    for (const chain of raw) {
      const mcap = chain.totalCirculatingUSD?.peggedUSD;
      if (chain.name && mcap && mcap > 0) {
        map.set(chain.name, mcap);
      }
    }
    return map;
  } catch (err) {
    log.error("Failed to fetch stablecoin data", {
      error: err instanceof Error ? err.message : String(err),
    });
    return new Map();
  }
}

// --- Orchestrators ---

export async function scrapeChains(): Promise<{ chains: number }> {
  const chainRows = await fetchChains();
  const chains = await upsertChainTvls(chainRows);
  return { chains };
}

export async function scrapeHistoricalTvl(): Promise<number> {
  let totalPoints = 0;

  for (const chainName of MAJOR_CHAINS) {
    const cid = chainToId(chainName);
    const latestDate = await getLatestHistoryDate(cid);

    const now = Math.floor(Date.now() / 1000);
    const twoDaysAgo = now - 2 * 86400;

    if (latestDate && latestDate > twoDaysAgo) {
      log.info("Historical TVL up to date", { chain: chainName });
      continue;
    }

    const points = await fetchHistoricalChainTvl(chainName);
    await delay(REQUEST_DELAY_MS);

    if (points.length > 0) {
      const toInsert = latestDate
        ? points.filter((p) => p.date > latestDate)
        : points;

      if (toInsert.length > 0) {
        const count = await upsertChainTvlHistory(toInsert);
        totalPoints += count;
        log.info("Inserted historical TVL", {
          chain: chainName,
          points: toInsert.length,
        });
      }
    }
  }

  return totalPoints;
}

export async function scrapeChainMetrics(): Promise<number> {
  const stablecoinMap = await fetchStablecoinsByChain();
  await delay(REQUEST_DELAY_MS);

  let metricsCount = 0;
  const now = Math.floor(Date.now() / 1000);
  const today = now - (now % 86400); // midnight UTC

  for (const chainName of MAJOR_CHAINS) {
    const cid = chainToId(chainName);

    const fees = await fetchChainFees(chainName);
    await delay(REQUEST_DELAY_MS);

    const dexVol = await fetchChainDexVolumes(chainName);
    await delay(REQUEST_DELAY_MS);

    const stablecoinMcap = stablecoinMap.get(chainName) ?? null;

    const metrics: ChainMetricsRow = {
      chain_id: cid,
      metric_date: today,
      fees_24h: fees?.total24h ?? null,
      fees_7d: fees?.total7d ?? null,
      fees_30d: fees?.total30d ?? null,
      fees_change_1d: fees?.change_1d ?? null,
      revenue_24h: null,
      revenue_7d: null,
      revenue_30d: null,
      revenue_change_1d: null,
      dex_volume_24h: dexVol?.total24h ?? null,
      dex_volume_7d: dexVol?.total7d ?? null,
      dex_volume_30d: dexVol?.total30d ?? null,
      dex_volume_change_1d: dexVol?.change_1d ?? null,
      stablecoin_mcap: stablecoinMcap,
      updated_at: now,
    };

    await upsertChainMetrics(metrics);
    metricsCount++;

    log.info("Chain metrics updated", {
      chain: chainName,
      fees24h: fees?.total24h ? formatTvl(fees.total24h) : "N/A",
      dexVol24h: dexVol?.total24h ? formatTvl(dexVol.total24h) : "N/A",
      stablecoinMcap: stablecoinMcap ? formatTvl(stablecoinMcap) : "N/A",
    });
  }

  return metricsCount;
}
