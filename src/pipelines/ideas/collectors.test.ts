import { test, expect, describe } from "bun:test";
import {
  buildChatOptions,
  excludeConsumed,
  selectRanked,
  normalizeVelocities,
  recencyFactor,
  computeRankScore,
  clamp01,
  toNumber,
  parseJsonArray,
  parseMakers,
  parseTopics,
  parseTopComments,
} from "./collectors";

interface Row {
  readonly id: string;
  readonly title: string;
}

const id = (r: Row) => r.id;

// ── buildChatOptions (collector provider routing) ───────────────────────────
//
// Regression: collectors used to hardcode the provider, so a non-Anthropic
// routed generator (e.g. alibaba/deepseek-v4-flash) sent a deepseek model to
// the wrong provider. The local helper must now honor a routed provider while
// defaulting to the collectors' historical "agent-sdk" when none is supplied.

describe("buildChatOptions (collectors)", () => {
  test("defaults provider to agent-sdk when none is supplied", () => {
    const opts = buildChatOptions("claude-sonnet-4-6");
    expect(opts.provider).toBe("agent-sdk");
    expect(opts.model).toBe("claude-sonnet-4-6");
  });

  test("honors a routed non-anthropic provider", () => {
    const opts = buildChatOptions("deepseek-v4-flash", "alibaba");
    expect(opts.provider).toBe("alibaba");
    expect(opts.model).toBe("deepseek-v4-flash");
  });

  test("threads any supported provider through unchanged", () => {
    expect(buildChatOptions("x/y", "openrouter").provider).toBe("openrouter");
    expect(buildChatOptions("c", "anthropic").provider).toBe("anthropic");
  });
});

// ── excludeConsumed (consumed-source dedup) ────────────────────────────────

describe("excludeConsumed", () => {
  test("returns all rows when nothing has been consumed", () => {
    const rows: Row[] = [
      { id: "a", title: "A" },
      { id: "b", title: "B" },
    ];
    const result = excludeConsumed(rows, new Set<string>(), id, 10);
    expect(result.selected).toEqual(rows);
    expect(result.selectedIds).toEqual(["a", "b"]);
  });

  test("filters out already-consumed rows", () => {
    const rows: Row[] = [
      { id: "a", title: "A" },
      { id: "b", title: "B" },
      { id: "c", title: "C" },
    ];
    const consumed = new Set(["b"]);
    const result = excludeConsumed(rows, consumed, id, 10);
    expect(result.selectedIds).toEqual(["a", "c"]);
    expect(result.selected.map((r) => r.id)).toEqual(["a", "c"]);
  });

  test("caps the result at the target count", () => {
    const rows: Row[] = [
      { id: "a", title: "A" },
      { id: "b", title: "B" },
      { id: "c", title: "C" },
      { id: "d", title: "D" },
    ];
    const result = excludeConsumed(rows, new Set<string>(), id, 2);
    expect(result.selected).toHaveLength(2);
    expect(result.selectedIds).toEqual(["a", "b"]);
  });

  test("returns empty when every fresh row is consumed", () => {
    const rows: Row[] = [
      { id: "a", title: "A" },
      { id: "b", title: "B" },
    ];
    const consumed = new Set(["a", "b"]);
    const result = excludeConsumed(rows, consumed, id, 10);
    expect(result.selected).toEqual([]);
    expect(result.selectedIds).toEqual([]);
  });

  test("applies the consumed filter before the target cap", () => {
    const rows: Row[] = [
      { id: "a", title: "A" }, // consumed
      { id: "b", title: "B" },
      { id: "c", title: "C" },
      { id: "d", title: "D" },
    ];
    const consumed = new Set(["a"]);
    // After excluding 'a', the first 2 fresh rows are b and c.
    const result = excludeConsumed(rows, consumed, id, 2);
    expect(result.selectedIds).toEqual(["b", "c"]);
  });

  test("preserves input order and does not mutate the source array", () => {
    const rows: Row[] = [
      { id: "c", title: "C" },
      { id: "a", title: "A" },
      { id: "b", title: "B" },
    ];
    const snapshot = [...rows];
    const result = excludeConsumed(rows, new Set<string>(), id, 10);
    expect(result.selectedIds).toEqual(["c", "a", "b"]);
    expect(rows).toEqual(snapshot);
  });

  test("handles an empty input array", () => {
    const result = excludeConsumed<Row>([], new Set<string>(), id, 5);
    expect(result.selected).toEqual([]);
    expect(result.selectedIds).toEqual([]);
  });

  test("supports a custom id extractor", () => {
    const rows = [
      { uuid: "x1" },
      { uuid: "x2" },
    ];
    const result = excludeConsumed(rows, new Set(["x1"]), (r) => r.uuid, 10);
    expect(result.selectedIds).toEqual(["x2"]);
  });
});

