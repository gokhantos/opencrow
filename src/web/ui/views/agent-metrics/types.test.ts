import { test, expect } from "bun:test";
import { RANGES, AGENT_COLORS, MODEL_COLORS, sinceEpoch } from "./types";

/* ---------- RANGES ---------- */

test("RANGES has 4 entries", () => {
  expect(RANGES.length).toBe(4);
});

test("RANGES ids are unique", () => {
  const ids = RANGES.map((r) => r.id);
  expect(new Set(ids).size).toBe(ids.length);
});

test("RANGES 24h seconds", () => {
  expect(RANGES[0].seconds).toBe(86400);
});

test("RANGES 7d seconds", () => {
  expect(RANGES[1].seconds).toBe(7 * 86400);
});

test("RANGES 30d seconds", () => {
  expect(RANGES[2].seconds).toBe(30 * 86400);
});

test("RANGES all seconds is 0", () => {
  expect(RANGES[3].seconds).toBe(0);
});

/* ---------- AGENT_COLORS ---------- */

test("AGENT_COLORS has 10 entries", () => {
  expect(AGENT_COLORS.length).toBe(10);
});

test("AGENT_COLORS are valid hex strings", () => {
  for (const c of AGENT_COLORS) {
    expect(c).toMatch(/^#[0-9a-f]{6}$/i);
  }
});

test("AGENT_COLORS are unique", () => {
  expect(new Set(AGENT_COLORS).size).toBe(AGENT_COLORS.length);
});

/* ---------- MODEL_COLORS ---------- */

test("MODEL_COLORS has 8 entries", () => {
  expect(MODEL_COLORS.length).toBe(8);
});

test("MODEL_COLORS are valid hex strings", () => {
  for (const c of MODEL_COLORS) {
    expect(c).toMatch(/^#[0-9a-f]{6}$/i);
  }
});

test("MODEL_COLORS are unique", () => {
  expect(new Set(MODEL_COLORS).size).toBe(MODEL_COLORS.length);
});

/* ---------- sinceEpoch ---------- */

test("sinceEpoch: returns undefined for 'all'", () => {
  expect(sinceEpoch("all")).toBeUndefined();
});

test("sinceEpoch: returns undefined for unknown range", () => {
  expect(sinceEpoch("unknown")).toBeUndefined();
});

test("sinceEpoch: 24h returns epoch roughly 86400 seconds ago", () => {
  const result = sinceEpoch("24h")!;
  const now = Math.floor(Date.now() / 1000);
  expect(now - result).toBeCloseTo(86400, -1);
});

test("sinceEpoch: 7d returns epoch roughly 7 days ago", () => {
  const result = sinceEpoch("7d")!;
  const now = Math.floor(Date.now() / 1000);
  expect(now - result).toBeCloseTo(7 * 86400, -1);
});

test("sinceEpoch: 30d returns epoch roughly 30 days ago", () => {
  const result = sinceEpoch("30d")!;
  const now = Math.floor(Date.now() / 1000);
  expect(now - result).toBeCloseTo(30 * 86400, -1);
});

test("sinceEpoch: result is less than current time", () => {
  const result = sinceEpoch("24h")!;
  const now = Math.floor(Date.now() / 1000);
  expect(result).toBeLessThan(now);
});
