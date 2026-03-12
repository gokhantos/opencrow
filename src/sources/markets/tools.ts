import type { ToolDefinition, ToolCategory } from "../../tools/types";
import { requireString, getString, getNumber, getEnum, isToolError } from "../../tools/input-helpers";
import {
  getLatestPrice,
  getCandles,
  getMarketSummaries,
  getLatestMetrics,
  getLatestFundingRate,
  getFundingRateHistory,
  getRecentLiquidations,
  getLiquidationSummary,
} from "./queries";
import {
  generateMarketSnapshot,
  generateTechnicalAnalysis,
  generateFundingSummary,
} from "./context";
import type { MarketType } from "./types";

export function createMarketTools(
  symbols: readonly string[],
  marketTypes: readonly MarketType[],
): readonly ToolDefinition[] {
  return [
    createGetPriceTool(symbols, marketTypes),
    createMarketSummaryTool(symbols, marketTypes),
    createGetCandlesTool(symbols, marketTypes),
    createFuturesOverviewTool(symbols),
    createFundingRateTool(symbols),
    createLiquidationsTool(symbols),
    createTechnicalAnalysisTool(symbols, marketTypes),
    createMarketSnapshotTool(symbols, marketTypes),
    createFundingSummaryTool(symbols),
  ];
}

function formatPrice(value: number): string {
  if (value >= 1000) {
    return value.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }
  return value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 8,
  });
}

function createGetPriceTool(
  symbols: readonly string[],
  marketTypes: readonly MarketType[],
): ToolDefinition {
  return {
    name: "get_price",
    description: `Get the latest price for a crypto symbol. Available: ${symbols.join(", ")}. Markets: ${marketTypes.join(", ")}.`,
    categories: ["research"] as readonly ToolCategory[],
    inputSchema: {
      type: "object",
      properties: {
        symbol: {
          type: "string",
          description: "Trading pair, e.g. BTC/USDT",
          enum: symbols,
        },
        market_type: {
          type: "string",
          description: "Market type: spot or futures",
          enum: marketTypes,
          default: "spot",
        },
      },
      required: ["symbol"],
    },
    async execute(input) {
      const symbol = requireString(input, "symbol");
      if (isToolError(symbol)) return symbol;
      const marketType = getEnum(input, "market_type", marketTypes) ?? "spot";

      try {
        const result = await getLatestPrice(symbol, marketType);
        if (!result) {
          return {
            output: `No price data available for ${symbol} (${marketType})`,
            isError: false,
          };
        }
        const ago = Math.round((Date.now() - result.timestamp) / 1000);
        return {
          output: `${symbol} (${marketType}): $${formatPrice(result.price)} (${ago}s ago)`,
          isError: false,
        };
      } catch (error) {
        return {
          output: `Error: ${error instanceof Error ? error.message : String(error)}`,
          isError: true,
        };
      }
    },
  };
}

function createMarketSummaryTool(
  symbols: readonly string[],
  marketTypes: readonly MarketType[],
): ToolDefinition {
  return {
    name: "market_summary",
    description:
      "Get 24h market summary for all tracked crypto symbols including price, change, high, low, volume. Can filter by market type (spot/futures).",
    categories: ["research"] as readonly ToolCategory[],
    inputSchema: {
      type: "object",
      properties: {
        market_type: {
          type: "string",
          description: "Market type: spot or futures (default: both)",
          enum: [...marketTypes, "all"],
        },
      },
      required: [],
    },
    async execute(input) {
      const requestedType = getEnum(input, "market_type", [...marketTypes, "all"] as const);

      try {
        const types =
          !requestedType || requestedType === "all"
            ? marketTypes
            : [requestedType as MarketType];

        const allSummaries = await Promise.all(
          types.map((mt) => getMarketSummaries(symbols, mt)),
        );

        const summaries = allSummaries.flat();
        if (summaries.length === 0) {
          return { output: "No market data available yet.", isError: false };
        }

        const lines = summaries.map((s) => {
          const dir = s.changePercent24h >= 0 ? "+" : "";
          return [
            `**${s.symbol}** (${s.marketType}): $${formatPrice(s.price)}`,
            `  24h: ${dir}${s.changePercent24h.toFixed(2)}% ($${dir}${s.change24h.toFixed(2)})`,
            `  H: $${formatPrice(s.high24h)} | L: $${formatPrice(s.low24h)}`,
            `  Vol: $${s.quoteVolume24h.toLocaleString("en-US", { maximumFractionDigits: 0 })}`,
          ].join("\n");
        });

        return { output: lines.join("\n\n"), isError: false };
      } catch (error) {
        return {
          output: `Error: ${error instanceof Error ? error.message : String(error)}`,
          isError: true,
        };
      }
    },
  };
}