// ── clamp01 / toNumber ──────────────────────────────────────────────────────

describe("clamp01", () => {
  test("clamps below 0, above 1, and passes through mid-range", () => {
    expect(clamp01(-3)).toBe(0);
    expect(clamp01(2)).toBe(1);
    expect(clamp01(0.42)).toBeCloseTo(0.42);
  });
  test("NaN maps to 0", () => {
    expect(clamp01(Number.NaN)).toBe(0);
  });
});

describe("toNumber", () => {
  test("coerces numeric strings and falls back on garbage", () => {
    expect(toNumber("42")).toBe(42);
    expect(toNumber(7)).toBe(7);
    expect(toNumber("nope")).toBe(0);
    expect(toNumber(null, 5)).toBe(5);
    expect(toNumber(undefined, 9)).toBe(9);
  });
});

// ── normalizeVelocities ─────────────────────────────────────────────────────

describe("normalizeVelocities", () => {
  test("min-max normalizes against the batch max", () => {
    const out = normalizeVelocities([
      { id: "a", velocity: 0 },
      { id: "b", velocity: 50 },
      { id: "c", velocity: 100 },
    ]);
    expect(out.get("a")).toBe(0);
    expect(out.get("b")).toBeCloseTo(0.5);
    expect(out.get("c")).toBe(1);
  });

  test("negative velocities clamp to 0", () => {
    const out = normalizeVelocities([
      { id: "a", velocity: -10 },
      { id: "b", velocity: 20 },
    ]);
    expect(out.get("a")).toBe(0);
    expect(out.get("b")).toBe(1);
  });

  test("a flat (all-zero) batch yields 0 for every row", () => {
    const out = normalizeVelocities([
      { id: "a", velocity: 0 },
      { id: "b", velocity: 0 },
    ]);
    expect(out.get("a")).toBe(0);
    expect(out.get("b")).toBe(0);
  });

  test("empty input yields an empty map", () => {
    expect(normalizeVelocities([]).size).toBe(0);
  });
});

// ── recencyFactor ───────────────────────────────────────────────────────────

describe("recencyFactor", () => {
  const now = 1_000_000_000;

  test("a just-scraped item is ~1.0", () => {
    expect(recencyFactor(now, now)).toBeCloseTo(1, 5);
  });

  test("one half-life ago is ~0.5", () => {
    const oneWeekAgo = now - 7 * 86_400;
    expect(recencyFactor(oneWeekAgo, now, 7)).toBeCloseTo(0.5, 5);
  });

  test("missing/zero timestamps map to neutral 0.5", () => {
    expect(recencyFactor(0, now)).toBe(0.5);
    expect(recencyFactor(null, now)).toBe(0.5);
    expect(recencyFactor(undefined, now)).toBe(0.5);
  });

  test("future timestamps never exceed 1", () => {
    expect(recencyFactor(now + 86_400, now)).toBeLessThanOrEqual(1);
  });
});

// ── computeRankScore ────────────────────────────────────────────────────────

describe("computeRankScore", () => {
  const noJitter = () => 0;

  test("higher credibility yields a higher score", () => {
    const lo = computeRankScore({ credibility: 0.2 }, noJitter);
    const hi = computeRankScore({ credibility: 0.9 }, noJitter);
    expect(hi).toBeGreaterThan(lo);
  });

  test("velocity and corroboration both boost the score", () => {
    const base = computeRankScore({ credibility: 0.5 }, noJitter);
    const withVel = computeRankScore({ credibility: 0.5, velocityNorm: 1 }, noJitter);
    const withCorro = computeRankScore({ credibility: 0.5, corroborationCount: 4 }, noJitter);
    expect(withVel).toBeGreaterThan(base);
    expect(withCorro).toBeGreaterThan(base);
  });

  test("corroboration is log-scaled (3rd source < 2nd source delta)", () => {
    const one = computeRankScore({ corroborationCount: 1 }, noJitter);
    const two = computeRankScore({ corroborationCount: 2 }, noJitter);
    const four = computeRankScore({ corroborationCount: 4 }, noJitter);
    expect(two - one).toBeGreaterThanOrEqual(four - two);
  });

  test("exploration jitter is bounded by the exploration weight", () => {
    const withoutJitter = computeRankScore({ credibility: 0.5 }, () => 0, 0.15);
    const withFullJitter = computeRankScore({ credibility: 0.5 }, () => 1, 0.15);
    expect(withFullJitter - withoutJitter).toBeCloseTo(0.15, 5);
  });

  test("a perfect signal stays bounded (~<= 1 + jitter)", () => {
    const s = computeRankScore(
      { credibility: 1, velocityNorm: 1, corroborationCount: 8, recency: 1 },
      noJitter,
    );
    expect(s).toBeGreaterThan(0.8);
    expect(s).toBeLessThanOrEqual(1.0001);
  });
});

