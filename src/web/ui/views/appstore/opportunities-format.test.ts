import { test, expect } from "bun:test";
import { formatOpportunity, trendBadge } from "./opportunities-format";

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
