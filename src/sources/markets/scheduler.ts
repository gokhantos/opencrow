import type { MarketPipelineConfig } from "./config";
import type { MarketType } from "./types";
import {
  findKlineGaps,
  findKlineGapWindows,
  findMetricsGaps,
  findFundingRateGaps,
  findMarkPriceGaps,
  findLatestKlineTs,
  daysAgo,
  startOfToday,
} from "./gap-detector";
import { fillKlineDays } from "./backfill";
import {
  fillMetricsDays,
  fillFundingGap,
  fillTakerVolumeGap,
  pollLatestFundingRates,
} from "./backfill-metrics";
import {
  fillOpenInterestGap,
  fillTopTraderPositionGap,
  fillTopTraderAccountGap,
  fillGlobalLongShortGap,
} from "./backfill-oi-ls";
import { fillMarkPriceDays } from "./backfill-mark-price";
import { fillRecentKlines, TIMEFRAME_MS } from "./backfill-recent";
import { createLogger } from "../../logger";

// --- Derivatives poll periods and intervals ---

/** Taker volume: period → poll interval in ms */
const TAKER_VOL_SCHEDULE: ReadonlyArray<{
  period: string;
  intervalMs: number;
}> = [
  { period: "5m", intervalMs: 5 * 60 * 1000 },
  { period: "15m", intervalMs: 15 * 60 * 1000 },
  { period: "1h", intervalMs: 60 * 60 * 1000 },
  { period: "4h", intervalMs: 4 * 60 * 60 * 1000 },
  { period: "1d", intervalMs: 24 * 60 * 60 * 1000 },
];

/** OI + L/S ratios: groups of periods polled together on a shared interval */
const OI_LS_SCHEDULE: ReadonlyArray<{
  periods: readonly string[];
  intervalMs: number;
}> = [
  { periods: ["5m"], intervalMs: 5 * 60 * 1000 },
  { periods: ["15m", "1h"], intervalMs: 60 * 60 * 1000 },
  { periods: ["4h"], intervalMs: 4 * 60 * 60 * 1000 },
  { periods: ["1d"], intervalMs: 24 * 60 * 60 * 1000 },
];

const log = createLogger("market:scheduler");

const GAP_LOOKBACK_DAYS = 30;

interface Job {
  readonly name: string;
  readonly intervalMs: number;
  readonly fn: () => Promise<void>;
  timer?: ReturnType<typeof setInterval>;
}

export interface Scheduler {
  start(): void;
  stop(): void;
}

function makeJob(
  name: string,
  intervalMs: number,
  fn: () => Promise<void>,
): Job {
  return { name, intervalMs, fn };
}

function runJob(job: Job): void {
  job.fn().catch((err) => {
    log.error("Scheduled job failed", {
      job: job.name,
      error: err,
    });
  });
}

/**
 * Create a scheduler that runs gap patrol and data polling jobs on fixed intervals.
 *
 * Jobs registered:
 * - recent-kline-patrol (every 5m): fill today/yesterday 1m gaps via REST API
 * - kline-gap-patrol (every 1h): find and fill 1m kline gaps in last 30 days
 * - metrics-gap-patrol (every 1h): find and fill futures_metrics CSV gaps
 * - funding-rate-poll (every 30m): proactively fetch latest funding rate events
 * - funding-gap-patrol (every 1h): find and fill funding rate sequence gaps >12h
 * - mark-price-gap-patrol (every 2h): find and fill mark price kline gaps
 * - taker-volume-poll-{period} (5m/15m/1h/4h/1d): REST poll per period
 * - oi-ls-poll-{label} (5m/1h/4h/1d): OI + L/S ratio REST poll per period group
 */
