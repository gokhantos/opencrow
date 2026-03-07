import { createSender } from "./questdb";
import type { Sender } from "@questdb/nodejs-client";
import type { Liquidation } from "./types";
import type { MarketPipelineConfig } from "./config";
import { createLogger } from "../../logger";

const log = createLogger("market:liquidations");

/** Serializes ILP writes — prevents concurrent sender.flush() from corrupting state */
class WriteQueue {
  private tail: Promise<void> = Promise.resolve();

  enqueue(fn: () => Promise<void>): void {
    this.tail = this.tail.then(fn).catch((err) => {
      log.error("ILP write failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }
}

const WS_FUTURES = "wss://fstream.binance.com/ws";

export interface LiquidationStream {
  start(): Promise<void>;
  stop(): Promise<void>;
  getStats(): LiquidationStats;
}

export interface LiquidationStats {
  readonly connected: boolean;
  readonly messagesReceived: number;
  readonly lastUpdate: number | null;
}

// Binance forceOrder event shape
interface BinanceForceOrderEvent {
  readonly e: "forceOrder";
  readonly E: number;
  readonly o: {
    readonly s: string; // Symbol
    readonly S: string; // Side (BUY/SELL)
    readonly o: string; // Order type
    readonly f: string; // Time in force
    readonly q: string; // Quantity
    readonly p: string; // Price
    readonly ap: string; // Average price
    readonly X: string; // Order status
    readonly l: string; // Last filled qty
    readonly z: string; // Filled accumulated qty
    readonly T: number; // Trade time
  };
}

function parseLiquidation(event: BinanceForceOrderEvent): Liquidation {
  const o = event.o;
  return {
    symbol: `${o.s.replace("USDT", "")}/USDT`,
    side: o.S as "BUY" | "SELL",
    orderType: o.o,
    timeInForce: o.f,
    quantity: Number(o.q),
    price: Number(o.p),
    avgPrice: Number(o.ap),
    status: o.X,
    lastFilledQty: Number(o.l),
    filledAccumulatedQty: Number(o.z),
    tradeTime: o.T,
  };
}

async function insertLiquidation(
  sender: Sender,
  liq: Liquidation,
): Promise<void> {
  // ILP rule: all .symbol() calls MUST precede any column (float/int/timestamp/string)
  sender
    .table("liquidations")
    .symbol("symbol", liq.symbol)
    .symbol("side", liq.side)
    .symbol("order_type", liq.orderType)
    .symbol("time_in_force", liq.timeInForce)
    .symbol("status", liq.status)
    .floatColumn("quantity", liq.quantity)
    .floatColumn("price", liq.price)
    .floatColumn("avg_price", liq.avgPrice)
    .floatColumn("last_filled_qty", liq.lastFilledQty)
    .floatColumn("filled_accumulated_qty", liq.filledAccumulatedQty)
    .at(BigInt(liq.tradeTime) * 1000n);
  await sender.flush();
}

export function createLiquidationStream(
  config: MarketPipelineConfig,
  signal?: AbortSignal,
): LiquidationStream {
  let ws: WebSocket | null = null;
  let running = false;
  let reconnectAttempts = 0;
  let messagesReceived = 0;
  let lastUpdate: number | null = null;
  let connected = false;
  let sender: Sender | null = null;
  const writeQueue = new WriteQueue();

  // Track which symbols we care about
  const trackedSymbols = new Set(config.symbols.map((s) => s.replace("/", "")));

  function connect(): void {
    if (!running) return;

    // Subscribe to all market liquidations
    const url = `${WS_FUTURES}/!forceOrder@arr`;
    log.info("Connecting liquidation stream", { url });

    ws = new WebSocket(url);

    ws.addEventListener("open", () => {
      connected = true;
      reconnectAttempts = 0;
      lastUpdate = Date.now();
      log.info("Liquidation stream connected");
    });

    ws.addEventListener("message", (event) => {
      try {
        const raw =
          typeof event.data === "string"
            ? event.data
            : new TextDecoder().decode(event.data as ArrayBuffer);

        const data = JSON.parse(raw) as BinanceForceOrderEvent;
        if (data.e !== "forceOrder") return;

        // Only store liquidations for our tracked symbols
        if (!trackedSymbols.has(data.o.s)) return;

        messagesReceived++;
        lastUpdate = Date.now();

        if (sender) {
          const liq = parseLiquidation(data);
          const s = sender;
          writeQueue.enqueue(async () => {
            await insertLiquidation(s, liq);
            log.debug("Liquidation recorded", {
              symbol: liq.symbol,
              side: liq.side,
              qty: liq.quantity,
              price: liq.avgPrice,
            });
          });
        }
      } catch (error) {
        log.error("Failed to process liquidation", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });

    ws.addEventListener("close", () => {
      connected = false;
      if (running) scheduleReconnect();
    });

    ws.addEventListener("error", (event) => {
      log.error("Liquidation stream error", { error: String(event) });
    });
  }

  function scheduleReconnect(): void {
    if (!running || signal?.aborted) return;

    reconnectAttempts++;
    if (reconnectAttempts > config.stream!.maxReconnectAttempts) {
      log.error("Liquidation stream: max reconnect attempts reached");
      return;
    }

    const delay =
      config.stream!.reconnectDelayMs *
      Math.pow(2, Math.min(reconnectAttempts - 1, 5));

    log.info("Liquidation stream reconnecting", {
      attempt: reconnectAttempts,
      delayMs: delay,
    });

    setTimeout(() => {
      if (running && !signal?.aborted) connect();
    }, delay);
  }

  return {
    async start() {
      if (running) return;
      running = true;
      // Dedicated sender — not shared with other streams or backfills
      sender = await createSender();
      connect();
    },

    async stop() {
      running = false;
      if (ws) {
        ws.close();
        ws = null;
      }
      if (sender) {
        await sender.close();
        sender = null;
      }
      log.info("Liquidation stream stopped");
    },

    getStats(): LiquidationStats {
      return { connected, messagesReceived, lastUpdate };
    },
  };
}
