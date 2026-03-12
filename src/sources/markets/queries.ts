import { getQuestDB } from "./questdb";
import type {
  OhlcvRow,
  MarketSummary,
  TimeFrame,
  MarketType,
  FuturesMetrics,
  FundingRate,
  TakerVolume,
} from "./types";
import { fetchBinanceKlines, fetchBinanceTicker24hr } from "./binance-rest";

// OI + L/S ratio queries live in a separate file to keep this file under the line limit
export {
  getOpenInterestHistory,
  getLatestOpenInterest,
  getLongShortRatioHistory,
  getLatestLongShortRatio,
  type LSRatioTable,
} from "./queries-derivatives";
/** QuestDB returns timestamps as ISO strings — parse to epoch ms */
function tsToMs(isoOrNull: unknown): number {
  if (!isoOrNull) return 0;
  return new Date(String(isoOrNull)).getTime();
}

// --- Input validation (prevent SQL injection via allowlist patterns) ---

/** Symbols contain only uppercase letters, numbers, and "/" */
function safeSymbol(s: string): string {
  if (!/^[A-Z0-9/]+$/.test(s)) {
    throw new Error(`Invalid symbol: ${s}`);
  }
  return s;
}

/** Period strings for derivatives endpoints */
function safePeriod(p: string): string {
  if (!/^[0-9]+(m|h|d)$/.test(p)) {
    throw new Error(`Invalid period: ${p}`);
  }
  return p;
}

export async function getLatestPrice(
  symbol: string,
  marketType: MarketType,
): Promise<{ price: number; timestamp: number } | null> {
  const ticker = await fetchBinanceTicker24hr(symbol, marketType);
  if (!ticker) return null;
  return { price: ticker.price, timestamp: Date.now() };
}

export async function getCandles(params: {
  readonly symbol: string;
  readonly marketType: MarketType;
  readonly timeframe: TimeFrame;
  readonly from: number;
  readonly to: number;
  readonly limit?: number;
}): Promise<readonly OhlcvRow[]> {
  return fetchBinanceKlines({
    symbol: params.symbol,
    marketType: params.marketType,
    timeframe: params.timeframe,
    startTime: params.from,
    endTime: params.to,
    limit: params.limit,
  });
}

export async function getMarketSummaries(
  symbols: readonly string[],
  marketType: MarketType,
): Promise<readonly MarketSummary[]> {
  const results = await Promise.all(
    symbols.map((s) => fetchBinanceTicker24hr(s, marketType)),
  );
  return results.filter((r): r is MarketSummary => r !== null);
}

export async function getKlineCounts(): Promise<
  ReadonlyMap<string, readonly { timeframe: string; count: number }[]>
> {
  const { query } = getQuestDB();
  const rows = await query<{
    market_type: string;
    symbol: string;
    timeframe: string;
    cnt: number;
  }>(
    `SELECT market_type, symbol, timeframe, count() AS cnt
     FROM klines
     GROUP BY market_type, symbol, timeframe
     ORDER BY market_type, symbol, timeframe`,
  );

  const map = new Map<string, { timeframe: string; count: number }[]>();
  for (const row of rows) {
    const key = `${row.market_type}:${row.symbol}`;
    const existing = map.get(key) ?? [];
    map.set(key, [
      ...existing,
      { timeframe: row.timeframe, count: Number(row.cnt) },
    ]);
  }
  return map;
}

// --- Futures Metrics queries ---

