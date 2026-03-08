import { createSender } from "./questdb";
import type { Sender } from "@questdb/nodejs-client";
import type { Kline, TimeFrame, StreamStatus, MarketType } from "./types";
import type { MarketPipelineConfig } from "./config";
import { createLogger } from "../../logger";

const log = createLogger("market:stream");

// Binance WebSocket endpoints
const WS_SPOT = "wss://stream.binance.com:9443/ws";
const WS_FUTURES = "wss://fstream.binance.com/ws";

interface StreamOptions {
  readonly config: MarketPipelineConfig;
  readonly onKline?: (kline: Kline) => void;
  readonly signal?: AbortSignal;
}

export interface KlineStream {
  start(): Promise<void>;
  stop(): Promise<void>;
  getStatus(): readonly StreamStatus[];
}

interface StreamEntry {
  ws: WebSocket | null;
  status: StreamStatus;
  reconnectAttempts: number;
  messagesReceived: number;
}

/**
 * Serializes all ILP writes through a single async chain.
 * Prevents concurrent sender.flush() calls which corrupt the buffer.
 */
class WriteQueue {
  private tail: Promise<void> = Promise.resolve();

  enqueue(fn: () => Promise<void>): void {
    this.tail = this.tail.then(fn).catch((err) => {
      log.error("ILP write failed", {
        error: err,
      });
    });
  }
}

function symbolToStreamId(symbol: string): string {
  return symbol.replace("/", "").toLowerCase();
}

function buildStreamUrl(
  marketType: MarketType,
  symbol: string,
  timeframe: TimeFrame,
): string {
  const streamId = symbolToStreamId(symbol);
  const base = marketType === "spot" ? WS_SPOT : WS_FUTURES;
  return `${base}/${streamId}@kline_${timeframe}`;
}

function streamKey(
  marketType: MarketType,
  symbol: string,
  timeframe: TimeFrame,
): string {
  return `${marketType}:${symbol}:${timeframe}`;
}

interface BinanceKlineEvent {
  readonly e: string;
  readonly E: number;
  readonly s: string;
  readonly k: {
    readonly t: number;
    readonly T: number;
    readonly s: string;
    readonly i: string;
    readonly o: string;
    readonly h: string;
    readonly l: string;
    readonly c: string;
    readonly v: string;
    readonly n: number;
    readonly x: boolean;
    readonly q: string;
  };
}

function parseKlineEvent(
  event: BinanceKlineEvent,
  symbol: string,
  marketType: MarketType,
): Kline {
  const k = event.k;
  return {
    symbol,
    marketType,
    timeframe: k.i,
    openTime: k.t,
    open: Number(k.o),
    high: Number(k.h),
    low: Number(k.l),
    close: Number(k.c),
    volume: Number(k.v),
    closeTime: k.T,
    quoteVolume: Number(k.q),
    trades: k.n,
    isClosed: k.x,
  };
}

function buildInsertFn(sender: Sender, kline: Kline): () => Promise<void> {
  return async () => {
    sender
      .table("klines")
      .symbol("symbol", kline.symbol)
      .symbol("market_type", kline.marketType)
      .symbol("timeframe", kline.timeframe)
      .floatColumn("open", kline.open)
      .floatColumn("high", kline.high)
      .floatColumn("low", kline.low)
      .floatColumn("close", kline.close)
      .floatColumn("volume", kline.volume)
      .timestampColumn("close_time", BigInt(kline.closeTime) * 1000n)
      .floatColumn("quote_volume", kline.quoteVolume)
      .intColumn("trades", kline.trades)
      .at(BigInt(kline.openTime) * 1000n);
    await sender.flush();
  };
}

