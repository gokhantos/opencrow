// --- Constants ---

export const DEFILLAMA_AGENT_ID = "defillama";
export const REQUEST_DELAY_MS = 1_200; // polite rate limiting

// --- API URLs ---
export const PROTOCOLS_URL = "https://api.llama.fi/protocols";
export const CHAINS_URL = "https://api.llama.fi/v2/chains";
export const HISTORICAL_CHAIN_TVL_URL = "https://api.llama.fi/v2/historicalChainTvl";
export const FEES_URL = "https://api.llama.fi/overview/fees";
export const DEX_VOLUMES_URL = "https://api.llama.fi/overview/dexs";
export const PROTOCOL_DETAIL_URL = "https://api.llama.fi/protocol";
export const CATEGORIES_URL = "https://api.llama.fi/categories";
export const OPTIONS_URL = "https://api.llama.fi/overview/options";
export const DERIVATIVES_URL = "https://api.llama.fi/overview/derivatives";
export const STABLECOIN_CHAINS_URL = "https://stablecoins.llama.fi/stablecoinchains";
export const YIELDS_URL = "https://yields.llama.fi/pools";
export const BRIDGES_URL = "https://bridges.llama.fi/bridges";
export const BRIDGE_DETAIL_URL = "https://bridges.llama.fi/bridge";
export const HACKS_URL = "https://api.llama.fi/hacks";
export const STABLECOINS_URL = "https://stablecoins.llama.fi/stablecoins";
export const EMISSIONS_URL = "https://api.llama.fi/emissions";
export const TREASURY_URL = "https://api.llama.fi/treasury";

// --- Fetch helpers ---

export async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${url}`);
  }
  return response.json() as Promise<T>;
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Format helpers ---

export function formatTvl(tvl: number | null | undefined): string {
  if (tvl === null || tvl === undefined) return "N/A";
  if (tvl >= 1_000_000_000) return `$${(tvl / 1_000_000_000).toFixed(2)}B`;
  if (tvl >= 1_000_000) return `$${(tvl / 1_000_000).toFixed(2)}M`;
  if (tvl >= 1_000) return `$${(tvl / 1_000).toFixed(2)}K`;
  return `$${tvl.toFixed(2)}`;
}

export function formatChange(change: number | null): string {
  if (change === null || change === undefined) return "N/A";
  const sign = change >= 0 ? "+" : "";
  return `${sign}${change.toFixed(2)}%`;
}
