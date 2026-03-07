import { getQuestDB, createSender } from "./questdb";
import type { Sender } from "@questdb/nodejs-client";
import type { Kline, TimeFrame, BackfillProgress, MarketType } from "./types";
import { type MarketPipelineConfig, getListingDate } from "./config";
import { fillRecentKlines } from "./backfill-recent";
import { createLogger } from "../../logger";

const log = createLogger("market:backfill");

const BASE_URL = "https://data.binance.vision/data";

interface BackfillOptions {
  readonly config: MarketPipelineConfig;
  readonly onProgress?: (progress: BackfillProgress) => void;
  readonly signal?: AbortSignal;
}

function symbolToExchangeId(symbol: string): string {
  return symbol.replace("/", "");
}

function normalizeTimestamp(ts: number, marketType: MarketType): number {
  // Binance switched spot timestamps to microseconds from Jan 2025
  // Futures remain milliseconds
  if (marketType === "spot" && ts > 1e15) {
    return Math.floor(ts / 1000);
  }
  return ts;
}

function marketTypePath(marketType: MarketType): string {
  return marketType === "spot" ? "spot" : "futures/um";
}

function buildMonthlyUrl(
  marketType: MarketType,
  exchangeId: string,
  timeframe: TimeFrame,
  year: number,
  month: number,
): string {
  const m = String(month).padStart(2, "0");
  const filename = `${exchangeId}-${timeframe}-${year}-${m}`;
  const path = marketTypePath(marketType);
  return `${BASE_URL}/${path}/monthly/klines/${exchangeId}/${timeframe}/${filename}.zip`;
}

function buildDailyUrl(
  marketType: MarketType,
  exchangeId: string,
  timeframe: TimeFrame,
  date: Date,
): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  const filename = `${exchangeId}-${timeframe}-${y}-${m}-${d}`;
  const path = marketTypePath(marketType);
  return `${BASE_URL}/${path}/daily/klines/${exchangeId}/${timeframe}/${filename}.zip`;
}

function parseKlineCsv(
  csv: string,
  symbol: string,
  marketType: MarketType,
  timeframe: TimeFrame,
): readonly Kline[] {
  const lines = csv.trim().split("\n");
  const klines: Kline[] = [];

  for (const line of lines) {
    const cols = line.split(",");
    if (cols.length < 11) continue;

    const openTimeRaw = Number(cols[0]);
    if (Number.isNaN(openTimeRaw)) continue;

    const openTime = normalizeTimestamp(openTimeRaw, marketType);
    const closeTime = normalizeTimestamp(Number(cols[6]), marketType);

    klines.push({
      symbol,
      marketType,
      timeframe,
      openTime,
      open: Number(cols[1]),
      high: Number(cols[2]),
      low: Number(cols[3]),
      close: Number(cols[4]),
      volume: Number(cols[5]),
      closeTime,
      quoteVolume: Number(cols[7]),
      trades: Number(cols[8]),
      isClosed: true,
    });
  }

  return klines;
}

