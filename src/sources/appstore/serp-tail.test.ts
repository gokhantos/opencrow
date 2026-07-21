import { describe, expect, it } from "bun:test";
import { buildSerpTail, rankFromTail } from "./serp-tail";
import type { TopApp } from "./keyword-types";

function app(overrides: Partial<TopApp> = {}): TopApp {
  return {
    id: "1",
    name: "Sample",
    reviews: 10,
    rating: 4.0,
    ageDays: 100,
    ratingsPerDay: 0.1,
    titleMatch: false,
    ...overrides,
  };
}

describe("buildSerpTail", () => {
  it("returns entries at position >= topN as {id, rank} pairs, 0-based on the full array", () => {
    const serp = [
      app({ id: "a" }),
      app({ id: "b" }),
      app({ id: "c" }),
      app({ id: "d" }),
      app({ id: "e" }),
    ];
    const tail = buildSerpTail(serp, 2);
    expect(tail).toEqual([
      { id: "c", rank: 2 },
      { id: "d", rank: 3 },
      { id: "e", rank: 4 },
    ]);
  });

  it("returns [] when the fetch has topN or fewer entries (no tail)", () => {
    const serp = [app({ id: "a" }), app({ id: "b" })];
    expect(buildSerpTail(serp, 2)).toEqual([]);
    expect(buildSerpTail(serp, 20)).toEqual([]);
  });

  it("returns [] for an empty SERP", () => {
    expect(buildSerpTail([], 20)).toEqual([]);
  });

  it("drops tail entries with an empty id — nothing to key a rank lookup on", () => {
    const serp = [app({ id: "a" }), app({ id: "b" }), app({ id: "" }), app({ id: "d" })];
    const tail = buildSerpTail(serp, 1);
    expect(tail).toEqual([
      { id: "b", rank: 1 },
      { id: "d", rank: 3 },
    ]);
  });

  it("preserves rank as the FULL-array index, not a tail-relative offset", () => {
    const serp = Array.from({ length: 30 }, (_, i) => app({ id: `id-${i}` }));
    const tail = buildSerpTail(serp, 20);
    expect(tail.length).toBe(10);
    expect(tail[0]).toEqual({ id: "id-20", rank: 20 });
    expect(tail[9]).toEqual({ id: "id-29", rank: 29 });
  });
});

describe("rankFromTail", () => {
  const tail = [
    { id: "a", rank: 20 },
    { id: "b", rank: 21 },
  ];

  it("returns the rank for a present id", () => {
    expect(rankFromTail(tail, "a")).toBe(20);
    expect(rankFromTail(tail, "b")).toBe(21);
  });

  it("returns undefined for an id not in the tail", () => {
    expect(rankFromTail(tail, "missing")).toBeUndefined();
  });

  it("returns undefined for an empty tail", () => {
    expect(rankFromTail([], "a")).toBeUndefined();
  });
});
