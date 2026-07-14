import { test, expect } from "bun:test";
import {
  buildabilityBand,
  formatFirstFound,
  formatOpportunity,
  sourceBadge,
  titleCaseLabel,
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

/* ---------- buildabilityBand ---------- */

test("buildabilityBand: >=70 is the green/Strong band, including the upper boundary and max", () => {
  expect(buildabilityBand(70).dot).toBe("🟢");
  expect(buildabilityBand(70).label).toBe("Strong");
  expect(buildabilityBand(100).dot).toBe("🟢");
});

test("buildabilityBand: 40..69 is the yellow/Moderate band, at both boundaries", () => {
  expect(buildabilityBand(40).dot).toBe("🟡");
  expect(buildabilityBand(40).label).toBe("Moderate");
  expect(buildabilityBand(69).dot).toBe("🟡");
  expect(buildabilityBand(69).label).toBe("Moderate");
});

test("buildabilityBand: <40 is the white/Weak band, including zero", () => {
  expect(buildabilityBand(39).dot).toBe("⚪");
  expect(buildabilityBand(39).label).toBe("Weak");
  expect(buildabilityBand(0).dot).toBe("⚪");
});

test("buildabilityBand: every band has a non-empty className", () => {
  for (const score of [0, 39, 40, 69, 70, 100]) {
    expect(buildabilityBand(score).className.length).toBeGreaterThan(0);
  }
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

/* ---------- formatOpportunity applied to peakOpportunity ----------
 * `peakOpportunity` is the same 0..1 ratio shape as `opportunity` (the
 * best-ever score vs. the latest score across a keyword's scan history), so
 * it's formatted with the same helper — these cases pin that a peak value
 * that reaches (or exceeds, pre-clamp) the top of the range still renders
 * sensibly, since a keyword's peak is frequently 1.0 or very close to it. */

test("formatOpportunity: peak value at the top of the range", () => {
  expect(formatOpportunity(0.97)).toBe("97%");
});

test("formatOpportunity: peak can equal latest (never scanned again)", () => {
  const peak = 0.42;
  const latest = 0.42;
  expect(formatOpportunity(peak)).toBe(formatOpportunity(latest));
});

/* ---------- titleCaseLabel ---------- */

test("titleCaseLabel: capitalizes each word of a lowercase multi-word label", () => {
  expect(titleCaseLabel("meal planner")).toBe("Meal Planner");
});

test("titleCaseLabel: single word", () => {
  expect(titleCaseLabel("budgeting")).toBe("Budgeting");
});

test("titleCaseLabel: already-capitalized input round-trips unchanged", () => {
  expect(titleCaseLabel("Sleep Tracker")).toBe("Sleep Tracker");
});

test("titleCaseLabel: empty string round-trips unchanged rather than throwing", () => {
  expect(titleCaseLabel("")).toBe("");
});

test("titleCaseLabel: collapses no whitespace — repeated spaces keep empty segments intact", () => {
  expect(titleCaseLabel("meal  planner")).toBe("Meal  Planner");
});
