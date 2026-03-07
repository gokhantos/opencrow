import { initQuestDB, closeQuestDB } from "./questdb";
import { backfillAll } from "./backfill";
import { backfillMetrics, backfillFundingRates } from "./backfill-metrics";
import { backfillAllOIAndLS } from "./backfill-oi-ls";
import { backfillMarkPriceKlines } from "./backfill-mark-price";
import { createKlineStream, type KlineStream } from "./stream";
import {
  createLiquidationStream,
  type LiquidationStream,
} from "./stream-liquidations";
import {
  createMarkPriceStream,
  type MarkPriceStream,
} from "./stream-mark-price";
import { createScheduler, type Scheduler } from "./scheduler";
import type { LiveKlineHub } from "./ws-hub";
import type { MarketPipelineConfig } from "./config";
import type {
  PipelineStatus,
  BackfillProgress,
  MarkPriceSnapshot,
} from "./types";
import { createLogger } from "../../logger";

const log = createLogger("market:pipeline");

export interface MarketPipeline {
  start(): Promise<void>;
  stop(): Promise<void>;
  getStatus(): PipelineStatus;
  getMarkPrice(symbol: string): MarkPriceSnapshot | null;
}

export function createMarketPipeline(
  config: MarketPipelineConfig,
  liveHub?: LiveKlineHub,
): MarketPipeline {
  let running = false;
  let questdbConnected = false;
  let klineStream: KlineStream | null = null;
  let liqStream: LiquidationStream | null = null;
  let markPriceStream: MarkPriceStream | null = null;
  let scheduler: Scheduler | null = null;
  let backfillProgress: readonly BackfillProgress[] = [];
  const abortController = new AbortController();

  async function runDerivativesBackfills(): Promise<void> {
    // Vision-based backfills run concurrently
    await Promise.all([
      backfillMetrics(config, abortController.signal).catch((err) =>
        log.error("Metrics backfill failed", { error: err }),
      ),
      backfillFundingRates(config, abortController.signal).catch((err) =>
        log.error("Funding rate backfill failed", { error: err }),
      ),
      backfillMarkPriceKlines(config, abortController.signal).catch((err) =>
        log.error("Mark price backfill failed", { error: err }),
      ),
    ]);

    // REST API backfill for OI + L/S ratios (sequential to respect rate limits)
    await backfillAllOIAndLS(config, abortController.signal).catch((err) =>
      log.error("OI + L/S ratio backfill failed", { error: err }),
    );
  }

  return {
    async start() {
      if (running) return;
      running = true;

      log.info("Starting market pipeline", {
        marketTypes: config.marketTypes,
        symbols: config.symbols,
        backfillEnabled: config.backfill !== undefined,
        streamEnabled: config.stream !== undefined,
      });

      const ilpUrl = process.env.QUESTDB_ILP_URL ?? config.questdbIlpUrl;
      const httpUrl = process.env.QUESTDB_HTTP_URL ?? config.questdbHttpUrl;

      let questdbReady = false;
      try {
        await initQuestDB(ilpUrl, httpUrl);
        questdbReady = true;
        questdbConnected = true;
      } catch (err) {
        log.warn("QuestDB unavailable — pipeline running without storage", {
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // Start all backfills in background (non-blocking)
      if (config.backfill !== undefined && questdbReady) {
        // Kline backfill (parallel)
        backfillAll({
          config,
          onProgress: (p) => {
            backfillProgress = [
              ...backfillProgress.filter(
                (bp) =>
                  !(
                    bp.symbol === p.symbol &&
                    bp.marketType === p.marketType &&
                    bp.timeframe === p.timeframe
                  ),
              ),
              p,
            ];
          },
          signal: abortController.signal,
        })
          .then((results) => {
            backfillProgress = results;
            log.info("Kline backfill completed", {
              results: results.map(
                (r) => `${r.marketType}:${r.symbol}:${r.timeframe}=${r.status}`,
              ),
            });
          })
          .catch((err) => {
            log.error("Kline backfill failed", { error: err });
          });

        // Futures-specific backfills (concurrent with each other)
        if (config.marketTypes.includes("futures")) {
          runDerivativesBackfills()
            .then(() => log.info("Derivatives backfills completed"))
            .catch((err) =>
              log.error("Derivatives backfills failed", { error: err }),
            );
        }
      }

      // Start WebSocket streams immediately (don't wait for backfill)
      if (config.stream !== undefined && questdbReady) {
        klineStream = createKlineStream({
          config,
          // Forward every kline event (including unclosed) to the live hub
          onKline: liveHub ? (kline) => liveHub.publish(kline) : undefined,
          signal: abortController.signal,
        });
        await klineStream.start();

        if (config.marketTypes.includes("futures")) {
          // Liquidation stream
          liqStream = createLiquidationStream(config, abortController.signal);
          await liqStream.start();

          // Mark price stream (in-memory snapshots)
          markPriceStream = createMarkPriceStream(
            config,
            abortController.signal,
          );
          await markPriceStream.start();
        }
      }

      // Start gap patrol scheduler (handles taker vol poll + all gap detection)
      if (questdbReady) {
        scheduler = createScheduler(config, abortController.signal);
        scheduler.start();
      }

      log.info("Market pipeline started");
    },

    async stop() {
      if (!running) return;
      running = false;
      log.info("Stopping market pipeline...");

      abortController.abort();

      if (scheduler) {
        scheduler.stop();
        scheduler = null;
      }

      if (klineStream) {
        await klineStream.stop();
        klineStream = null;
      }

      if (liqStream) {
        await liqStream.stop();
        liqStream = null;
      }

      if (markPriceStream) {
        await markPriceStream.stop();
        markPriceStream = null;
      }

      await closeQuestDB();
      log.info("Market pipeline stopped");
    },

    getStatus(): PipelineStatus {
      const klineStreams = klineStream?.getStatus() ?? [];
      const liqStats = liqStream?.getStats();

      return {
        running,
        questdbConnected,
        symbols: config.symbols,
        marketTypes: config.marketTypes,
        backfill: backfillProgress,
        streams: [
          ...klineStreams,
          ...(liqStats
            ? [
                {
                  symbol: "ALL",
                  marketType: "futures" as const,
                  timeframe: "realtime" as const,
                  connected: liqStats.connected,
                  lastUpdate: liqStats.lastUpdate,
                  messagesReceived: liqStats.messagesReceived,
                },
              ]
            : []),
          ...(markPriceStream
            ? [
                {
                  symbol: "ALL",
                  marketType: "futures" as const,
                  timeframe: "markPrice" as const,
                  connected: markPriceStream.getAllSnapshots().length > 0,
                  lastUpdate:
                    markPriceStream.getAllSnapshots()[0]?.timestamp ?? null,
                  messagesReceived: markPriceStream.getAllSnapshots().length,
                },
              ]
            : []),
        ],
      };
    },

    getMarkPrice(symbol: string): MarkPriceSnapshot | null {
      return markPriceStream?.getSnapshot(symbol) ?? null;
    },
  };
}
