import { test, expect } from "bun:test";
import {
  formatFirstFound,
  formatOpportunity,
  matchesKeywordSearch,
  sourceBadge,
  trendBadge,
} from "./opportunities-format";

/* ---------- formatOpportunity ---------- */

test("formatOpportunity: mid-range value rounds to nearest percent", () => {
  expect(formatOpportunity(0.53)).toBe("53%");
});

test("formatOpportunity: zero", () => {
  expect(formatOpportunity(0)).toBe("0%");
});

test("formatOpportunity: one", () => {
  expect(formatOpportunity(1)).toBe("100%");
});

test("formatOpportunity: rounds half up", () => {
  expect(formatOpportunity(0.005)).toBe("1%");
  expect(formatOpportunity(0.004)).toBe("0%");
});

test("formatOpportunity: non-finite input returns a dash", () => {
  expect(formatOpportunity(Number.NaN)).toBe("—");
  expect(formatOpportunity(Number.POSITIVE_INFINITY)).toBe("—");
});

test("formatOpportunity: clamps out-of-range values", () => {
  expect(formatOpportunity(-0.2)).toBe("0%");
  expect(formatOpportunity(1.5)).toBe("100%");
});

/* ---------- trendBadge ---------- */

test("trendBadge: heating", () => {
  const badge = trendBadge("heating");
  expect(badge.label).toBe("Heating");
  expect(badge.className).toContain("danger");
});

test("trendBadge: cooling", () => {
  const badge = trendBadge("cooling");
  expect(badge.label).toBe("Cooling");
  expect(badge.className).toContain("accent");
});

test("trendBadge: stable", () => {
  const badge = trendBadge("stable");
  expect(badge.label).toBe("Stable");
});

test("trendBadge: new", () => {
  const badge = trendBadge("new");
  expect(badge.label).toBe("New");
});

test("trendBadge: unknown value falls back to the raw label", () => {
  const badge = trendBadge("mystery");
  expect(badge.label).toBe("mystery");
  expect(badge.className).toBeTruthy();
});

test("trendBadge: all known trends have a non-empty className", () => {
  for (const trend of ["heating", "cooling", "stable", "new"]) {
    expect(trendBadge(trend).className.length).toBeGreaterThan(0);
  }
});

/* ---------- sourceBadge ---------- */

test("sourceBadge: seed", () => {
  const badge = sourceBadge("seed");
  expect(badge.label).toBe("Seed");
});

test("sourceBadge: autocomplete", () => {
  const badge = sourceBadge("autocomplete");
  expect(badge.label).toBe("Autocomplete");
  expect(badge.className).toContain("cyan");
});

test("sourceBadge: pipeline", () => {
  const badge = sourceBadge("pipeline");
  expect(badge.label).toBe("Pipeline");
  expect(badge.className).toContain("purple");
});

test("sourceBadge: manual", () => {
  const badge = sourceBadge("manual");
  expect(badge.label).toBe("Manual");
  expect(badge.className).toContain("success");
});

test("sourceBadge: null renders as Unknown rather than throwing", () => {
  const badge = sourceBadge(null);
  expect(badge.label).toBe("Unknown");
});

test("sourceBadge: unrecognized string falls back to the raw label", () => {
  const badge = sourceBadge("mystery-source");
  expect(badge.label).toBe("mystery-source");
  expect(badge.className.length).toBeGreaterThan(0);
});

/* ---------- formatFirstFound ---------- */

test("formatFirstFound: null renders as a dash", () => {
  expect(formatFirstFound(null)).toBe("—");
});

test("formatFirstFound: non-finite epoch renders as a dash", () => {
  expect(formatFirstFound(Number.NaN)).toBe("—");
});

test("formatFirstFound: recent epoch renders a relative string", () => {
  const fiveMinutesAgo = Math.floor(Date.now() / 1000) - 300;
  expect(formatFirstFound(fiveMinutesAgo)).toBe("5m ago");
});

test("formatFirstFound: epoch from a day ago renders 'yesterday'", () => {
  const oneDayAgo = Math.floor(Date.now() / 1000) - 86400;
  expect(formatFirstFound(oneDayAgo)).toBe("yesterday");
});

/* ---------- matchesKeywordSearch ---------- */

test("matchesKeywordSearch: empty needle matches everything", () => {
  expect(matchesKeywordSearch("meal planner", "")).toBe(true);
  expect(matchesKeywordSearch("meal planner", "   ")).toBe(true);
});

test("matchesKeywordSearch: substring match", () => {
  expect(matchesKeywordSearch("meal planner", "plan")).toBe(true);
  expect(matchesKeywordSearch("habit tracker", "plan")).toBe(false);
});

test("matchesKeywordSearch: case-insensitive", () => {
  expect(matchesKeywordSearch("Meal Planner", "PLANNER")).toBe(true);
  expect(matchesKeywordSearch("meal planner", "Meal")).toBe(true);
});

test("matchesKeywordSearch: ignores leading/trailing whitespace in the needle", () => {
  expect(matchesKeywordSearch("meal planner", "  planner  ")).toBe(true);
});

test("matchesKeywordSearch: no match returns false", () => {
  expect(matchesKeywordSearch("meal planner", "zzz-nonexistent")).toBe(false);
});
