/**
 * Shared formatting utilities for the OpenCrow web UI.
 * Replaces ~20 locally-defined duplicates across view files.
 */

/** Format a unix epoch (seconds) to a locale string. Returns "Never" for falsy values. */
export function formatTime(epoch: number | null): string {
  if (!epoch) return "Never";
  return new Date(epoch * 1000).toLocaleString();
}

/** Format a large number with K/M suffixes. */
export function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/** Format a unix epoch (seconds) to a relative time string (e.g. "5m ago"). */
export function relativeTime(epoch: number): string {
  const diff = Math.floor(Date.now() / 1000) - epoch;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

/** Format seconds into a human-readable uptime (e.g. "2d 5h 3m"). */
export function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/** Format a unix epoch (seconds) to HH:MM:SS time-only string. */
export function formatTimestamp(epoch: number): string {
  if (!epoch) return "—";
  return new Date(epoch * 1000).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/** Format an ISO timestamp string to HH:MM:SS.mmm. */
export function formatLogTimestamp(ts: string): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  return `${hh}:${mm}:${ss}.${ms}`;
}

/** Format a unix epoch (seconds) to a short relative string (e.g. "5m", "3h", "2d"). */
export function formatAge(epoch: number): string {
  if (!epoch) return "";
  const diff = Math.floor(Date.now() / 1000) - epoch;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86400)}d`;
}

/** Format an ISO date string to YYYY-MM-DD. */
export function formatDate(dateStr: string): string {
  if (!dateStr) return "";
  return dateStr.slice(0, 10);
}

/** Format an ISO timestamp string to "Mon DD" style. */
export function formatShortDate(ts: string): string {
  const d = new Date(ts);
  const mon = d.toLocaleString("en", { month: "short" });
  const day = d.getDate();
  return `${mon} ${day}`;
}

/** Like relativeTime but includes "yesterday" for 1-day-old epochs. */
export function timeAgo(epoch: number): string {
  const diff = Math.floor(Date.now() / 1000) - epoch;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  const days = Math.floor(diff / 86400);
  if (days === 1) return "yesterday";
  return `${days}d ago`;
}

/** Format a future epoch (seconds) as a countdown string. */
export function formatCountdown(targetEpoch: number): string {
  const diff = targetEpoch - Math.floor(Date.now() / 1000);
  if (diff <= 0) return "now";
  const hrs = Math.floor(diff / 3600);
  const mins = Math.floor((diff % 3600) / 60);
  const secs = diff % 60;
  if (hrs > 0) return `${hrs}h ${mins}m`;
  if (mins > 0) return `${mins}m ${secs}s`;
  return `${secs}s`;
}

/** Format a minute interval as a human label (e.g. "Every 30 min", "Every 2h"). */
export function intervalLabel(minutes: number): string {
  if (minutes < 60) return `Every ${minutes} min`;
  const hrs = Math.floor(minutes / 60);
  const rem = minutes % 60;
  if (rem === 0) return `Every ${hrs}h`;
  return `Every ${hrs}h ${rem}m`;
}

/** Format USD cost with appropriate precision. */
export function formatCost(usd: number): string {
  if (usd === 0) return "$0.00";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

/** Format milliseconds as a human-readable duration (e.g. "2.3s", "1m 30s"). */
export function formatDuration(ms: number): string {
  if (!ms) return "\u2014";
  if (ms < 1000) return `${ms}ms`;
  const sec = ms / 1000;
  return sec < 60
    ? `${sec.toFixed(1)}s`
    : `${Math.floor(sec / 60)}m ${Math.round(sec % 60)}s`;
}

/** Parse a JSON array string, returning [] on failure. */
export function parseJsonArray<T = string>(json: string): readonly T[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
