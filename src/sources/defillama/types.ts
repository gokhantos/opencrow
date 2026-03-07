// --- Raw API types ---

export interface RawProtocol {
  readonly slug: string;
  readonly name: string;
  readonly category?: string;
  readonly chain?: string;
  readonly chains?: readonly string[];
  readonly tvl?: number;
  readonly change_1d?: number;
  readonly change_7d?: number;
  readonly url?: string;
  readonly description?: string;
}

export interface RawChain {
  readonly name: string;
  readonly tvl?: number;
  readonly protocols?: number;
}

export interface RawHistoricalTvlPoint {
  readonly date: number;
  readonly tvl: number;
}

export interface RawChainFees {
  readonly total24h?: number;
  readonly total7d?: number;
  readonly total30d?: number;
  readonly change_1d?: number;
}

export interface RawChainDexVolume {
  readonly total24h?: number;
  readonly total7d?: number;
  readonly total30d?: number;
  readonly change_1d?: number;
}

export interface RawStablecoinChain {
  readonly name: string;
  readonly totalCirculatingUSD?: {
    readonly peggedUSD?: number;
  };
}

export interface RawDexProtocol {
  readonly name?: string;
  readonly slug?: string;
  readonly total24h?: number;
  readonly change_1d?: number;
}

export interface RawProtocolDetail {
  readonly id: string;
  readonly name: string;
  readonly symbol?: string;
  readonly logo?: string;
  readonly twitter?: string;
  readonly description?: string;
  readonly category?: string;
  readonly chains?: readonly string[];
  readonly currentChainTvls?: Readonly<Record<string, number>>;
  readonly mcap?: number;
  readonly raises?: readonly {
    readonly date?: string;
    readonly amount?: number;
    readonly round?: string;
    readonly sector?: string;
    readonly leadInvestors?: readonly string[];
    readonly otherInvestors?: readonly string[];
  }[];
  readonly metrics?: {
    readonly fees?: { readonly "24h"?: number; readonly "7d"?: number };
    readonly revenue?: { readonly "24h"?: number; readonly "7d"?: number };
  };
}

export interface RawCategory {
  readonly chart: Readonly<Record<string, Readonly<Record<string, { readonly tvl: number }>>>> ;
  readonly categories: Readonly<Record<string, readonly string[]>>;
  readonly categoryPercentages: Readonly<Record<string, number>>;
}

export interface RawDexOverview {
  readonly totalVolume24h?: number;
  readonly totalVolume7d?: number;
  readonly change_1d?: number;
  readonly protocols?: readonly {
    readonly name?: string;
    readonly slug?: string;
    readonly total24h?: number;
    readonly change_1d?: number;
    readonly chains?: readonly string[];
  }[];
}

export interface RawFeesOverview {
  readonly totalFees24h?: number;
  readonly totalRevenue24h?: number;
  readonly change_1d?: number;
  readonly protocols?: readonly {
    readonly name?: string;
    readonly slug?: string;
    readonly fees24h?: number;
    readonly revenue24h?: number;
    readonly chains?: readonly string[];
  }[];
}

export interface RawOptionsOverview {
  readonly totalPremiumVolume?: number;
  readonly totalNotionalVolume?: number;
  readonly protocols?: readonly {
    readonly name?: string;
    readonly slug?: string;
    readonly premiumVolume24h?: number;
    readonly notionalVolume24h?: number;
    readonly chains?: readonly string[];
  }[];
}

export interface RawDerivativesOverview {
  readonly totalVolume24h?: number;
  readonly totalOpenInterest?: number;
  readonly change_1d?: number;
  readonly protocols?: Readonly<Record<string, {
    readonly volume24h?: number;
    readonly openInterest?: number;
    readonly chains?: readonly string[];
  }>>;
}

// --- DB row types ---

export interface ProtocolRow {
  readonly id: string;
  readonly name: string;
  readonly category: string;
  readonly chain: string;
  readonly chains_json: string;
  readonly tvl: number;
  readonly tvl_prev: number | null;
  readonly change_1d: number | null;
  readonly change_7d: number | null;
  readonly url: string;
  readonly description: string;
  readonly first_seen_at: number;
  readonly updated_at: number;
  readonly indexed_at: number | null;
}

