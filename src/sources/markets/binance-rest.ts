import type { OhlcvRow, MarketType, MarketSummary, TimeFrame } from "./types";
import { createLogger } from "../../logger";

const log = createLogger("market:binance-rest");

// --- TTL Cache ---

class TtlCache<T> {
  private readonly store = new Map<string, { value: T; expiresAt: number }>();

  constructor(private readonly ttlMs: number) {}

  get(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T): void {
    this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }
}

const klinesCache = new TtlCache<readonly OhlcvRow[]>(10_000);
const tickerCache = new TtlCache<MarketSummary | null>(15_000);

// --- Helpers ---

/** Convert "BTC/USDT" → "BTCUSDT" */
export function toBinanceSymbol(symbol: string): string {
  return symbol.replace("/", "");
}

/** Binance interval strings match our TimeFrame type exactly */
const BINANCE_INTERVALS: Record<TimeFrame, string> = {
  "1m": "1m",
  "5m": "5m",
  "15m": "15m",
  "1h": "1h",
  "4h": "4h",
  "1d": "1d",
  "1w": "1w",
  "1M": "1M",
};

function baseUrl(marketType: MarketType): string {
  return marketType === "futures"
    ? "https://fapi.binance.com"
    : "https://api.binance.com";
}

function klinesPath(marketType: MarketType): string {
  return marketType === "futures" ? "/fapi/v1/klines" : "/api/v3/klines";
}

function tickerPath(marketType: MarketType): string {
  return marketType === "futures"
    ? "/fapi/v1/ticker/24hr"
    : "/api/v3/ticker/24hr";
}

/** Max candles per request: spot=1000, futures=1500 */
function maxPerRequest(marketType: MarketType): number {
  return marketType === "futures" ? 1500 : 1000;
}

// --- Klines ---

type BinanceKlineArr = [
  number, // 0: open time
  string, // 1: open
  string, // 2: high
  string, // 3: low
  string, // 4: close
  string, // 5: volume
  number, // 6: close time
  string, // 7: quote volume
  number, // 8: trades
  string, // 9: taker buy base vol
  string, // 10: taker buy quote vol
  string, // 11: ignore
];

function mapKline(
  arr: BinanceKlineArr,
  symbol: string,
  marketType: MarketType,
  timeframe: string,
): OhlcvRow {
  return {
    symbol,
    market_type: marketType,
    timeframe,
    open_time: arr[0],
    open: Number(arr[1]),
    high: Number(arr[2]),
    low: Number(arr[3]),
    close: Number(arr[4]),
    volume: Number(arr[5]),
    close_time: arr[6],
    quote_volume: Number(arr[7]),
    trades: arr[8],
  };
}

export async function fetchBinanceKlines(params: {
  readonly symbol: string;
  readonly marketType: MarketType;
  readonly timeframe: TimeFrame;
  readonly startTime: number;
  readonly endTime: number;
  readonly limit?: number;
}): Promise<readonly OhlcvRow[]> {
  const cacheKey = `${params.marketType}:${params.symbol}:${params.timeframe}:${params.startTime}:${params.endTime}:${params.limit ?? 0}`;
  const cached = klinesCache.get(cacheKey);
  if (cached) return cached;

  const binSymbol = toBinanceSymbol(params.symbol);
  const interval = BINANCE_INTERVALS[params.timeframe];
  const maxPer = maxPerRequest(params.marketType);
  const wantedLimit = params.limit ?? 1000;

  const allRows: OhlcvRow[] = [];
  let cursor = params.startTime;

  while (cursor < params.endTime && allRows.length < wantedLimit) {
    const batchLimit = Math.min(maxPer, wantedLimit - allRows.length);
    const url = new URL(
      `${baseUrl(params.marketType)}${klinesPath(params.marketType)}`,
    );
    url.searchParams.set("symbol", binSymbol);
    url.searchParams.set("interval", interval);
    url.searchParams.set("startTime", String(cursor));
    url.searchParams.set("endTime", String(params.endTime));
    url.searchParams.set("limit", String(batchLimit));

    const res = await fetch(url.toString());
    if (!res.ok) {
      const body = await res.text();
      log.error(`Binance klines error ${res.status}: ${body}`);
      break;
    }

    const data: BinanceKlineArr[] = await res.json();
    if (data.length === 0) break;

    for (const arr of data) {
      allRows.push(
        mapKline(arr, params.symbol, params.marketType, params.timeframe),
      );
    }

    // Move cursor past the last candle's open time to avoid duplicates
    cursor = data[data.length - 1]![0] + 1;

    // If we got fewer than requested, there's no more data
    if (data.length < batchLimit) break;
  }

  const result = Object.freeze(allRows);
  klinesCache.set(cacheKey, result);
  return result;
}

// --- 24hr Ticker ---

interface BinanceTicker24hr {
  readonly symbol: string;
  readonly lastPrice: string;
  readonly priceChange: string;
  readonly priceChangePercent: string;
  readonly highPrice: string;
  readonly lowPrice: string;
  readonly volume: string;
  readonly quoteVolume: string;
  readonly openPrice: string;
}

export async function fetchBinanceTicker24hr(
  symbol: string,
  marketType: MarketType,
): Promise<MarketSummary | null> {
  const cacheKey = `${marketType}:${symbol}`;
  const cached = tickerCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const binSymbol = toBinanceSymbol(symbol);
  const url = `${baseUrl(marketType)}${tickerPath(marketType)}?symbol=${binSymbol}`;

  try {
    const res = await fetch(url);
    if (!res.ok) {
      log.error(`Binance ticker error ${res.status} for ${symbol}`);
      tickerCache.set(cacheKey, null);
      return null;
    }

    const t: BinanceTicker24hr = await res.json();
    const price = Number(t.lastPrice);
    const summary: MarketSummary = {
      symbol,
      marketType,
      price,
      change24h: Number(t.priceChange),
      changePercent24h: Number(t.priceChangePercent),
      high24h: Number(t.highPrice),
      low24h: Number(t.lowPrice),
      volume24h: Number(t.volume),
      quoteVolume24h: Number(t.quoteVolume),
    };
    tickerCache.set(cacheKey, summary);
    return summary;
  } catch (err) {
    log.error(`Binance ticker fetch failed for ${symbol}:`, err);
    tickerCache.set(cacheKey, null);
    return null;
  }
}
