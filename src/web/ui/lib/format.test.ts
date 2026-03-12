import { test, expect } from "bun:test";
import {
  formatTime,
  formatNumber,
  relativeTime,
  formatUptime,
  formatTimestamp,
  formatLogTimestamp,
  formatAge,
  formatDate,
  formatShortDate,
  parseJsonArray,
  timeAgo,
  formatCountdown,
  intervalLabel,
} from "./format";

/* ---------- formatTime ---------- */

test("formatTime returns 'Never' for null/0", () => {
  expect(formatTime(null)).toBe("Never");
  expect(formatTime(0)).toBe("Never");
});

test("formatTime formats an epoch to locale string", () => {
  const epoch = 1700000000;
  const result = formatTime(epoch);
  expect(result).toContain("2023");
});

/* ---------- formatNumber ---------- */

test("formatNumber returns raw string for small numbers", () => {
  expect(formatNumber(42)).toBe("42");
  expect(formatNumber(999)).toBe("999");
});

test("formatNumber uses K suffix for thousands", () => {
  expect(formatNumber(1_500)).toBe("1.5K");
  expect(formatNumber(10_000)).toBe("10.0K");
});

test("formatNumber uses M suffix for millions", () => {
  expect(formatNumber(2_500_000)).toBe("2.5M");
});

/* ---------- relativeTime ---------- */

test("relativeTime returns 'just now' for recent epochs", () => {
  const now = Math.floor(Date.now() / 1000);
  expect(relativeTime(now - 30)).toBe("just now");
});

test("relativeTime returns minutes ago", () => {
  const now = Math.floor(Date.now() / 1000);
  expect(relativeTime(now - 300)).toBe("5m ago");
});

test("relativeTime returns hours ago", () => {
  const now = Math.floor(Date.now() / 1000);
  expect(relativeTime(now - 7200)).toBe("2h ago");
});

test("relativeTime returns days ago", () => {
  const now = Math.floor(Date.now() / 1000);
  expect(relativeTime(now - 172800)).toBe("2d ago");
});

/* ---------- timeAgo ---------- */

test("timeAgo returns 'yesterday' for 1 day ago", () => {
  const now = Math.floor(Date.now() / 1000);
  expect(timeAgo(now - 86400)).toBe("yesterday");
});

test("timeAgo returns 'Xd ago' for multiple days", () => {
  const now = Math.floor(Date.now() / 1000);
  expect(timeAgo(now - 86400 * 3)).toBe("3d ago");
});

/* ---------- formatUptime ---------- */

test("formatUptime formats seconds only", () => {
  expect(formatUptime(45)).toBe("45s");
});

test("formatUptime formats minutes and seconds", () => {
  expect(formatUptime(125)).toBe("2m 5s");
});

test("formatUptime formats hours, minutes, seconds", () => {
  expect(formatUptime(3661)).toBe("1h 1m 1s");
});

test("formatUptime formats days, hours, minutes", () => {
  expect(formatUptime(90061)).toBe("1d 1h 1m");
});

/* ---------- formatTimestamp ---------- */

test("formatTimestamp returns dash for falsy epoch", () => {
  expect(formatTimestamp(0)).toBe("—");
});

test("formatTimestamp returns HH:MM:SS format", () => {
  const result = formatTimestamp(1700000000);
  expect(result).toMatch(/\d{2}:\d{2}:\d{2}/);
});

/* ---------- formatLogTimestamp ---------- */

test("formatLogTimestamp formats ISO string to HH:MM:SS.mmm", () => {
  const result = formatLogTimestamp("2024-01-15T10:30:45.123Z");
  expect(result).toMatch(/\d{2}:\d{2}:\d{2}\.\d{3}/);
});

/* ---------- formatAge ---------- */

test("formatAge returns empty for falsy", () => {
  expect(formatAge(0)).toBe("");
});

test("formatAge returns short relative format", () => {
  const now = Math.floor(Date.now() / 1000);
  expect(formatAge(now - 300)).toBe("5m");
  expect(formatAge(now - 7200)).toBe("2h");
  expect(formatAge(now - 172800)).toBe("2d");
});

/* ---------- formatDate ---------- */

test("formatDate extracts YYYY-MM-DD from ISO string", () => {
  expect(formatDate("2024-03-15T10:00:00Z")).toBe("2024-03-15");
});

test("formatDate returns empty for empty string", () => {
  expect(formatDate("")).toBe("");
});

/* ---------- formatShortDate ---------- */

test("formatShortDate formats to Mon DD", () => {
  const result = formatShortDate("2024-01-15T00:00:00Z");
  expect(result).toContain("Jan");
  expect(result).toContain("15");
});

/* ---------- parseJsonArray ---------- */

test("parseJsonArray parses valid JSON array", () => {
  expect(parseJsonArray('["a","b","c"]')).toEqual(["a", "b", "c"]);
});

test("parseJsonArray returns [] for invalid JSON", () => {
  expect(parseJsonArray("not json")).toEqual([]);
});

test("parseJsonArray returns [] for non-array JSON", () => {
  expect(parseJsonArray('{"key":"val"}')).toEqual([]);
});

/* ---------- formatCountdown ---------- */

test("formatCountdown returns 'now' for past epoch", () => {
  const past = Math.floor(Date.now() / 1000) - 10;
  expect(formatCountdown(past)).toBe("now");
});

test("formatCountdown formats seconds", () => {
  const future = Math.floor(Date.now() / 1000) + 30;
  expect(formatCountdown(future)).toMatch(/\d+s/);
});

test("formatCountdown formats minutes and seconds", () => {
  const future = Math.floor(Date.now() / 1000) + 125;
  expect(formatCountdown(future)).toMatch(/\d+m \d+s/);
});

test("formatCountdown formats hours and minutes", () => {
  const future = Math.floor(Date.now() / 1000) + 3700;
  expect(formatCountdown(future)).toMatch(/\d+h \d+m/);
});

/* ---------- intervalLabel ---------- */

test("intervalLabel formats minutes", () => {
  expect(intervalLabel(30)).toBe("Every 30 min");
});

test("intervalLabel formats whole hours", () => {
  expect(intervalLabel(60)).toBe("Every 1h");
  expect(intervalLabel(120)).toBe("Every 2h");
});

test("intervalLabel formats hours and remainder", () => {
  expect(intervalLabel(90)).toBe("Every 1h 30m");
});
