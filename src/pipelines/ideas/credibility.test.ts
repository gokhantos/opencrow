import { test, expect, describe } from "bun:test";
import {
  betaPosteriorMean,
  betaPosteriorVariance,
  updatePosterior,
  thompsonSample,
  computeSourceCredibility,
  credibilityKey,
  rankBySourceCredibility,
  flattenFeedbackRows,
  PRIOR_ALPHA,
  PRIOR_BETA,
  type SourceOutcomeRow,
  type Rng,
} from "./credibility";

// ── Seeded RNG (mulberry32) for deterministic Thompson sampling ──────────────

function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic RNG that replays a fixed sequence (cycling). */
function fixedRng(values: readonly number[]): Rng {
  let i = 0;
  return () => {
    const v = values[i % values.length]!;
    i += 1;
    return v;
  };
}

// ── betaPosteriorMean ────────────────────────────────────────────────────────

describe("betaPosteriorMean", () => {
  test("uniform Beta(1,1) has mean 0.5", () => {
    expect(betaPosteriorMean(1, 1)).toBe(0.5);
  });

  test("mean = alpha / (alpha + beta)", () => {
    expect(betaPosteriorMean(3, 1)).toBeCloseTo(0.75, 10);
    expect(betaPosteriorMean(2, 8)).toBeCloseTo(0.2, 10);
  });

  test("more successes than failures pushes mean above 0.5", () => {
    expect(betaPosteriorMean(10, 2)).toBeGreaterThan(0.5);
  });

  test("throws on non-positive shape params", () => {
    expect(() => betaPosteriorMean(0, 1)).toThrow();
    expect(() => betaPosteriorMean(1, 0)).toThrow();
    expect(() => betaPosteriorMean(-1, 1)).toThrow();
  });
});

// ── betaPosteriorVariance ────────────────────────────────────────────────────

describe("betaPosteriorVariance", () => {
  test("Beta(1,1) variance is 1/12", () => {
    expect(betaPosteriorVariance(1, 1)).toBeCloseTo(1 / 12, 10);
  });

  test("variance shrinks as evidence accumulates", () => {
    const weak = betaPosteriorVariance(2, 2);
    const strong = betaPosteriorVariance(200, 200);
    expect(strong).toBeLessThan(weak);
  });

  test("throws on non-positive shape params", () => {
    expect(() => betaPosteriorVariance(0, 1)).toThrow();
  });
});

// ── updatePosterior (immutability + correctness) ─────────────────────────────

describe("updatePosterior", () => {
  test("success increments alpha only", () => {
    expect(updatePosterior({ alpha: 1, beta: 1 }, true)).toEqual({
      alpha: 2,
      beta: 1,
    });
  });

  test("failure increments beta only", () => {
    expect(updatePosterior({ alpha: 1, beta: 1 }, false)).toEqual({
      alpha: 1,
      beta: 2,
    });
  });

  test("does not mutate the input prior", () => {
    const prior = { alpha: 5, beta: 3 };
    const next = updatePosterior(prior, true);
    expect(prior).toEqual({ alpha: 5, beta: 3 });
    expect(next).not.toBe(prior);
  });

  test("sequential updates compose", () => {
    let p = { alpha: PRIOR_ALPHA, beta: PRIOR_BETA };
    p = updatePosterior(p, true);
    p = updatePosterior(p, true);
    p = updatePosterior(p, false);
    expect(p).toEqual({ alpha: 3, beta: 2 });
  });
});

// ── thompsonSample (determinism + bounds + behavior) ─────────────────────────