export async function getLatestMetrics(
  symbol: string,
): Promise<FuturesMetrics | null> {
  const { query } = getQuestDB();
  const rows = await query<{
    symbol: string;
    create_time: string;
    sum_open_interest: number;
    sum_open_interest_value: number;
    count_toptrader_long_short_ratio: number;
    sum_toptrader_long_short_ratio: number;
    count_long_short_ratio: number;
    sum_taker_long_short_vol_ratio: number;
  }>(
    `SELECT *
     FROM futures_metrics
     WHERE symbol = '${safeSymbol(symbol)}'
     ORDER BY create_time DESC
     LIMIT 1`,
  );
  if (rows.length === 0) return null;
  const r = rows[0]!;
  return {
    symbol: r.symbol,
    createTime: tsToMs(r.create_time),
    sumOpenInterest: r.sum_open_interest,
    sumOpenInterestValue: r.sum_open_interest_value,
    countTopTraderLongShortRatio: r.count_toptrader_long_short_ratio,
    sumTopTraderLongShortRatio: r.sum_toptrader_long_short_ratio,
    countLongShortRatio: r.count_long_short_ratio,
    sumTakerLongShortVolRatio: r.sum_taker_long_short_vol_ratio,
  };
}

export async function getLatestFundingRate(
  symbol: string,
): Promise<FundingRate | null> {
  const { query } = getQuestDB();
  const rows = await query<{
    symbol: string;
    funding_time: string;
    funding_rate: number;
    mark_price: number;
  }>(
    `SELECT *
     FROM funding_rates
     WHERE symbol = '${safeSymbol(symbol)}'
     ORDER BY funding_time DESC
     LIMIT 1`,
  );
  if (rows.length === 0) return null;
  const r = rows[0]!;
  return {
    symbol: r.symbol,
    fundingTime: tsToMs(r.funding_time),
    fundingRate: r.funding_rate,
    markPrice: r.mark_price,
  };
}

export async function getFundingRateHistory(params: {
  readonly symbol: string;
  readonly from: number;
  readonly to: number;
  readonly limit?: number;
}): Promise<readonly FundingRate[]> {
  const { query } = getQuestDB();
  const fromIso = new Date(params.from).toISOString();
  const toIso = new Date(params.to).toISOString();
  const limit = params.limit ?? 500;

  const rows = await query<{
    symbol: string;
    funding_time: string;
    funding_rate: number;
    mark_price: number;
  }>(
    `SELECT *
     FROM funding_rates
     WHERE symbol = '${safeSymbol(params.symbol)}'
       AND funding_time >= '${fromIso}'
       AND funding_time <= '${toIso}'
     ORDER BY funding_time
     LIMIT ${limit}`,
  );
  return rows.map((r) => ({
    symbol: r.symbol,
    fundingTime: tsToMs(r.funding_time),
    fundingRate: r.funding_rate,
    markPrice: r.mark_price,
  }));
}

export async function getRecentLiquidations(params: {
  readonly symbol?: string;
  readonly hoursBack?: number;
  readonly limit?: number;
}): Promise<
  readonly {
    symbol: string;
    side: string;
    quantity: number;
    price: number;
    avg_price: number;
    trade_time: number;
    usd_value: number;
  }[]
> {
  const { query } = getQuestDB();
  const hoursBack = params.hoursBack ?? 24;
  const since = new Date(Date.now() - hoursBack * 60 * 60 * 1000).toISOString();
  const symbolFilter = params.symbol
    ? `AND symbol = '${safeSymbol(params.symbol)}'`
    : "";
  const limit = params.limit ?? 50;

  const rows = await query<{
    symbol: string;
    side: string;
    quantity: number;
    price: number;
    avg_price: number;
    trade_time: string;
  }>(
    `SELECT symbol, side, quantity, price, avg_price, trade_time
     FROM liquidations
     WHERE trade_time >= '${since}'
       ${symbolFilter}
     ORDER BY trade_time DESC
     LIMIT ${limit}`,
  );
  return rows.map((r) => ({
    symbol: r.symbol,
    side: r.side,
    quantity: r.quantity,
    price: r.price,
    avg_price: r.avg_price,
    trade_time: tsToMs(r.trade_time),
    usd_value: r.quantity * r.avg_price,
  }));
}

