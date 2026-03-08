import { getQuestDB } from "./questdb";
import type { MarketType } from "./types";
import { createLogger } from "../../logger";

const log = createLogger("market:gap-detector");

// Thresholds: flag a day as a gap if it falls below these minimums
const MIN_KLINE_1M_PER_DAY = 1008; // 1440 expected, 70% threshold
const MIN_METRICS_PER_DAY = 200; // 288 expected (5m intervals), 70%
const MIN_MARK_PRICE_PER_DAY = 20; // 24 expected (1h), 83%

export interface GapDay {
  readonly date: Date;
  readonly actualCount: number;
  readonly expectedMin: number;
}

export interface KlineGapWindow {
  readonly fromMs: number;
  readonly toMs: number;
}

export interface FundingRateGap {
  readonly gapStart: number; // epoch ms — end of last known record
  readonly gapEnd: number; // epoch ms — start of next known record
  readonly gapHours: number;
}

/**
 * Return the open_time of the most recent kline for a symbol/marketType/timeframe.
 * Used by the recent-kline-patrol to compute how far behind we are.
 */
export async function findLatestKlineTs(
  symbol: string,
  marketType: MarketType,
  timeframe: string,
): Promise<number | null> {
  try {
    const { query } = getQuestDB();
    const rows = await query<{ latest: string | null }>(
      `SELECT MAX(open_time) AS latest
       FROM klines
       WHERE symbol = '${symbol}'
         AND market_type = '${marketType}'
         AND timeframe = '${timeframe}'`,
    );
    const val = rows[0]?.latest;
    if (!val) return null;
    return new Date(String(val)).getTime();
  } catch {
    return null;
  }
}

/** Start of today UTC — used as exclusive upper bound to skip today's incomplete data */
export function startOfToday(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/** Start of N days ago UTC */
export function daysAgo(n: number): Date {
  const d = startOfToday();
  d.setUTCDate(d.getUTCDate() - n);
  return d;
}

function toMs(isoOrNull: unknown): number | null {
  if (!isoOrNull) return null;
  const t = new Date(String(isoOrNull)).getTime();
  return Number.isNaN(t) ? null : t;
}

/** Build a map of dayKey → count from SAMPLE BY 1d query results */
function buildDayCountMap(
  rows: readonly { ts: string; cnt: number }[],
): Map<number, number> {
  const map = new Map<number, number>();
  for (const row of rows) {
    const ms = toMs(row.ts);
    if (ms === null) continue;
    const d = new Date(ms);
    const key = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    map.set(key, Number(row.cnt));
  }
  return map;
}

/** Enumerate all days in [from, to) and return those below minCount */
function gapsFromMap(
  dayCounts: Map<number, number>,
  from: Date,
  to: Date,
  minCount: number,
): readonly GapDay[] {
  const gaps: GapDay[] = [];
  const current = new Date(
    Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()),
  );

  while (current < to) {
    const key = current.getTime();
    const count = dayCounts.get(key) ?? 0;
    if (count < minCount) {
      gaps.push({
        date: new Date(current),
        actualCount: count,
        expectedMin: minCount,
      });
    }
    current.setUTCDate(current.getUTCDate() + 1);
  }

  return gaps;
}

const MIN_KLINE_1M_PER_HOUR = 42; // 60 expected, 70% threshold

/**
 * Find contiguous windows of missing 1m kline data at hour-level granularity.
 * Returns precise [fromMs, toMs] windows for runs of hours with < 42 candles.
 * Used by kline-gap-patrol pass 2 to fill internal gaps via REST API.
 */
export async function findKlineGapWindows(
  symbol: string,
  marketType: MarketType,
  from: Date,
  to: Date,
): Promise<readonly KlineGapWindow[]> {
  try {
    const { query } = getQuestDB();
    const rows = await query<{ open_time: string; cnt: number }>(
      `SELECT open_time, count() AS cnt
       FROM klines
       WHERE symbol = '${symbol}'
         AND market_type = '${marketType}'
         AND timeframe = '1m'
         AND open_time >= '${from.toISOString()}'
         AND open_time < '${to.toISOString()}'
       SAMPLE BY 1h FILL(0)
       ORDER BY open_time`,
    );

    // Collect hours that are below threshold
    const gapHours: number[] = [];
    for (const row of rows) {
      const ms = toMs(row.open_time);
      if (ms === null) continue;
      if (Number(row.cnt) < MIN_KLINE_1M_PER_HOUR) {
        gapHours.push(ms);
      }
    }

    if (gapHours.length === 0) return [];

    // Merge adjacent gap hours into contiguous windows
    const ONE_HOUR = 60 * 60 * 1000;
    const windows: KlineGapWindow[] = [];
    let windowStart = gapHours[0]!;
    let windowEnd = gapHours[0]! + ONE_HOUR;

    for (let i = 1; i < gapHours.length; i++) {
      const hourMs = gapHours[i]!;
      if (hourMs <= windowEnd) {
        // Adjacent or overlapping — extend the window
        windowEnd = hourMs + ONE_HOUR;
      } else {
        // Non-adjacent — close current window and start new one
        windows.push({ fromMs: windowStart, toMs: windowEnd });
        windowStart = hourMs;
        windowEnd = hourMs + ONE_HOUR;
      }
    }
    // Close final window
    windows.push({ fromMs: windowStart, toMs: windowEnd });

    return windows;
  } catch (err) {
    log.error("findKlineGapWindows failed", {
      symbol,
      marketType,
      error: err,
    });
    return [];
  }
}

