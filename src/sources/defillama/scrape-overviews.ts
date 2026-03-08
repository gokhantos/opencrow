import { createLogger } from "../../logger";
import {
  fetchJson,
  delay,
  REQUEST_DELAY_MS,
  PROTOCOL_DETAIL_URL,
  CATEGORIES_URL,
  FEES_URL,
  DEX_VOLUMES_URL,
  OPTIONS_URL,
  DERIVATIVES_URL,
} from "./api";
import type {
  RawProtocolDetail,
  RawCategory,
  RawFeesOverview,
  RawDexOverview,
  RawOptionsOverview,
  RawDerivativesOverview,
  ProtocolDetailRow,
  CategoryRow,
  GlobalMetricsRow,
  ProtocolMetricsRow,
} from "./types";
import {
  getStaleProtocolIds,
  upsertProtocolDetails,
  upsertCategories,
  upsertGlobalMetrics,
  upsertProtocolMetrics,
} from "./store-overviews";

const log = createLogger("defillama-overviews");

const STALE_DETAIL_AGE_SECONDS = 86_400; // 24 hours
const DETAIL_BATCH_LIMIT = 100;

// =============================================================================
// Mappers
// =============================================================================

function rawDetailToRow(raw: RawProtocolDetail): ProtocolDetailRow {
  const now = Math.floor(Date.now() / 1000);
  return {
    id: raw.id ?? "",
    symbol: raw.symbol ?? "",
    logo: raw.logo ?? "",
    twitter: raw.twitter ?? "",
    description_full: raw.description ?? "",
    mcap: raw.mcap ?? null,
    chains_json: JSON.stringify(raw.chains ?? []),
    current_chain_tvls_json: JSON.stringify(raw.currentChainTvls ?? {}),
    raises_json: JSON.stringify(raw.raises ?? []),
    fees_24h: raw.metrics?.fees?.["24h"] ?? null,
    fees_7d: raw.metrics?.fees?.["7d"] ?? null,
    revenue_24h: raw.metrics?.revenue?.["24h"] ?? null,
    revenue_7d: raw.metrics?.revenue?.["7d"] ?? null,
    updated_at: now,
  };
}

// =============================================================================
// Protocol details
// =============================================================================

export async function scrapeProtocolDetails(): Promise<number> {
  const slugs = await getStaleProtocolIds(STALE_DETAIL_AGE_SECONDS, DETAIL_BATCH_LIMIT);
  if (slugs.length === 0) {
    log.info("No stale protocol details to fetch");
    return 0;
  }

  log.info("Fetching protocol details", { count: slugs.length });
  const rows: ProtocolDetailRow[] = [];

  for (const slug of slugs) {
    const raw = await fetchJson<RawProtocolDetail>(`${PROTOCOL_DETAIL_URL}/${slug}`);
    if (raw !== null) {
      rows.push(rawDetailToRow(raw));
    }
    await delay(REQUEST_DELAY_MS);
  }

  const count = await upsertProtocolDetails(rows);
  log.info("Protocol details upserted", { count });
  return count;
}

// =============================================================================
// Categories
// =============================================================================

export async function scrapeCategories(): Promise<number> {
  const raw = await fetchJson<RawCategory>(CATEGORIES_URL);
  if (raw === null) return 0;
  const now = Math.floor(Date.now() / 1000);

  // Find latest timestamp in chart for TVL values
  const chartTimestamps = Object.keys(raw.chart ?? {}).map(Number).sort((a, b) => b - a);
  const latestTs = chartTimestamps[0];
  const latestChart = latestTs !== undefined ? (raw.chart[String(latestTs)] ?? {}) : {};

  const rows: CategoryRow[] = Object.entries(raw.categories ?? {}).map(([name, protocols]) => {
    const tvlEntry = latestChart[name];
    const tvl = tvlEntry?.tvl ?? 0;
    const percentage = raw.categoryPercentages?.[name] ?? 0;
    return {
      name,
      tvl,
      percentage,
      protocol_count: Array.isArray(protocols) ? protocols.length : 0,
      updated_at: now,
    };
  });

  const count = await upsertCategories(rows);
  log.info("Categories upserted", { count });
  return count;
}

// =============================================================================
// Global fees
// =============================================================================

export async function scrapeGlobalFees(): Promise<void> {
  const url = `${FEES_URL}?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true`;
  const raw = await fetchJson<RawFeesOverview>(url);
  if (raw === null) return;
  const now = Math.floor(Date.now() / 1000);
  const today = Math.floor(now / 86_400) * 86_400;

  await upsertGlobalMetrics({
    metric_type: "fees",
    metric_date: today,
    total_24h: raw.totalFees24h ?? null,
    total_7d: null,
    change_1d: raw.change_1d ?? null,
    extra_json: JSON.stringify({ totalRevenue24h: raw.totalRevenue24h ?? null }),
    updated_at: now,
  });

  const protocolRows: ProtocolMetricsRow[] = (raw.protocols ?? [])
    .filter((p) => p.slug != null)
    .map((p) => ({
      protocol_id: p.slug!,
      metric_type: "fees",
      value_24h: p.fees24h ?? null,
      value_7d: null,
      change_1d: null,
      chains_json: JSON.stringify(p.chains ?? []),
      updated_at: now,
    }));

  await upsertProtocolMetrics(protocolRows);
  log.info("Global fees scraped", { protocols: protocolRows.length });
}

// =============================================================================
// Global DEX volumes
// =============================================================================

