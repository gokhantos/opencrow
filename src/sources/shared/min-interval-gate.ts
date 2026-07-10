/**
 * min-interval-gate.ts — lightweight async throttle for in-process callers.
 *
 * Enforces at least `minIntervalMs` between successive `acquire()` slots.
 * Intended for agent-tool entry points that can be invoked on demand by an
 * LLM tool-call loop — outside any scraper's own scrape-cycle budget — so a
 * runaway loop (including concurrent/unawaited calls) can't spray an
 * upstream API.
 *
 * Each call reserves its slot *synchronously* (before any `await`), so
 * concurrent callers queue correctly instead of racing to read a stale
 * "last resolved" timestamp.
 *
 * State is module/instance scoped (in-memory only) and lives for the
 * lifetime of the process that creates the gate. This is NOT a substitute
 * for the rate-limit-aware backoff in ssrf-safe-fetch.ts — it just bounds
 * how often a caller may *start* a request in the first place.
 */
export function createMinIntervalGate(minIntervalMs: number): () => Promise<void> {
  let nextSlotAt = 0; // epoch ms of the earliest time the next acquire() may resolve

  return function acquire(): Promise<void> {
    const now = Date.now();
    const scheduledAt = Math.max(now, nextSlotAt);
    nextSlotAt = scheduledAt + minIntervalMs;

    const waitMs = scheduledAt - now;
    if (waitMs <= 0) return Promise.resolve();
    return new Promise<void>((resolve) => setTimeout(resolve, waitMs));
  };
}
