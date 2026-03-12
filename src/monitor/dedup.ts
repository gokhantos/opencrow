import type { AlertLevel, DedupEntry } from "./types";

export interface AlertDeduplicator {
  /** Returns true if this alert should fire (not in cooldown). */
  shouldFire(key: string, level: AlertLevel): boolean;
  /** Record that an alert was fired. */
  markFired(key: string, level: AlertLevel): void;
  /** Get all currently active alert keys. */
  getActiveKeys(): ReadonlySet<string>;
  /** Check if an alert key was previously active. */
  wasActive(key: string): boolean;
  /** Remove an alert from the active set (condition resolved). */
  markResolved(key: string): void;
  /** Remove expired entries older than 2x cooldown. */
  cleanup(): void;
}

export function createAlertDeduplicator(
  cooldownMs: number,
): AlertDeduplicator {
  const entries = new Map<string, DedupEntry>();

  return {
    shouldFire(key: string, _level: AlertLevel): boolean {
      const entry = entries.get(key);
      if (!entry) return true;
      return Date.now() - entry.lastFiredAt > cooldownMs;
    },

    markFired(key: string, level: AlertLevel): void {
      const existing = entries.get(key);
      entries.set(key, {
        lastFiredAt: Date.now(),
        level,
        consecutiveCount: (existing?.consecutiveCount ?? 0) + 1,
      });
    },

    getActiveKeys(): ReadonlySet<string> {
      return new Set(entries.keys());
    },

    wasActive(key: string): boolean {
      return entries.has(key);
    },

    markResolved(key: string): void {
      entries.delete(key);
    },

    cleanup(): void {
      const cutoff = Date.now() - cooldownMs * 2;
      for (const [key, entry] of entries) {
        if (entry.lastFiredAt < cutoff) {
          entries.delete(key);
        }
      }
    },
  };
}

export function dedupKey(category: string, title: string): string {
  return `${category}:${title}`;
}
