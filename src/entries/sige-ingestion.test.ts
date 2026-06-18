/**
 * Unit tests for the computeCredibility heuristic exported from sige-ingestion.
 *
 * These are pure-function tests — no DB, no network, no side effects.
 */

import { describe, expect, it } from "bun:test";
import { computeCredibility } from "./sige-ingestion";

// ─── appstore_review ──────────────────────────────────────────────────────────

describe("computeCredibility — appstore_review", () => {
  it("returns 1.0 for a 1-star review (maximum signal)", () => {
    expect(computeCredibility({ source_type: "appstore_review", rating: 1 })).toBe(1.0);
  });

  it("returns 0.75 for a 2-star review", () => {
    expect(computeCredibility({ source_type: "appstore_review", rating: 2 })).toBe(0.75);
  });

  it("returns 0.5 for a 3-star review (floor — ingestion gate already filters to ≤2, but heuristic is still safe)", () => {
    expect(computeCredibility({ source_type: "appstore_review", rating: 3 })).toBe(0.5);
  });

  it("defaults to 0.5 when rating is absent", () => {
    expect(computeCredibility({ source_type: "appstore_review" })).toBe(0.5);
  });
});

// ─── playstore_review ─────────────────────────────────────────────────────────

describe("computeCredibility — playstore_review", () => {
  it("returns 1.0 for a 1-star review with no thumbs-up", () => {
    expect(computeCredibility({ source_type: "playstore_review", rating: 1, thumbs_up: 0 })).toBe(
      1.0,
    );
  });

  it("adds thumbs-up bonus: 100 upvotes on a 2-star review → 0.75 + 0.2 = 0.95", () => {
    expect(
      computeCredibility({ source_type: "playstore_review", rating: 2, thumbs_up: 100 }),
    ).toBeCloseTo(0.95);
  });

  it("clamps to 1.0 even when thumbs-up bonus would push a 1-star review above 1", () => {
    expect(
      computeCredibility({ source_type: "playstore_review", rating: 1, thumbs_up: 999 }),
    ).toBe(1.0);
  });

  it("low engagement 2-star review: only ratingScore contributes → 0.75", () => {
    expect(
      computeCredibility({ source_type: "playstore_review", rating: 2, thumbs_up: 0 }),
    ).toBe(0.75);
  });
});

// ─── reddit_post ──────────────────────────────────────────────────────────────

describe("computeCredibility — reddit_post", () => {
  it("returns the floor 0.15 for a zero-score, zero-comment post", () => {
    expect(
      computeCredibility({ source_type: "reddit_post", score: 0, num_comments: 0 }),
    ).toBe(0.15);
  });

  it("returns high credibility for viral post (500 score, 200 comments)", () => {
    // scoreComponent = 1.0 * 0.6 = 0.6; engagementComponent = 1.0 * 0.4 = 0.4 → 1.0
    expect(
      computeCredibility({ source_type: "reddit_post", score: 500, num_comments: 200 }),
    ).toBe(1.0);
  });

  it("medium post: score 250, comments 100 → 0.5", () => {
    // scoreComponent = 0.5 * 0.6 = 0.3; engagementComponent = 0.5 * 0.4 = 0.2 → 0.5
    expect(
      computeCredibility({ source_type: "reddit_post", score: 250, num_comments: 100 }),
    ).toBeCloseTo(0.5);
  });

  it("negative score falls back to the floor (0.15)", () => {
    expect(
      computeCredibility({ source_type: "reddit_post", score: -50, num_comments: 0 }),
    ).toBe(0.15);
  });
});

// ─── producthunt ─────────────────────────────────────────────────────────────

describe("computeCredibility — producthunt", () => {
  it("returns the floor 0.2 for a zero-vote product", () => {
    expect(computeCredibility({ source_type: "producthunt", points: 0 })).toBe(0.2);
  });

  it("returns 0.8 for a 500-vote product (soft cap)", () => {
    expect(computeCredibility({ source_type: "producthunt", points: 500 })).toBeCloseTo(0.8);
  });

  it("clamps to 1.0 for an exceptionally popular product (1000+ votes)", () => {
    expect(computeCredibility({ source_type: "producthunt", points: 1000 })).toBe(1.0);
  });
});