function createGetCandlesTool(
  symbols: readonly string[],
  marketTypes: readonly MarketType[],
): ToolDefinition {
  return {
    name: "get_candles",
    description:
      "Get OHLCV candlestick data for a symbol. Returns open, high, low, close, volume for each candle. Use for technical analysis.",
    categories: ["research"] as readonly ToolCategory[],
    inputSchema: {
      type: "object",
      properties: {
        symbol: {
          type: "string",
          description: "Trading pair, e.g. BTC/USDT",
          enum: symbols,
        },
        market_type: {
          type: "string",
          description: "Market type: spot or futures",
          enum: marketTypes,
          default: "spot",
        },
        timeframe: {
          type: "string",
          description: "Candle interval",
          enum: ["1m", "5m", "15m", "1h", "4h", "1d", "1w", "1M"],
        },
        hours_back: {
          type: "number",
          description:
            "How many hours of data to fetch (default 24, max 43800 = 5 years). Use higher values for 1w/1M timeframes.",
        },
        limit: {
          type: "number",
          description: "Max candles to return (default 100, max 500)",
        },
      },
      required: ["symbol", "timeframe"],
    },
    async execute(input) {
      const symbol = requireString(input, "symbol");
      if (isToolError(symbol)) return symbol;
      const marketType = getEnum(input, "market_type", marketTypes) ?? "spot";
      const timeframe = getEnum(input, "timeframe", ["1m", "5m", "15m", "1h", "4h", "1d", "1w", "1M"] as const);
      if (!timeframe) return { output: "Missing or invalid timeframe.", isError: true };
      const hoursBack = getNumber(input, "hours_back", { defaultVal: 24, min: 1, max: 43800 });
      const limit = getNumber(input, "limit", { defaultVal: 100, min: 1, max: 500 });

      try {
        const now = Date.now();
        const from = now - hoursBack * 60 * 60 * 1000;

        const candles = await getCandles({
          symbol,
          marketType,
          timeframe,
          from,
          to: now,
          limit,
        });

        if (candles.length === 0) {
          return {
            output: `No candle data for ${symbol} ${timeframe} (${marketType})`,
            isError: false,
          };
        }

        const header = "Time | Open | High | Low | Close | Volume";
        const rows = candles.map((c) => {
          const t = new Date(Number(c.open_time)).toISOString().slice(0, 16);
          return `${t} | ${c.open} | ${c.high} | ${c.low} | ${c.close} | ${Number(c.volume).toFixed(2)}`;
        });

        return {
          output: `${symbol} ${timeframe} (${marketType}) — ${candles.length} candles\n${header}\n${rows.join("\n")}`,
          isError: false,
        };
      } catch (error) {
        return {
          output: `Error: ${error instanceof Error ? error.message : String(error)}`,
          isError: true,
        };
      }
    },
  };
}