export async function getMetricsHistory(params: {
  readonly symbol: string;
  readonly from: number;
  readonly to: number;
  readonly limit?: number;
}): Promise<readonly FuturesMetrics[]> {
  const { query } = getQuestDB();
  const fromIso = new Date(params.from).toISOString();
  const toIso = new Date(params.to).toISOString();
  const limit = params.limit ?? 500;

  const rows = await query<{
    symbol: string;
    create_time: string;
    sum_open_interest: number;
    sum_open_interest_value: number;
    count_toptrader_long_short_ratio: number;
    sum_toptrader_long_short_ratio: number;
    count_long_short_ratio: number;
    sum_taker_long_short_vol_ratio: number;
  }>(
    `SELECT *
     FROM futures_metrics
     WHERE symbol = '${safeSymbol(params.symbol)}'
       AND create_time >= '${fromIso}'
       AND create_time <= '${toIso}'
     ORDER BY create_time
     LIMIT ${limit}`,
  );
  return rows.map((r) => ({
    symbol: r.symbol,
    createTime: tsToMs(r.create_time),
    sumOpenInterest: r.sum_open_interest,
    sumOpenInterestValue: r.sum_open_interest_value,
    countTopTraderLongShortRatio: r.count_toptrader_long_short_ratio,
    sumTopTraderLongShortRatio: r.sum_toptrader_long_short_ratio,
    countLongShortRatio: r.count_long_short_ratio,
    sumTakerLongShortVolRatio: r.sum_taker_long_short_vol_ratio,
  }));
}

export async function getLiquidationBuckets(params: {
  readonly symbol?: string;
  readonly hoursBack?: number;
  readonly bucketMinutes?: number;
}): Promise<
  readonly {
    bucket: number;
    long_usd: number;
    short_usd: number;
    long_count: number;
    short_count: number;
  }[]
> {
  const { query } = getQuestDB();
  const hoursBack = params.hoursBack ?? 24;
  const since = new Date(Date.now() - hoursBack * 60 * 60 * 1000).toISOString();
  const symbolFilter = params.symbol
    ? `AND symbol = '${safeSymbol(params.symbol)}'`
    : "";
  const bucketMinutes = params.bucketMinutes ?? 60;

  const rows = await query<{
    trade_time: string;
    long_usd: number;
    short_usd: number;
    long_count: number;
    short_count: number;
  }>(
    `SELECT
       trade_time,
       sum(CASE WHEN side = 'SELL' THEN quantity * avg_price ELSE 0 END) AS long_usd,
       sum(CASE WHEN side = 'BUY' THEN quantity * avg_price ELSE 0 END) AS short_usd,
       sum(CASE WHEN side = 'SELL' THEN 1 ELSE 0 END) AS long_count,
       sum(CASE WHEN side = 'BUY' THEN 1 ELSE 0 END) AS short_count
     FROM liquidations
     WHERE trade_time >= '${since}'
       ${symbolFilter}
     SAMPLE BY ${bucketMinutes}m
     ORDER BY trade_time`,
  );
  return rows.map((r) => ({
    bucket: tsToMs(r.trade_time),
    long_usd: r.long_usd,
    short_usd: r.short_usd,
    long_count: r.long_count,
    short_count: r.short_count,
  }));
}

export async function getLiquidationSummary(params: {
  readonly symbol?: string;
  readonly hoursBack?: number;
}): Promise<
  readonly {
    symbol: string;
    side: string;
    count: number;
    total_qty: number;
    total_usd: number;
  }[]
> {
  const { query } = getQuestDB();
  const hoursBack = params.hoursBack ?? 24;
  const since = new Date(Date.now() - hoursBack * 60 * 60 * 1000).toISOString();
  const symbolFilter = params.symbol
    ? `AND symbol = '${safeSymbol(params.symbol)}'`
    : "";

  return query<{
    symbol: string;
    side: string;
    count: number;
    total_qty: number;
    total_usd: number;
  }>(
    `SELECT
       symbol,
       side,
       count() AS count,
       sum(quantity) AS total_qty,
       sum(quantity * avg_price) AS total_usd
     FROM liquidations
     WHERE trade_time >= '${since}'
       ${symbolFilter}
     GROUP BY symbol, side
     ORDER BY total_usd DESC`,
  );
}

