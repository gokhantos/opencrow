import { Hono } from "hono";
import type { MarketPipeline } from "../../sources/markets/pipeline";
import {
  getLatestPrice,
  getCandles,
  getMarketSummaries,
  getKlineCounts,
  getLatestMetrics,
  getLatestFundingRate,
  getFundingRateHistory,
  getMetricsHistory,
  getRecentLiquidations,
  getLiquidationSummary,
  getLiquidationBuckets,
  getTakerVolume,
  getLatestTakerVolume,
  getOpenInterestHistory,
  getLatestOpenInterest,
  getLongShortRatioHistory,
  getLatestLongShortRatio,
} from "../../sources/markets/queries";
import type { LSRatioTable } from "../../sources/markets/queries-derivatives";
import type { TimeFrame, MarketType } from "../../sources/markets/types";
import { computeAllIndicators } from "../../sources/markets/indicators";
import { createLogger } from "../../logger";

const log = createLogger("market:routes");

const VALID_MARKET_TYPES = new Set<string>(["spot", "futures"]);
const VALID_TIMEFRAMES = new Set<string>([
  "1m",
  "5m",
  "15m",
  "1h",
  "4h",
  "1d",
  "1w",
  "1M",
]);

function parseMarketType(
  raw: string | undefined,
  fallback: MarketType = "spot",
): MarketType | null {
  if (!raw) return fallback;
  return VALID_MARKET_TYPES.has(raw) ? (raw as MarketType) : null;
}

function parseTimeFrame(
  raw: string | undefined,
  fallback: TimeFrame = "1h",
): TimeFrame | null {
  if (!raw) return fallback;
  return VALID_TIMEFRAMES.has(raw) ? (raw as TimeFrame) : null;
}

function parsePositiveInt(
  raw: string | undefined,
  fallback: number,
  max: number,
): number {
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}

const MATRIX_TIMEFRAMES: readonly TimeFrame[] = [
  "5m",
  "15m",
  "1h",
  "4h",
  "1d",
  "1w",
];

const MATRIX_TF_HOURS: Readonly<Record<string, number>> = {
  "5m": 48,
  "15m": 120,
  "1h": 504,
  "4h": 2016,
  "1d": 8400,
  "1w": 52500,
};

type Signal = "buy" | "sell" | "neutral";

function computeSignal(
  key: string,
  value: number | null,
  close: number,
): Signal {
  if (value === null) return "neutral";
  switch (key) {
    case "rsi":
      return value < 30 ? "buy" : value > 70 ? "sell" : "neutral";
    case "macdHistogram":
      return value > 0 ? "buy" : value < 0 ? "sell" : "neutral";
    case "stochK":
      return value < 20 ? "buy" : value > 80 ? "sell" : "neutral";
    case "cci":
      return value < -100 ? "buy" : value > 100 ? "sell" : "neutral";
    case "williamsR":
      return value < -80 ? "buy" : value > -20 ? "sell" : "neutral";
    case "awesomeOsc":
    case "momentum":
    case "bullBearPower":
    case "roc":
    case "trix":
    case "forceIndex":
      return value > 0 ? "buy" : value < 0 ? "sell" : "neutral";
    case "kstLine":
      return value > 0 ? "buy" : value < 0 ? "sell" : "neutral";
    case "stochRsiK":
      return value < 20 ? "buy" : value > 80 ? "sell" : "neutral";
    case "mfi":
      return value < 20 ? "buy" : value > 80 ? "sell" : "neutral";
    case "ultimateOsc":
      return value > 70 ? "buy" : value < 30 ? "sell" : "neutral";
    case "ema9":
    case "ema10":
    case "ema21":
    case "ema30":
    case "ema50":
    case "ema100":
    case "ema200":
    case "sma10":
    case "sma20":
    case "sma30":
    case "sma50":
    case "sma100":
    case "sma200":
    case "hma9":
    case "vwma20":
    case "superTrend":
    case "psar":
      return close > value ? "buy" : close < value ? "sell" : "neutral";
    default:
      return "neutral";
  }
}

