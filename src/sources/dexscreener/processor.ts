/** DexScreener data processor — fetch, store, and index trending tokens. */

import { createLogger } from "../../logger";
import type { MemoryManager, DexTokenForIndex } from "../../memory/types";
import {
  fetchTrendingTokens,
  fetchNewTokens,
  type TrendingToken,
} from "./scraper";
import { upsertTokens } from "./store";

import { getErrorMessage } from "../../lib/error-serialization";
const log = createLogger("dexscreener-processor");

const DEFAULT_INTERVALS = {
  trending: 15 * 60_000, // Every 15 minutes
  new: 30 * 60_000, // Every 30 minutes
};

const TICK_INTERVAL_MS = 60_000; // Check every minute

export interface DexScreenerProcessor {
  start(): void;
  stop(): void;
  fetchTrending(): Promise<{ ok: boolean; found: number; inserted: number; error?: string }>;
  fetchNew(): Promise<{ ok: boolean; found: number; inserted: number; error?: string }>;
}

const SHARED_AGENT_ID = "shared";

function toDexTokensForIndex(tokens: readonly TrendingToken[]): readonly DexTokenForIndex[] {
  const now = Math.floor(Date.now() / 1000);
  return tokens.map((token) => ({
    id: `${token.chainId}-${token.address}`,
    name: token.name,
    symbol: token.symbol,
    chainId: token.chainId,
    address: token.address,
    priceUsd: token.priceUsd,
    priceChange24h: token.priceChange24h,
    volume24h: token.volume24h,
    liquidityUsd: token.liquidityUsd ?? 0,
    marketCap: token.marketCap ?? 0,
    pairUrl: token.pairUrl,
    createdAt: token.createdAt ?? now,
  }));
}

export function createDexScreenerProcessor(config?: {
  intervals?: { trending?: number; new?: number };
  memoryManager?: MemoryManager;
}): DexScreenerProcessor {
  let timer: ReturnType<typeof setInterval> | null = null;
  const running = new Set<string>();
  const lastRun = new Map<string, number>();

  const intervals = {
    ...DEFAULT_INTERVALS,
    ...config?.intervals,
  };

  async function fetchTrending(): Promise<{
    ok: boolean;
    found: number;
    inserted: number;
    error?: string;
  }> {
    if (running.has("trending")) {
      return { ok: false, found: 0, inserted: 0, error: "Already running" };
    }
    running.add("trending");

    const t0 = Date.now();

    try {
      const tokens = await fetchTrendingTokens(50);

      if (tokens.length === 0) {
        return { ok: false, found: 0, inserted: 0, error: "No tokens fetched" };
      }

      const upsertResult = await upsertTokens(tokens, { isTrending: true, isNew: false });
      const { found, inserted } = upsertResult;

      // Index into RAG for semantic search
      if (config?.memoryManager && tokens.length > 0) {
        const forIndex = toDexTokensForIndex(tokens);
        config.memoryManager
          .indexDexTokens(SHARED_AGENT_ID, forIndex)
          .catch((err) =>
            log.error("Failed to index tokens into RAG", {
              count: forIndex.length,
              error: err,
            }),
          );
      }

      const durationMs = Date.now() - t0;
      log.info("Trending tokens fetched", { found, inserted, durationMs });
      lastRun.set("trending", Date.now());

      return { ok: true, found, inserted };
    } catch (err) {
      const msg = getErrorMessage(err);
      log.error("Trending fetch failed", { error: msg });
      return { ok: false, found: 0, inserted: 0, error: msg };
    } finally {
      running.delete("trending");
    }
  }

  async function fetchNew(): Promise<{
    ok: boolean;
    found: number;
    inserted: number;
    error?: string;
  }> {
    if (running.has("new")) {
      return { ok: false, found: 0, inserted: 0, error: "Already running" };
    }
    running.add("new");

    const t0 = Date.now();

    try {
      const tokens = await fetchNewTokens(24);

      if (tokens.length === 0) {
        return { ok: true, found: 0, inserted: 0 }; // Not an error, just no new tokens
      }

      const upsertResult = await upsertTokens(tokens, { isTrending: false, isNew: true });
      const { found, inserted } = upsertResult;

      // Index into RAG for semantic search
      if (config?.memoryManager && tokens.length > 0) {
        const forIndex = toDexTokensForIndex(tokens);
        config.memoryManager
          .indexDexTokens(SHARED_AGENT_ID, forIndex)
          .catch((err) =>
            log.error("Failed to index new tokens into RAG", {
              count: forIndex.length,
              error: err,
            }),
          );
      }

      const durationMs = Date.now() - t0;
      log.info("New tokens fetched", { found, inserted, durationMs });
      lastRun.set("new", Date.now());

      return { ok: true, found, inserted };
    } catch (err) {
      const msg = getErrorMessage(err);
      log.error("New tokens fetch failed", { error: msg });
      return { ok: false, found: 0, inserted: 0, error: msg };
    } finally {
      running.delete("new");
    }
  }

  async function tick(): Promise<void> {
    const now = Date.now();

    // Check trending tokens
    const lastTrending = lastRun.get("trending") ?? 0;
    if (now - lastTrending >= intervals.trending) {
      fetchTrending().catch((err) =>
        log.error("Unhandled trending fetch error", { error: err }),
      );
    }

    // Check new tokens
    const lastNew = lastRun.get("new") ?? 0;
    if (now - lastNew >= intervals.new) {
      fetchNew().catch((err) =>
        log.error("Unhandled new tokens fetch error", { error: err }),
      );
    }
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(tick, TICK_INTERVAL_MS);
      log.info("DexScreener processor started", {
        tickMs: TICK_INTERVAL_MS,
        intervals,
      });
      // First tick immediately
      Promise.all([
        fetchTrending().catch((err) => log.error("First trending fetch error", { error: err })),
        fetchNew().catch((err) => log.error("First new tokens fetch error", { error: err })),
      ]);
    },

    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
        log.info("DexScreener processor stopped");
      }
    },

    fetchTrending,
    fetchNew,
  };
}
