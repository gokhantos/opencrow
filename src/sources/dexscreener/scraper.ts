/** DexScreener scraper — uses official API endpoints for token discovery. */

import { createLogger } from "../../logger";

import { getErrorMessage } from "../../lib/error-serialization";
const log = createLogger("scraper-dexscreener");

const BASE = "https://api.dexscreener.com";

const HEADERS: Record<string, string> = {
  Accept: "application/json",
  "User-Agent": "OpenCrow/1.0",
};

/** Only track these chains. */
const ALLOWED_CHAINS = new Set(["solana", "ethereum", "base"]);

// ─── API response types ───

interface BoostEntry {
  readonly url: string;
  readonly chainId: string;
  readonly tokenAddress: string;
  readonly description?: string;
  readonly totalAmount?: number;
  readonly icon?: string;
  readonly links?: readonly { readonly type?: string; readonly url: string }[];
}

interface ProfileEntry {
  readonly url: string;
  readonly chainId: string;
  readonly tokenAddress: string;
  readonly description?: string;
  readonly icon?: string;
  readonly links?: readonly { readonly type?: string; readonly url: string }[];
  readonly cto?: boolean;
}

export interface DexScreenerPair {
  readonly chainId: string;
  readonly dexId: string;
  readonly url: string;
  readonly pairAddress: string;
  readonly baseToken: {
    readonly address: string;
    readonly name: string;
    readonly symbol: string;
  };
  readonly quoteToken: {
    readonly address: string;
    readonly name: string;
    readonly symbol: string;
  };
  readonly priceNative: string;
  readonly priceUsd: string;
  readonly txns: {
    readonly m5: { readonly buys: number; readonly sells: number };
    readonly h1: { readonly buys: number; readonly sells: number };
    readonly h6: { readonly buys: number; readonly sells: number };
    readonly h24: { readonly buys: number; readonly sells: number };
  };
  readonly volume: {
    readonly h24: number;
    readonly h6: number;
    readonly h1: number;
    readonly m5: number;
  };
  readonly priceChange: {
    readonly m5?: number;
    readonly h1?: number;
    readonly h6?: number;
    readonly h24?: number;
  };
  readonly liquidity?: {
    readonly usd: number;
    readonly base: number;
    readonly quote: number;
  };
  readonly fdv?: number;
  readonly marketCap?: number;
  readonly pairCreatedAt?: number;
  readonly info?: {
    readonly imageUrl?: string;
    readonly websites?: readonly { readonly label?: string; readonly url: string }[];
    readonly socials?: readonly { readonly type: string; readonly url: string }[];
  };
  readonly boosts?: { readonly active: number };
}

export interface TrendingToken {
  readonly symbol: string;
  readonly name: string;
  readonly address: string;
  readonly chainId: string;
  readonly priceUsd: string;
  readonly priceChange24h: number;
  readonly volume24h: number;
  readonly liquidityUsd?: number;
  readonly marketCap?: number;
  readonly pairUrl: string;
  readonly createdAt?: number;
  readonly imageUrl?: string;
  readonly boostAmount?: number;
}

// ─── API fetchers ───

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok) {
      log.warn("API request failed", { url, status: res.status });
      return null;
    }
    return (await res.json()) as T;
  } catch (err) {
    log.warn("API request error", { url, error: String(err) });
    return null;
  }
}

/** Get top boosted tokens (most actively promoted = trending). */
async function fetchTopBoosts(): Promise<readonly BoostEntry[]> {
  const data = await fetchJson<BoostEntry[]>(`${BASE}/token-boosts/top/v1`);
  return data ?? [];
}

/** Get latest boosted tokens. */
async function fetchLatestBoosts(): Promise<readonly BoostEntry[]> {
  const data = await fetchJson<BoostEntry[]>(`${BASE}/token-boosts/latest/v1`);
  return data ?? [];
}

/** Get latest token profiles (new listings). */
async function fetchLatestProfiles(): Promise<readonly ProfileEntry[]> {
  const data = await fetchJson<ProfileEntry[]>(`${BASE}/token-profiles/latest/v1`);
  return data ?? [];
}

/** Batch-fetch full pair data for tokens on a given chain. Max 30 addresses per call. */
async function fetchTokenPairs(
  chainId: string,
  addresses: readonly string[],
): Promise<readonly DexScreenerPair[]> {
  if (addresses.length === 0) return [];

  // API accepts comma-separated addresses, max 30
  const batches: string[][] = [];
  for (let i = 0; i < addresses.length; i += 30) {
    batches.push(addresses.slice(i, i + 30) as string[]);
  }

  const results = await Promise.all(
    batches.map(async (batch) => {
      const joined = batch.join(",");
      const data = await fetchJson<DexScreenerPair[]>(
        `${BASE}/tokens/v1/${chainId}/${joined}`,
      );
      return data ?? [];
    }),
  );

  return results.flat();
}

