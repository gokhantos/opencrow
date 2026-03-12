import { test, expect } from "bun:test";
import type { TimeFrame } from "./types";

// Re-implemented from useLiveKline.tsx (module-private pure functions)

const TIMEFRAME_MS: Record<TimeFrame, number> = {
  "1m": 60_000,
  "5m": 300_000,
  "15m": 900_000,
  "1h": 3_600_000,
  "4h": 14_400_000,
  "1d": 86_400_000,
  "1w": 604_800_000,
  "1M": 2_592_000_000,
};

function periodStart(tsMs: number, tf: TimeFrame): number {
  const ms = TIMEFRAME_MS[tf];
  return Math.floor(tsMs / ms) * ms;
}

/* ---------- TIMEFRAME_MS ---------- */

test("TIMEFRAME_MS has correct millisecond values", () => {
  expect(TIMEFRAME_MS["1m"]).toBe(60_000);
  expect(TIMEFRAME_MS["5m"]).toBe(300_000);
  expect(TIMEFRAME_MS["15m"]).toBe(900_000);
  expect(TIMEFRAME_MS["1h"]).toBe(3_600_000);
  expect(TIMEFRAME_MS["4h"]).toBe(14_400_000);
  expect(TIMEFRAME_MS["1d"]).toBe(86_400_000);
  expect(TIMEFRAME_MS["1w"]).toBe(604_800_000);
  expect(TIMEFRAME_MS["1M"]).toBe(2_592_000_000);
});

test("TIMEFRAME_MS values increase", () => {
  const tfs: TimeFrame[] = ["1m", "5m", "15m", "1h", "4h", "1d", "1w", "1M"];
  for (let i = 1; i < tfs.length; i++) {
    expect(TIMEFRAME_MS[tfs[i]!]).toBeGreaterThan(TIMEFRAME_MS[tfs[i - 1]!]);
  }
});

/* ---------- periodStart ---------- */

test("periodStart floors to 1m boundary", () => {
  // 1:30.5 into a minute → floor to start of that minute
  const ts = 60_000 + 30_500;
  expect(periodStart(ts, "1m")).toBe(60_000);
});

test("periodStart floors to 5m boundary", () => {
  // 7 minutes in → floor to 5m mark
  const ts = 7 * 60_000;
  expect(periodStart(ts, "5m")).toBe(5 * 60_000);
});

test("periodStart floors to 1h boundary", () => {
  // 90 minutes in → floor to 1h mark
  const ts = 90 * 60_000;
  expect(periodStart(ts, "1h")).toBe(60 * 60_000);
});

test("periodStart returns 0 for timestamp within first period", () => {
  expect(periodStart(30_000, "1m")).toBe(0);
  expect(periodStart(200_000, "5m")).toBe(0);
});

test("periodStart is idempotent at boundary", () => {
  const boundary = 300_000; // exactly 5m
  expect(periodStart(boundary, "5m")).toBe(boundary);
});

test("periodStart floors to 4h boundary", () => {
  // 5 hours in → floor to 4h mark
  const ts = 5 * 3_600_000;
  expect(periodStart(ts, "4h")).toBe(4 * 3_600_000);
});

test("periodStart floors to 1d boundary", () => {
  // 36 hours in → floor to 24h mark
  const ts = 36 * 3_600_000;
  expect(periodStart(ts, "1d")).toBe(24 * 3_600_000);
});

/* ---------- WS aggregation logic ---------- */

interface OhlcvRow {
  open_time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  quote_volume: number;
  trades: number;
}

function aggregateKline(
  prev: OhlcvRow | null,
  kline: { open: number; high: number; low: number; close: number; volume: number; quoteVolume: number; trades: number },
  pStart: number,
  _tf: TimeFrame,
): OhlcvRow {
  if (!prev || prev.open_time !== pStart) {
    return {
      open_time: pStart,
      open: kline.open,
      high: kline.high,
      low: kline.low,
      close: kline.close,
      volume: kline.volume,
      quote_volume: kline.quoteVolume,
      trades: kline.trades,
    };
  }
  return {
    ...prev,
    high: Math.max(prev.high, kline.high),
    low: Math.min(prev.low, kline.low),
    close: kline.close,
    volume: prev.volume + kline.volume,
    quote_volume: prev.quote_volume + kline.quoteVolume,
    trades: prev.trades + kline.trades,
  };
}

test("aggregateKline creates new candle when no prev", () => {
  const k = { open: 100, high: 105, low: 98, close: 103, volume: 50, quoteVolume: 5000, trades: 10 };
  const result = aggregateKline(null, k, 0, "5m");
  expect(result.open_time).toBe(0);
  expect(result.open).toBe(100);
  expect(result.close).toBe(103);
  expect(result.volume).toBe(50);
});

test("aggregateKline creates new candle when period changes", () => {
  const prev: OhlcvRow = {
    open_time: 0,
    open: 100, high: 105, low: 98, close: 103,
    volume: 50, quote_volume: 5000, trades: 10,
  };
  const k = { open: 106, high: 108, low: 104, close: 107, volume: 30, quoteVolume: 3000, trades: 5 };
  const result = aggregateKline(prev, k, 300_000, "5m");
  expect(result.open_time).toBe(300_000);
  expect(result.open).toBe(106);
  expect(result.volume).toBe(30);
});

test("aggregateKline updates running aggregate within same period", () => {
  const prev: OhlcvRow = {
    open_time: 0,
    open: 100, high: 105, low: 98, close: 103,
    volume: 50, quote_volume: 5000, trades: 10,
  };
  const k = { open: 103, high: 110, low: 97, close: 108, volume: 30, quoteVolume: 3000, trades: 5 };
  const result = aggregateKline(prev, k, 0, "5m");
  expect(result.open_time).toBe(0);
  expect(result.open).toBe(100); // keeps original open
  expect(result.high).toBe(110); // takes max
  expect(result.low).toBe(97); // takes min
  expect(result.close).toBe(108); // uses latest
  expect(result.volume).toBe(80); // sums
  expect(result.quote_volume).toBe(8000);
  expect(result.trades).toBe(15);
});