describe("thompsonSample", () => {
  test("always returns a value in [0, 1]", () => {
    const rng = mulberry32(42);
    for (let i = 0; i < 500; i++) {
      const s = thompsonSample(2, 5, rng);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(1);
    }
  });

  test("is deterministic for a fixed seed", () => {
    const a = thompsonSample(3, 4, mulberry32(123));
    const b = thompsonSample(3, 4, mulberry32(123));
    expect(a).toBe(b);
  });

  test("different seeds generally produce different draws", () => {
    const a = thompsonSample(3, 4, mulberry32(1));
    const b = thompsonSample(3, 4, mulberry32(2));
    expect(a).not.toBe(b);
  });

  test("sample mean approximates the posterior mean over many draws", () => {
    const rng = mulberry32(2026);
    const alpha = 8;
    const beta = 2;
    let sum = 0;
    const n = 20000;
    for (let i = 0; i < n; i++) sum += thompsonSample(alpha, beta, rng);
    const empiricalMean = sum / n;
    expect(empiricalMean).toBeCloseTo(betaPosteriorMean(alpha, beta), 1);
  });

  test("a high-success source samples higher on average than a low-success one", () => {
    const rng = mulberry32(7);
    const n = 4000;
    let goodSum = 0;
    let badSum = 0;
    for (let i = 0; i < n; i++) {
      goodSum += thompsonSample(20, 2, rng);
      badSum += thompsonSample(2, 20, rng);
    }
    expect(goodSum / n).toBeGreaterThan(badSum / n);
  });

  test("falls back to mean when gamma draws degenerate to zero", () => {
    // An rng that always returns ~0 forces the gamma fallback path.
    const zeroRng = fixedRng([Number.EPSILON]);
    const s = thompsonSample(2, 3, zeroRng);
    expect(s).toBeGreaterThanOrEqual(0);
    expect(s).toBeLessThanOrEqual(1);
  });

  test("throws on non-positive shape params", () => {
    expect(() => thompsonSample(0, 1, mulberry32(1))).toThrow();
  });
});

// ── credibilityKey ───────────────────────────────────────────────────────────

describe("credibilityKey", () => {
  test("composes a stable key from the three dimensions", () => {
    expect(credibilityKey("research_signals", "trend", "Productivity")).toBe(
      "research_signals::trend::Productivity",
    );
  });

  test("distinct tuples yield distinct keys", () => {
    expect(credibilityKey("a", "b", "c")).not.toBe(credibilityKey("a", "b", "d"));
    expect(credibilityKey("a", "b", "c")).not.toBe(credibilityKey("x", "b", "c"));
  });
});

// ── computeSourceCredibility ─────────────────────────────────────────────────

describe("computeSourceCredibility", () => {
  const rows: readonly SourceOutcomeRow[] = [
    { source_table: "research_signals", signal_type: "trend", category: "Health", success: true },
    { source_table: "research_signals", signal_type: "trend", category: "Health", success: true },
    { source_table: "research_signals", signal_type: "trend", category: "Health", success: false },
    { source_table: "app_reviews", signal_type: "pain", category: "Finance", success: false },
  ];

  test("aggregates successes/failures per (table, signal_type, category)", () => {
    const result = computeSourceCredibility(rows);
    const health = result.find((r) => r.category === "Health");
    expect(health).toBeDefined();
    expect(health!.successes).toBe(2);
    expect(health!.failures).toBe(1);
    // alpha = prior(1) + 2, beta = prior(1) + 1
    expect(health!.alpha).toBe(3);
    expect(health!.beta).toBe(2);
    expect(health!.mean).toBeCloseTo(0.6, 10);
  });

  test("applies the Beta(1,1) prior by default", () => {
    const result = computeSourceCredibility([
      { source_table: "t", signal_type: "s", category: "c", success: true },
    ]);
    expect(result[0]!.alpha).toBe(2);
    expect(result[0]!.beta).toBe(1);
    expect(result[0]!.mean).toBeCloseTo(2 / 3, 10);
  });

  test("respects custom priors", () => {
    const result = computeSourceCredibility(
      [{ source_table: "t", signal_type: "s", category: "c", success: false }],
      5,
      5,
    );
    expect(result[0]!.alpha).toBe(5);
    expect(result[0]!.beta).toBe(6);
  });

  test("returns one posterior per distinct tuple", () => {
    expect(computeSourceCredibility(rows)).toHaveLength(2);
  });

  test("empty input yields empty output", () => {
    expect(computeSourceCredibility([])).toEqual([]);
  });

  test("skips malformed rows defensively", () => {
    const dirty = [
      { source_table: "t", signal_type: "s", category: "c", success: true },
      // intentionally malformed (numeric source_table) to exercise defensive skip
      { source_table: 123, signal_type: "s", category: "c", success: true },
    ] as readonly SourceOutcomeRow[];
    const result = computeSourceCredibility(dirty);
    expect(result).toHaveLength(1);
    expect(result[0]!.successes).toBe(1);
  });

  test("throws on non-positive priors", () => {
    expect(() => computeSourceCredibility([], 0, 1)).toThrow();
  });
});

// ── rankBySourceCredibility ──────────────────────────────────────────────────