/**
 * Well-known high-volume tokens per chain for direct lookup.
 * DexScreener search API doesn't return Ethereum L1 pairs,
 * so we fetch these directly via /tokens/v1/{chain}/{addresses}.
 */
const SEED_TOKENS: Readonly<Record<string, readonly string[]>> = {
  ethereum: [
    "0x6982508145454Ce325dDbE47a25d4ec3d2311933", // PEPE
    "0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE", // SHIB
    "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", // WBTC
    "0x514910771AF9Ca656af840dff83E8264EcF986CA", // LINK
    "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984", // UNI
    "0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9", // AAVE
    "0xfAbA6f8e4a5E8Ab82F62fe7C39859FA577269BE3", // ONDO
    "0x163f8C2467924be0ae7B5347228CABF260318753", // WLD
    "0xdAC17F958D2ee523a2206206994597C13D831ec7", // USDT
    "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", // USDC
    "0x6B175474E89094C44Da98b954EedeAC495271d0F", // DAI
    "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", // WETH
    "0x4d224452801ACEd8B2F0aebE155379bb5D594381", // APE
    "0x15D4c048F83bd7e37d49eA4C83a07267Ec4203dA", // GALA
    "0xaea46A60368A7bD060eec7DF8CBa43b7EF41Ad85", // FET
  ],
  base: [
    "0x532f27101965dd16442E59d40670FaF5eBB142E4", // BRETT
    "0xB1a03EdA10342529bBF8EB700a06C60441fEf25d", // MIGGLES
    "0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b", // VIRTUAL
    "0xBC45647eA894030a4E9801Ec03479739FA2485F0", // TOSHI
    "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed", // DEGEN
    "0x940181a94A35A4569E4529A3CDfB74e38FD98631", // AERO
    "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // USDC
    "0x4200000000000000000000000000000000000006", // WETH
    "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22", // cbETH
    "0x236aa50979D5f3De3Bd1Eeb40E81137F22ab794b", // tBTC
  ],
};

/**
 * Fetch top pairs for a chain via direct token address lookup.
 * This works for Ethereum where search API returns zero results.
 */
async function fetchChainTopPairs(chainId: string): Promise<readonly DexScreenerPair[]> {
  const addresses = SEED_TOKENS[chainId];
  if (!addresses || addresses.length === 0) return [];

  return fetchTokenPairs(chainId, addresses);
}

/** Search pairs by query (for user search feature). */
export async function searchToken(query: string): Promise<readonly TrendingToken[]> {
  const t0 = Date.now();

  const data = await fetchJson<{ pairs?: DexScreenerPair[] }>(
    `${BASE}/latest/dex/search?q=${encodeURIComponent(query)}`,
  );

  const pairs = data?.pairs ?? [];
  const results = pairs
    .filter((p) => p.liquidity && p.liquidity.usd > 1000 && p.volume.h24 > 1000)
    .slice(0, 30)
    .map(pairToToken);

  log.info("Token search completed", { query, count: results.length, durationMs: Date.now() - t0 });
  return results;
}

// ─── Helpers ───

function pairToToken(pair: DexScreenerPair): TrendingToken {
  return {
    symbol: pair.baseToken.symbol,
    name: pair.baseToken.name,
    address: pair.baseToken.address,
    chainId: pair.chainId,
    priceUsd: pair.priceUsd,
    priceChange24h: pair.priceChange.h24 ?? 0,
    volume24h: pair.volume.h24,
    liquidityUsd: pair.liquidity?.usd,
    marketCap: pair.fdv ?? pair.marketCap,
    pairUrl: pair.url,
    createdAt: pair.pairCreatedAt,
    imageUrl: pair.info?.imageUrl,
    boostAmount: pair.boosts?.active,
  };
}

/** Pick the best pair for each unique token (highest volume). */
function bestPairPerToken(pairs: readonly DexScreenerPair[]): readonly DexScreenerPair[] {
  const best = new Map<string, DexScreenerPair>();

  for (const pair of pairs) {
    const key = `${pair.chainId}:${pair.baseToken.address}`;
    const existing = best.get(key);
    if (!existing || pair.volume.h24 > existing.volume.h24) {
      best.set(key, pair);
    }
  }

  return [...best.values()];
}

