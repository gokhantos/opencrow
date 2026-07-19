import { describe, expect, it } from "bun:test";
import {
  computeAcceleration,
  isNewborn,
  isObservationDue,
  MIN_RECENT_WINDOW_HOURS,
  NEWBORN_AGE_DAYS_MAX,
  VELOCITY_BUCKET_MS,
} from "./app-velocity";
import type { VelocityPoint } from "./app-velocity";

describe("isNewborn", () => {
  it("is true for an app younger than NEWBORN_AGE_DAYS_MAX", () => {
    expect(isNewborn(0)).toBe(true);
    expect(isNewborn(NEWBORN_AGE_DAYS_MAX - 1)).toBe(true);
  });

  it("is false at or above NEWBORN_AGE_DAYS_MAX", () => {
    expect(isNewborn(NEWBORN_AGE_DAYS_MAX)).toBe(false);
    expect(isNewborn(NEWBORN_AGE_DAYS_MAX + 100)).toBe(false);
  });
});

describe("isObservationDue", () => {
  const now = 1_000_000;

  it("is true when the app has never been observed", () => {
    expect(isObservationDue(null, now)).toBe(true);
  });

  it("is false when the last observation is still within the bucket", () => {
    const lastObservedAt = now - VELOCITY_BUCKET_MS / 1000 / 2;
    expect(isObservationDue(lastObservedAt, now)).toBe(false);
  });

  it("is true exactly at the bucket boundary", () => {
    const lastObservedAt = now - VELOCITY_BUCKET_MS / 1000;
    expect(isObservationDue(lastObservedAt, now)).toBe(true);
  });

  it("is true once the bucket has fully elapsed", () => {
    const lastObservedAt = now - VELOCITY_BUCKET_MS / 1000 - 1;
    expect(isObservationDue(lastObservedAt, now)).toBe(true);
  });
});

describe("computeAcceleration", () => {
  const HOUR = 3600;
  const DAY = 24 * HOUR;

  function point(observedAt: number, reviews: number): VelocityPoint {
    return { observedAt, reviews };
  }

  it("returns all-null for fewer than 2 points", () => {
    expect(computeAcceleration([])).toEqual({
      recentVelocity: null,
      overallVelocity: null,
      acceleration: null,
    });
    expect(computeAcceleration([point(0, 10)])).toEqual({
      recentVelocity: null,
      overallVelocity: null,
      acceleration: null,
    });
  });

  it("computes recent/overall velocity and their ratio from 3 points (newest-first)", () => {
    // earliest: 5 days ago, 100 reviews
    // second-latest: 1 day ago, 150 reviews (overall: 50 reviews / 4 days = 12.5/day)
    // latest: now, 500 reviews (recent: 350 reviews / 1 day = 350/day)
    const now = 10 * DAY;
    const points = [point(now, 500), point(now - DAY, 150), point(now - 5 * DAY, 100)];
    const result = computeAcceleration(points);
    expect(result.recentVelocity).toBeCloseTo(350, 5);
    expect(result.overallVelocity).toBeCloseTo(400 / 5, 5); // (500-100)/5 days = 80/day
    expect(result.acceleration).toBeCloseTo(350 / 80, 5);
  });

  it("accepts a full time-ordered series, using only the first two and the last", () => {
    const now = 10 * DAY;
    const points = [
      point(now, 500),
      point(now - HOUR, 480), // ignored — not used by the two-point/earliest logic beyond index 1
      point(now - DAY, 150),
      point(now - 5 * DAY, 100),
    ];
    // Recent velocity is computed from points[0] and points[1] specifically
    // (the "two most recent" contract), NOT points[0] and points[2].
    const result = computeAcceleration(points);
    const expectedRecentGapHours = 1; // now vs now-HOUR
    expect(expectedRecentGapHours).toBeLessThan(MIN_RECENT_WINDOW_HOURS);
    // Gap under MIN_RECENT_WINDOW_HOURS -> recentVelocity is null.
    expect(result.recentVelocity).toBeNull();
  });

  it("recentVelocity is null when the two most-recent points are under MIN_RECENT_WINDOW_HOURS apart", () => {
    const now = 10 * DAY;
    const points = [point(now, 200), point(now - HOUR, 190), point(now - 5 * DAY, 100)];
    const result = computeAcceleration(points);
    expect(result.recentVelocity).toBeNull();
    // Overall velocity is still computable from earliest/latest.
    expect(result.overallVelocity).not.toBeNull();
    // acceleration requires both sides — null when recentVelocity is null.
    expect(result.acceleration).toBeNull();
  });

  it("overallVelocity is null when latest and earliest share the same timestamp", () => {
    const now = 10 * DAY;
    const points = [point(now, 200), point(now - DAY, 100), point(now, 50)];
    // earliest === latest timestamp here (both `now`) -> span is 0.
    const result = computeAcceleration(points);
    expect(result.overallVelocity).toBeNull();
    expect(result.acceleration).toBeNull();
  });

  it("clamps a review-count decrease to a non-negative velocity (never negative)", () => {
    const now = 10 * DAY;
    // Reviews going DOWN (e.g. a data correction) must not produce a negative velocity.
    const points = [point(now, 50), point(now - DAY, 100), point(now - 5 * DAY, 200)];
    const result = computeAcceleration(points);
    expect(result.recentVelocity).toBe(0);
    expect(result.overallVelocity).toBe(0);
    expect(result.acceleration).toBeNull(); // overallVelocity is 0, not > 0
  });

  it("acceleration is null when overallVelocity is exactly 0 (no established baseline to compare against)", () => {
    const now = 10 * DAY;
    const points = [point(now, 100), point(now - DAY, 100), point(now - 5 * DAY, 100)];
    const result = computeAcceleration(points);
    expect(result.recentVelocity).toBe(0);
    expect(result.overallVelocity).toBe(0);
    expect(result.acceleration).toBeNull();
  });
});