/**
 * Find days in [from, to) with fewer than MIN_KLINE_1M_PER_DAY 1m candles.
 * Excludes today (always incomplete).
 */
export async function findKlineGaps(
  symbol: string,
  marketType: MarketType,
  from: Date,
  to: Date,
): Promise<readonly GapDay[]> {
  try {
    const { query } = getQuestDB();
    const rows = await query<{ open_time: string; cnt: number }>(
      `SELECT open_time, count() AS cnt
       FROM klines
       WHERE symbol = '${symbol}'
         AND market_type = '${marketType}'
         AND timeframe = '1m'
         AND open_time >= '${from.toISOString()}'
         AND open_time < '${to.toISOString()}'
       SAMPLE BY 1d
       ORDER BY open_time`,
    );
    const mapped = rows.map((r) => ({ ts: r.open_time, cnt: r.cnt }));
    return gapsFromMap(
      buildDayCountMap(mapped),
      from,
      to,
      MIN_KLINE_1M_PER_DAY,
    );
  } catch (err) {
    log.error("findKlineGaps failed", {
      symbol,
      marketType,
      error: err,
    });
    return [];
  }
}

/**
 * Find days in [from, to) with fewer than MIN_METRICS_PER_DAY rows in futures_metrics.
 */
export async function findMetricsGaps(
  symbol: string,
  from: Date,
  to: Date,
): Promise<readonly GapDay[]> {
  try {
    const { query } = getQuestDB();
    const rows = await query<{ create_time: string; cnt: number }>(
      `SELECT create_time, count() AS cnt
       FROM futures_metrics
       WHERE symbol = '${symbol}'
         AND create_time >= '${from.toISOString()}'
         AND create_time < '${to.toISOString()}'
       SAMPLE BY 1d
       ORDER BY create_time`,
    );
    const mapped = rows.map((r) => ({ ts: r.create_time, cnt: r.cnt }));
    return gapsFromMap(buildDayCountMap(mapped), from, to, MIN_METRICS_PER_DAY);
  } catch (err) {
    log.error("findMetricsGaps failed", {
      symbol,
      error: err,
    });
    return [];
  }
}

/**
 * Find consecutive funding rate entries where the gap exceeds 12h (normal is ~8h).
 */
export async function findFundingRateGaps(
  symbol: string,
  from: Date,
  to: Date,
): Promise<readonly FundingRateGap[]> {
  try {
    const { query } = getQuestDB();
    const rows = await query<{ funding_time: string }>(
      `SELECT funding_time
       FROM funding_rates
       WHERE symbol = '${symbol}'
         AND funding_time >= '${from.toISOString()}'
         AND funding_time <= '${to.toISOString()}'
       ORDER BY funding_time`,
    );

    if (rows.length < 2) return [];

    const gaps: FundingRateGap[] = [];
    for (let i = 0; i < rows.length - 1; i++) {
      const t1 = toMs(rows[i]!.funding_time);
      const t2 = toMs(rows[i + 1]!.funding_time);
      if (t1 === null || t2 === null) continue;

      const gapHours = (t2 - t1) / (1000 * 60 * 60);
      if (gapHours > 12) {
        gaps.push({ gapStart: t1, gapEnd: t2, gapHours });
      }
    }

    return gaps;
  } catch (err) {
    log.error("findFundingRateGaps failed", {
      symbol,
      error: err,
    });
    return [];
  }
}

/**
 * Find days in [from, to) with fewer than MIN_MARK_PRICE_PER_DAY 1h mark price rows.
 */
export async function findMarkPriceGaps(
  symbol: string,
  from: Date,
  to: Date,
): Promise<readonly GapDay[]> {
  try {
    const { query } = getQuestDB();
    const rows = await query<{ open_time: string; cnt: number }>(
      `SELECT open_time, count() AS cnt
       FROM mark_price_klines
       WHERE symbol = '${symbol}'
         AND timeframe = '1h'
         AND open_time >= '${from.toISOString()}'
         AND open_time < '${to.toISOString()}'
       SAMPLE BY 1d
       ORDER BY open_time`,
    );
    const mapped = rows.map((r) => ({ ts: r.open_time, cnt: r.cnt }));
    return gapsFromMap(
      buildDayCountMap(mapped),
      from,
      to,
      MIN_MARK_PRICE_PER_DAY,
    );
  } catch (err) {
    log.error("findMarkPriceGaps failed", {
      symbol,
      error: err,
    });
    return [];
  }
}
