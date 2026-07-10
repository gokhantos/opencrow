import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Log-freshness diagnostics.
 *
 * The app logger emits ISO-8601 UTC timestamps (`new Date().toISOString()` →
 * `…Z`). On a machine running ahead of UTC (e.g. UTC+3) the newest lines read
 * as an *earlier* wall-clock hour than "now" — at 15:56 local the freshest
 * entry is `12:56Z`. Eyeballing `tail` (or grepping for a local-clock hour that
 * UTC has not yet reached) makes a perfectly live log look "frozen hours ago".
 *
 * This module compares the newest timestamp to `Date.now()` in the SAME epoch
 * (immune to the timezone illusion) and renders both the UTC stamp and its local
 * equivalent, so a live log reads as live.
 */

export type FreshnessStatus = "pass" | "warn" | "fail";

export interface FreshnessVerdict {
  readonly status: FreshnessStatus;
  readonly message: string;
  readonly repair?: string;
}

/** Fresh if the newest entry is within this window. */
export const FRESH_MAX_AGE_MS = 10 * 60_000; // 10 min
/** Stale-but-warn up to this age; beyond it is a failure. */
export const STALE_MAX_AGE_MS = 2 * 60 * 60_000; // 2 h
/** Tolerate small clock skew before flagging a future-dated timestamp. */
const FUTURE_SKEW_TOLERANCE_MS = 60_000; // 1 min

const ISO_TS = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g;

/**
 * Scan a chunk of log text for ISO-8601 UTC timestamps and return the newest as
 * epoch-ms, or null if none parse. Order-independent: takes the max, so a
 * trailing partial/older line can't mask a fresher one.
 */
export function extractNewestLogTimestampMs(text: string): number | null {
  let newest: number | null = null;
  for (const match of text.matchAll(ISO_TS)) {
    const ms = Date.parse(match[0]);
    if (!Number.isNaN(ms) && (newest === null || ms > newest)) {
      newest = ms;
    }
  }
  return newest;
}

/** Human-friendly age, e.g. "4s", "3m", "2h14m". */
export function formatAge(ms: number): string {
  const clamped = Math.max(0, ms);
  const totalSec = Math.floor(clamped / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const totalMin = Math.floor(totalSec / 60);
  if (totalMin < 60) return `${totalMin}m`;
  const hours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  return mins > 0 ? `${hours}h${mins}m` : `${hours}h`;
}

/** Local wall-clock "HH:MM" for an epoch-ms instant. */
function localHhMm(ms: number): string {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

/**
 * Classify freshness from the newest timestamp vs now. Pure — no IO — so the
 * timezone/age logic is unit-testable with fixed inputs.
 */
export function classifyLogFreshness(
  newestMs: number | null,
  nowMs: number,
): FreshnessVerdict {
  if (newestMs === null) {
    return {
      status: "warn",
      message: "No parseable timestamp in recent log output",
    };
  }

  const iso = new Date(newestMs).toISOString();
  const local = localHhMm(newestMs);
  const ageMs = nowMs - newestMs;

  // Future-dated beyond tolerance → clock skew between logger and this process.
  if (ageMs < -FUTURE_SKEW_TOLERANCE_MS) {
    return {
      status: "warn",
      message: `Newest entry is ${formatAge(-ageMs)} in the future (${iso} / ${local} local) — clock skew between logger and this host`,
    };
  }

  const stamp = `${iso} / ${local} local`;

  if (ageMs <= FRESH_MAX_AGE_MS) {
    return {
      status: "pass",
      message: `Live — last entry ${formatAge(ageMs)} ago (${stamp}). Timestamps are UTC.`,
    };
  }

  if (ageMs <= STALE_MAX_AGE_MS) {
    return {
      status: "warn",
      message: `Last entry ${formatAge(ageMs)} ago (${stamp}). Timestamps are UTC — quiet, or writes stalled.`,
      repair: "Tail the log; if truly stalled: opencrow service core restart",
    };
  }

  return {
    status: "fail",
    message: `No log output for ${formatAge(ageMs)} (last ${stamp}). Timestamps are UTC — the process may be wedged or not writing to this file.`,
    repair: "opencrow service core restart",
  };
}

/**
 * Read the last `maxBytes` of a file without loading the whole thing (the core
 * err.log grows to tens of MB). Returns null if the file is missing/empty.
 */
export function readLogTail(filePath: string, maxBytes = 64 * 1024): string | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, "r");
    const size = fs.fstatSync(fd).size;
    if (size === 0) return null;
    const len = Math.min(size, maxBytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    return buf.toString("utf8");
  } catch {
    return null;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

/** Path to the core service's launchd/systemd stderr sink. */
export function coreLogPath(home: string = os.homedir()): string {
  return path.join(home, ".opencrow", "logs", "opencrow.err.log");
}
