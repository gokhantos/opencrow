import { test, expect, describe } from "bun:test";
import {
  sourceCredibility,
  authorityPrior,
  engagementPercentile,
  engagementLogScale,
  engagementFactor,
  AUTHORITY_PRIORS,
  UNKNOWN_SOURCE_PRIOR,
  DEFAULT_LOG_SATURATION,
} from "./source-credibility";

describe("authorityPrior — prior lookup", () => {
  test("returns the bare-source prior when no sub-source given", () => {
    const { prior, key } = authorityPrior("hackernews");
    expect(prior).toBe(AUTHORITY_PRIORS["hackernews"]!);
    expect(key).toBe("hackernews");
  });

  test("falls back to bare source when sub-source is unknown", () => {
    const { prior, key } = authorityPrior("hackernews", "no-such-sub");
    expect(prior).toBe(AUTHORITY_PRIORS["hackernews"]!);
    expect(key).toBe("hackernews");
  });

  test("returns UNKNOWN prior for a fully unknown source", () => {
    const { prior, key } = authorityPrior("mystery-blog");
    expect(prior).toBe(UNKNOWN_SOURCE_PRIOR);
    expect(key).toBe("unknown");
  });

  test("is case- and whitespace-insensitive", () => {
    const a = authorityPrior("  HackerNews  ", "  Front-Page ");
    expect(a.key).toBe("hackernews/front-page");
    expect(a.prior).toBe(AUTHORITY_PRIORS["hackernews/front-page"]!);
  });
});

describe("authorityPrior — sub-source granularity ordering", () => {
  test("ycombinator/funding outranks hackernews front-page", () => {
    expect(authorityPrior("ycombinator", "funding").prior).toBeGreaterThan(
      authorityPrior("hackernews", "front-page").prior,
    );
  });

  test("HN front-page outranks a top github repo", () => {
    expect(authorityPrior("hackernews", "front-page").prior).toBeGreaterThan(
      authorityPrior("github", "top").prior,
    );
  });

  test("a top github repo outranks a generic subreddit", () => {
    expect(authorityPrior("github", "top").prior).toBeGreaterThan(
      authorityPrior("reddit", "generic").prior,
    );
  });

  test("reputable news domain outranks generic news outranks blog", () => {
    const reuters = authorityPrior("news", "reuters").prior;
    const generic = authorityPrior("news", "generic").prior;
    const blog = authorityPrior("news", "blog").prior;
    expect(reuters).toBeGreaterThan(generic);
    expect(generic).toBeGreaterThan(blog);
  });

  test("granular sub-source key beats the bare-source default", () => {
    const granular = authorityPrior("hackernews", "front-page").prior;
    const bare = authorityPrior("hackernews").prior;
    expect(granular).not.toBe(bare);
    expect(granular).toBe(AUTHORITY_PRIORS["hackernews/front-page"]!);
  });

  test("all priors are within [0, 1]", () => {
    for (const value of Object.values(AUTHORITY_PRIORS)) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });
});

describe("engagementPercentile", () => {
  const dist = [0, 10, 20, 30, 40];

  test("empty distribution yields neutral 0.5", () => {
    expect(engagementPercentile(100, [])).toBe(0.5);
  });

  test("max value covers the whole distribution", () => {
    expect(engagementPercentile(40, dist)).toBe(1);
  });

  test("below-minimum value still covers values it meets or exceeds", () => {
    // metric 0 meets/exceeds only the single 0 → 1/5
    expect(engagementPercentile(0, dist)).toBeCloseTo(0.2, 6);
  });

  test("middle value covers the lower half", () => {
    // metric 20 >= {0,10,20} → 3/5
    expect(engagementPercentile(20, dist)).toBeCloseTo(0.6, 6);
  });

  test("is monotonic non-decreasing in the metric", () => {
    let prev = -1;
    for (const m of [-5, 0, 5, 15, 25, 35, 50]) {
      const p = engagementPercentile(m, dist);
      expect(p).toBeGreaterThanOrEqual(prev);
      prev = p;
    }
  });

  test("negative metric is clamped to 0", () => {
    expect(engagementPercentile(-100, dist)).toBe(
      engagementPercentile(0, dist),
    );
  });
});