// --- Mark price klines queries ---

export async function getMarkPriceKlines(params: {
  readonly symbol: string;
  readonly from: number;
  readonly to: number;
  readonly limit?: number;
}): Promise<
  readonly {
    open_time: number;
    mark_open: number;
    mark_high: number;
    mark_low: number;
    mark_close: number;
    index_open: number;
    index_close: number;
  }[]
> {
  const { query } = getQuestDB();
  const fromIso = new Date(params.from).toISOString();
  const toIso = new Date(params.to).toISOString();
  const limit = params.limit ?? 1000;

  const rows = await query<{
    open_time: string;
    mark_open: number;
    mark_high: number;
    mark_low: number;
    mark_close: number;
    index_open: number;
    index_close: number;
  }>(
    `SELECT open_time, mark_open, mark_high, mark_low, mark_close, index_open, index_close
     FROM mark_price_klines
     WHERE symbol = '${safeSymbol(params.symbol)}'
       AND timeframe = '1h'
       AND open_time >= '${fromIso}'
       AND open_time <= '${toIso}'
     ORDER BY open_time
     LIMIT ${limit}`,
  );

  return rows.map((r) => ({
    open_time: tsToMs(r.open_time),
    mark_open: r.mark_open,
    mark_high: r.mark_high,
    mark_low: r.mark_low,
    mark_close: r.mark_close,
    index_open: r.index_open,
    index_close: r.index_close,
  }));
}

// --- Taker volume queries ---

export async function getTakerVolume(params: {
  readonly symbol: string;
  readonly from: number;
  readonly to: number;
  readonly period?: string;
  readonly limit?: number;
}): Promise<readonly TakerVolume[]> {
  const { query } = getQuestDB();
  const fromIso = new Date(params.from).toISOString();
  const toIso = new Date(params.to).toISOString();
  const period = safePeriod(params.period ?? "1h");
  const limit = params.limit ?? 500;

  const rows = await query<{
    ts: string;
    symbol: string;
    period: string;
    buy_vol: number;
    sell_vol: number;
    buy_sell_ratio: number;
  }>(
    `SELECT ts, symbol, period, buy_vol, sell_vol, buy_sell_ratio
     FROM taker_volume
     WHERE symbol = '${safeSymbol(params.symbol)}'
       AND period = '${period}'
       AND ts >= '${fromIso}'
       AND ts <= '${toIso}'
     ORDER BY ts
     LIMIT ${limit}`,
  );

  return rows.map((r) => ({
    symbol: r.symbol,
    period: r.period,
    ts: tsToMs(r.ts),
    buyVol: r.buy_vol,
    sellVol: r.sell_vol,
    buySellRatio: r.buy_sell_ratio,
  }));
}

export async function getLatestTakerVolume(
  symbol: string,
  period: string = "1h",
): Promise<TakerVolume | null> {
  const { query } = getQuestDB();
  const rows = await query<{
    ts: string;
    symbol: string;
    period: string;
    buy_vol: number;
    sell_vol: number;
    buy_sell_ratio: number;
  }>(
    `SELECT ts, symbol, period, buy_vol, sell_vol, buy_sell_ratio
     FROM taker_volume
     WHERE symbol = '${safeSymbol(symbol)}'
       AND period = '${safePeriod(period)}'
     ORDER BY ts DESC
     LIMIT 1`,
  );
  if (rows.length === 0) return null;
  const r = rows[0]!;
  return {
    symbol: r.symbol,
    period: r.period,
    ts: tsToMs(r.ts),
    buyVol: r.buy_vol,
    sellVol: r.sell_vol,
    buySellRatio: r.buy_sell_ratio,
  };
}
