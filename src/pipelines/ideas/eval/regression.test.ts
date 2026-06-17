import { test, expect, describe } from "bun:test";
import {
  detectRegressions,
  computeBaseline,
  extractMetrics,
  type EvalAggregate,
} from "./regression";

// ── Aggregate builder ───────────────────────────────────────────────────────────

function agg(overrides: {
  novelty?: number | null;
  feasibility?: number | null;
  signalGrounding?: number | null;
  validatedRate?: number;
  humanValidatedRate?: number;
  killedRate?: number;
  dedupF1?: number | null;
}): EvalAggregate {
  return {
    totalIdeas: 10,
    meanSubscores: {
      novelty: overrides.novelty ?? null,
      feasibility: overrides.feasibility ?? null,
      signalGrounding: overrides.signalGrounding ?? null,
      counts: { novelty: 1, feasibility: 1, signalGrounding: 1 },
    },
    outcomeRates: {
      killedRate: overrides.killedRate ?? 0,
      humanValidatedRate: overrides.humanValidatedRate ?? 0,
      validatedRate: overrides.validatedRate ?? 0,
      totalIdeas: 10,
      killedCount: 0,
      humanValidatedCount: 0,
      validatedCount: 0,
    },
    dedupQuality:
      overrides.dedupF1 === undefined
        ? null
        : {
            precision: null,
            recall: null,
            f1: overrides.dedupF1,
            truePositives: 0,
            falsePositives: 0,
            falseNegatives: 0,
            trueNegatives: 0,
            labeled: 0,
          },
  };
}

// ── extractMetrics ──────────────────────────────────────────────────────────────

describe("extractMetrics", () => {
  test("pulls direction-tagged scalars", () => {
    const metrics = extractMetrics(agg({ novelty: 0.7, killedRate: 0.3 }));
    const byKey = new Map(metrics.map((m) => [m.key, m]));
    expect(byKey.get("meanNovelty")?.value).toBe(0.7);
    expect(byKey.get("meanNovelty")?.direction).toBe("higher_is_better");
    expect(byKey.get("killedRate")?.value).toBe(0.3);
    expect(byKey.get("killedRate")?.direction).toBe("lower_is_better");
  });
});

// ── computeBaseline ─────────────────────────────────────────────────────────────

describe("computeBaseline", () => {
  test("averages non-null metric values per key", () => {
    const baseline = computeBaseline([
      agg({ novelty: 0.8 }),
      agg({ novelty: 0.6 }),
      agg({ novelty: null }), // skipped
    ]);
    expect(baseline.get("meanNovelty")).toEqual({ mean: 0.7, count: 2 });
  });

  test("empty window → empty baseline", () => {
    expect(computeBaseline([]).size).toBe(0);
  });
});

// ── detectRegressions ───────────────────────────────────────────────────────────

describe("detectRegressions", () => {
  const trailing = [agg({ novelty: 0.8, killedRate: 0.2, validatedRate: 0.5 })];

  test("no regression when metric holds steady", () => {
    const alerts = detectRegressions(
      agg({ novelty: 0.8, killedRate: 0.2, validatedRate: 0.5 }),
      trailing,
    );
    expect(alerts).toEqual([]);
  });

  test("higher-is-better drop is flagged", () => {
    // novelty 0.8 → 0.6: abs drop 0.2 (≥0.05), rel 0.25 (≥0.1) → critical
    const alerts = detectRegressions(agg({ novelty: 0.6 }), trailing);
    const novelty = alerts.find((a) => a.metric === "meanNovelty");
    expect(novelty).toBeDefined();
    expect(novelty!.delta).toBeCloseTo(-0.2, 5);
    expect(novelty!.severity).toBe("critical");
    expect(novelty!.relativeChange).toBe(0.25);
  });

  test("higher-is-better improvement is NOT flagged", () => {
    const alerts = detectRegressions(agg({ novelty: 0.95 }), trailing);
    expect(alerts.find((a) => a.metric === "meanNovelty")).toBeUndefined();
  });

  test("lower-is-better rise is flagged (killedRate up)", () => {
    // killedRate 0.2 → 0.4: worsening 0.2, rel 1.0 → critical
    const alerts = detectRegressions(agg({ killedRate: 0.4 }), trailing);
    const killed = alerts.find((a) => a.metric === "killedRate");
    expect(killed).toBeDefined();
    expect(killed!.direction).toBe("lower_is_better");
    expect(killed!.delta).toBeCloseTo(0.2, 5);
    expect(killed!.severity).toBe("critical");
  });

  test("lower-is-better drop is improvement, NOT flagged", () => {
    const alerts = detectRegressions(agg({ killedRate: 0.05 }), trailing);
    expect(alerts.find((a) => a.metric === "killedRate")).toBeUndefined();
  });

  test("sub-threshold change is ignored", () => {
    // novelty 0.8 → 0.78: abs drop 0.02 < 0.05 → no alert
    const alerts = detectRegressions(agg({ novelty: 0.78 }), trailing);
    expect(alerts.find((a) => a.metric === "meanNovelty")).toBeUndefined();
  });

  test("relative threshold gates small absolute on small scale", () => {
    // baseline validatedRate 0.5; new 0.44 → abs 0.06 (≥0.05), rel 0.12 (≥0.1) → warning
    const alerts = detectRegressions(agg({ validatedRate: 0.44 }), trailing);
    const v = alerts.find((a) => a.metric === "validatedRate");
    expect(v).toBeDefined();
    expect(v!.severity).toBe("warning");
  });

  test("metric absent from baseline does not alert", () => {
    // trailing has no dedupF1 → current dedupF1 has nothing to compare to
    const alerts = detectRegressions(agg({ dedupF1: 0.1 }), trailing);
    expect(alerts.find((a) => a.metric === "dedupF1")).toBeUndefined();
  });

  test("respects minBaselineCount", () => {
    const alerts = detectRegressions(agg({ novelty: 0.5 }), trailing, {
      minBaselineCount: 2,
    });
    // only 1 trailing observation → below required 2 → no alert
    expect(alerts.find((a) => a.metric === "meanNovelty")).toBeUndefined();
  });

  test("null current metric does not alert", () => {
    const alerts = detectRegressions(agg({ novelty: null }), trailing);
    expect(alerts.find((a) => a.metric === "meanNovelty")).toBeUndefined();
  });

  test("custom thresholds change severity boundary", () => {
    const alerts = detectRegressions(agg({ novelty: 0.6 }), trailing, {
      criticalRelativeDrop: 0.5, // 0.25 rel now below critical
    });
    const novelty = alerts.find((a) => a.metric === "meanNovelty");
    expect(novelty!.severity).toBe("warning");
  });
});
