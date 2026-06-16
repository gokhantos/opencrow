import { test, expect, describe } from "bun:test";
import {
  extractJson,
  validatePainCluster,
  validateEmergingPattern,
  validateGapSignal,
  validateCollisionPoint,
  validateSynthesizedSignals,
  signalsToPromptContext,
} from "./signal-synthesis";

// ── extractJson ────────────────────────────────────────────────────────────

describe("extractJson", () => {
  test("parses a bare JSON object", () => {
    const result = extractJson('{"painClusters": []}');
    expect(result.painClusters).toEqual([]);
  });

  test("parses JSON inside a fenced code block", () => {
    const text = 'Here is the data:\n```json\n{"gapSignals": [{"category": "x"}]}\n```\nDone.';
    const result = extractJson(text);
    expect(Array.isArray(result.gapSignals)).toBe(true);
  });

  test("parses a fenced block without a json language tag", () => {
    const text = "```\n{\"emergingPatterns\": []}\n```";
    const result = extractJson(text);
    expect(result.emergingPatterns).toEqual([]);
  });

  test("falls back to the first object match in surrounding prose", () => {
    const text = 'Analysis follows. {"collisionPoints": [{"trend1": "a"}]} Thanks.';
    const result = extractJson(text);
    expect(Array.isArray(result.collisionPoints)).toBe(true);
  });

  test("throws a descriptive error when no JSON can be extracted", () => {
    expect(() => extractJson("there is no json here at all")).toThrow(
      /Unable to extract JSON/,
    );
  });

  test("throws when the only braces contain malformed JSON", () => {
    expect(() => extractJson("prefix {not: valid json,,} suffix")).toThrow(
      /Unable to extract JSON/,
    );
  });
});

// ── validatePainCluster ────────────────────────────────────────────────────

describe("validatePainCluster", () => {
  test("throws on a non-object input", () => {
    expect(() => validatePainCluster("nope", 0)).toThrow(/must be an object/);
    expect(() => validatePainCluster(null, 0)).toThrow(/must be an object/);
  });

  test("normalizes a fully-specified cluster", () => {
    const cluster = validatePainCluster(
      {
        name: "  Onboarding friction  ",
        description: "Users churn during setup",
        sources: ["HN", "Reddit", "  ", 42],
        severity: "critical",
        affectedUserSegment: "new users",
      },
      0,
    );
    expect(cluster.name).toBe("Onboarding friction");
    expect(cluster.severity).toBe("critical");
    // Non-strings and blank entries are filtered out of sources.
    expect(cluster.sources).toEqual(["HN", "Reddit"]);
  });

  test("defaults an unknown severity to medium", () => {
    const cluster = validatePainCluster({ severity: "apocalyptic" }, 2);
    expect(cluster.severity).toBe("medium");
  });

  test("supplies a fallback name from the index when missing", () => {
    const cluster = validatePainCluster({}, 4);
    expect(cluster.name).toBe("Pain Cluster 5");
  });
});

// ── validateEmergingPattern ────────────────────────────────────────────────

describe("validateEmergingPattern", () => {
  test("throws on a non-object input", () => {
    expect(() => validateEmergingPattern(7, 0)).toThrow(/must be an object/);
  });

  test("defaults an unknown momentum to emerging", () => {
    const pattern = validateEmergingPattern({ momentum: "exploding" }, 0);
    expect(pattern.momentum).toBe("emerging");
  });

  test("preserves a valid momentum and defaults the time horizon", () => {
    const pattern = validateEmergingPattern({ momentum: "accelerating" }, 0);
    expect(pattern.momentum).toBe("accelerating");
    expect(pattern.timeHorizon).toBe("unknown");
  });
});

// ── validateGapSignal & validateCollisionPoint ─────────────────────────────

describe("validateGapSignal", () => {
  test("throws on a non-object input", () => {
    expect(() => validateGapSignal(null, 0)).toThrow(/must be an object/);
  });

  test("supplies indexed fallback category", () => {
    const gap = validateGapSignal({}, 1);
    expect(gap.category).toBe("Category 2");
  });
});

describe("validateCollisionPoint", () => {
  test("throws on a non-object input", () => {
    expect(() => validateCollisionPoint("x", 0)).toThrow(/must be an object/);
  });

  test("supplies fallback trend names", () => {
    const cp = validateCollisionPoint({ intersection: "novel thing" }, 0);
    expect(cp.trend1).toBe("Trend A");
    expect(cp.trend2).toBe("Trend B");
    expect(cp.intersection).toBe("novel thing");
  });
});

// ── validateSynthesizedSignals ─────────────────────────────────────────────

describe("validateSynthesizedSignals", () => {
  test("treats non-array fields as empty and counts the total", () => {
    const result = validateSynthesizedSignals({
      painClusters: [{ name: "p1" }, { name: "p2" }],
      emergingPatterns: [{ name: "e1" }],
      gapSignals: "not an array",
      collisionPoints: undefined,
    });
    expect(result.painClusters).toHaveLength(2);
    expect(result.emergingPatterns).toHaveLength(1);
    expect(result.gapSignals).toEqual([]);
    expect(result.collisionPoints).toEqual([]);
    expect(result.rawSignalCount).toBe(3);
  });

  test("returns all-empty structure for an empty raw object", () => {
    const result = validateSynthesizedSignals({});
    expect(result.rawSignalCount).toBe(0);
    expect(result.painClusters).toEqual([]);
  });

  test("propagates per-item validation errors for malformed entries", () => {
    expect(() =>
      validateSynthesizedSignals({ painClusters: ["not an object"] }),
    ).toThrow(/must be an object/);
  });
});

// ── signalsToPromptContext ─────────────────────────────────────────────────

describe("signalsToPromptContext", () => {
  test("renders pain clusters with uppercased severity", () => {
    const context = signalsToPromptContext({
      painClusters: [
        {
          name: "Onboarding",
          description: "hard setup",
          sources: ["HN"],
          severity: "high",
          affectedUserSegment: "new users",
        },
      ],
      emergingPatterns: [],
      gapSignals: [],
      collisionPoints: [],
      rawSignalCount: 1,
    });
    expect(context).toContain("[HIGH] Onboarding");
    expect(context).toContain("1 raw signals");
  });

  test("omits empty sections", () => {
    const context = signalsToPromptContext({
      painClusters: [],
      emergingPatterns: [],
      gapSignals: [],
      collisionPoints: [],
      rawSignalCount: 0,
    });
    expect(context).not.toContain("### Pain Clusters");
    expect(context).not.toContain("### Collision Points");
  });
});