/** Group token entries by chainId. */
function groupByChain<T extends { readonly chainId: string; readonly tokenAddress: string }>(
  entries: readonly T[],
): ReadonlyMap<string, readonly string[]> {
  const map = new Map<string, string[]>();
  const seen = new Set<string>();

  for (const entry of entries) {
    const key = `${entry.chainId}:${entry.tokenAddress}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const existing = map.get(entry.chainId);
    if (existing) {
      existing.push(entry.tokenAddress);
    } else {
      map.set(entry.chainId, [entry.tokenAddress]);
    }
  }

  return map;
}

/** Fetch full pair data for a set of discovered tokens, in parallel by chain. */
async function enrichTokens(
  entries: readonly { readonly chainId: string; readonly tokenAddress: string }[],
): Promise<readonly DexScreenerPair[]> {
  const byChain = groupByChain(entries);

  const allPairs = await Promise.all(
    [...byChain.entries()].map(([chainId, addresses]) =>
      fetchTokenPairs(chainId, addresses),
    ),
  );

  return allPairs.flat();
}

// ─── Public API ───

/**
 * Fetch trending tokens — top boosted + latest boosted, enriched with full pair data.
 * Supplements with search-based discovery for ethereum/base which are underrepresented
 * in the boost APIs (90%+ Solana).
 */
export async function fetchTrendingTokens(limit: number = 50): Promise<
  readonly TrendingToken[]
> {
  const t0 = Date.now();

  try {
    // Fetch boost lists + search-based pairs for ETH/Base in parallel
    const [topBoosts, latestBoosts, ethPairs, basePairs] = await Promise.all([
      fetchTopBoosts(),
      fetchLatestBoosts(),
      fetchChainTopPairs("ethereum"),
      fetchChainTopPairs("base"),
    ]);

    // Merge and deduplicate boost entries
    const seen = new Set<string>();
    const allEntries: { chainId: string; tokenAddress: string; boostAmount: number }[] = [];

    for (const entry of [...topBoosts, ...latestBoosts]) {
      if (!ALLOWED_CHAINS.has(entry.chainId)) continue;
      const key = `${entry.chainId}:${entry.tokenAddress}`;
      if (seen.has(key)) continue;
      seen.add(key);
      allEntries.push({
        chainId: entry.chainId,
        tokenAddress: entry.tokenAddress,
        boostAmount: entry.totalAmount ?? 0,
      });
    }

    // Enrich boosted tokens with full pair data
    const boostedPairs = allEntries.length > 0
      ? await enrichTokens(allEntries)
      : [];

    // Merge boosted pairs + search-based ETH/Base pairs
    const allPairs = [...boostedPairs, ...ethPairs, ...basePairs];

    // Filter: must have real volume and liquidity
    const validPairs = allPairs.filter(
      (p) =>
        ALLOWED_CHAINS.has(p.chainId) &&
        p.volume.h24 > 1000 &&
        p.liquidity &&
        p.liquidity.usd > 5000,
    );

    const deduped = bestPairPerToken(validPairs);

    // Sort by volume descending
    const sorted = [...deduped].sort((a, b) => b.volume.h24 - a.volume.h24);

    // Build boost amount lookup
    const boostMap = new Map(allEntries.map((e) => [`${e.chainId}:${e.tokenAddress}`, e.boostAmount]));

    const trending = sorted.slice(0, limit).map((pair) => ({
      ...pairToToken(pair),
      boostAmount: boostMap.get(`${pair.chainId}:${pair.baseToken.address}`) ?? 0,
    }));

    log.info("Trending tokens fetched", {
      boosts: allEntries.length,
      searchEth: ethPairs.length,
      searchBase: basePairs.length,
      result: trending.length,
      durationMs: Date.now() - t0,
    });

    return trending;
  } catch (err) {
    const msg = getErrorMessage(err);
    log.error("Trending fetch failed", { error: msg });
    return [];
  }
}

/**
 * Fetch new token listings — latest profiles + search-based discovery for ETH/Base.
 */
export async function fetchNewTokens(hours: number = 24): Promise<
  readonly TrendingToken[]
> {
  const t0 = Date.now();
  const cutoff = Date.now() - hours * 60 * 60 * 1000;

  try {
    // Fetch profiles + search-based pairs for ETH/Base in parallel
    const [allProfiles, ethPairs, basePairs] = await Promise.all([
      fetchLatestProfiles(),
      fetchChainTopPairs("ethereum"),
      fetchChainTopPairs("base"),
    ]);

    const profiles = allProfiles.filter((p) => ALLOWED_CHAINS.has(p.chainId));

    // Enrich profile tokens with full pair data
    const profilePairs = profiles.length > 0
      ? await enrichTokens(profiles)
      : [];

    // Merge all sources
    const allPairs = [...profilePairs, ...ethPairs, ...basePairs];

    // Filter for recent pairs with some activity
    const recentPairs = allPairs.filter((p) => {
      if (!ALLOWED_CHAINS.has(p.chainId)) return false;
      if (p.pairCreatedAt && p.pairCreatedAt < cutoff) return false;
      if (!p.liquidity || p.liquidity.usd < 1000) return false;
      return true;
    });

    const deduped = bestPairPerToken(recentPairs);
    const sorted = [...deduped].sort(
      (a, b) => (b.pairCreatedAt ?? 0) - (a.pairCreatedAt ?? 0),
    );

    const newTokens = sorted.slice(0, 50).map(pairToToken);

    log.info("New tokens fetched", {
      profiles: profiles.length,
      searchEth: ethPairs.length,
      searchBase: basePairs.length,
      result: newTokens.length,
      durationMs: Date.now() - t0,
    });

    return newTokens;
  } catch (err) {
    const msg = getErrorMessage(err);
    log.error("New tokens fetch failed", { error: msg });
    return [];
  }
}
