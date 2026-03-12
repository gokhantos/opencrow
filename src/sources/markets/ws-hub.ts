import type { ServerWebSocket } from "bun";
import type { Kline } from "./types";
import { createLogger } from "../../logger";

const log = createLogger("market:ws-hub");

/** Data attached to each WebSocket connection */
export interface WsClientData {
  readonly subscriptions: Set<string>;
}

/** Subscribe/unsubscribe message from client */
interface ClientMsg {
  readonly action: "subscribe" | "unsubscribe";
  readonly symbol: string;
  readonly marketType: string;
  readonly timeframe: string;
}

function topicKey(symbol: string, marketType: string, timeframe: string): string {
  return `kline:${symbol}:${marketType}:${timeframe}`;
}

export interface LiveKlineHub {
  /** Called by the market pipeline when a new kline arrives (any state, open or closed) */
  publish(kline: Kline): void;
  /** Called by the WebSocket server when a client connects */
  onOpen(ws: ServerWebSocket<WsClientData>): void;
  /** Called by the WebSocket server on client message */
  onMessage(ws: ServerWebSocket<WsClientData>, msg: string | Buffer): void;
  /** Called by the WebSocket server when a client disconnects */
  onClose(ws: ServerWebSocket<WsClientData>): void;
  /** Total number of active subscriptions across all clients */
  getSubscriberCount(): number;
}

/**
 * Simple in-process pub/sub hub that routes live kline events to subscribed
 * frontend WebSocket clients.
 *
 * Topics follow the format: `kline:{symbol}:{marketType}:{timeframe}`
 * (e.g. `kline:BTC/USDT:futures:1m`)
 */
export function createLiveKlineHub(): LiveKlineHub {
  // topic → set of subscribed WebSocket connections
  const topics = new Map<string, Set<ServerWebSocket<WsClientData>>>();

  function subscribe(
    ws: ServerWebSocket<WsClientData>,
    topic: string,
  ): void {
    let clients = topics.get(topic);
    if (!clients) {
      clients = new Set();
      topics.set(topic, clients);
    }
    clients.add(ws);
    ws.data.subscriptions.add(topic);
    log.debug("Client subscribed", { topic, total: clients.size });
  }

  function unsubscribe(
    ws: ServerWebSocket<WsClientData>,
    topic: string,
  ): void {
    topics.get(topic)?.delete(ws);
    ws.data.subscriptions.delete(topic);
  }

  return {
    publish(kline: Kline): void {
      const topic = topicKey(kline.symbol, kline.marketType, kline.timeframe);
      const clients = topics.get(topic);
      if (!clients || clients.size === 0) return;

      const msg = JSON.stringify({ type: "kline", data: kline });
      const dead = new Set<ServerWebSocket<WsClientData>>();

      for (const ws of clients) {
        try {
          ws.send(msg);
        } catch {
          dead.add(ws);
        }
      }

      // Prune disconnected clients
      for (const ws of dead) {
        clients.delete(ws);
        ws.data.subscriptions.delete(topic);
      }
    },

    onOpen(_ws: ServerWebSocket<WsClientData>): void {
      log.debug("WebSocket client connected");
    },

    onMessage(ws: ServerWebSocket<WsClientData>, msg: string | Buffer): void {
      try {
        const raw = typeof msg === "string" ? msg : msg.toString();
        const data = JSON.parse(raw) as ClientMsg;

        if (data.action !== "subscribe" && data.action !== "unsubscribe") return;
        if (!data.symbol || !data.marketType || !data.timeframe) return;

        const topic = topicKey(data.symbol, data.marketType, data.timeframe);

        if (data.action === "subscribe") {
          subscribe(ws, topic);
        } else {
          unsubscribe(ws, topic);
        }
      } catch {
        // Ignore malformed messages
      }
    },

    onClose(ws: ServerWebSocket<WsClientData>): void {
      // Remove from all subscribed topics
      for (const topic of ws.data.subscriptions) {
        topics.get(topic)?.delete(ws);
      }
      ws.data.subscriptions.clear();
      log.debug("WebSocket client disconnected");
    },

    getSubscriberCount(): number {
      let count = 0;
      for (const clients of topics.values()) count += clients.size;
      return count;
    },
  };
}