// ─── hackernews ───────────────────────────────────────────────────────────────

describe("computeCredibility — hackernews", () => {
  it("returns the floor 0.2 for a new story with no points", () => {
    expect(
      computeCredibility({ source_type: "hackernews", points: 0, num_comments: 0 }),
    ).toBe(0.2);
  });

  it("returns 1.0 for a top story (500 pts, 200 comments)", () => {
    // pointsComponent = 1.0 * 0.7 = 0.7; engagementComponent = 1.0 * 0.3 = 0.3 → 1.0
    expect(
      computeCredibility({ source_type: "hackernews", points: 500, num_comments: 200 }),
    ).toBe(1.0);
  });
});

// ─── news_article ─────────────────────────────────────────────────────────────

describe("computeCredibility — news_article", () => {
  it("always returns the fixed 0.6 regardless of inputs", () => {
    expect(computeCredibility({ source_type: "news_article" })).toBe(0.6);
  });
});

// ─── appstore_app ─────────────────────────────────────────────────────────────

describe("computeCredibility — appstore_app", () => {
  it("always returns 0.5", () => {
    expect(computeCredibility({ source_type: "appstore_app" })).toBe(0.5);
  });
});

// ─── playstore_app ────────────────────────────────────────────────────────────

describe("computeCredibility — playstore_app", () => {
  it("returns the floor 0.3 for an app with no install data", () => {
    expect(computeCredibility({ source_type: "playstore_app", installs: null })).toBe(0.3);
  });

  it("returns high credibility for a widely-installed, top-rated app", () => {
    // installsComponent = 1.0 * 0.8 = 0.8; ratingComponent = 1.0 * 0.2 = 0.2 → 1.0
    expect(
      computeCredibility({ source_type: "playstore_app", installs: "10,000,000+", rating: 5 }),
    ).toBe(1.0);
  });

  it("parses shorthand install counts and applies floor (1M+ installs, 4★ → below floor → 0.3)", () => {
    // installsComponent = (1_000_000/10_000_000)*0.8 = 0.08
    // ratingComponent   = (4/5)*0.2 = 0.16
    // raw = 0.24, floor = 0.3 → returns 0.3
    expect(
      computeCredibility({ source_type: "playstore_app", installs: "1,000,000+", rating: 4 }),
    ).toBeCloseTo(0.3);
  });

  it("correctly combines installs and rating for a mid-tier app", () => {
    // 5_000_000 / 10_000_000 * 0.8 = 0.4; 4/5 * 0.2 = 0.16 → 0.56
    const score = computeCredibility({
      source_type: "playstore_app",
      installs: "5,000,000+",
      rating: 4,
    });
    expect(score).toBeCloseTo(0.56);
  });
});

// ─── unknown source ───────────────────────────────────────────────────────────

describe("computeCredibility — unknown source type", () => {
  it("returns the conservative default 0.4", () => {
    expect(computeCredibility({ source_type: "mystery_source" })).toBe(0.4);
  });
});

// ─── output is always in [0, 1] ───────────────────────────────────────────────

describe("computeCredibility — output range invariant", () => {
  const edgeCases: Array<Parameters<typeof computeCredibility>[0]> = [
    { source_type: "appstore_review", rating: 0 },
    { source_type: "playstore_review", rating: 0, thumbs_up: 10_000 },
    { source_type: "reddit_post", score: -1_000, num_comments: -5 },
    { source_type: "producthunt", points: 100_000 },
    { source_type: "hackernews", points: 100_000, num_comments: 100_000 },
    { source_type: "playstore_app", installs: "invalid", rating: 10 },
  ];

  for (const inputs of edgeCases) {
    it(`stays in [0, 1] for ${JSON.stringify(inputs)}`, () => {
      const score = computeCredibility(inputs);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    });
  }
});