// ── selectRanked ────────────────────────────────────────────────────────────

interface RankRow {
  readonly id: string;
  readonly s: number;
}

describe("selectRanked", () => {
  const rows: RankRow[] = [
    { id: "a", s: 0.1 },
    { id: "b", s: 0.9 },
    { id: "c", s: 0.5 },
    { id: "d", s: 0.7 },
  ];

  test("adaptive=true selects the highest-scoring rows in score order", () => {
    const out = selectRanked(rows, new Set(), (r) => r.id, 2, (r) => r.s, true);
    expect(out.selectedIds).toEqual(["b", "d"]);
  });

  test("adaptive=false preserves the legacy input order", () => {
    const out = selectRanked(rows, new Set(), (r) => r.id, 2, (r) => r.s, false);
    expect(out.selectedIds).toEqual(["a", "b"]);
  });

  test("excludes consumed rows before ranking", () => {
    const out = selectRanked(rows, new Set(["b"]), (r) => r.id, 2, (r) => r.s, true);
    expect(out.selectedIds).toEqual(["d", "c"]);
  });

  test("ties break deterministically by input order", () => {
    const tied: RankRow[] = [
      { id: "x", s: 0.5 },
      { id: "y", s: 0.5 },
    ];
    const out = selectRanked(tied, new Set(), (r) => r.id, 2, (r) => r.s, true);
    expect(out.selectedIds).toEqual(["x", "y"]);
  });
});

// ── JSON field promotion ────────────────────────────────────────────────────

describe("parseJsonArray", () => {
  test("parses a JSON array string", () => {
    expect(parseJsonArray('["a","b"]')).toEqual(["a", "b"]);
  });
  test("passes through real arrays", () => {
    expect(parseJsonArray([1, 2])).toEqual([1, 2]);
  });
  test("returns [] for null, empty, '[]', non-array, or malformed", () => {
    expect(parseJsonArray(null)).toEqual([]);
    expect(parseJsonArray("")).toEqual([]);
    expect(parseJsonArray("[]")).toEqual([]);
    expect(parseJsonArray('{"a":1}')).toEqual([]);
    expect(parseJsonArray("not json")).toEqual([]);
  });
});

describe("parseMakers", () => {
  test("extracts name + handle from objects", () => {
    const makers = parseMakers('[{"name":"Ada","username":"ada"},{"name":"Bob"}]');
    expect(makers).toEqual([{ name: "Ada", handle: "ada" }, { name: "Bob" }]);
  });
  test("skips entries with no name and caps at 5", () => {
    const raw = JSON.stringify([
      {}, { name: "1" }, { name: "2" }, { name: "3" }, { name: "4" }, { name: "5" }, { name: "6" },
    ]);
    expect(parseMakers(raw)).toHaveLength(5);
  });
  test("malformed input yields []", () => {
    expect(parseMakers("garbage")).toEqual([]);
  });
});

describe("parseTopics", () => {
  test("handles string arrays and object arrays", () => {
    expect(parseTopics('["AI","Dev Tools"]')).toEqual(["AI", "Dev Tools"]);
    expect(parseTopics('[{"name":"SaaS"}]')).toEqual(["SaaS"]);
  });
});

describe("parseTopComments", () => {
  test("extracts and trims comment text, respecting max", () => {
    const raw = JSON.stringify([
      { text: "  first comment  " },
      { body: "second" },
      "third",
      { content: "fourth" },
    ]);
    expect(parseTopComments(raw, 3)).toEqual(["first comment", "second", "third"]);
  });
  test("malformed input yields []", () => {
    expect(parseTopComments("nope")).toEqual([]);
  });
});
