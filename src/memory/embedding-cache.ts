const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_MAX_ENTRIES = 200;

interface CacheEntry {
  readonly embedding: Float32Array;
  readonly expiresAt: number;
}

export interface EmbeddingCache {
  get(query: string): Float32Array | null;
  set(query: string, embedding: Float32Array): void;
}

export function createEmbeddingCache(
  ttlMs: number = DEFAULT_TTL_MS,
  maxEntries: number = DEFAULT_MAX_ENTRIES,
): EmbeddingCache {
  const cache = new Map<string, CacheEntry>();

  function evictExpired(): void {
    const now = Date.now();
    for (const [key, entry] of cache) {
      if (entry.expiresAt <= now) {
        cache.delete(key);
      }
    }
  }

  // Proactively evict expired entries every 60s
  const cleanupTimer = setInterval(evictExpired, 60_000);
  if (cleanupTimer.unref) cleanupTimer.unref();

  return {
    get(query: string): Float32Array | null {
      const entry = cache.get(query);
      if (!entry) return null;
      if (entry.expiresAt <= Date.now()) {
        cache.delete(query);
        return null;
      }
      return entry.embedding;
    },

    set(query: string, embedding: Float32Array): void {
      if (cache.size >= maxEntries) {
        evictExpired();
      }
      // If still at capacity after eviction, drop oldest entry
      if (cache.size >= maxEntries) {
        const firstKey = cache.keys().next().value;
        if (firstKey !== undefined) {
          cache.delete(firstKey);
        }
      }
      cache.set(query, {
        embedding,
        expiresAt: Date.now() + ttlMs,
      });
    },
  };
}