export async function scrapeGlobalDexVolumes(): Promise<void> {
  const url = `${DEX_VOLUMES_URL}?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true`;
  const raw = await fetchJson<RawDexOverview>(url);
  if (raw === null) return;
  const now = Math.floor(Date.now() / 1000);
  const today = Math.floor(now / 86_400) * 86_400;

  await upsertGlobalMetrics({
    metric_type: "dex_volume",
    metric_date: today,
    total_24h: raw.totalVolume24h ?? null,
    total_7d: raw.totalVolume7d ?? null,
    change_1d: raw.change_1d ?? null,
    extra_json: "{}",
    updated_at: now,
  });

  const protocolRows: ProtocolMetricsRow[] = (raw.protocols ?? [])
    .filter((p) => p.slug != null)
    .map((p) => ({
      protocol_id: p.slug!,
      metric_type: "dex_volume",
      value_24h: p.total24h ?? null,
      value_7d: null,
      change_1d: null,
      chains_json: JSON.stringify(p.chains ?? []),
      updated_at: now,
    }));

  await upsertProtocolMetrics(protocolRows);
  log.info("Global DEX volumes scraped", { protocols: protocolRows.length });
}

// =============================================================================
// Options
// =============================================================================

export async function scrapeOptions(): Promise<void> {
  const url = `${OPTIONS_URL}?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true`;
  const raw = await fetchJson<RawOptionsOverview>(url);
  if (raw === null) return;
  const now = Math.floor(Date.now() / 1000);
  const today = Math.floor(now / 86_400) * 86_400;

  await upsertGlobalMetrics({
    metric_type: "options_premium",
    metric_date: today,
    total_24h: raw.totalPremiumVolume ?? null,
    total_7d: null,
    change_1d: null,
    extra_json: "{}",
    updated_at: now,
  });

  await upsertGlobalMetrics({
    metric_type: "options_notional",
    metric_date: today,
    total_24h: raw.totalNotionalVolume ?? null,
    total_7d: null,
    change_1d: null,
    extra_json: "{}",
    updated_at: now,
  });

  const protocolRows: ProtocolMetricsRow[] = (raw.protocols ?? [])
    .filter((p) => p.slug != null)
    .flatMap((p) => [
      {
        protocol_id: p.slug!,
        metric_type: "options_premium",
        value_24h: p.premiumVolume24h ?? null,
        value_7d: null,
        change_1d: null,
        chains_json: JSON.stringify(p.chains ?? []),
        updated_at: now,
      },
      {
        protocol_id: p.slug!,
        metric_type: "options_notional",
        value_24h: p.notionalVolume24h ?? null,
        value_7d: null,
        change_1d: null,
        chains_json: JSON.stringify(p.chains ?? []),
        updated_at: now,
      },
    ]);

  await upsertProtocolMetrics(protocolRows);
  log.info("Options scraped", { protocols: raw.protocols?.length ?? 0 });
}

// =============================================================================
// Derivatives
// =============================================================================

export async function scrapeDerivatives(): Promise<void> {
  const url = `${DERIVATIVES_URL}?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true`;
  const raw = await fetchJson<RawDerivativesOverview>(url);
  if (raw === null) return;
  const now = Math.floor(Date.now() / 1000);
  const today = Math.floor(now / 86_400) * 86_400;

  await upsertGlobalMetrics({
    metric_type: "derivatives_volume",
    metric_date: today,
    total_24h: raw.totalVolume24h ?? null,
    total_7d: null,
    change_1d: raw.change_1d ?? null,
    extra_json: "{}",
    updated_at: now,
  });

  await upsertGlobalMetrics({
    metric_type: "derivatives_oi",
    metric_date: today,
    total_24h: raw.totalOpenInterest ?? null,
    total_7d: null,
    change_1d: null,
    extra_json: "{}",
    updated_at: now,
  });

  const protocolEntries = Object.entries(raw.protocols ?? {});
  const protocolRows: ProtocolMetricsRow[] = protocolEntries.flatMap(([slug, data]) => [
    {
      protocol_id: slug,
      metric_type: "derivatives_volume",
      value_24h: data.volume24h ?? null,
      value_7d: null,
      change_1d: null,
      chains_json: JSON.stringify(data.chains ?? []),
      updated_at: now,
    },
    {
      protocol_id: slug,
      metric_type: "derivatives_oi",
      value_24h: data.openInterest ?? null,
      value_7d: null,
      change_1d: null,
      chains_json: JSON.stringify(data.chains ?? []),
      updated_at: now,
    },
  ]);

  await upsertProtocolMetrics(protocolRows);
  log.info("Derivatives scraped", { protocols: protocolEntries.length });
}

// =============================================================================
// Orchestrator
// =============================================================================

export async function scrapeOverviews(): Promise<{ protocolDetails: number; categories: number }> {
  log.info("Starting overviews scrape");

  let protocolDetails = 0;
  let categories = 0;

  try {
    protocolDetails = await scrapeProtocolDetails();
  } catch (err) {
    log.error("Failed to scrape protocol details", { error: err });
  }
  await delay(REQUEST_DELAY_MS);

  try {
    categories = await scrapeCategories();
  } catch (err) {
    log.error("Failed to scrape categories", { error: err });
  }
  await delay(REQUEST_DELAY_MS);

  try {
    await scrapeGlobalFees();
  } catch (err) {
    log.error("Failed to scrape global fees", { error: err });
  }
  await delay(REQUEST_DELAY_MS);

  try {
    await scrapeGlobalDexVolumes();
  } catch (err) {
    log.error("Failed to scrape global DEX volumes", { error: err });
  }
  await delay(REQUEST_DELAY_MS);

  try {
    await scrapeOptions();
  } catch (err) {
    log.error("Failed to scrape options", { error: err });
  }
  await delay(REQUEST_DELAY_MS);

  try {
    await scrapeDerivatives();
  } catch (err) {
    log.error("Failed to scrape derivatives", { error: err });
  }

  log.info("Overviews scrape complete", { protocolDetails, categories });
  return { protocolDetails, categories };
}
