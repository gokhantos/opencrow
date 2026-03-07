import { z } from "zod";

export const marketSymbolSchema = z.enum(["BTC/USDT", "ETH/USDT", "SOL/USDT"]);

export const timeframeSchema = z.enum([
  "1m",
  "5m",
  "15m",
  "1h",
  "4h",
  "1d",
  "1w",
  "1M",
]);

export const marketTypeSchema = z.enum(["spot", "futures"]);

/** Earliest data available on Binance per symbol and market type */
export const LISTING_DATES: Record<string, Record<string, string>> = {
  "BTC/USDT": {
    spot: "2017-08-17",
    futures: "2019-09-08",
  },
  "ETH/USDT": {
    spot: "2017-08-17",
    futures: "2019-11-01",
  },
  "SOL/USDT": {
    spot: "2020-08-11",
    futures: "2020-10-09",
  },
};

/** Earliest futures metrics data on data.binance.vision */
export const METRICS_EARLIEST = "2021-12-01";

/** Earliest funding rate data available via Binance API */
export const FUNDING_EARLIEST: Record<string, string> = {
  "BTC/USDT": "2019-09-08",
  "ETH/USDT": "2019-11-01",
  "SOL/USDT": "2020-10-09",
};

export function getListingDate(symbol: string, marketType: string): Date {
  const date = LISTING_DATES[symbol]?.[marketType];
  return date
    ? new Date(`${date}T00:00:00Z`)
    : new Date("2017-08-17T00:00:00Z");
}

export const marketPipelineConfigSchema = z.object({
  questdbIlpUrl: z.string().default("tcp::addr=127.0.0.1:9009"),
  questdbHttpUrl: z.string().default("http://127.0.0.1:9000"),
  exchange: z.string().default("binance"),
  marketTypes: z.array(marketTypeSchema).default(["spot", "futures"]),
  symbols: z
    .array(marketSymbolSchema)
    .default(["BTC/USDT", "ETH/USDT", "SOL/USDT"]),
  backfill: z
    .object({
      timeframes: z.array(timeframeSchema).default(["1m"]),
      fullHistory: z.boolean().default(true),
    })
    .default({
      timeframes: ["1m"],
      fullHistory: true,
    })
    .optional(),
  stream: z
    .object({
      timeframes: z.array(timeframeSchema).default(["1m"]),
      reconnectDelayMs: z.number().int().min(1000).max(60000).default(5000),
      maxReconnectAttempts: z.number().int().min(1).max(50).default(20),
    })
    .default({
      timeframes: ["1m"],
      reconnectDelayMs: 5000,
      maxReconnectAttempts: 20,
    })
    .optional(),
});

export type MarketPipelineConfig = z.infer<typeof marketPipelineConfigSchema>;
