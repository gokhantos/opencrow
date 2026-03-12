import { test, expect, describe } from "bun:test";
import {
  computeOverlays,
  computeOscillators,
  computeVolumeIndicators,
  computeAllIndicators,
} from "./indicators";
import type { OhlcvRow } from "./types";

// ---------------------------------------------------------------------------
// Deterministic candle factory
// ---------------------------------------------------------------------------

function generateCandles(count: number, startPrice = 100): OhlcvRow[] {
  const candles: OhlcvRow[] = [];
  let price = startPrice;
  const BASE_TIME = 1700000000000;
  for (let i = 0; i < count; i++) {
    const change = Math.sin(i * 0.3) * 2 + 0.1; // deterministic wave pattern
    price = Math.max(10, price + change);
    const spread = Math.abs(Math.sin(i * 0.7)) * 3 + 0.5;
    const open = price - change / 2;
    const high = price + spread;
    const low = Math.max(1, price - spread);
    const volume = 1000 + Math.abs(Math.sin(i * 0.5)) * 5000;
    candles.push({
      symbol: "BTC/USDT",
      market_type: "spot",
      timeframe: "1m",
      open_time: BASE_TIME + i * 60000,
      open,
      high,
      low,
      close: price,
      volume,
      close_time: BASE_TIME + i * 60000 + 59999,
      quote_volume: price * volume,
      trades: 100,
    });
  }
  return candles;
}

const CANDLES_200 = generateCandles(200);
const CANDLES_5 = generateCandles(5);
const CANDLES_0: OhlcvRow[] = [];

// ---------------------------------------------------------------------------
// Overlay keys expected in the result
// ---------------------------------------------------------------------------

const OVERLAY_KEYS = [
  "ema9",
  "ema10",
  "ema21",
  "ema30",
  "ema50",
  "ema100",
  "ema200",
  "sma10",
  "sma20",
  "sma30",
  "sma50",
  "sma100",
  "sma200",
  "bbUpper",
  "bbMiddle",
  "bbLower",
  "vwap",
  "hma9",
  "vwma20",
  "superTrend",
  "psar",
  "keltnerUpper",
  "keltnerMiddle",
  "keltnerLower",
  "ichimokuConversion",
  "ichimokuBase",
  "ichimokuSpanA",
  "ichimokuSpanB",
] as const;

const OSCILLATOR_KEYS = [
  "rsi",
  "macdLine",
  "macdSignal",
  "macdHistogram",
  "stochK",
  "stochD",
  "adx",
  "cci",
  "williamsR",
  "atr",
  "awesomeOsc",
  "momentum",
  "stochRsiK",
  "stochRsiD",
  "bullBearPower",
  "ultimateOsc",
  "roc",
  "kstLine",
  "kstSignal",
  "trix",
  "mfi",
  "forceIndex",
] as const;

const VOLUME_KEYS = ["obv", "volumeMa", "adl"] as const;

// ---------------------------------------------------------------------------
// computeOverlays
// ---------------------------------------------------------------------------