describe("rankBySourceCredibility", () => {
  const creds = computeSourceCredibility([
    { source_table: "good", signal_type: "s", category: "c", success: true },
    { source_table: "good", signal_type: "s", category: "c", success: true },
    { source_table: "good", signal_type: "s", category: "c", success: true },
    { source_table: "bad", signal_type: "s", category: "c", success: false },
    { source_table: "bad", signal_type: "s", category: "c", success: false },
  ]);

  test("exploit mode ranks higher posterior mean first", () => {
    const ranked = rankBySourceCredibility(creds, { explore: false });
    expect(ranked[0]!.source_table).toBe("good");
    expect(ranked[1]!.source_table).toBe("bad");
  });

  test("does not mutate the input array", () => {
    const input = [...creds];
    rankBySourceCredibility(creds, { explore: false });
    expect(creds).toEqual(input);
  });

  test("explore mode is deterministic with a seeded rng", () => {
    const a = rankBySourceCredibility(creds, { explore: true, rng: mulberry32(99) });
    const b = rankBySourceCredibility(creds, { explore: true, rng: mulberry32(99) });
    expect(a.map((c) => c.source_table)).toEqual(b.map((c) => c.source_table));
  });
});

// ── flattenFeedbackRows (pure provenance flattening) ─────────────────────────

describe("flattenFeedbackRows", () => {
  test("expands one outcome row per source attribution", () => {
    const out = flattenFeedbackRows([
      {
        idea_id: "i1",
        kind: "validated",
        category: "Productivity",
        source_ids_json: JSON.stringify([
          { table: "research_signals", id: "s1" },
          { table: "app_reviews", id: "r9" },
        ]),
      },
    ]);
    expect(out).toHaveLength(2);
    expect(out.every((o) => o.success)).toBe(true);
    expect(out[0]!.category).toBe("Productivity");
    expect(out.map((o) => o.source_table).sort()).toEqual([
      "app_reviews",
      "research_signals",
    ]);
  });

  test("maps kinds to outcomes correctly", () => {
    const mk = (kind: string) =>
      flattenFeedbackRows([
        {
          idea_id: "x",
          kind,
          category: "c",
          source_ids_json: JSON.stringify([{ table: "t", id: "1" }]),
        },
      ]);
    expect(mk("validated")[0]!.success).toBe(true);
    expect(mk("built")[0]!.success).toBe(true);
    expect(mk("archived")[0]!.success).toBe(false);
    expect(mk("dismissed")[0]!.success).toBe(false);
  });

  test("ignores non-terminal kinds", () => {
    const out = flattenFeedbackRows([
      {
        idea_id: "x",
        kind: "idea",
        category: "c",
        source_ids_json: JSON.stringify([{ table: "t", id: "1" }]),
      },
    ]);
    expect(out).toEqual([]);
  });

  test("uses signal_type from provenance entry when present", () => {
    const out = flattenFeedbackRows([
      {
        idea_id: "x",
        kind: "built",
        category: "c",
        source_ids_json: JSON.stringify([
          { table: "t", id: "1", signal_type: "pain" },
        ]),
      },
    ]);
    expect(out[0]!.signal_type).toBe("pain");
  });

  test("defaults signal_type to 'unknown' when absent", () => {
    const out = flattenFeedbackRows([
      {
        idea_id: "x",
        kind: "built",
        category: "c",
        source_ids_json: JSON.stringify([{ table: "t", id: "1" }]),
      },
    ]);
    expect(out[0]!.signal_type).toBe("unknown");
  });

  test("skips malformed JSON without throwing", () => {
    const out = flattenFeedbackRows([
      { idea_id: "x", kind: "validated", category: "c", source_ids_json: "{not json" },
      { idea_id: "y", kind: "validated", category: "c", source_ids_json: null },
    ]);
    expect(out).toEqual([]);
  });

  test("skips entries without a string table", () => {
    const out = flattenFeedbackRows([
      {
        idea_id: "x",
        kind: "validated",
        category: "c",
        source_ids_json: JSON.stringify([{ id: "1" }, { table: 5, id: "2" }]),
      },
    ]);
    expect(out).toEqual([]);
  });

  test("end-to-end: flatten then aggregate into posteriors", () => {
    const rows = [
      {
        idea_id: "a",
        kind: "validated",
        category: "Health",
        source_ids_json: JSON.stringify([{ table: "research_signals", id: "1" }]),
      },
      {
        idea_id: "b",
        kind: "archived",
        category: "Health",
        source_ids_json: JSON.stringify([{ table: "research_signals", id: "2" }]),
      },
    ];
    const creds = computeSourceCredibility(flattenFeedbackRows(rows));
    expect(creds).toHaveLength(1);
    expect(creds[0]!.successes).toBe(1);
    expect(creds[0]!.failures).toBe(1);
    expect(creds[0]!.mean).toBeCloseTo(0.5, 10);
  });
});
