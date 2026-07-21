import { describe, expect, it } from "bun:test";
import { computeEffectiveMaxBatches } from "./app-enrichment";
import { computeEffectiveAppsPerTick } from "./review-harvester";

// `runAppEnrichmentIfDue`'s throttle-scaling gate math (deep-scrape build
// Stage 2, §0.4: "maxBatchesPerPass × multiplier, 0 ⇒ skip") — factored into
// a pure, exported function (mirrors `sweep-throttle.ts`'s
// `computeEffectiveSweepRate`) so it's unit-testable without reaching into
// `scraper.ts`'s closure-scoped `runAppEnrichmentIfDue`.
describe("computeEffectiveMaxBatches", () => {
  it("returns the configured value unchanged at full throttle (multiplier 1)", () => {
    expect(computeEffectiveMaxBatches(4, 1)).toBe(4);
  });

  it("halves (and floors) at a 0.5 multiplier", () => {
    expect(computeEffectiveMaxBatches(5, 0.5)).toBe(2);
  });

  it("floors to 0 (⇒ skip) at a fully-throttled multiplier of 0", () => {
    expect(computeEffectiveMaxBatches(4, 0)).toBe(0);
  });

  it("clamps to 0 rather than going negative for a pathological negative multiplier", () => {
    expect(computeEffectiveMaxBatches(4, -1)).toBe(0);
  });

  it("floors a fractional result rather than rounding", () => {
    expect(computeEffectiveMaxBatches(3, 0.9)).toBe(2); // 2.7 -> 2, not 3
  });
});

// `runReviewHarvestIfDue`'s throttle-scaling gate math (deep-scrape build
// Stage 4, §0.4: "appsPerTick × multiplier, floor 1") — same pattern as
// `computeEffectiveMaxBatches` above, but with a DIFFERENT floor: a
// fully-throttled pass still harvests at least 1 app/tick rather than
// skipping entirely, unless the configured `appsPerTick` is itself 0 (the
// explicit "pass disabled" knob).
describe("computeEffectiveAppsPerTick", () => {
  it("returns the configured value unchanged at full throttle (multiplier 1)", () => {
    expect(computeEffectiveAppsPerTick(3, 1)).toBe(3);
  });

  it("floors to 1 (never 0) at a fully-throttled multiplier of 0, given a positive appsPerTick", () => {
    expect(computeEffectiveAppsPerTick(3, 0)).toBe(1);
  });

  it("floors to 1 at a small multiplier that would otherwise round to 0", () => {
    expect(computeEffectiveAppsPerTick(3, 0.1)).toBe(1); // 0.3 -> floored to 0, then floored UP to 1
  });

  it("returns 0 when appsPerTick itself is configured to 0 (explicit disable), regardless of multiplier", () => {
    expect(computeEffectiveAppsPerTick(0, 1)).toBe(0);
  });

  it("clamps to 0 (not 1) for a pathological negative appsPerTick", () => {
    expect(computeEffectiveAppsPerTick(-1, 1)).toBe(0);
  });

  it("floors a fractional result rather than rounding, once above the floor", () => {
    expect(computeEffectiveAppsPerTick(10, 0.35)).toBe(3); // 3.5 -> 3, not 4
  });
});