export function createScheduler(
  config: MarketPipelineConfig,
  signal?: AbortSignal,
): Scheduler {
  const jobs: Job[] = [];
  const isFutures = config.marketTypes.includes("futures");

  // ── Recent kline patrol (REST API, every 5 min) ───────────────────────────
  // Fills today's and yesterday's gaps using Binance REST API (not archives).
  // data.binance.vision only has data up to yesterday, so this covers the gap.
  jobs.push(
    makeJob("recent-kline-patrol", 5 * 60 * 1000, async () => {
      if (signal?.aborted) return;

      // Leave 2 minutes of buffer — don't try to fill the current in-flight candle
      const TWO_MINUTES = 2 * 60 * 1000;
      const toMs = Date.now() - TWO_MINUTES;

      // Only patrol 1m — all other timeframes are derived from 1m at query time
      for (const marketType of config.marketTypes) {
        for (const symbol of config.symbols) {
          if (signal?.aborted) break;

          const latestTs = await findLatestKlineTs(
            symbol,
            marketType as MarketType,
            "1m",
          );
          if (!latestTs) continue; // No data at all — initial backfill hasn't run yet

          const fromMs = latestTs + TIMEFRAME_MS["1m"];
          if (fromMs >= toMs) continue; // Already up to date

          await fillRecentKlines(
            symbol,
            marketType as MarketType,
            "1m",
            fromMs,
            toMs,
            signal,
          ).catch((err) =>
            log.error("Failed to fill recent klines", {
              symbol,
              marketType,
              timeframe: "1m",
              error: err,
            }),
          );
        }
      }
    }),
  );

  // ── Kline gap patrol (every 1h) ───────────────────────────────────────────
  jobs.push(
    makeJob("kline-gap-patrol", 60 * 60 * 1000, async () => {
      if (signal?.aborted) return;
      const from = daysAgo(GAP_LOOKBACK_DAYS);
      const to = startOfToday();

      for (const marketType of config.marketTypes) {
        for (const symbol of config.symbols) {
          const gaps = await findKlineGaps(
            symbol,
            marketType as MarketType,
            from,
            to,
          );
          if (gaps.length === 0) continue;

          log.info("Kline gap patrol: filling gaps", {
            symbol,
            marketType,
            gapCount: gaps.length,
            dates: gaps
              .slice(0, 5)
              .map((g) => g.date.toISOString().slice(0, 10)),
          });

          const gapDates = gaps.map((g) => g.date);

          // Only fill 1m gaps — all other timeframes are derived at query time
          await fillKlineDays(
            symbol,
            marketType as MarketType,
            "1m",
            gapDates,
            signal,
          ).catch((err) =>
            log.error("Failed to fill kline gaps", {
              symbol,
              marketType,
              timeframe: "1m",
              error: err,
            }),
          );
        }
      }

      // Pass 2: hour-level internal gap repair via REST API (1m only)
      for (const marketType of config.marketTypes) {
        for (const symbol of config.symbols) {
          if (signal?.aborted) break;

          const gapWindows = await findKlineGapWindows(
            symbol,
            marketType as MarketType,
            from,
            to,
          );
          if (gapWindows.length === 0) continue;

          log.info("Kline gap patrol pass 2: filling internal gaps via REST", {
            symbol,
            marketType,
            windowCount: gapWindows.length,
            totalHours: gapWindows.reduce(
              (sum, w) => sum + (w.toMs - w.fromMs) / 3_600_000,
              0,
            ),
          });

          for (const window of gapWindows) {
            if (signal?.aborted) break;
            await fillRecentKlines(
              symbol,
              marketType as MarketType,
              "1m",
              window.fromMs,
              window.toMs,
              signal,
            ).catch((err) =>
              log.error("Failed to fill internal kline gap", {
                symbol,
                marketType,
                from: new Date(window.fromMs).toISOString(),
                to: new Date(window.toMs).toISOString(),
                error: err,
              }),
            );
          }
        }
      }
    }),
  );

  // ── Futures-only jobs ──────────────────────────────────────────────────────
  if (isFutures) {
    // Futures metrics gap patrol (every 1h)
    jobs.push(
      makeJob("metrics-gap-patrol", 60 * 60 * 1000, async () => {
        if (signal?.aborted) return;
        const from = daysAgo(GAP_LOOKBACK_DAYS);
        const to = startOfToday();

        for (const symbol of config.symbols) {
          if (signal?.aborted) break;
          const gaps = await findMetricsGaps(symbol, from, to);
          if (gaps.length === 0) continue;

          log.info("Metrics gap patrol: filling gaps", {
            symbol,
            gapCount: gaps.length,
          });

          await fillMetricsDays(
            symbol,
            gaps.map((g) => g.date),
            signal,
          ).catch((err) =>
            log.error("Failed to fill metrics gaps", {
              symbol,
              error: err,
            }),
          );
        }
      }),
    );

    // Funding rate live poll (every 30m) — proactively fetches new funding events
    jobs.push(
      makeJob("funding-rate-poll", 30 * 60 * 1000, async () => {
        if (signal?.aborted) return;
        await pollLatestFundingRates(config, signal).catch((err) =>
          log.error("Funding rate poll failed", {
            error: err,
          }),
        );
      }),
    );

    // Funding rate gap patrol (every 1h) — detects and fills sequence gaps >12h
    jobs.push(
      makeJob("funding-gap-patrol", 60 * 60 * 1000, async () => {
        if (signal?.aborted) return;
        const from = daysAgo(GAP_LOOKBACK_DAYS);
        const to = startOfToday();

        for (const symbol of config.symbols) {
          if (signal?.aborted) break;
          const gaps = await findFundingRateGaps(symbol, from, to);
          if (gaps.length === 0) continue;

          log.info("Funding gap patrol: filling gaps", {
            symbol,
            gapCount: gaps.length,
            maxGapHours: Math.max(...gaps.map((g) => g.gapHours)).toFixed(1),
          });

          for (const gap of gaps) {
            if (signal?.aborted) break;
            await fillFundingGap(
              symbol,
              gap.gapStart,
              gap.gapEnd,
              signal,
            ).catch((err) =>
              log.error("Failed to fill funding gap", {
                symbol,
                error: err,
              }),
            );
          }
        }
      }),
    );

    // Mark price gap patrol (every 2h)
    jobs.push(
      makeJob("mark-price-gap-patrol", 2 * 60 * 60 * 1000, async () => {
        if (signal?.aborted) return;
        const from = daysAgo(GAP_LOOKBACK_DAYS);
        const to = startOfToday();

        for (const symbol of config.symbols) {
          if (signal?.aborted) break;
          const gaps = await findMarkPriceGaps(symbol, from, to);
          if (gaps.length === 0) continue;

          log.info("Mark price gap patrol: filling gaps", {
            symbol,
            gapCount: gaps.length,
          });

          await fillMarkPriceDays(
            symbol,
            gaps.map((g) => g.date),
            signal,
          ).catch((err) =>
            log.error("Failed to fill mark price gaps", {
              symbol,
              error: err,
            }),
          );
        }
      }),
    );

    // Taker volume: one job per period, each on its own cadence
    for (const { period, intervalMs } of TAKER_VOL_SCHEDULE) {
      const p = period; // capture for closure
      jobs.push(
        makeJob(`taker-volume-poll-${p}`, intervalMs, async () => {
          if (signal?.aborted) return;
          await fillTakerVolumeGap(config, p, signal);
        }),
      );
    }

    // OI + L/S ratio polling (REST API, multi-period)
    // Each metric is independent — a failure in one does not skip the others.
    for (const { periods, intervalMs } of OI_LS_SCHEDULE) {
      const ps = periods; // capture for closure
      const label = ps.join("+");
      jobs.push(
        makeJob(`oi-ls-poll-${label}`, intervalMs, async () => {
          if (signal?.aborted) return;
          await fillOpenInterestGap(config, ps, signal).catch((err) =>
            log.error("OI gap fill failed", {
              periods: ps,
              error: err,
            }),
          );
          if (signal?.aborted) return;
          await fillTopTraderPositionGap(config, ps, signal).catch((err) =>
            log.error("Top trader position gap fill failed", {
              periods: ps,
              error: err,
            }),
          );
          if (signal?.aborted) return;
          await fillTopTraderAccountGap(config, ps, signal).catch((err) =>
            log.error("Top trader account gap fill failed", {
              periods: ps,
              error: err,
            }),
          );
          if (signal?.aborted) return;
          await fillGlobalLongShortGap(config, ps, signal).catch((err) =>
            log.error("Global L/S gap fill failed", {
              periods: ps,
              error: err,
            }),
          );
        }),
      );
    }
  }

  return {
    start() {
      log.info("Starting scheduler", {
        jobCount: jobs.length,
        jobs: jobs.map((j) => j.name),
      });

      for (const job of jobs) {
        // Run each job immediately on start, then on interval
        runJob(job);
        job.timer = setInterval(() => {
          if (signal?.aborted) return;
          runJob(job);
        }, job.intervalMs);
      }
    },

    stop() {
      log.info("Stopping scheduler");
      for (const job of jobs) {
        if (job.timer !== undefined) {
          clearInterval(job.timer);
          job.timer = undefined;
        }
      }
    },
  };
}
