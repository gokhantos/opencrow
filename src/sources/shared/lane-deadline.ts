/**
 * lane-deadline.ts — hard wall-clock bound for a single scraper-lane step.
 *
 * The gap this fills: `pass-deadline.ts`'s `isPassOverBudget` is checked
 * BETWEEN items of a sequential pass, and `fetch-with-timeout.ts`'s
 * `HARD_DEADLINE_GRACE_MS` backstop bounds ONE `fetch`. Neither can rescue a
 * lane that awaits a single non-fetch operation which never settles — a DB
 * read, a vector-store upsert, an embedding call. Those awaits sit inside a
 * lane holding a single-flight lock, so "never settles" means "the lock is
 * held forever" and the whole lane stops silently.
 *
 * This has now happened twice on the App Store scraper, each time on a
 * different resource, which is why the fix here is generic rather than
 * per-call-site:
 *
 *   - 2026-07-24 20:48 UTC — a `config_overrides` read never settled
 *     client-side (Postgres reported the connection `state='idle'`, i.e. the
 *     server had already answered, while the Bun SQL promise never resolved).
 *     It permanently checked out 1 of the scraper's 2 pooled connections and
 *     parked the direct sweep + hourly tick for 11.5h. PR #349 bounded only
 *     `getSecret`'s call site, so the hang relocated; PR #353 right-sized the
 *     pool, which contained the blast radius but did not stop the hang.
 *   - 2026-07-25 10:36 UTC — the hourly `scrape()` chain parked on
 *     `indexUnindexedReviews()` / `indexUnindexedRankings()` with ~10 sockets
 *     stuck in `SYN_SENT` to Qdrant (:6333) while Qdrant itself was healthy
 *     (`/readyz` 200, 6 connections, 0% CPU). `running` stayed true for 2.5h+,
 *     so every subsequent hourly tick logged "App Store scrape already
 *     running, skipping" and `appstore_ranking_history` went stale, while the
 *     keyword lanes — on their own connections after #353 — kept working.
 *
 * `withLaneDeadline` races the work against a timer, so the caller ALWAYS
 * settles within `deadlineMs` regardless of what the underlying operation
 * does. The abandoned promise is intentionally left unawaited: it may never
 * settle (that is the failure being guarded), so it can never surface an
 * unhandled rejection. Mirrors `fetchWithTimeout`'s hard-deadline convention.
 *
 * This bounds the LANE, it does not cancel the work — a hung Qdrant connect
 * stays hung and its socket leaks. That is the accepted trade: a leaked socket
 * degrades, a held lock stops the lane outright.
 */

/**
 * Deadline for a best-effort memory-indexing step (embeddings + Qdrant
 * upsert) inside a scraper's hourly chain. Generous — a large unindexed
 * backlog legitimately takes minutes — but far below the hourly cadence, so a
 * wedged vector store can never hold the lane into the next tick.
 */
export const MEMORY_INDEXING_DEADLINE_MS = 10 * 60_000;

/**
 * Thrown when a lane step exceeds its wall-clock deadline. Distinct type so
 * callers can log it as a lane-level budget breach rather than a generic
 * failure of the underlying operation.
 */
export class LaneDeadlineError extends Error {
  constructor(
    readonly label: string,
    readonly deadlineMs: number,
  ) {
    super(`Lane step "${label}" exceeded its ${deadlineMs}ms deadline`);
    this.name = "LaneDeadlineError";
  }
}

/**
 * Runs `fn` with a hard wall-clock bound.
 *
 * Resolves with `fn`'s value if it settles in time; rejects with
 * `LaneDeadlineError` at `deadlineMs` otherwise. The timer is always cleared
 * on the settle path so this never keeps the event loop alive.
 *
 * @param label   Stable identifier for logs (e.g. "appstore:index-reviews").
 * @param deadlineMs Wall-clock budget in ms.
 * @param fn      The lane step to bound.
 */
export async function withLaneDeadline<T>(
  label: string,
  deadlineMs: number,
  fn: () => Promise<T>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new LaneDeadlineError(label, deadlineMs)), deadlineMs);
  });

  try {
    return await Promise.race([fn(), deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
