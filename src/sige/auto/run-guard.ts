/**
 * DB-backed run guard for autonomous SIGE.
 *
 * Provides a cross-process single-flight slot (Postgres advisory lock) plus
 * cheap session accounting, so the scheduler and `entries/sige.ts`
 * pollAndProcess can prevent double-spending the expensive ~45-min expert game.
 *
 * Default-OFF invariant: these are inert helpers; nothing here ticks or spends
 * unless an enabled caller invokes it.
 */

import { getErrorMessage } from "../../lib/error-serialization";
import { createLogger } from "../../logger";
import { getDb } from "../../store/db";

const log = createLogger("sige:run-guard");

/**
 * Advisory-lock key for the autonomous-SIGE single-flight slot. A stable,
 * arbitrary 63-bit-safe integer chosen so it will not collide with other
 * advisory locks in the schema. `maxConcurrent` is locked at 1 in config, so a
 * single key is sufficient.
 */
const SIGE_ADVISORY_LOCK_KEY = 7_318_204_517;

/** Hard cap on the broad discovery pool (mirrors schema broadPoolSize max). */
const BROAD_POOL_MAX = 200;

/**
 * Non-terminal session statuses that count as "runnable" (queued or in-flight).
 * Mirrors the SigeSessionStatus enum minus the three terminal states.
 */
const NON_TERMINAL_STATUSES: readonly string[] = [
  "pending",
  "knowledge_construction",
  "game_formulation",
  "expert_game",
  "social_simulation",
  "scoring",
  "report_generation",
];

export interface SigeRunSlot {
  readonly acquired: boolean;
  readonly release: () => Promise<void>;
}

/** A no-op slot returned when the lock could not be acquired (or on error). */
const NOT_ACQUIRED: SigeRunSlot = {
  acquired: false,
  release: async () => {},
};

/**
 * Try to acquire the single autonomous-SIGE run slot via
 * `pg_try_advisory_lock`. Non-blocking: returns immediately.
 *
 * - `acquired: true`  → caller holds the slot; MUST call `release()` (which runs
 *   `pg_advisory_unlock`) when the run finishes, ideally in a `finally`.
 * - `acquired: false` → another process/connection holds the slot, or the DB
 *   call failed. `release()` is a safe no-op.
 *
 * NOTE: advisory locks are scoped to the acquiring *connection*. Bun.sql pools
 * connections, so `release()` issues `pg_advisory_unlock` which Postgres applies
 * to the session that holds the lock; with a single-connection pool this is the
 * same session. The cross-process guarantee (the only one we rely on) holds
 * regardless of pooling: a second process cannot acquire while the first holds.
 *
 * `maxConcurrent` is accepted for forward-compatibility but is locked at 1 by
 * config; the single advisory key enforces exactly one concurrent slot.
 */
export async function acquireSigeRunSlot(maxConcurrent: number): Promise<SigeRunSlot> {
  if (maxConcurrent < 1) return NOT_ACQUIRED;

  try {
    const db = getDb();
    const rows = (await db`
      SELECT pg_try_advisory_lock(${SIGE_ADVISORY_LOCK_KEY}) AS locked
    `) as Array<{ locked: boolean }>;

    const acquired = rows[0]?.locked === true;
    if (!acquired) return NOT_ACQUIRED;

    return {
      acquired: true,
      release: async () => {
        try {
          const d = getDb();
          await d`SELECT pg_advisory_unlock(${SIGE_ADVISORY_LOCK_KEY})`;
        } catch (err) {
          // Releasing is best-effort: a failed unlock is recovered when the
          // connection is reset/recycled. Never throw from release().
          log.warn("failed to release SIGE run slot (non-fatal)", {
            err: getErrorMessage(err),
          });
        }
      },
    };
  } catch (err) {
    log.warn("failed to acquire SIGE run slot (non-fatal) — treating as taken", {
      err: getErrorMessage(err),
    });
    return NOT_ACQUIRED;
  }
}

/**
 * Count `sige_sessions` that are still runnable, split into queued (`pending`)
 * vs in-flight (any other non-terminal status). Used by the scheduler
 * single-flight guard and the route DoS cap.
 *
 * Fault-tolerant: on any DB error returns `{ pending: 0, inFlight: 0 }` so a
 * transient failure does not block (or crash) the caller's guard logic.
 */
export async function countRunnableSessions(): Promise<{
  readonly pending: number;
  readonly inFlight: number;
}> {
  try {
    const db = getDb();
    const rows = (await db`
      SELECT status, COUNT(*) AS cnt
      FROM sige_sessions
      WHERE status IN ${db([...NON_TERMINAL_STATUSES])}
      GROUP BY status
    `) as Array<{ status: string; cnt: string | number }>;

    let pending = 0;
    let inFlight = 0;
    for (const row of rows) {
      const n = Number(row.cnt);
      if (row.status === "pending") pending += n;
      else inFlight += n;
    }
    return { pending, inFlight };
  } catch (err) {
    log.warn("countRunnableSessions failed (non-fatal) — returning zeros", {
      err: getErrorMessage(err),
    });
    return { pending: 0, inFlight: 0 };
  }
}

/** Clamp a requested broad-pool size to the schema hard cap. PURE. */
export function clampBroadPool(requested: number): number {
  // NaN/sub-1 fall back to the floor of 1; Infinity clamps to the max below.
  if (Number.isNaN(requested) || requested < 1) return 1;
  return Math.min(Math.floor(requested), BROAD_POOL_MAX);
}