export function createKlineStream(options: StreamOptions): KlineStream {
  const { config, onKline, signal } = options;
  const entries = new Map<string, StreamEntry>();
  let running = false;
  let sender: Sender | null = null;
  const writeQueue = new WriteQueue();

  function connectStream(
    marketType: MarketType,
    symbol: string,
    timeframe: TimeFrame,
  ): void {
    const key = streamKey(marketType, symbol, timeframe);
    const entry = entries.get(key);
    if (!entry || !running) return;

    const url = buildStreamUrl(marketType, symbol, timeframe);
    log.info("Connecting stream", { marketType, symbol, timeframe, url });

    const ws = new WebSocket(url);

    ws.addEventListener("open", () => {
      log.info("Stream connected", { key });
      const updated: StreamEntry = {
        ...entry,
        ws,
        reconnectAttempts: 0,
        status: {
          ...entry.status,
          connected: true,
          lastUpdate: Date.now(),
        },
      };
      entries.set(key, updated);
    });

    ws.addEventListener("message", (event) => {
      try {
        const data = JSON.parse(
          typeof event.data === "string"
            ? event.data
            : new TextDecoder().decode(event.data as ArrayBuffer),
        ) as BinanceKlineEvent;

        if (data.e !== "kline") return;

        const kline = parseKlineEvent(data, symbol, marketType);
        const current = entries.get(key)!;
        entries.set(key, {
          ...current,
          messagesReceived: current.messagesReceived + 1,
          status: {
            ...current.status,
            lastUpdate: Date.now(),
            messagesReceived: current.messagesReceived + 1,
          },
        });

        onKline?.(kline);

        // Only persist closed candles; enqueue to avoid concurrent sender.flush()
        if (kline.isClosed && sender) {
          writeQueue.enqueue(buildInsertFn(sender, kline));
        }
      } catch (error) {
        log.error("Failed to process kline message", {
          key,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });

    ws.addEventListener("close", () => {
      const current = entries.get(key);
      if (!current || !running) return;

      entries.set(key, {
        ...current,
        ws: null,
        status: { ...current.status, connected: false },
      });

      scheduleReconnect(marketType, symbol, timeframe);
    });

    ws.addEventListener("error", (event) => {
      log.error("Stream error", { key, error: String(event) });
    });

    entries.set(key, { ...entry, ws });
  }

  function scheduleReconnect(
    marketType: MarketType,
    symbol: string,
    timeframe: TimeFrame,
  ): void {
    if (!running || signal?.aborted) return;

    const key = streamKey(marketType, symbol, timeframe);
    const entry = entries.get(key);
    if (!entry) return;

    const attempts = entry.reconnectAttempts + 1;
    if (attempts > config.stream!.maxReconnectAttempts) {
      log.error("Max reconnect attempts reached", { key, attempts });
      return;
    }

    entries.set(key, { ...entry, reconnectAttempts: attempts });

    const delay =
      config.stream!.reconnectDelayMs * Math.pow(2, Math.min(attempts - 1, 5));
    log.info("Scheduling reconnect", {
      key,
      attempt: attempts,
      delayMs: delay,
    });

    setTimeout(() => {
      if (running && !signal?.aborted) {
        connectStream(marketType, symbol, timeframe);
      }
    }, delay);
  }

  return {
    async start() {
      if (running) return;
      running = true;

      // Dedicated sender for the stream — not shared with backfills
      sender = await createSender();

      for (const marketType of config.marketTypes) {
        for (const symbol of config.symbols) {
          for (const timeframe of config.stream!.timeframes) {
            const key = streamKey(marketType, symbol, timeframe as TimeFrame);
            entries.set(key, {
              ws: null,
              reconnectAttempts: 0,
              messagesReceived: 0,
              status: {
                symbol,
                marketType,
                timeframe: timeframe as TimeFrame,
                connected: false,
                lastUpdate: null,
                messagesReceived: 0,
              },
            });
            connectStream(marketType, symbol, timeframe as TimeFrame);
          }
        }
      }

      log.info("Kline streams started", {
        marketTypes: config.marketTypes,
        symbols: config.symbols,
        timeframes: config.stream!.timeframes,
        totalStreams: entries.size,
      });
    },

    async stop() {
      running = false;
      for (const [key, entry] of entries) {
        if (entry.ws) {
          entry.ws.close();
          log.debug("Stream closed", { key });
        }
      }
      entries.clear();

      if (sender) {
        await sender.close();
        sender = null;
      }

      log.info("All kline streams stopped");
    },

    getStatus(): readonly StreamStatus[] {
      return Array.from(entries.values()).map((e) => e.status);
    },
  };
}