export interface ChainTvlRow {
  readonly id: string;
  readonly name: string;
  readonly tvl: number;
  readonly tvl_prev: number | null;
  readonly protocols_count: number;
  readonly updated_at: number;
}

export interface ChainTvlHistoryRow {
  readonly chain_id: string;
  readonly date: number;
  readonly tvl: number;
}

export interface ChainMetricsRow {
  readonly chain_id: string;
  readonly metric_date: number;
  readonly fees_24h: number | null;
  readonly fees_7d: number | null;
  readonly fees_30d: number | null;
  readonly fees_change_1d: number | null;
  readonly revenue_24h: number | null;
  readonly revenue_7d: number | null;
  readonly revenue_30d: number | null;
  readonly revenue_change_1d: number | null;
  readonly dex_volume_24h: number | null;
  readonly dex_volume_7d: number | null;
  readonly dex_volume_30d: number | null;
  readonly dex_volume_change_1d: number | null;
  readonly stablecoin_mcap: number | null;
  readonly updated_at: number;
}

export interface ProtocolDetailRow {
  readonly id: string;
  readonly symbol: string;
  readonly logo: string;
  readonly twitter: string;
  readonly description_full: string;
  readonly mcap: number | null;
  readonly chains_json: string;
  readonly current_chain_tvls_json: string;
  readonly raises_json: string;
  readonly fees_24h: number | null;
  readonly fees_7d: number | null;
  readonly revenue_24h: number | null;
  readonly revenue_7d: number | null;
  readonly updated_at: number;
}

export interface CategoryRow {
  readonly name: string;
  readonly tvl: number;
  readonly percentage: number;
  readonly protocol_count: number;
  readonly updated_at: number;
}

export interface GlobalMetricsRow {
  readonly metric_type: string;
  readonly metric_date: number;
  readonly total_24h: number | null;
  readonly total_7d: number | null;
  readonly change_1d: number | null;
  readonly extra_json: string;
  readonly updated_at: number;
}

export interface ProtocolMetricsRow {
  readonly protocol_id: string;
  readonly metric_type: string;
  readonly value_24h: number | null;
  readonly value_7d: number | null;
  readonly change_1d: number | null;
  readonly chains_json: string;
  readonly updated_at: number;
}

export interface RawYieldPool {
  readonly pool?: string;
  readonly chain?: string;
  readonly project?: string;
  readonly symbol?: string;
  readonly tvlUsd?: number;
  readonly apy?: number;
  readonly apyBase?: number;
  readonly apyReward?: number;
  readonly apyBase7d?: number;
  readonly rewardTokens?: readonly string[];
  readonly underlyingTokens?: readonly string[];
  readonly poolMeta?: string;
  readonly exposure?: string;
  readonly il7d?: number;
  readonly volumeUsd1d?: number;
  readonly volumeUsd7d?: number;
}

export interface RawBridge {
  readonly id?: number;
  readonly name?: string;
  readonly displayName?: string;
  readonly icon?: string;
  readonly volumePrevDay?: number;
  readonly volumePrev2Day?: number;
  readonly lastHourlyVolume?: number;
  readonly last24hVolume?: number;
}

export interface RawBridgeDetail {
  readonly id?: number;
  readonly name?: string;
  readonly displayName?: string;
  readonly lastDailyVolume?: number;
  readonly weeklyVolume?: number;
  readonly monthlyVolume?: number;
  readonly chainBreakdown?: Readonly<Record<string, {
    readonly lastDailyVolume?: number;
    readonly weeklyVolume?: number;
    readonly monthlyVolume?: number;
    readonly last24hVolume?: number;
  }>>;
}

export interface RawHack {
  readonly name?: string;
  readonly protocol?: string;
  readonly amount?: number;
  readonly chain?: string;
  readonly classification?: string;
  readonly technique?: string;
  readonly date?: number;
  readonly description?: string;
}