function getLastNonNull(arr: readonly (number | null)[]): number | null {
  for (let i = arr.length - 1; i >= 0; i--) {
    const v = arr[i];
    if (v !== null && v !== undefined) return v;
  }
  return null;
}

export function createMarketRoutes(
  pipeline: MarketPipeline | undefined,
  symbols: readonly string[],
  marketTypes: readonly MarketType[],
  opts?: { coreClient?: import("../core-client").CoreClient },
): Hono {
  const app = new Hono();

  app.onError((err, c) => {
    log.error("Market route error", {
      error: err,
      stack: err instanceof Error ? err.stack : undefined,
    });
    return c.json({ success: false, error: "Internal server error" }, 500);
  });

  app.get("/market/status", async (c) => {
    if (pipeline) {
      return c.json({ success: true, data: pipeline.getStatus() });
    }
    if (opts?.coreClient) {
      try {
        const result = await opts.coreClient.marketStatus();
        return c.json({ success: true, data: result.data });
      } catch {
        return c.json({ success: false, error: "Core unreachable" }, 503);
      }
    }
    return c.json(
      { success: false, error: "Market pipeline not available" },
      503,
    );
  });

  app.get("/market/summary", async (c) => {
    const mt = parseMarketType(c.req.query("market_type") ?? undefined);
    if (mt === null) {
      return c.json({ success: false, error: "Invalid market_type" }, 400);
    }
    const types = c.req.query("market_type") ? [mt] : marketTypes;

    const allSummaries = await Promise.all(
      types.map((t) => getMarketSummaries(symbols, t)),
    );
    return c.json({ success: true, data: allSummaries.flat() });
  });

  app.get("/market/price/:symbol", async (c) => {
    const symbol = decodeURIComponent(c.req.param("symbol"));
    const mt = parseMarketType(c.req.query("market_type") ?? undefined);
    if (mt === null) {
      return c.json({ success: false, error: "Invalid market_type" }, 400);
    }

    const result = await getLatestPrice(symbol, mt);
    if (!result) {
      return c.json({ success: false, error: "No data" }, 404);
    }
    return c.json({ success: true, data: result });
  });

  // --- Candles with technical indicators (must be before :symbol catch-all) ---

  app.get("/market/candles/:symbol/indicators", async (c) => {
    const symbol = decodeURIComponent(c.req.param("symbol"));
    const mt = parseMarketType(c.req.query("market_type") ?? undefined);
    if (mt === null) {
      return c.json({ success: false, error: "Invalid market_type" }, 400);
    }
    const timeframe = parseTimeFrame(c.req.query("timeframe") ?? undefined);
    if (timeframe === null) {
      return c.json({ success: false, error: "Invalid timeframe" }, 400);
    }
    const hoursBack = parsePositiveInt(
      c.req.query("hours") ?? undefined,
      168,
      43800,
    );
    const limit = parsePositiveInt(
      c.req.query("limit") ?? undefined,
      500,
      2000,
    );

    const warmup = 200;
    const fetchLimit = limit + warmup;

    const now = Date.now();
    const from = now - hoursBack * 60 * 60 * 1000;
    const allCandles = await getCandles({
      symbol,
      marketType: mt,
      timeframe,
      from,
      to: now,
      limit: fetchLimit,
    });

    if (allCandles.length === 0) {
      return c.json({ success: false, error: "No candle data" }, 404);
    }

    const result = computeAllIndicators(allCandles);

    const trimStart = Math.max(0, allCandles.length - limit);
    const trimmed = {
      candles: result.candles.slice(trimStart),
      overlays: trimArrays(result.overlays, trimStart),
      oscillators: trimArrays(result.oscillators, trimStart),
      volume: trimArrays(result.volume, trimStart),
    };

    return c.json({ success: true, data: trimmed });
  });

  app.get("/market/candles/:symbol", async (c) => {
    const symbol = decodeURIComponent(c.req.param("symbol"));
    const mt = parseMarketType(c.req.query("market_type") ?? undefined);
    if (mt === null) {
      return c.json({ success: false, error: "Invalid market_type" }, 400);
    }
    const timeframe = parseTimeFrame(c.req.query("timeframe") ?? undefined);
    if (timeframe === null) {
      return c.json({ success: false, error: "Invalid timeframe" }, 400);
    }
    const hoursBack = parsePositiveInt(
      c.req.query("hours") ?? undefined,
      24,
      43800,
    );
    const limit = parsePositiveInt(
      c.req.query("limit") ?? undefined,
      200,
      1000,
    );

    const now = Date.now();
    const from = now - hoursBack * 60 * 60 * 1000;
    const candles = await getCandles({
      symbol,
      marketType: mt,
      timeframe,
      from,
      to: now,
      limit,
    });

    return c.json({ success: true, data: candles });
  });

  // --- Multi-timeframe indicator matrix ---

  app.get("/market/indicators/:symbol/matrix", async (c) => {
    const symbol = decodeURIComponent(c.req.param("symbol"));
    const mt = parseMarketType(c.req.query("market_type") ?? undefined);
    if (mt === null) {
      return c.json({ success: false, error: "Invalid market_type" }, 400);
    }

    const tfResults = await Promise.all(
      MATRIX_TIMEFRAMES.map(async (tf) => {
        const hours = MATRIX_TF_HOURS[tf] ?? 504;
        const now = Date.now();
        const from = now - hours * 60 * 60 * 1000;
        const candles = await getCandles({
          symbol,
          marketType: mt,
          timeframe: tf,
          from,
          to: now,
          limit: 500,
        });
        if (candles.length === 0) return null;
        const indicators = computeAllIndicators(candles);
        const close = candles[candles.length - 1]!.close;
        return {
          tf,
          close,
          overlays: indicators.overlays,
          oscillators: indicators.oscillators,
        };
      }),
    );

    const oscKeys = [
      { key: "rsi", label: "RSI (14)" },
      { key: "macdHistogram", label: "MACD" },
      { key: "stochK", label: "Stoch %K" },
      { key: "cci", label: "CCI (20)" },
      { key: "williamsR", label: "Williams %R" },
      { key: "adx", label: "ADX (14)" },
      { key: "atr", label: "ATR (14)" },
      { key: "awesomeOsc", label: "Awesome Osc" },
      { key: "momentum", label: "Momentum (10)" },
      { key: "stochRsiK", label: "Stoch RSI" },
      { key: "bullBearPower", label: "Bull Bear" },
      { key: "ultimateOsc", label: "Ult Osc (7,14,28)" },
      { key: "roc", label: "ROC (9)" },
      { key: "kstLine", label: "KST" },
      { key: "trix", label: "TRIX (18)" },
      { key: "mfi", label: "MFI (14)" },
      { key: "forceIndex", label: "Force Index (13)" },
    ];

    const maKeys = [
      { key: "ema9", label: "EMA 9" },
      { key: "ema10", label: "EMA 10" },
      { key: "ema21", label: "EMA 21" },
      { key: "ema30", label: "EMA 30" },
      { key: "ema50", label: "EMA 50" },
      { key: "ema100", label: "EMA 100" },
      { key: "ema200", label: "EMA 200" },
      { key: "sma10", label: "SMA 10" },
      { key: "sma20", label: "SMA 20" },
      { key: "sma30", label: "SMA 30" },
      { key: "sma50", label: "SMA 50" },
      { key: "sma100", label: "SMA 100" },
      { key: "sma200", label: "SMA 200" },
      { key: "hma9", label: "HMA 9" },
      { key: "vwma20", label: "VWMA 20" },
      { key: "superTrend", label: "SuperTrend" },
      { key: "psar", label: "PSAR" },
    ];

    function buildRow(
      key: string,
      label: string,
      source: "oscillators" | "overlays",
    ) {
      const cells: Record<string, { value: number | null; signal: Signal }> =
        {};
      for (const result of tfResults) {
        if (!result) continue;
        const data =
          source === "oscillators" ? result.oscillators : result.overlays;
        const arr = (data as Record<string, readonly (number | null)[]>)[key];
        const value = arr ? getLastNonNull(arr) : null;
        cells[result.tf] = {
          value,
          signal: computeSignal(key, value, result.close),
        };
      }
      return { key, label, cells };
    }

    const oscillators = oscKeys.map(({ key, label }) =>
      buildRow(key, label, "oscillators"),
    );
    const movingAverages = maKeys.map(({ key, label }) =>
      buildRow(key, label, "overlays"),
    );

    const signalRows = [...oscillators, ...movingAverages];
    const summary: Record<
      string,
      { buy: number; sell: number; neutral: number; overall: string }
    > = {};

    for (const tf of MATRIX_TIMEFRAMES) {
      let buy = 0;
      let sell = 0;
      let neutral = 0;
      for (const row of signalRows) {
        const cell = row.cells[tf];
        if (!cell) continue;
        if (cell.signal === "buy") buy++;
        else if (cell.signal === "sell") sell++;
        else neutral++;
      }
      const total = buy + sell + neutral;
      let overall: string;
      if (total === 0) {
        overall = "neutral";
      } else if (buy / total >= 0.6) {
        overall = "strong_buy";
      } else if (buy > sell) {
        overall = "buy";
      } else if (sell / total >= 0.6) {
        overall = "strong_sell";
      } else if (sell > buy) {
        overall = "sell";
      } else {
        overall = "neutral";
      }
      summary[tf] = { buy, sell, neutral, overall };
    }

    return c.json({
      success: true,
      data: {
        timeframes: MATRIX_TIMEFRAMES,
        oscillators,
        movingAverages,
        summary,
      },
    });
  });

  app.get("/market/counts", async (c) => {
    const counts = await getKlineCounts();
    const data = Object.fromEntries(counts);
    return c.json({ success: true, data });
  });

  // --- Futures metrics endpoints ---

  app.get("/market/metrics/:symbol", async (c) => {
    const symbol = decodeURIComponent(c.req.param("symbol"));
    const metrics = await getLatestMetrics(symbol);
    if (!metrics) {
      return c.json({ success: false, error: "No metrics data" }, 404);
    }
    return c.json({ success: true, data: metrics });
  });

  app.get("/market/funding/:symbol", async (c) => {
    const symbol = decodeURIComponent(c.req.param("symbol"));
    const hoursBack = parsePositiveInt(
      c.req.query("hours") ?? undefined,
      72,
      720,
    );
    const limit = parsePositiveInt(c.req.query("limit") ?? undefined, 100, 500);

    const now = Date.now();
    const from = now - hoursBack * 60 * 60 * 1000;

    const [latest, history] = await Promise.all([
      getLatestFundingRate(symbol),
      getFundingRateHistory({ symbol, from, to: now, limit }),
    ]);

    return c.json({ success: true, data: { latest, history } });
  });

  app.get("/market/metrics/:symbol/history", async (c) => {
    const symbol = decodeURIComponent(c.req.param("symbol"));
    const hoursBack = parsePositiveInt(
      c.req.query("hours") ?? undefined,
      24,
      720,
    );
    const limit = parsePositiveInt(
      c.req.query("limit") ?? undefined,
      500,
      2000,
    );

    const now = Date.now();
    const from = now - hoursBack * 60 * 60 * 1000;
    const history = await getMetricsHistory({ symbol, from, to: now, limit });

    return c.json({ success: true, data: history });
  });

  app.get("/market/liquidations/buckets", async (c) => {
    const symbol = c.req.query("symbol") ?? undefined;
    const hoursBack = parsePositiveInt(
      c.req.query("hours") ?? undefined,
      24,
      168,
    );
    const bucketMinutes = parsePositiveInt(
      c.req.query("bucket_minutes") ?? undefined,
      60,
      1440,
    );

    const buckets = await getLiquidationBuckets({
      symbol,
      hoursBack,
      bucketMinutes,
    });

    return c.json({ success: true, data: buckets });
  });

  app.get("/market/liquidations", async (c) => {
    const symbol = c.req.query("symbol") ?? undefined;
    const hoursBack = parsePositiveInt(
      c.req.query("hours") ?? undefined,
      24,
      168,
    );
    const limit = parsePositiveInt(c.req.query("limit") ?? undefined, 50, 200);

    const [recent, summary] = await Promise.all([
      getRecentLiquidations({ symbol, hoursBack, limit }),
      getLiquidationSummary({ symbol, hoursBack }),
    ]);

    return c.json({ success: true, data: { recent, summary } });
  });

  // --- Open interest (live, multi-period from REST API) ---

  app.get("/market/open-interest/:symbol", async (c) => {
    const symbol = decodeURIComponent(c.req.param("symbol"));
    const period = c.req.query("period") ?? "1h";
    const hoursBack = parsePositiveInt(
      c.req.query("hours") ?? undefined,
      24,
      720,
    );
    const limit = parsePositiveInt(
      c.req.query("limit") ?? undefined,
      500,
      2000,
    );

    const now = Date.now();
    const from = now - hoursBack * 60 * 60 * 1000;

    const [latest, history] = await Promise.all([
      getLatestOpenInterest(symbol, period),
      getOpenInterestHistory({ symbol, period, from, to: now, limit }),
    ]);

    return c.json({ success: true, data: { latest, history } });
  });

  // --- Long/short ratios (live, multi-period from REST API) ---

  const VALID_LS_TABLES = new Set<string>([
    "top_trader_position_ratio",
    "top_trader_account_ratio",
    "global_long_short_ratio",
  ]);

  app.get("/market/long-short/:symbol", async (c) => {
    const symbol = decodeURIComponent(c.req.param("symbol"));
    const tableParam = c.req.query("table") ?? "global_long_short_ratio";
    if (!VALID_LS_TABLES.has(tableParam)) {
      return c.json({ success: false, error: "Invalid table" }, 400);
    }
    const table = tableParam as LSRatioTable;
    const period = c.req.query("period") ?? "1h";
    const hoursBack = parsePositiveInt(
      c.req.query("hours") ?? undefined,
      24,
      720,
    );
    const limit = parsePositiveInt(
      c.req.query("limit") ?? undefined,
      500,
      2000,
    );

    const now = Date.now();
    const from = now - hoursBack * 60 * 60 * 1000;

    const [latest, history] = await Promise.all([
      getLatestLongShortRatio(symbol, table, period),
      getLongShortRatioHistory({ symbol, table, period, from, to: now, limit }),
    ]);

    return c.json({ success: true, data: { latest, history } });
  });

  // --- Taker buy/sell volume ---

  app.get("/market/taker-volume/:symbol", async (c) => {
    const symbol = decodeURIComponent(c.req.param("symbol"));
    const period = c.req.query("period") ?? "1h";
    const hoursBack = parsePositiveInt(
      c.req.query("hours") ?? undefined,
      24,
      720,
    );
    const limit = parsePositiveInt(
      c.req.query("limit") ?? undefined,
      500,
      2000,
    );

    const now = Date.now();
    const from = now - hoursBack * 60 * 60 * 1000;

    const [latest, history] = await Promise.all([
      getLatestTakerVolume(symbol, period),
      getTakerVolume({ symbol, period, from, to: now, limit }),
    ]);

    return c.json({ success: true, data: { latest, history } });
  });

  return app;
}

function trimArrays<T extends Record<string, readonly unknown[]>>(
  obj: T,
  start: number,
): T {
  const result: Record<string, readonly unknown[]> = {};
  for (const [key, arr] of Object.entries(obj)) {
    result[key] = arr.slice(start);
  }
  return result as T;
}