function formatCompact(value: number): string {
  if (value >= 1e9) return `$${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `$${(value / 1e6).toFixed(2)}M`;
  if (value >= 1e3) return `$${(value / 1e3).toFixed(1)}K`;
  return `$${value.toFixed(2)}`;
}

function createFuturesOverviewTool(symbols: readonly string[]): ToolDefinition {
  return {
    name: "futures_overview",
    description:
      "Get futures derivatives overview: open interest, long/short ratios, taker buy/sell ratio, and current funding rate for a symbol.",
    categories: ["research"] as readonly ToolCategory[],
    inputSchema: {
      type: "object",
      properties: {
        symbol: {
          type: "string",
          description: "Trading pair, e.g. BTC/USDT",
          enum: symbols,
        },
      },
      required: ["symbol"],
    },
    async execute(input) {
      const symbol = requireString(input, "symbol");
      if (isToolError(symbol)) return symbol;

      try {
        const [metrics, funding] = await Promise.all([
          getLatestMetrics(symbol),
          getLatestFundingRate(symbol),
        ]);

        if (!metrics && !funding) {
          return {
            output: `No futures data available for ${symbol}`,
            isError: false,
          };
        }

        const lines: string[] = [`**${symbol} Futures Overview**`];

        if (metrics) {
          const ago = Math.round((Date.now() - metrics.createTime) / 60000);
          lines.push(
            `Open Interest: ${formatCompact(metrics.sumOpenInterestValue)} (${metrics.sumOpenInterest.toFixed(2)} contracts)`,
            `Top Trader L/S (count): ${metrics.countTopTraderLongShortRatio.toFixed(4)}`,
            `Top Trader L/S (sum): ${metrics.sumTopTraderLongShortRatio.toFixed(4)}`,
            `Account L/S Ratio: ${metrics.countLongShortRatio.toFixed(4)}`,
            `Taker Buy/Sell Ratio: ${metrics.sumTakerLongShortVolRatio.toFixed(4)}`,
            `(${ago}m ago)`,
          );
        }

        if (funding) {
          const annualized = funding.fundingRate * 3 * 365 * 100;
          lines.push(
            `\nFunding Rate: ${(funding.fundingRate * 100).toFixed(4)}% (${annualized.toFixed(1)}% annualized)`,
            `Mark Price: $${formatPrice(funding.markPrice)}`,
          );
        }

        return { output: lines.join("\n"), isError: false };
      } catch (error) {
        return {
          output: `Error: ${error instanceof Error ? error.message : String(error)}`,
          isError: true,
        };
      }
    },
  };
}

function createFundingRateTool(symbols: readonly string[]): ToolDefinition {
  return {
    name: "funding_rate",
    description:
      "Get funding rate history for a futures symbol. Shows rate trends over time. Useful for identifying sentiment shifts.",
    categories: ["research"] as readonly ToolCategory[],
    inputSchema: {
      type: "object",
      properties: {
        symbol: {
          type: "string",
          description: "Trading pair, e.g. BTC/USDT",
          enum: symbols,
        },
        hours_back: {
          type: "number",
          description:
            "Hours of history (default 72 = 3 days, max 720 = 30 days). Funding rates are ~8h intervals.",
        },
        limit: {
          type: "number",
          description: "Max entries to return (default 50, max 200)",
        },
      },
      required: ["symbol"],
    },
    async execute(input) {
      const symbol = requireString(input, "symbol");
      if (isToolError(symbol)) return symbol;
      const hoursBack = getNumber(input, "hours_back", { defaultVal: 72, min: 1, max: 720 });
      const limit = getNumber(input, "limit", { defaultVal: 50, min: 1, max: 200 });

      try {
        const now = Date.now();
        const from = now - hoursBack * 60 * 60 * 1000;

        const rates = await getFundingRateHistory({
          symbol,
          from,
          to: now,
          limit,
        });

        if (rates.length === 0) {
          return {
            output: `No funding rate data for ${symbol}`,
            isError: false,
          };
        }

        const avg =
          rates.reduce((sum, r) => sum + r.fundingRate, 0) / rates.length;
        const avgAnnualized = avg * 3 * 365 * 100;

        const header = `**${symbol} Funding Rate** (${rates.length} entries, avg: ${(avg * 100).toFixed(4)}%, ${avgAnnualized.toFixed(1)}% annualized)\n`;
        const rows = rates.map((r) => {
          const t = new Date(r.fundingTime).toISOString().slice(0, 16);
          const pct = (r.fundingRate * 100).toFixed(4);
          return `${t} | ${pct}% | mark: $${formatPrice(r.markPrice)}`;
        });

        return {
          output: `${header}Time | Rate | Mark Price\n${rows.join("\n")}`,
          isError: false,
        };
      } catch (error) {
        return {
          output: `Error: ${error instanceof Error ? error.message : String(error)}`,
          isError: true,
        };
      }
    },
  };
}

function createLiquidationsTool(symbols: readonly string[]): ToolDefinition {
  return {
    name: "liquidations",
    description:
      "Get recent liquidation events and summary. Shows individual liquidations and aggregated totals by side (long/short).",
    categories: ["research"] as readonly ToolCategory[],
    inputSchema: {
      type: "object",
      properties: {
        symbol: {
          type: "string",
          description:
            "Trading pair to filter (optional, omit for all tracked symbols)",
          enum: symbols,
        },
        hours_back: {
          type: "number",
          description: "Hours of history (default 24, max 168 = 7 days)",
        },
        mode: {
          type: "string",
          description:
            "Output mode: 'summary' for aggregated totals, 'recent' for individual events, 'both' for both (default: both)",
          enum: ["summary", "recent", "both"],
        },
      },
      required: [],
    },
    async execute(input) {
      const symbol = getString(input, "symbol");
      const hoursBack = getNumber(input, "hours_back", { defaultVal: 24, min: 1, max: 168 });
      const mode = getEnum(input, "mode", ["summary", "recent", "both"] as const) ?? "both";

      try {
        const lines: string[] = [
          `**Liquidations** ${symbol ?? "All Pairs"} (${hoursBack}h)`,
        ];

        if (mode === "summary" || mode === "both") {
          const summary = await getLiquidationSummary({
            symbol,
            hoursBack,
          });

          if (summary.length === 0) {
            lines.push("\nNo liquidations in this period.");
          } else {
            lines.push("\n**Summary by Symbol/Side:**");
            for (const s of summary) {
              lines.push(
                `  ${s.symbol} ${s.side}: ${s.count} events, ${formatCompact(s.total_usd)} total`,
              );
            }
          }
        }

        if (mode === "recent" || mode === "both") {
          const recent = await getRecentLiquidations({
            symbol,
            hoursBack,
            limit: 20,
          });

          if (recent.length > 0) {
            lines.push("\n**Recent Liquidations:**");
            for (const r of recent) {
              const t = new Date(r.trade_time).toISOString().slice(11, 19);
              lines.push(
                `  ${t} ${r.symbol} ${r.side} ${r.quantity.toFixed(4)} @ $${formatPrice(r.avg_price)} (${formatCompact(r.usd_value)})`,
              );
            }
          }
        }

        return { output: lines.join("\n"), isError: false };
      } catch (error) {
        return {
          output: `Error: ${error instanceof Error ? error.message : String(error)}`,
          isError: true,
        };
      }
    },
  };
}

// --- Optimized tools (delegates to shared formatters in context.ts) ---

function createTechnicalAnalysisTool(
  symbols: readonly string[],
  marketTypes: readonly MarketType[],
): ToolDefinition {
  return {
    name: "technical_analysis",
    description:
      "Get pre-computed technical indicators for a symbol. Includes trend (EMA/SMA, SuperTrend, PSAR, Keltner, HMA, VWMA), oscillators (RSI, MACD, Stoch, CCI, ADX, Awesome Osc, Momentum, Stoch RSI, Bull Bear, Ultimate Osc, ROC, KST, TRIX, MFI, Force Index), Bollinger/Ichimoku, and volume (OBV, ADL). Much more token-efficient than fetching raw candles.",
    categories: ["research"] as readonly ToolCategory[],
    inputSchema: {
      type: "object",
      properties: {
        symbol: {
          type: "string",
          description: "Trading pair, e.g. BTC/USDT",
          enum: symbols,
        },
        market_type: {
          type: "string",
          description: "Market type: spot or futures",
          enum: marketTypes,
          default: "spot",
        },
        timeframe: {
          type: "string",
          description: "Candle interval for analysis",
          enum: ["5m", "15m", "1h", "4h", "1d"],
        },
      },
      required: ["symbol", "timeframe"],
    },
    async execute(input) {
      const symbol = requireString(input, "symbol");
      if (isToolError(symbol)) return symbol;
      const marketType = getEnum(input, "market_type", marketTypes) ?? "spot";
      const timeframe = getEnum(input, "timeframe", ["5m", "15m", "1h", "4h", "1d"] as const);
      if (!timeframe) return { output: "Missing or invalid timeframe.", isError: true };

      try {
        const output = await generateTechnicalAnalysis(
          symbol,
          marketType,
          timeframe,
        );
        return { output, isError: false };
      } catch (error) {
        return {
          output: `Error: ${error instanceof Error ? error.message : String(error)}`,
          isError: true,
        };
      }
    },
  };
}

function createMarketSnapshotTool(
  symbols: readonly string[],
  marketTypes: readonly MarketType[],
): ToolDefinition {
  return {
    name: "market_snapshot",
    description:
      "Get a comprehensive market snapshot in one call: prices (spot+futures), 24h stats, open interest, L/S ratios, funding rate, and liquidation summary. Start here for any analysis.",
    categories: ["research"] as readonly ToolCategory[],
    inputSchema: {
      type: "object",
      properties: {
        symbol: {
          type: "string",
          description: "Trading pair, e.g. BTC/USDT",
          enum: symbols,
        },
      },
      required: ["symbol"],
    },
    async execute(input) {
      const symbol = requireString(input, "symbol");
      if (isToolError(symbol)) return symbol;

      try {
        const output = await generateMarketSnapshot(symbol, marketTypes);
        return { output, isError: false };
      } catch (error) {
        return {
          output: `Error: ${error instanceof Error ? error.message : String(error)}`,
          isError: true,
        };
      }
    },
  };
}

function createFundingSummaryTool(symbols: readonly string[]): ToolDefinition {
  return {
    name: "funding_summary",
    description:
      "Get a statistical summary of funding rate history: mean/min/max per window (24h/72h/7d), sign changes, trend direction, and spike detection. Much more efficient than raw funding_rate history.",
    categories: ["research"] as readonly ToolCategory[],
    inputSchema: {
      type: "object",
      properties: {
        symbol: {
          type: "string",
          description: "Trading pair, e.g. BTC/USDT",
          enum: symbols,
        },
        hours_back: {
          type: "number",
          description:
            "Hours of history (default 168 = 7 days, max 720 = 30 days)",
        },
      },
      required: ["symbol"],
    },
    async execute(input) {
      const symbol = requireString(input, "symbol");
      if (isToolError(symbol)) return symbol;
      const hoursBack = getNumber(input, "hours_back", { defaultVal: 168, min: 1, max: 720 });

      try {
        const output = await generateFundingSummary(symbol, hoursBack);
        return { output, isError: false };
      } catch (error) {
        return {
          output: `Error: ${error instanceof Error ? error.message : String(error)}`,
          isError: true,
        };
      }
    },
  };
}
