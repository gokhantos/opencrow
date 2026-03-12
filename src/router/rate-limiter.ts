import { createLogger } from "../logger";

const log = createLogger("router:rate-limiter");

export interface RateLimiterConfig {
  readonly maxTokens: number;
  readonly refillPerSecond: number;
}

export interface RateLimiter {
  tryConsume(key: string): boolean;
  dispose(): void;
}

interface BucketEntry {
  tokens: number;
  lastRefill: number;
  lastSeen: number;
}

const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const EVICT_AFTER_MS = 10 * 60 * 1000; // 10 minutes idle
const MAX_BUCKETS = 10_000;

function refillBucket(
  entry: BucketEntry,
  now: number,
  config: RateLimiterConfig,
): BucketEntry {
  const elapsedSec = (now - entry.lastRefill) / 1000;
  const refilled = Math.min(
    config.maxTokens,
    entry.tokens + elapsedSec * config.refillPerSecond,
  );
  return { ...entry, tokens: refilled, lastRefill: now };
}

export function createRateLimiter(config: RateLimiterConfig): RateLimiter {
  const buckets = new Map<string, BucketEntry>();

  const cleanupInterval = setInterval(() => {
    const now = Date.now();
    let evicted = 0;
    for (const [key, entry] of buckets) {
      if (now - entry.lastSeen > EVICT_AFTER_MS) {
        buckets.delete(key);
        evicted++;
      }
    }
    if (evicted > 0) {
      log.debug("Rate limiter evicted idle buckets", { evicted });
    }
  }, CLEANUP_INTERVAL_MS);

  // Allow GC if the interval is the only reference
  if (cleanupInterval.unref) cleanupInterval.unref();

  function evictOldest(): void {
    let oldestKey: string | undefined;
    let oldestSeen = Infinity;
    for (const [k, e] of buckets) {
      if (e.lastSeen < oldestSeen) {
        oldestSeen = e.lastSeen;
        oldestKey = k;
      }
    }
    if (oldestKey) buckets.delete(oldestKey);
  }

  function tryConsume(key: string): boolean {
    const now = Date.now();
    const existing = buckets.get(key);

    if (!existing && buckets.size >= MAX_BUCKETS) {
      evictOldest();
    }

    const entry = existing
      ? refillBucket(existing, now, config)
      : { tokens: config.maxTokens, lastRefill: now, lastSeen: now };

    if (entry.tokens < 1) {
      buckets.set(key, { ...entry, lastSeen: now });
      return false;
    }

    buckets.set(key, { ...entry, tokens: entry.tokens - 1, lastSeen: now });
    return true;
  }

  function dispose(): void {
    clearInterval(cleanupInterval);
    buckets.clear();
  }

  return { tryConsume, dispose };
}
