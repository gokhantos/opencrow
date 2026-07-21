import { describe, expect, it } from "bun:test";
import {
  applyMemoryIndexingPolicy,
  computeNextDueAt,
  DAILY_INTERVAL_SECONDS,
  isHarvestDue,
  resolveCohort,
  shouldDeactivateEnrollment,
  shouldStopPaging,
  WEEKLY_INTERVAL_SECONDS,
} from "./review-harvest-scheduling";
import type { AppReviewRow } from "./store";

describe("resolveCohort (cohort assignment — daily wins)", () => {
  it("resolves to daily for signature-hit alone", () => {
    expect(resolveCohort(["signature-hit"])).toBe("daily");
  });

  it("resolves to daily for velocity alone", () => {
    expect(resolveCohort(["velocity"])).toBe("daily");
  });

  it("resolves to weekly for chart-newborn alone", () => {
    expect(resolveCohort(["chart-newborn"])).toBe("weekly");
  });

  it("daily wins when chart-newborn is matched alongside a daily reason", () => {
    expect(resolveCohort(["chart-newborn", "velocity"])).toBe("daily");
    expect(resolveCohort(["signature-hit", "chart-newborn"])).toBe("daily");
  });

  it("defaults to weekly for an empty reason set (defensive)", () => {
    expect(resolveCohort([])).toBe("weekly");
  });
});

describe("computeNextDueAt / isHarvestDue", () => {
  it("is due immediately (null next-due) when never harvested", () => {
    expect(computeNextDueAt("daily", null)).toBeNull();
    expect(isHarvestDue("daily", null, 1_000)).toBe(true);
  });

  it("daily cohort is due exactly DAILY_INTERVAL_SECONDS after the last harvest", () => {
    const last = 1_000_000;
    expect(computeNextDueAt("daily", last)).toBe(last + DAILY_INTERVAL_SECONDS);
    expect(isHarvestDue("daily", last, last + DAILY_INTERVAL_SECONDS - 1)).toBe(false);
    expect(isHarvestDue("daily", last, last + DAILY_INTERVAL_SECONDS)).toBe(true);
  });

  it("weekly cohort is due exactly WEEKLY_INTERVAL_SECONDS after the last harvest", () => {
    const last = 1_000_000;
    expect(computeNextDueAt("weekly", last)).toBe(last + WEEKLY_INTERVAL_SECONDS);
    expect(isHarvestDue("weekly", last, last + WEEKLY_INTERVAL_SECONDS - 1)).toBe(false);
    expect(isHarvestDue("weekly", last, last + WEEKLY_INTERVAL_SECONDS)).toBe(true);
  });
});

describe("shouldStopPaging", () => {
  it("stops at MAX_REVIEW_PAGES (page 10) regardless of content", () => {
    expect(
      shouldStopPaging({ page: 10, entriesReturned: 50, allEntriesAlreadyKnown: false, isFirstHarvestForApp: true }),
    ).toBe(true);
  });

  it("stops on an empty page", () => {
    expect(
      shouldStopPaging({ page: 3, entriesReturned: 0, allEntriesAlreadyKnown: false, isFirstHarvestForApp: true }),
    ).toBe(true);
  });

  it("stops on a short (< page size) page — no padding, so it's the last page", () => {
    expect(
      shouldStopPaging({ page: 4, entriesReturned: 12, allEntriesAlreadyKnown: false, isFirstHarvestForApp: true }),
    ).toBe(true);
  });

  it("continues on a full, not-fully-known page short of the page cap", () => {
    expect(
      shouldStopPaging({ page: 2, entriesReturned: 50, allEntriesAlreadyKnown: false, isFirstHarvestForApp: true }),
    ).toBe(false);
  });

  it("first-harvest legacy-remnant rule: does NOT early-stop on a fully-known page during an app's FIRST harvest", () => {
    expect(
      shouldStopPaging({ page: 1, entriesReturned: 50, allEntriesAlreadyKnown: true, isFirstHarvestForApp: true }),
    ).toBe(false);
  });

  it("a LATER harvest DOES early-stop on a fully-known page (caught up to previously-harvested content)", () => {
    expect(
      shouldStopPaging({ page: 2, entriesReturned: 50, allEntriesAlreadyKnown: true, isFirstHarvestForApp: false }),
    ).toBe(true);
  });
});

describe("shouldDeactivateEnrollment", () => {
  it("deactivates immediately on delisted, regardless of the empty-harvest streak", () => {
    expect(
      shouldDeactivateEnrollment({ consecutiveEmptyHarvests: 0, maxConsecutiveEmptyHarvests: 5, delisted: true }),
    ).toBe(true);
  });

  it("deactivates once the empty-harvest streak reaches the max", () => {
    expect(
      shouldDeactivateEnrollment({ consecutiveEmptyHarvests: 5, maxConsecutiveEmptyHarvests: 5, delisted: false }),
    ).toBe(true);
    expect(
      shouldDeactivateEnrollment({ consecutiveEmptyHarvests: 4, maxConsecutiveEmptyHarvests: 5, delisted: false }),
    ).toBe(false);
  });
});

function reviewRow(overrides: Partial<AppReviewRow> = {}): AppReviewRow {
  return {
    id: "1",
    app_id: "app-1",
    app_name: "Test App",
    author: "Someone",
    rating: 5,
    title: "t",
    content: "c",
    version: "1.0",
    first_seen_at: 1_000,
    indexed_at: null,
    ...overrides,
  };
}

describe("applyMemoryIndexingPolicy", () => {
  it("'all' is a no-op passthrough", () => {
    const rows = [reviewRow({ rating: 5 }), reviewRow({ id: "2", rating: 1 })];
    expect(applyMemoryIndexingPolicy(rows, "all", 5_000)).toEqual(rows);
  });

  it("'low-star-only' pre-marks indexed_at for rating >= 4, leaves lower ratings untouched", () => {
    const rows = [
      reviewRow({ id: "5star", rating: 5 }),
      reviewRow({ id: "4star", rating: 4 }),
      reviewRow({ id: "3star", rating: 3 }),
      reviewRow({ id: "1star", rating: 1 }),
    ];
    const result = applyMemoryIndexingPolicy(rows, "low-star-only", 5_000);
    expect(result.find((r) => r.id === "5star")?.indexed_at).toBe(5_000);
    expect(result.find((r) => r.id === "4star")?.indexed_at).toBe(5_000);
    expect(result.find((r) => r.id === "3star")?.indexed_at).toBeNull();
    expect(result.find((r) => r.id === "1star")?.indexed_at).toBeNull();
  });

  it("does not mutate the input array", () => {
    const row = reviewRow({ rating: 5 });
    const rows = [row];
    const original: AppReviewRow = { ...row };
    applyMemoryIndexingPolicy(rows, "low-star-only", 5_000);
    expect(rows[0]).toEqual(original);
  });
});