export interface RawStablecoin {
  readonly id?: string;
  readonly name?: string;
  readonly symbol?: string;
  readonly pegType?: string;
  readonly circulating?: { readonly peggedUSD?: number };
  readonly chains?: readonly string[];
  readonly price?: number;
}

export interface RawEmission {
  readonly protocolId?: string;
  readonly name?: string;
  readonly token?: string;
  readonly circSupply?: number;
  readonly totalLocked?: number;
  readonly maxSupply?: number;
  readonly gecko_id?: string;
  readonly unlocksPerDay?: number;
  readonly mcap?: number;
  readonly nextEvent?: { readonly date?: number; readonly toUnlock?: number };
  readonly events?: readonly {
    readonly description?: string;
    readonly timestamp?: number;
    readonly noOfTokens?: readonly number[];
    readonly category?: string;
    readonly unlockType?: string;
  }[];
}

export interface RawTreasury {
  readonly id?: string;
  readonly name?: string;
  readonly slug?: string;
  readonly tvl?: number;
  readonly category?: string;
  readonly chains?: readonly string[];
  readonly tokenBreakdowns?: {
    readonly ownTokens?: number;
    readonly stablecoins?: number;
    readonly majors?: number;
    readonly others?: number;
  };
}

// --- Phase 3 DB row types ---

export interface YieldPoolRow {
  readonly pool_id: string;
  readonly chain: string;
  readonly project: string;
  readonly symbol: string;
  readonly tvl_usd: number;
  readonly apy: number | null;
  readonly apy_base: number | null;
  readonly apy_reward: number | null;
  readonly apy_base_7d: number | null;
  readonly volume_usd_1d: number | null;
  readonly volume_usd_7d: number | null;
  readonly pool_meta: string;
  readonly exposure: string;
  readonly reward_tokens_json: string;
  readonly updated_at: number;
}

export interface BridgeRow {
  readonly id: number;
  readonly name: string;
  readonly display_name: string;
  readonly volume_prev_day: number | null;
  readonly volume_prev_2day: number | null;
  readonly last_24h_volume: number | null;
  readonly chain_breakdown_json: string;
  readonly updated_at: number;
}

export interface HackRow {
  readonly id: string;
  readonly name: string;
  readonly protocol: string;
  readonly amount: number;
  readonly chain: string;
  readonly classification: string;
  readonly technique: string;
  readonly date: number;
  readonly description: string;
  readonly updated_at: number;
}

export interface EmissionRow {
  readonly protocol_id: string;
  readonly name: string;
  readonly token: string;
  readonly circ_supply: number | null;
  readonly total_locked: number | null;
  readonly max_supply: number | null;
  readonly unlocks_per_day: number | null;
  readonly mcap: number | null;
  readonly next_event_date: number | null;
  readonly next_event_unlock: number | null;
  readonly events_json: string;
  readonly updated_at: number;
}

export interface StablecoinRow {
  readonly id: string;
  readonly name: string;
  readonly symbol: string;
  readonly peg_type: string;
  readonly circulating: number;
  readonly chains_json: string;
  readonly price: number | null;
  readonly updated_at: number;
}

export interface TreasuryRow {
  readonly protocol_id: string;
  readonly name: string;
  readonly total_usd: number;
  readonly own_tokens_usd: number;
  readonly stablecoins_usd: number;
  readonly majors_usd: number;
  readonly others_usd: number;
  readonly updated_at: number;
}

// --- Scraper exports ---

export interface DefiLlamaScraper {
  start(): void;
  stop(): void;
  scrapeNow(): Promise<ScrapeResult>;
}

export interface ScrapeResult {
  readonly ok: boolean;
  readonly protocols?: number;
  readonly chains?: number;
  readonly historyPoints?: number;
  readonly metricsChains?: number;
  readonly protocolDetails?: number;
  readonly categories?: number;
  readonly yieldPools?: number;
  readonly bridges?: number;
  readonly hacks?: number;
  readonly stablecoins?: number;
  readonly emissions?: number;
  readonly treasury?: number;
  readonly error?: string;
}