async function downloadAndExtractCsv(
  url: string,
  signal?: AbortSignal,
): Promise<string | null> {
  try {
    const response = await fetch(url, { signal });
    if (!response.ok) {
      if (response.status === 404) return null;
      throw new Error(`HTTP ${response.status} fetching ${url}`);
    }

    const zipBuffer = await response.arrayBuffer();

    const tmpDir = `/tmp/opencrow-backfill-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const tmpZip = `${tmpDir}/data.zip`;

    await Bun.$`mkdir -p ${tmpDir}`.quiet();
    await Bun.write(tmpZip, new Uint8Array(zipBuffer));
    await Bun.$`unzip -o -q ${tmpZip} -d ${tmpDir}`.quiet();

    const files = await Array.fromAsync(
      new Bun.Glob("*.csv").scan({ cwd: tmpDir }),
    );
    if (files.length === 0) {
      await Bun.$`rm -rf ${tmpDir}`.quiet();
      return null;
    }

    const csvContent = await Bun.file(`${tmpDir}/${files[0]}`).text();
    await Bun.$`rm -rf ${tmpDir}`.quiet();

    return csvContent;
  } catch (error) {
    if (signal?.aborted) return null;
    log.error("Download failed", { url, error });
    return null;
  }
}

async function insertKlines(
  sender: Sender,
  klines: readonly Kline[],
): Promise<void> {
  if (klines.length === 0) return;

  for (const k of klines) {
    sender
      .table("klines")
      .symbol("symbol", k.symbol)
      .symbol("market_type", k.marketType)
      .symbol("timeframe", k.timeframe)
      .floatColumn("open", k.open)
      .floatColumn("high", k.high)
      .floatColumn("low", k.low)
      .floatColumn("close", k.close)
      .floatColumn("volume", k.volume)
      .timestampColumn("close_time", BigInt(k.closeTime) * 1000n)
      .floatColumn("quote_volume", k.quoteVolume)
      .intColumn("trades", k.trades)
      .at(BigInt(k.openTime) * 1000n);
  }
  await sender.flush();
}

async function updateBackfillProgress(
  sender: Sender,
  symbol: string,
  marketType: MarketType,
  timeframe: TimeFrame,
  progress: BackfillProgress,
): Promise<void> {
  // ILP rule: all .symbol() calls MUST precede any column (float/int/timestamp/string)
  sender
    .table("backfill_progress")
    .symbol("symbol", symbol)
    .symbol("market_type", marketType)
    .symbol("timeframe", timeframe)
    .symbol("status", progress.status)
    .stringColumn("error", progress.error ?? "")
    .timestampColumn("oldest_ts", BigInt(progress.oldestTimestamp || 0) * 1000n)
    .timestampColumn("newest_ts", BigInt(progress.newestTimestamp || 0) * 1000n)
    .intColumn("total", progress.fetchedCandles)
    .at(BigInt(Date.now()) * 1000n);
  await sender.flush();
}

async function getExistingProgress(
  symbol: string,
  marketType: MarketType,
  timeframe: TimeFrame,
): Promise<{ newestTs: number; total: number } | null> {
  const { query } = getQuestDB();
  const rows = await query<{ newest_ts: string; total: number }>(
    `SELECT newest_ts, total
     FROM backfill_progress
     WHERE symbol = '${symbol}'
       AND market_type = '${marketType}'
       AND timeframe = '${timeframe}'
       AND status = 'completed'
     ORDER BY updated_at DESC
     LIMIT 1`,
  );
  if (rows.length === 0) return null;
  return {
    newestTs: new Date(String(rows[0]!.newest_ts)).getTime(),
    total: Number(rows[0]!.total),
  };
}

function generateMonthRange(
  startDate: Date,
  endDate: Date,
): readonly { year: number; month: number }[] {
  const months: { year: number; month: number }[] = [];
  const current = new Date(
    Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), 1),
  );
  const end = new Date(
    Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth(), 1),
  );

  while (current <= end) {
    months.push({
      year: current.getUTCFullYear(),
      month: current.getUTCMonth() + 1,
    });
    current.setUTCMonth(current.getUTCMonth() + 1);
  }

  return months;
}

function generateDayRange(startDate: Date, endDate: Date): readonly Date[] {
  const days: Date[] = [];
  const current = new Date(
    Date.UTC(
      startDate.getUTCFullYear(),
      startDate.getUTCMonth(),
      startDate.getUTCDate(),
    ),
  );

  while (current <= endDate) {
    days.push(new Date(current));
    current.setUTCDate(current.getUTCDate() + 1);
  }

  return days;
}

/**
 * Returns true if the stored newest timestamp covers through at least yesterday UTC.
 * When true, historical backfill for this symbol/market/timeframe can be skipped.
 */
function isHistoricalComplete(newestTs: number): boolean {
  const yesterdayMidnight = new Date();
  yesterdayMidnight.setUTCDate(yesterdayMidnight.getUTCDate() - 1);
  yesterdayMidnight.setUTCHours(0, 0, 0, 0);
  return newestTs >= yesterdayMidnight.getTime();
}

/**
 * Fill specific gap days for a single symbol/marketType/timeframe from daily archives.
 * Used by the gap patrol scheduler to repair detected gaps.
 */
export async function fillKlineDays(
  symbol: string,
  marketType: MarketType,
  timeframe: TimeFrame,
  days: readonly Date[],
  signal?: AbortSignal,
): Promise<void> {
  const exchangeId = symbolToExchangeId(symbol);
  const sender = await createSender();

  try {
    for (const day of days) {
      if (signal?.aborted) break;

      const url = buildDailyUrl(marketType, exchangeId, timeframe, day);
      const csv = await downloadAndExtractCsv(url, signal);
      if (!csv) {
        const dayAgeMs = Date.now() - day.getTime();
        const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

        if (dayAgeMs < SEVEN_DAYS_MS) {
          const dayStartMs = day.getTime();
          const dayEndMs = dayStartMs + 24 * 60 * 60 * 1000 - 1;
          log.info("No daily archive, falling back to REST API", {
            symbol,
            marketType,
            timeframe,
            day: day.toISOString().slice(0, 10),
          });
          await fillRecentKlines(
            symbol,
            marketType,
            timeframe,
            dayStartMs,
            dayEndMs,
            signal,
          );
        } else {
          log.debug(
            "No daily archive for gap day (too old for REST fallback)",
            {
              symbol,
              marketType,
              timeframe,
              day: day.toISOString().slice(0, 10),
            },
          );
        }
        continue;
      }

      const klines = parseKlineCsv(csv, symbol, marketType, timeframe);
      if (klines.length > 0) {
        await insertKlines(sender, klines);
        log.debug("Filled kline gap day", {
          symbol,
          marketType,
          timeframe,
          day: day.toISOString().slice(0, 10),
          count: klines.length,
        });
      }
    }
  } finally {
    await sender.close();
  }
}

export async function backfillSymbol(
  sender: Sender,
  symbol: string,
  marketType: MarketType,
  timeframe: TimeFrame,
  options: BackfillOptions,
): Promise<BackfillProgress> {
  const exchangeId = symbolToExchangeId(symbol);
  const { config, onProgress, signal } = options;

  let progress: BackfillProgress = {
    symbol,
    marketType,
    timeframe,
    totalCandles: 0,
    fetchedCandles: 0,
    oldestTimestamp: 0,
    newestTimestamp: 0,
    status: "running",
  };

  const report = (update: Partial<BackfillProgress>) => {
    progress = { ...progress, ...update };
    onProgress?.(progress);
  };

  try {
    const existing = await getExistingProgress(symbol, marketType, timeframe);

    // Smart skip: if already complete through yesterday, nothing to download
    if (existing && isHistoricalComplete(existing.newestTs)) {
      log.info("Historical backfill already complete, skipping", {
        symbol,
        marketType,
        timeframe,
        newestTs: new Date(existing.newestTs).toISOString(),
      });
      return {
        ...progress,
        status: "completed",
        fetchedCandles: 0,
        newestTimestamp: existing.newestTs,
      };
    }

    const now = new Date();
    const startDate = getListingDate(symbol, marketType);

    // Monthly data is available up to ~2 months ago
    const monthlyEnd = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1),
    );
    const months = generateMonthRange(startDate, monthlyEnd);

    log.info("Starting backfill", {
      symbol,
      marketType,
      timeframe,
      months: months.length,
      from: startDate.toISOString(),
    });

    let totalFetched = 0;
    let oldestTs = Infinity;
    let newestTs = 0;

    // Download monthly archives
    for (const { year, month } of months) {
      if (signal?.aborted) break;

      const monthEnd = new Date(Date.UTC(year, month, 0, 23, 59, 59)).getTime();
      if (existing && monthEnd <= existing.newestTs) {
        log.debug("Skipping already-fetched month", {
          symbol,
          marketType,
          year,
          month,
        });
        continue;
      }

      const url = buildMonthlyUrl(
        marketType,
        exchangeId,
        timeframe,
        year,
        month,
      );
      log.debug("Downloading", { url });

      const csv = await downloadAndExtractCsv(url, signal);
      if (!csv) {
        log.debug("No data for month", { symbol, marketType, year, month });
        continue;
      }

      const klines = parseKlineCsv(csv, symbol, marketType, timeframe);
      if (klines.length > 0) {
        await insertKlines(sender, klines);
        totalFetched += klines.length;
        oldestTs = Math.min(oldestTs, klines[0]!.openTime);
        newestTs = Math.max(newestTs, klines[klines.length - 1]!.openTime);

        report({
          fetchedCandles: totalFetched,
          oldestTimestamp: oldestTs,
          newestTimestamp: newestTs,
        });

        log.info("Inserted monthly klines", {
          symbol,
          marketType,
          timeframe,
          year,
          month,
          count: klines.length,
          total: totalFetched,
        });
      }
    }

    // Daily data fills the gap from last monthly archive to yesterday
    const dailyStart = new Date(monthlyEnd);
    dailyStart.setUTCDate(dailyStart.getUTCDate() + 1);
    const yesterday = new Date(now);
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);

    const days = generateDayRange(dailyStart, yesterday);

    for (const day of days) {
      if (signal?.aborted) break;

      const dayTs = day.getTime();
      if (existing && dayTs <= existing.newestTs) continue;

      const url = buildDailyUrl(marketType, exchangeId, timeframe, day);
      const csv = await downloadAndExtractCsv(url, signal);
      if (!csv) continue;

      const klines = parseKlineCsv(csv, symbol, marketType, timeframe);
      if (klines.length > 0) {
        await insertKlines(sender, klines);
        totalFetched += klines.length;
        oldestTs = Math.min(oldestTs, klines[0]!.openTime);
        newestTs = Math.max(newestTs, klines[klines.length - 1]!.openTime);

        report({
          fetchedCandles: totalFetched,
          oldestTimestamp: oldestTs,
          newestTimestamp: newestTs,
        });
      }
    }

    const finalProgress: BackfillProgress = {
      ...progress,
      status: "completed",
      fetchedCandles: totalFetched,
      oldestTimestamp: oldestTs === Infinity ? 0 : oldestTs,
      newestTimestamp: newestTs,
    };

    await updateBackfillProgress(
      sender,
      symbol,
      marketType,
      timeframe,
      finalProgress,
    );

    log.info("Backfill completed", {
      symbol,
      marketType,
      timeframe,
      totalCandles: totalFetched,
    });

    return finalProgress;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    const errorProgress: BackfillProgress = {
      ...progress,
      status: "error",
      error: errorMsg,
    };
    await updateBackfillProgress(
      sender,
      symbol,
      marketType,
      timeframe,
      errorProgress,
    ).catch(() => {});
    log.error("Backfill failed", {
      symbol,
      marketType,
      timeframe,
      error: errorMsg,
    });
    return errorProgress;
  }
}

/** Run tasks with bounded concurrency — each task creates its own sender */
async function runConcurrent<T>(
  tasks: (() => Promise<T>)[],
  concurrency: number,
): Promise<readonly T[]> {
  const results: T[] = new Array(tasks.length);
  let next = 0;

  async function worker(): Promise<void> {
    while (next < tasks.length) {
      const i = next++;
      results[i] = await tasks[i]!();
    }
  }

  const workerCount = Math.min(concurrency, tasks.length);
  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}

export async function backfillAll(
  options: BackfillOptions,
): Promise<readonly BackfillProgress[]> {
  const { config, signal } = options;

  // Build all (marketType, symbol, timeframe) combinations
  const jobs: Array<() => Promise<BackfillProgress>> = [];

  for (const marketType of config.marketTypes) {
    for (const symbol of config.symbols) {
      for (const timeframe of config.backfill!.timeframes) {
        // Capture loop variables
        const mt = marketType;
        const sym = symbol;
        const tf = timeframe as TimeFrame;

        jobs.push(async () => {
          if (signal?.aborted) {
            return {
              symbol: sym,
              marketType: mt,
              timeframe: tf,
              totalCandles: 0,
              fetchedCandles: 0,
              oldestTimestamp: 0,
              newestTimestamp: 0,
              status: "error" as const,
              error: "Aborted",
            };
          }
          const sender = await createSender();
          try {
            return await backfillSymbol(sender, sym, mt, tf, options);
          } finally {
            await sender.close();
          }
        });
      }
    }
  }

  log.info("Starting parallel backfill", {
    totalJobs: jobs.length,
    concurrency: 5,
  });

  return runConcurrent(jobs, 5);
}