describe("engagementLogScale", () => {
  test("zero metric yields 0", () => {
    expect(engagementLogScale(0)).toBe(0);
  });

  test("metric at saturation yields 1", () => {
    expect(engagementLogScale(DEFAULT_LOG_SATURATION)).toBeCloseTo(1, 6);
  });

  test("is sub-linear: 10x metric is less than 10x factor", () => {
    const f1 = engagementLogScale(10);
    const f10 = engagementLogScale(100);
    expect(f10).toBeGreaterThan(f1);
    expect(f10).toBeLessThan(f1 * 10);
  });

  test("monotonic non-decreasing in metric", () => {
    let prev = -1;
    for (const m of [0, 1, 10, 100, 1000, 10000]) {
      const f = engagementLogScale(m);
      expect(f).toBeGreaterThanOrEqual(prev);
      prev = f;
    }
  });

  test("respects a custom saturation point", () => {
    expect(engagementLogScale(50, 50)).toBeCloseTo(1, 6);
    expect(engagementLogScale(50, 50)).toBeGreaterThan(
      engagementLogScale(50, 1000),
    );
  });

  test("clamps output to <= 1 above saturation", () => {
    expect(engagementLogScale(100000, 100)).toBe(1);
  });

  test("negative metric clamped to 0", () => {
    expect(engagementLogScale(-50)).toBe(0);
  });
});

describe("engagementFactor — distribution vs log-scale dispatch", () => {
  test("uses percentile when a distribution is provided", () => {
    const f = engagementFactor({ metric: 20, distribution: [0, 10, 20, 30, 40] });
    expect(f).toBeCloseTo(0.6, 6);
  });

  test("falls back to log-scale with empty distribution", () => {
    const f = engagementFactor({ metric: 10, distribution: [] });
    expect(f).toBeCloseTo(engagementLogScale(10), 6);
  });

  test("falls back to log-scale when distribution omitted", () => {
    const f = engagementFactor({ metric: 100 });
    expect(f).toBeCloseTo(engagementLogScale(100), 6);
  });
});

describe("sourceCredibility — combined weight", () => {
  test("weight equals prior when engagement omitted", () => {
    const r = sourceCredibility("hackernews", "front-page");
    expect(r.engagementFactor).toBe(1);
    expect(r.weight).toBeCloseTo(r.authorityPrior, 6);
    expect(r.priorKey).toBe("hackernews/front-page");
  });

  test("weight = prior × engagementFactor", () => {
    const r = sourceCredibility("github", "top", {
      metric: 20,
      distribution: [0, 10, 20, 30, 40],
    });
    const expectedPrior = AUTHORITY_PRIORS["github/top"]!;
    expect(r.authorityPrior).toBe(expectedPrior);
    expect(r.engagementFactor).toBeCloseTo(0.6, 6);
    expect(r.weight).toBeCloseTo(expectedPrior * 0.6, 6);
  });

  test("weight always within [0, 1]", () => {
    const r = sourceCredibility("ycombinator", "funding", {
      metric: 1_000_000,
    });
    expect(r.weight).toBeGreaterThanOrEqual(0);
    expect(r.weight).toBeLessThanOrEqual(1);
  });

  test("unknown source uses UNKNOWN prior", () => {
    const r = sourceCredibility("totally-unknown");
    expect(r.authorityPrior).toBe(UNKNOWN_SOURCE_PRIOR);
    expect(r.priorKey).toBe("unknown");
  });

  test("higher-authority source beats lower-authority at equal engagement", () => {
    const eng = { metric: 50 } as const;
    const yc = sourceCredibility("ycombinator", "funding", eng).weight;
    const generic = sourceCredibility("reddit", "generic", eng).weight;
    expect(yc).toBeGreaterThan(generic);
  });

  test("never throws and returns finite weight for odd input", () => {
    const r = sourceCredibility("", undefined, { metric: Number.NaN });
    expect(Number.isFinite(r.weight)).toBe(true);
    expect(r.weight).toBeGreaterThanOrEqual(0);
  });
});
