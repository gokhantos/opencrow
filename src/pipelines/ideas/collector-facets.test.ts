import { describe, expect, it } from "bun:test";
import {
  formatFacetAggregate,
  REVIEW_FACET_KINDS,
  CAPABILITY_FACET_KINDS,
  LANDSCAPE_FACET_KINDS,
} from "./collector-facets";

// formatFacetAggregate is pure: no DB, no network. We test it directly by
// passing aggregate shapes (the internal FacetAggregate is structurally the
// argument shape the function consumes).

const makeAggregate = (overrides: Record<string, unknown> = {}) => ({
  total: 0,
  problemTypes: [],
  targetAudiences: [],
  jtbd: [],
  sentiments: [],
  ...overrides,
});

describe("formatFacetAggregate", () => {
  it("returns empty string when there are zero facets", () => {
    const out = formatFacetAggregate("HEADING", makeAggregate());
    expect(out).toBe("");
  });

  it("returns empty string when total > 0 but every dimension is empty", () => {
    const out = formatFacetAggregate("HEADING", makeAggregate({ total: 5 }));
    expect(out).toBe("");
  });

  it("renders the heading with the total count", () => {
    const out = formatFacetAggregate(
      "REVIEWS",
      makeAggregate({
        total: 12,
        problemTypes: [{ value: "sync", count: 7 }],
      }),
    );
    expect(out).toContain("=== REVIEWS (structured facets over 12 signals) ===");
  });

  it("renders each dimension only when it has values", () => {
    const out = formatFacetAggregate(
      "X",
      makeAggregate({
        total: 9,
        problemTypes: [{ value: "latency", count: 4 }],
        sentiments: [{ value: "negative", count: 6 }],
      }),
    );
    expect(out).toContain("Problem types: latency (4)");
    expect(out).toContain("Sentiment mix: negative (6)");
    expect(out).not.toContain("Target audiences");
    expect(out).not.toContain("Jobs-to-be-done");
  });

  it("formats multiple values as a comma-separated value (count) list", () => {
    const out = formatFacetAggregate(
      "X",
      makeAggregate({
        total: 10,
        targetAudiences: [
          { value: "developers", count: 5 },
          { value: "designers", count: 3 },
        ],
      }),
    );
    expect(out).toContain("Target audiences: developers (5), designers (3)");
  });
});

describe("facet kind groupings", () => {
  it("review kinds cover both stores' reviews", () => {
    expect(REVIEW_FACET_KINDS).toContain("appstore_review");
    expect(REVIEW_FACET_KINDS).toContain("playstore_review");
  });

  it("capability kinds cover the tech/behavior sources", () => {
    expect(CAPABILITY_FACET_KINDS).toContain("producthunt_product");
    expect(CAPABILITY_FACET_KINDS).toContain("github_repo");
    expect(CAPABILITY_FACET_KINDS).toContain("hackernews_story");
  });

  it("landscape kinds cover apps and reviews", () => {
    expect(LANDSCAPE_FACET_KINDS).toContain("appstore_app");
    expect(LANDSCAPE_FACET_KINDS).toContain("playstore_app");
  });
});
