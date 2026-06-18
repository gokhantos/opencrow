/**
 * Cross-process cancellation watcher for SIGE runs.
 *
 * A SIGE session executes in the standalone SIGE process, while a cancel request
 * arrives in the WEB process and only flips the session's DB status to
 * `cancelled`. Nothing else crosses the process boundary, so without this watcher
 * the in-process run keeps executing (a zombie) — burning LLM cost and holding
 * the single-session slot so pending sessions never get claimed.
 *
 * This watcher periodically re-reads the session's status from the DB and, when
 * it observes a terminal status set externally (`cancelled`/`failed`/etc.),
 * aborts a dedicated cancel `AbortController`. Because that controller's signal is
 * combined into the run's single shared signal (which is already threaded into
 * `chat()` and every round), the abort stops in-flight LLM calls and the round
 * loop promptly.
 *
 * Robustness contract:
 *  - A transient DB read error MUST NOT abort the run — only a successfully-read
 *    terminal status triggers abort. Read errors are logged and the poll continues.
 *  - The interval is `unref`'d so it can never keep the process alive, and is
 *    cleared by the returned `stop()` (called from a `finally`).
 */

import { createLogger } from "../logger";
import { getSessionStatus, isTerminalStatus } from "./store";
import type { SigeSessionStatus } from "./types";

const log = createLogger("sige:cancel-watcher");

/** Default poll cadence — aligned with the run's coarse heartbeat granularity. */
export const DEFAULT_CANCEL_POLL_INTERVAL_MS = 10_000;

export interface CancelWatcherOptions {
  readonly sessionId: string;
  /**
   * The controller whose `abort()` is called when an externally-set terminal
   * status is observed. Its signal must be combined into the run's shared signal
   * by the caller so the abort actually reaches in-flight work.
   */
  readonly controller: AbortController;
  /** Poll cadence in ms. Defaults to {@link DEFAULT_CANCEL_POLL_INTERVAL_MS}. */
  readonly intervalMs?: number;
  /**
   * Status reader. Injectable for tests; defaults to the DB-backed
   * {@link getSessionStatus}. A `null` return (session vanished) is treated as a
   * non-terminal read and does NOT abort.
   */
  readonly getStatus?: (sessionId: string) => Promise<SigeSessionStatus | null>;
}

/**
 * Start polling the session's DB status; abort the supplied controller when a
 * terminal status is observed. Returns a `stop()` that clears the interval —
 * call it from a `finally` so no timer leaks.
 */
export function startCancelWatcher(options: CancelWatcherOptions): () => void {
  const { sessionId, controller } = options;
  const intervalMs = options.intervalMs ?? DEFAULT_CANCEL_POLL_INTERVAL_MS;
  const getStatus = options.getStatus ?? getSessionStatus;

  const poll = async (): Promise<void> => {
    // Already aborted (e.g. wall-clock timeout or process shutdown) — nothing to do.
    if (controller.signal.aborted) return;
    try {
      const status = await getStatus(sessionId);
      // A transient/empty read (null) is NOT terminal — do not abort.
      if (status !== null && isTerminalStatus(status)) {
        log.info("Session reached a terminal status externally — aborting run", {
          sessionId,
          status,
        });
        controller.abort();
      }
    } catch (err) {
      // CRITICAL: a transient DB read error must never abort the run. Log and
      // continue; the next tick re-reads.
      log.debug("Cancel-watcher status poll failed (non-fatal, continuing)", {
        sessionId,
        err,
      });
    }
  };

  const timer = setInterval(() => {
    void poll();
  }, intervalMs);
  // Never let the watcher keep the process alive.
  timer.unref?.();

  return () => clearInterval(timer);
}
