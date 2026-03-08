import { createSender } from "./questdb";
import type { MarketType, TimeFrame } from "./types";
import { createLogger } from "../../logger";

const log = createLogger("market:backfill-recent");

const SPOT_API = "https://api.binance.com";
const FUTURES_API = "https://fapi.binance.com";
const PAGE_LIMIT = 1000;

// Milliseconds per timeframe — used to compute gap windows
export const TIMEFRAME_MS: Record<TimeFrame, number> = {
  "1m": 60_000,
  "5m": 300_000,
  "15m": 900_000,
  "1h": 3_600_000,
  "4h": 14_400_000,
  "1d": 86_400_000,
  "1w": 604_800_000,
  "1M": 2_592_000_000,
};

function symbolToExchangeId(symbol: string): string {
  return symbol.replace("/", "");
}

function buildKlineUrl(
  marketType: MarketType,
  exchangeId: string,
  timeframe: TimeFrame,
  startTime: number,
  endTime: number,
): string {
  const base = marketType === "spot" ? SPOT_API : FUTURES_API;
  const path = marketType === "spot" ? "/api/v3/klines" : "/fapi/v1/klines";
  const params = new URLSearchParams({
    symbol: exchangeId,
    interval: timeframe,
    startTime: String(startTime),
    endTime: String(endTime),
    limit: String(PAGE_LIMIT),
  });
  return `${base}${path}?${params}`;
}

// Binance REST kline: [openTime, open, high, low, close, vol, closeTime, quoteVol, trades, ...]
type BinanceKlineRow = readonly [
  number, // 0: open time (ms)
  string, // 1: open
  string, // 2: high
  string, // 3: low
  string, // 4: close
  string, // 5: volume
  number, // 6: close time
  string, // 7: quote asset volume
  number, // 8: number of trades
  ...unknown[],
];

async function fetchKlinePage(
  url: string,
  signal?: AbortSignal,
): Promise<readonly BinanceKlineRow[]> {
  const res = await fetch(url, { signal });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} from ${url}`);
  }
  return res.json() as Promise<BinanceKlineRow[]>;
}

/**
 * Fill a kline gap window for a single symbol/marketType/timeframe using the
 * Binance REST API. Unlike data.binance.vision, this covers today and yesterday.
 *
 * @returns Number of candles inserted.
 */
export async function fillRecentKlines(
  symbol: string,
  marketType: MarketType,
  timeframe: TimeFrame,
  fromMs: number,
  toMs: number,
  signal?: AbortSignal,
): Promise<number> {
  if (fromMs >= toMs) return 0;

  const exchangeId = symbolToExchangeId(symbol);
  const sender = await createSender();
  let totalInserted = 0;

  try {
    let startTime = fromMs;

    while (!signal?.aborted && startTime < toMs) {
      const url = buildKlineUrl(
        marketType,
        exchangeId,
        timeframe,
        startTime,
        toMs,
      );
      const page = await fetchKlinePage(url, signal);
      if (page.length === 0) break;

      for (const row of page) {
        const openTime = row[0];
        const closeTime = row[6];

        sender
          .table("klines")
          .symbol("symbol", symbol)
          .symbol("market_type", marketType)
          .symbol("timeframe", timeframe)
          .floatColumn("open", Number(row[1]))
          .floatColumn("high", Number(row[2]))
          .floatColumn("low", Number(row[3]))
          .floatColumn("close", Number(row[4]))
          .floatColumn("volume", Number(row[5]))
          .timestampColumn("close_time", BigInt(closeTime) * 1000n)
          .floatColumn("quote_volume", Number(row[7]))
          .intColumn("trades", row[8])
          .at(BigInt(openTime) * 1000n);
      }
      await sender.flush();
      totalInserted += page.length;

      // Advance start time past the last candle
      startTime = page[page.length - 1]![0] + TIMEFRAME_MS[timeframe];

      // Rate limit: conservative delay between pages
      if (page.length === PAGE_LIMIT) {
        await Bun.sleep(100);
      } else {
        break; // Last page — no more data in this window
      }
    }

    if (totalInserted > 0) {
      log.info("Filled recent klines from REST API", {
        symbol,
        marketType,
        timeframe,
        count: totalInserted,
        from: new Date(fromMs).toISOString(),
        to: new Date(toMs).toISOString(),
      });
    }

    return totalInserted;
  } catch (err) {
    if (signal?.aborted) return totalInserted;
    log.error("fillRecentKlines failed", {
      symbol,
      marketType,
      timeframe,
      error: err,
    });
    return totalInserted;
  } finally {
    await sender.close();
  }
}