describe("computeOverlays", () => {
  test("returns all expected keys with 200 candles", () => {
    const result = computeOverlays(CANDLES_200);
    for (const key of OVERLAY_KEYS) {
      expect(result).toHaveProperty(key);
    }
  });

  test("all overlay arrays have length equal to candle count", () => {
    const result = computeOverlays(CANDLES_200);
    for (const key of OVERLAY_KEYS) {
      expect(result[key].length).toBe(200);
    }
  });

  test("EMA9 has some non-null values with 200 candles", () => {
    const result = computeOverlays(CANDLES_200);
    const nonNull = result.ema9.filter((v) => v !== null);
    expect(nonNull.length).toBeGreaterThan(0);
  });

  test("EMA200 has at least one non-null value with 200 candles", () => {
    const result = computeOverlays(CANDLES_200);
    const nonNull = result.ema200.filter((v) => v !== null);
    expect(nonNull.length).toBeGreaterThan(0);
  });

  test("Bollinger Bands: upper > middle > lower where all non-null", () => {
    const result = computeOverlays(CANDLES_200);
    for (let i = 0; i < 200; i++) {
      const upper = result.bbUpper[i] ?? null;
      const middle = result.bbMiddle[i] ?? null;
      const lower = result.bbLower[i] ?? null;
      if (upper !== null && middle !== null && lower !== null) {
        expect(upper).toBeGreaterThanOrEqual(middle);
        expect(middle).toBeGreaterThanOrEqual(lower);
      }
    }
  });

  test("VWAP is non-null for all candles (cumulative from first candle)", () => {
    const result = computeOverlays(CANDLES_200);
    const nonNull = result.vwap.filter((v) => v !== null);
    expect(nonNull.length).toBe(200);
  });

  test("Keltner upper >= middle >= lower where non-null", () => {
    const result = computeOverlays(CANDLES_200);
    for (let i = 0; i < 200; i++) {
      const upper = result.keltnerUpper[i] ?? null;
      const middle = result.keltnerMiddle[i] ?? null;
      const lower = result.keltnerLower[i] ?? null;
      if (upper !== null && middle !== null && lower !== null) {
        expect(upper).toBeGreaterThanOrEqual(middle);
        expect(middle).toBeGreaterThanOrEqual(lower);
      }
    }
  });

  test("does not throw with empty candles array", () => {
    expect(() => computeOverlays(CANDLES_0)).not.toThrow();
  });

  test("does not throw with 5 candles", () => {
    expect(() => computeOverlays(CANDLES_5)).not.toThrow();
  });

  test("all overlay arrays have length equal to candle count for 5 candles", () => {
    const result = computeOverlays(CANDLES_5);
    for (const key of OVERLAY_KEYS) {
      expect(result[key].length).toBe(5);
    }
  });

  test("most long-period EMAs are all null with only 5 candles", () => {
    const result = computeOverlays(CANDLES_5);
    // EMA200 requires 200 data points — all entries should be null with 5 candles
    const nonNull = result.ema200.filter((v) => v !== null);
    expect(nonNull.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// computeOscillators
// ---------------------------------------------------------------------------

describe("computeOscillators", () => {
  test("returns all expected keys with 200 candles", () => {
    const result = computeOscillators(CANDLES_200);
    for (const key of OSCILLATOR_KEYS) {
      expect(result).toHaveProperty(key);
    }
  });

  test("all oscillator arrays have length equal to candle count", () => {
    const result = computeOscillators(CANDLES_200);
    for (const key of OSCILLATOR_KEYS) {
      expect(result[key].length).toBe(200);
    }
  });

  test("RSI values are between 0 and 100 where non-null", () => {
    const result = computeOscillators(CANDLES_200);
    for (const v of result.rsi) {
      if (v !== null) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(100);
      }
    }
  });

  test("RSI has some non-null values with 200 candles", () => {
    const result = computeOscillators(CANDLES_200);
    const nonNull = result.rsi.filter((v) => v !== null);
    expect(nonNull.length).toBeGreaterThan(0);
  });

  test("ATR values are non-negative where non-null", () => {
    const result = computeOscillators(CANDLES_200);
    for (const v of result.atr) {
      if (v !== null) {
        expect(v).toBeGreaterThanOrEqual(0);
      }
    }
  });

  test("does not throw with empty candles array", () => {
    expect(() => computeOscillators(CANDLES_0)).not.toThrow();
  });

  test("does not throw with 5 candles", () => {
    expect(() => computeOscillators(CANDLES_5)).not.toThrow();
  });

  test("all oscillator arrays have length equal to candle count for 5 candles", () => {
    const result = computeOscillators(CANDLES_5);
    for (const key of OSCILLATOR_KEYS) {
      expect(result[key].length).toBe(5);
    }
  });

  test("RSI is all null with only 5 candles (requires 14+ candles)", () => {
    const result = computeOscillators(CANDLES_5);
    const nonNull = result.rsi.filter((v) => v !== null);
    expect(nonNull.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// computeVolumeIndicators
// ---------------------------------------------------------------------------

describe("computeVolumeIndicators", () => {
  test("returns all expected keys with 200 candles", () => {
    const result = computeVolumeIndicators(CANDLES_200);
    for (const key of VOLUME_KEYS) {
      expect(result).toHaveProperty(key);
    }
  });

  test("all volume arrays have length equal to candle count", () => {
    const result = computeVolumeIndicators(CANDLES_200);
    for (const key of VOLUME_KEYS) {
      expect(result[key].length).toBe(200);
    }
  });

  test("OBV has some non-null values with 200 candles", () => {
    const result = computeVolumeIndicators(CANDLES_200);
    const nonNull = result.obv.filter((v) => v !== null);
    expect(nonNull.length).toBeGreaterThan(0);
  });

  test("ADL has some non-null values with 200 candles", () => {
    const result = computeVolumeIndicators(CANDLES_200);
    const nonNull = result.adl.filter((v) => v !== null);
    expect(nonNull.length).toBeGreaterThan(0);
  });

  test("volumeMa has some non-null values with 200 candles", () => {
    const result = computeVolumeIndicators(CANDLES_200);
    const nonNull = result.volumeMa.filter((v) => v !== null);
    expect(nonNull.length).toBeGreaterThan(0);
  });

  test("does not throw with empty candles array", () => {
    expect(() => computeVolumeIndicators(CANDLES_0)).not.toThrow();
  });

  test("does not throw with 5 candles", () => {
    expect(() => computeVolumeIndicators(CANDLES_5)).not.toThrow();
  });

  test("all volume arrays have length equal to candle count for 5 candles", () => {
    const result = computeVolumeIndicators(CANDLES_5);
    for (const key of VOLUME_KEYS) {
      expect(result[key].length).toBe(5);
    }
  });

  test("volumeMa is all null with only 5 candles (requires 20+ candles)", () => {
    const result = computeVolumeIndicators(CANDLES_5);
    const nonNull = result.volumeMa.filter((v) => v !== null);
    expect(nonNull.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// computeAllIndicators
// ---------------------------------------------------------------------------

describe("computeAllIndicators", () => {
  test("returns candles, overlays, oscillators, and volume sub-objects", () => {
    const result = computeAllIndicators(CANDLES_200);
    expect(result).toHaveProperty("candles");
    expect(result).toHaveProperty("overlays");
    expect(result).toHaveProperty("oscillators");
    expect(result).toHaveProperty("volume");
  });

  test("candles sub-object is the same reference as input", () => {
    const result = computeAllIndicators(CANDLES_200);
    expect(result.candles).toBe(CANDLES_200);
  });

  test("overlays sub-object contains all expected overlay keys", () => {
    const result = computeAllIndicators(CANDLES_200);
    for (const key of OVERLAY_KEYS) {
      expect(result.overlays).toHaveProperty(key);
    }
  });

  test("oscillators sub-object contains all expected oscillator keys", () => {
    const result = computeAllIndicators(CANDLES_200);
    for (const key of OSCILLATOR_KEYS) {
      expect(result.oscillators).toHaveProperty(key);
    }
  });

  test("volume sub-object contains all expected volume keys", () => {
    const result = computeAllIndicators(CANDLES_200);
    for (const key of VOLUME_KEYS) {
      expect(result.volume).toHaveProperty(key);
    }
  });

  test("does not throw with empty candles array", () => {
    expect(() => computeAllIndicators(CANDLES_0)).not.toThrow();
  });

  test("does not throw with 5 candles", () => {
    expect(() => computeAllIndicators(CANDLES_5)).not.toThrow();
  });

  test("all indicator arrays match candle count with 5 candles", () => {
    const result = computeAllIndicators(CANDLES_5);
    for (const key of OVERLAY_KEYS) {
      expect(result.overlays[key].length).toBe(5);
    }
    for (const key of OSCILLATOR_KEYS) {
      expect(result.oscillators[key].length).toBe(5);
    }
    for (const key of VOLUME_KEYS) {
      expect(result.volume[key].length).toBe(5);
    }
  });
});
