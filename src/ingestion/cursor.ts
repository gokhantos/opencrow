/**
 * Composite high-water-mark cursors + daily-budget bookkeeping for ingestion.
 *
 * Cursor positions and daily counts are persisted in config_overrides under the
 * `CURSOR_NAMESPACE` so each run picks up exactly where the previous one stopped.
 *
 * NOTE: `CURSOR_NAMESPACE` is the string "sige-ingestion" — a LEGACY persisted
 * identifier kept AS-IS for compatibility. Renaming it would orphan every stored
 * cursor and daily-count override, resetting the high-water marks and triggering
 * mass re-ingestion. It is decoupled from the `sige` domain in every other respect.
 */

import { getOverride, setOverride } from "../store/config-overrides";
import { getDb } from "../store/db";
import { createLogger } from "../logger";

const log = createLogger("ingestion");

/** config_overrides namespace — LEGACY identifier, do NOT rename (see file header). */
export const CURSOR_NAMESPACE = "sige-ingestion";

/** config_overrides key for the tunable daily cap. */
const DAILY_CAP_OVERRIDE_KEY = "maxRecordsPerDay";

/**
 * High-water mark cursor: tracks the newest indexed_at + id processed.
 *
 * `ts`  — Unix epoch seconds (indexed_at of the last row processed in
 *          descending order, i.e. the HIGHEST ts seen so far).
 * `id`  — primary key of the last row processed within that ts bucket.
 *
 * Query predicate (freshest-first, tie-safe):
 *   WHERE (indexed_at > ts) OR (indexed_at = ts AND id > lastId)
 *   ORDER BY indexed_at DESC, id DESC
 */
export interface CompositeCursor {
  readonly ts: number;
  readonly id: string;
}

/** Source contract used by cursor initialisation (subset of SourceDefinition). */
export interface CursorSource {
  readonly name: string;
  maxIndexedAt(): Promise<number | null>;
}

/**
 * Serialise a composite cursor to a JSON string for storage in config_overrides.
 */
export function serializeCursor(cursor: CompositeCursor): string {
  return JSON.stringify({ ts: cursor.ts, id: cursor.id });
}

/**
 * Parse a stored cursor value.
 *
 * Returns the parsed composite cursor on success, or null when the stored
 * value is absent, in the legacy string format, or otherwise malformed.
 * The caller must treat null as "no cursor yet" and initialise from MAX(indexed_at).
 */
export function parseCursor(stored: unknown): CompositeCursor | null {
  if (stored === null || stored === undefined) return null;

  // Stored as a raw string (config_overrides returns the parsed JSON value)
  if (typeof stored === "string") {
    // Might be a legacy bare id string — treat as legacy
    try {
      const parsed: unknown = JSON.parse(stored);
      return validateCursorShape(parsed);
    } catch {
      // Not JSON — legacy format
      return null;
    }
  }

  // config_overrides JSON.parse already unwrapped the value for us
  if (typeof stored === "object") {
    return validateCursorShape(stored);
  }

  return null;
}

function validateCursorShape(value: unknown): CompositeCursor | null {
  if (
    value !== null &&
    typeof value === "object" &&
    "ts" in value &&
    "id" in value &&
    typeof (value as Record<string, unknown>)["ts"] === "number" &&
    typeof (value as Record<string, unknown>)["id"] === "string"
  ) {
    return {
      ts: (value as Record<string, unknown>)["ts"] as number,
      id: (value as Record<string, unknown>)["id"] as string,
    };
  }
  return null;
}

function cursorKey(sourceName: string): string {
  return `cursor:${sourceName}`;
}

/**
 * Read the composite cursor for a source.
 *
 * Returns the parsed cursor or null when:
 *  - No cursor stored yet (first run).
 *  - Stored value is in the legacy bare-string format.
 *  - Stored value is malformed JSON.
 *
 * The caller is responsible for initialising the cursor from MAX(indexed_at)
 * when null is returned.
 */
export async function readCursor(sourceName: string): Promise<CompositeCursor | null> {
  const stored = await getOverride(CURSOR_NAMESPACE, cursorKey(sourceName));
  return parseCursor(stored);
}

/**
 * Persist the composite cursor for a source.
 */
export async function writeCursor(sourceName: string, cursor: CompositeCursor): Promise<void> {
  await setOverride(CURSOR_NAMESPACE, cursorKey(sourceName), { ts: cursor.ts, id: cursor.id });
}

/**
 * Resolve the effective cursor for a source.
 *
 * When no valid cursor exists (first run or legacy format), initialises the
 * high-water mark to MAX(indexed_at) for that source so the backlog is
 * skipped and only new inflow is processed. Logs the initialisation clearly.
 *
 * Returns the resolved cursor and a flag indicating whether the cursor was
 * freshly initialised (used for per-source backlog-skip logging).
 */
export async function resolveOrInitCursor(
  source: CursorSource,
): Promise<{ cursor: CompositeCursor; wasInitialised: boolean }> {
  const existing = await readCursor(source.name);
  if (existing !== null) {
    return { cursor: existing, wasInitialised: false };
  }

  // No valid cursor — initialise high-water from MAX(indexed_at).
  const maxTs = await source.maxIndexedAt();
  const initTs = maxTs ?? 0;

  // Count rows that will be skipped (pre-existing backlog).
  const db = getDb();
  const countRows = await db`
    SELECT COUNT(*)::integer AS n
    FROM ${db.unsafe(source.name)}
    WHERE indexed_at IS NOT NULL AND indexed_at <= ${initTs}
  `;
  const countRow = countRows[0] as { n: number } | undefined;
  const backlogCount = countRow?.n ?? 0;

  const initCursor: CompositeCursor = { ts: initTs, id: "" };

  log.info("Initialising high-water cursor — pre-existing backlog will be skipped", {
    source: source.name,
    high_water_ts: initTs,
    skipped_backlog_rows: backlogCount,
    reason: maxTs === null ? "table_empty_or_all_null_indexed_at" : "first_run_skip_backlog",
  });

  try {
    await writeCursor(source.name, initCursor);
  } catch (err) {
    log.warn("Failed to persist initial cursor — will re-initialise next cycle", {
      source: source.name,
      err,
    });
  }

  return { cursor: initCursor, wasInitialised: true };
}

// ─── Daily Budget Cap ─────────────────────────────────────────────────────────

export interface DailyBudget {
  readonly date: string;
  readonly cap: number;
  /** Mutable running count — incremented in-place within the cycle. */
  count: number;
}

/**
 * Return today's UTC date as "YYYY-MM-DD".
 */
export function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * config_overrides key for today's ingested count.
 */
export function dailyCountKey(date: string): string {
  return `ingested:${date}`;
}

/**
 * Read the tunable daily cap from config_overrides, falling back to `fallback`
 * (config.ingestion.maxRecordsPerDay).
 */
export async function readDailyCap(fallback: number): Promise<number> {
  const override = await getOverride(CURSOR_NAMESPACE, DAILY_CAP_OVERRIDE_KEY);
  if (typeof override === "number" && Number.isFinite(override) && override > 0) {
    return Math.floor(override);
  }
  return fallback;
}

/**
 * Read today's ingested count from config_overrides.
 */
export async function readDailyCount(date: string): Promise<number> {
  const stored = await getOverride(CURSOR_NAMESPACE, dailyCountKey(date));
  if (typeof stored === "number" && Number.isFinite(stored)) return Math.floor(stored);
  return 0;
}

/**
 * Persist today's running ingested count.
 */
export async function writeDailyCount(date: string, count: number): Promise<void> {
  await setOverride(CURSOR_NAMESPACE, dailyCountKey(date), count);
}
