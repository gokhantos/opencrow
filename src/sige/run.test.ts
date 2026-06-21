/**
 * Unit tests for PURE exported helpers in sige/run.ts.
 *
 * No DB, no LLM, no network. Covers:
 *   - buildSessionConfig: deep-merge partial overrides, preserves defaults
 *   - reportToMarkdown: section order, idea enumeration, non-empty output
 *   - DEFAULT_SIGE_SESSION_CONFIG: structural completeness check
 */

import { test, expect, describe } from "bun:test";
import {
  buildSessionConfig,
  reportToMarkdown,
  DEFAULT_SIGE_SESSION_CONFIG,
  selectFrontiersToDevelop,
  selectFrontiersForDeepDevelopment,
} from "./run";
import type { SigeReport } from "./types";
import type { Frontier } from "./discovery/frontier-discovery";
import type { ScoredSketch, ThemeCandidate } from "../pipelines/ideas/shallow-ideation";

// ── helpers ──────────────────────────────────────────────────────────────────

function makeReport(overrides: Partial<SigeReport> = {}): SigeReport {
  return {
    executiveSummary: "exec summary",
    topIdeas: [
      {
        id: "idea-1",
        title: "IdeaAlpha",
        description: "alpha description",
        proposedBy: "founder:sess",
        round: 3,
        expertScore: 0.88,
        fusedScore: 0.85,
        incentiveBreakdown: {
          diversityBonus: 0,
          buildingBonus: 0.05,
          surpriseBonus: 0,
          accuracyPenalty: 0,
          memoryReward: 0,
          coalitionStability: 0,
          signalCredibility: 0,
          socialViability: 0,
        },
        strategicMetadata: {
          paretoOptimal: true,
          dominantStrategy: false,
          evolutionarilyStable: true,
          nashEquilibrium: false,
        },
      },
    ],
    perIdeaAnalysis: [
      {
        idea: {
          id: "idea-1",
          title: "IdeaAlpha",
          description: "alpha description",
          proposedBy: "founder:sess",
          round: 3,
          expertScore: 0.88,
          fusedScore: 0.85,
          incentiveBreakdown: {
            diversityBonus: 0,
            buildingBonus: 0.05,
            surpriseBonus: 0,
            accuracyPenalty: 0,
            memoryReward: 0,
            coalitionStability: 0,
            signalCredibility: 0,
            socialViability: 0,
          },
          strategicMetadata: {
            paretoOptimal: true,
            dominantStrategy: false,
            evolutionarilyStable: true,
            nashEquilibrium: false,
          },
        },
        gameContext: "game context for alpha",
        equilibriumMembership: ["nash", "pareto"],
        agentSupport: {},
        socialReception: "highly positive",
      },
    ],
    opportunityMap: "opportunity details",
    riskAssessment: "risk details",
    metaGameHealth: {
      diversityIndex: 0.75,
      convergenceRate: 0.3,
      noveltyScore: 0.6,
      agentBalanceScores: {} as never,
    },
    recommendedNextSession: "explore frontier X next",
    ...overrides,
  };
}

// ── DEFAULT_SIGE_SESSION_CONFIG ──────────────────────────────────────────────

describe("DEFAULT_SIGE_SESSION_CONFIG", () => {
  test("has all required config fields", () => {
    const cfg = DEFAULT_SIGE_SESSION_CONFIG;
    expect(cfg.expertRounds).toBeGreaterThan(0);
    expect(cfg.socialAgentCount).toBeGreaterThan(0);
    expect(cfg.socialRounds).toBeGreaterThan(0);
    expect(cfg.maxConcurrentAgents).toBeGreaterThan(0);
    expect(cfg.alpha).toBeGreaterThan(0);
    expect(cfg.alpha).toBeLessThanOrEqual(1);
    expect(cfg.provider).toBe("anthropic");
    expect(typeof cfg.model).toBe("string");
  });

  test("incentiveWeights sum to approximately 1.0", () => {
    const sum = Object.values(DEFAULT_SIGE_SESSION_CONFIG.incentiveWeights).reduce(
      (a, b) => a + b,
      0,
    );
    expect(sum).toBeCloseTo(1.0, 2);
  });
});

// ── buildSessionConfig ───────────────────────────────────────────────────────

describe("buildSessionConfig", () => {
  test("returns structurally equal config to DEFAULT_SIGE_SESSION_CONFIG when no partial supplied", () => {
    const cfg = buildSessionConfig();
    // The implementation returns the DEFAULT reference directly when nothing is
    // overridden (an intentional short-circuit). Asserting deep equality is the
    // correct contract — identity is an implementation detail, not a guarantee.
    expect(cfg).toEqual(DEFAULT_SIGE_SESSION_CONFIG);
  });

  test("top-level override works", () => {
    const cfg = buildSessionConfig({ expertRounds: 8 });
    expect(cfg.expertRounds).toBe(8);
    // Other fields unchanged.
    expect(cfg.socialAgentCount).toBe(DEFAULT_SIGE_SESSION_CONFIG.socialAgentCount);
  });

  test("incentiveWeights partial merge is shallow (only supplied keys overridden)", () => {
    const cfg = buildSessionConfig({
      incentiveWeights: {
        diversity: 0.5,
        building: DEFAULT_SIGE_SESSION_CONFIG.incentiveWeights.building,
        surprise: DEFAULT_SIGE_SESSION_CONFIG.incentiveWeights.surprise,
        accuracyPenalty: DEFAULT_SIGE_SESSION_CONFIG.incentiveWeights.accuracyPenalty,
        socialViability: DEFAULT_SIGE_SESSION_CONFIG.incentiveWeights.socialViability,
      },
    });
    // diversity overridden
    expect(cfg.incentiveWeights.diversity).toBe(0.5);
    // all other weight keys kept from defaults
    expect(cfg.incentiveWeights.building).toBe(
      DEFAULT_SIGE_SESSION_CONFIG.incentiveWeights.building,
    );
  });

  test("model override is respected", () => {
    const cfg = buildSessionConfig({ model: "claude-haiku-4-5" });
    expect(cfg.model).toBe("claude-haiku-4-5");
  });

  test("result is structurally complete (no missing required fields)", () => {
    const cfg = buildSessionConfig({ alpha: 0.7 });
    expect(cfg.expertRounds).toBeDefined();
    expect(cfg.socialAgentCount).toBeDefined();
    expect(cfg.socialRounds).toBeDefined();
    expect(cfg.maxConcurrentAgents).toBeDefined();
    expect(cfg.incentiveWeights).toBeDefined();
    expect(cfg.provider).toBeDefined();
    expect(cfg.model).toBeDefined();
  });
});

// ── reportToMarkdown ─────────────────────────────────────────────────────────

describe("reportToMarkdown", () => {
  test("contains the Executive Summary section", () => {
    const md = reportToMarkdown(makeReport());
    expect(md).toContain("Executive Summary");
    expect(md).toContain("exec summary");
  });

  test("contains the Top Ideas section with numbered entries", () => {
    const md = reportToMarkdown(makeReport());
    expect(md).toContain("Top Ideas");
    expect(md).toContain("1. **IdeaAlpha**");
  });

  test("includes fused score in the idea line", () => {
    const md = reportToMarkdown(makeReport());
    expect(md).toContain("score: 0.850");
  });

  test("contains Per-Idea Analysis", () => {
    const md = reportToMarkdown(makeReport());
    expect(md).toContain("Per-Idea Analysis");
    expect(md).toContain("IdeaAlpha");
    expect(md).toContain("game context for alpha");
  });

  test("contains equilibrium membership", () => {
    const md = reportToMarkdown(makeReport());
    expect(md).toContain("nash");
    expect(md).toContain("pareto");
  });

  test("contains Opportunity Map and Risk Assessment", () => {
    const md = reportToMarkdown(makeReport());
    expect(md).toContain("Opportunity Map");
    expect(md).toContain("opportunity details");
    expect(md).toContain("Risk Assessment");
    expect(md).toContain("risk details");
  });

  test("contains Meta-Game Health metrics", () => {
    const md = reportToMarkdown(makeReport());
    expect(md).toContain("Meta-Game Health");
    expect(md).toContain("Diversity index: 0.750");
    expect(md).toContain("Convergence rate: 0.300");
    expect(md).toContain("Novelty score: 0.600");
  });

  test("contains Recommended Next Session", () => {
    const md = reportToMarkdown(makeReport());
    expect(md).toContain("Recommended Next Session");
    expect(md).toContain("explore frontier X next");
  });

  test("falls back to 'N/A' for missing fusedScore", () => {
    const report = makeReport();
    // Remove fusedScore from the top idea.
    const ideaWithoutFused = { ...report.topIdeas[0]!, fusedScore: undefined };
    const reportWithout: SigeReport = {
      ...report,
      topIdeas: [ideaWithoutFused],
    };
    const md = reportToMarkdown(reportWithout);
    expect(md).toContain("N/A");
  });
});

// ── selectFrontiersToDevelop ─────────────────────────────────────────────────

function makeFrontier(id: string, theme: string, overrides: Partial<Frontier> = {}): Frontier {
  return {
    id,
    theme,
    themeKeys: [theme.toLowerCase()],
    candidates: [],
    signalStrength: 0.5,
    novelty: 0.5,
    score: 0.5,
    seedText: `seed for ${theme}`,
    ...overrides,
  };
}

function makeScored(
  id: string,
  kind: string,
  score: number,
  overrides: Partial<ThemeCandidate> = {},
): ScoredSketch {
  const candidate: ThemeCandidate = {
    id,
    title: `${kind} theme`,
    kind,
    source: "sige",
    signalStrength: score,
    context: "ctx",
    ...overrides,
  };
  return {
    candidate,
    sketch: { candidateId: id, line: `${kind} idea`, marketGap: score },
    score,
    components: { signal: score, novelty: score, marketGap: score },
  };
}

describe("selectFrontiersToDevelop", () => {
  test("selects MULTIPLE distinct frontiers spread across buckets (not top-1 collapse)", () => {
    const frontiers: readonly Frontier[] = [
      makeFrontier("f1", "Alpha"),
      makeFrontier("f2", "Beta"),
      makeFrontier("f3", "Gamma"),
      makeFrontier("f4", "Delta"),
    ];
    // Highest-scoring sketches deliberately span four distinct kind buckets.
    const scored: readonly ScoredSketch[] = [
      makeScored("f1", "productivity", 0.95),
      makeScored("f2", "health", 0.9),
      makeScored("f3", "finance", 0.85),
      makeScored("f4", "education", 0.8),
    ];

    const toDevelop = selectFrontiersToDevelop(frontiers, scored, {
      deepDevelopCount: 4,
      maxBucketShare: 0.5,
    });

    expect(toDevelop.length).toBe(4);
    const ids = toDevelop.map((f) => f.id);
    expect(new Set(ids).size).toBe(4);
    expect(ids).toEqual(["f1", "f2", "f3", "f4"]);
  });

  test("caps a dominant bucket so no single kind exceeds maxBucketShare", () => {
    const frontiers: readonly Frontier[] = [
      makeFrontier("f1", "Alpha"),
      makeFrontier("f2", "Beta"),
      makeFrontier("f3", "Gamma"),
      makeFrontier("f4", "Delta"),
    ];
    // Three top sketches share ONE bucket; only one alternative bucket exists.
    const scored: readonly ScoredSketch[] = [
      makeScored("f1", "productivity", 0.95),
      makeScored("f2", "productivity", 0.9),
      makeScored("f3", "productivity", 0.85),
      makeScored("f4", "health", 0.8),
    ];

    const toDevelop = selectFrontiersToDevelop(frontiers, scored, {
      deepDevelopCount: 2,
      maxBucketShare: 0.5,
    });

    expect(toDevelop.length).toBe(2);
    const ids = toDevelop.map((f) => f.id);
    // perBucketCap = ceil(2 * 0.5) = 1 → at most one "productivity" frontier kept,
    // and the diverse "health" frontier (f4) is pulled up despite its lower score.
    expect(ids).toEqual(["f1", "f4"]);
  });

  test("maps kept sketches back to their originating frontier by candidate.id", () => {
    const frontiers: readonly Frontier[] = [
      makeFrontier("f1", "Alpha"),
      makeFrontier("f2", "Beta"),
    ];
    const scored: readonly ScoredSketch[] = [
      makeScored("f2", "health", 0.9),
      makeScored("f1", "productivity", 0.8),
    ];

    const toDevelop = selectFrontiersToDevelop(frontiers, scored, {
      deepDevelopCount: 5,
      maxBucketShare: 0.5,
    });

    // Order follows the (diversity-selected) sketch order, not frontier order.
    expect(toDevelop.map((f) => f.id)).toEqual(["f2", "f1"]);
  });

  test("drops sketches whose candidate.id has no matching frontier", () => {
    const frontiers: readonly Frontier[] = [makeFrontier("f1", "Alpha")];
    const scored: readonly ScoredSketch[] = [
      makeScored("ghost", "health", 0.95),
      makeScored("f1", "productivity", 0.8),
    ];

    const toDevelop = selectFrontiersToDevelop(frontiers, scored, {
      deepDevelopCount: 5,
      maxBucketShare: 0.5,
    });

    expect(toDevelop.map((f) => f.id)).toEqual(["f1"]);
  });

  test("dedups so a frontier referenced twice is developed once", () => {
    const frontiers: readonly Frontier[] = [makeFrontier("f1", "Alpha")];
    const scored: readonly ScoredSketch[] = [
      makeScored("f1", "health", 0.95),
      makeScored("f1", "productivity", 0.8),
    ];

    const toDevelop = selectFrontiersToDevelop(frontiers, scored, {
      deepDevelopCount: 5,
      maxBucketShare: 0.5,
    });

    expect(toDevelop.map((f) => f.id)).toEqual(["f1"]);
  });

  test("falls back to candidate.title when kind is undefined", () => {
    const frontiers: readonly Frontier[] = [
      makeFrontier("f1", "Alpha"),
      makeFrontier("f2", "Beta"),
    ];
    const scored: readonly ScoredSketch[] = [
      makeScored("f1", "x", 0.9, { kind: undefined, title: "Alpha theme" }),
      makeScored("f2", "x", 0.8, { kind: undefined, title: "Beta theme" }),
    ];

    const toDevelop = selectFrontiersToDevelop(frontiers, scored, {
      deepDevelopCount: 5,
      maxBucketShare: 0.5,
    });

    // Distinct titles → distinct buckets → both kept.
    expect(toDevelop.map((f) => f.id)).toEqual(["f1", "f2"]);
  });

  test("does not mutate the input arrays", () => {
    const frontiers: readonly Frontier[] = [makeFrontier("f1", "Alpha")];
    const scored: readonly ScoredSketch[] = [makeScored("f1", "health", 0.9)];
    const frontiersCopy = [...frontiers];
    const scoredCopy = [...scored];

    selectFrontiersToDevelop(frontiers, scored, {
      deepDevelopCount: 5,
      maxBucketShare: 0.5,
    });

    expect(frontiers).toEqual(frontiersCopy);
    expect(scored).toEqual(scoredCopy);
  });
});

// ── selectFrontiersForDeepDevelopment (the on/off/fallback WIRING branches) ───
//
// These cover the autonomous selection DECISION (the reversibility guarantee),
// NOT the pure selector above. I/O is injected via `deps` — no `mock.module`.

type SelectOpts = Parameters<typeof selectFrontiersForDeepDevelopment>[1];
type SelectDeps = Parameters<typeof selectFrontiersForDeepDevelopment>[2];

function makeSelectOpts(overrides: Partial<SelectOpts> = {}): SelectOpts {
  return {
    shallowEnabled: true,
    batchSize: 10,
    model: "",
    deepDevelopCount: 6,
    maxBucketShare: 0.5,
    maxDeepFrontiers: 2,
    ...overrides,
  };
}

// A deps double whose lookupSaturation is never expected to fire (the helper
// only calls runShallow); runShallow is supplied per-test.
function makeSelectDeps(
  runShallow: SelectDeps["runShallow"],
): SelectDeps {
  return {
    runShallow,
    lookupSaturation: async () => "",
  };
}

describe("selectFrontiersForDeepDevelopment", () => {
  test("shallowEnabled=false → master's score-diverse selectDiverseBy (NOT a raw slice), no ideation", async () => {
    // Discovery order is f1,f2,f3 but scores are f3>f2>f1, and f1/f2 SHARE a
    // theme. master's selection sorts by score desc then caps each theme bucket
    // at 50% → picks f3 (top score) + f1 (the other theme). A raw
    // `slice(0, 2)` would have returned [f1, f2] in discovery order — proving
    // the OFF path is the score-diverse selection, not a slice.
    const frontiers: readonly Frontier[] = [
      makeFrontier("f1", "Alpha", { score: 0.5 }),
      makeFrontier("f2", "Alpha", { score: 0.7 }),
      makeFrontier("f3", "Beta", { score: 0.9 }),
    ];
    let shallowCalled = false;
    const deps = makeSelectDeps(async () => {
      shallowCalled = true;
      return [];
    });

    const out = await selectFrontiersForDeepDevelopment(
      frontiers,
      makeSelectOpts({ shallowEnabled: false, maxDeepFrontiers: 2 }),
      deps,
    );

    // Score-sorted: f3(0.9), f2(0.7), f1(0.5). perBucketCap = ceil(2*0.5)=1:
    // f3(Beta) admitted, f2(Alpha) admitted → length 2, stop. Equal to master's
    // `selectDiverseBy([...].sort(desc), { maxIdeas: 2, maxBucketShare: 0.5,
    // resolveBucket: theme })`.
    expect(out.map((f) => f.id)).toEqual(["f3", "f2"]);
    expect(shallowCalled).toBe(false);
  });

  test("ON + non-empty scored across distinct buckets → diversity-selected, bucket-capped frontiers", async () => {
    const frontiers: readonly Frontier[] = [
      makeFrontier("f1", "Alpha"),
      makeFrontier("f2", "Beta"),
      makeFrontier("f3", "Gamma"),
      makeFrontier("f4", "Delta"),
    ];
    // Three top sketches share ONE bucket; one alternative bucket exists. The
    // maxBucketShare cap must pull the diverse frontier up over a same-bucket one.
    const deps = makeSelectDeps(async () => [
      makeScored("f1", "productivity", 0.95),
      makeScored("f2", "productivity", 0.9),
      makeScored("f3", "productivity", 0.85),
      makeScored("f4", "health", 0.8),
    ]);

    const out = await selectFrontiersForDeepDevelopment(
      frontiers,
      makeSelectOpts({ deepDevelopCount: 2, maxBucketShare: 0.5 }),
      deps,
    );

    const ids = out.map((f) => f.id);
    // Multiple DISTINCT frontiers, capped by bucket: perBucketCap = ceil(2*0.5)=1
    // → one "productivity" (f1) + the diverse "health" (f4).
    expect(ids).toEqual(["f1", "f4"]);
    expect(new Set(ids).size).toBe(2);
  });

  test("ON + runShallow returns [] → degrades to master's score-diverse selection", async () => {
    // Same score-discriminating fixture as the OFF test: score-sorted +
    // bucket-capped, NOT a discovery-order slice.
    const frontiers: readonly Frontier[] = [
      makeFrontier("f1", "Alpha", { score: 0.5 }),
      makeFrontier("f2", "Alpha", { score: 0.7 }),
      makeFrontier("f3", "Beta", { score: 0.9 }),
    ];
    const deps = makeSelectDeps(async () => []);

    const out = await selectFrontiersForDeepDevelopment(
      frontiers,
      makeSelectOpts({ maxDeepFrontiers: 2 }),
      deps,
    );

    expect(out.map((f) => f.id)).toEqual(["f3", "f2"]);
  });

  test("ON + runShallow throws → caught, degrades to master's score-diverse selection", async () => {
    const frontiers: readonly Frontier[] = [
      makeFrontier("f1", "Alpha", { score: 0.5 }),
      makeFrontier("f2", "Alpha", { score: 0.7 }),
      makeFrontier("f3", "Beta", { score: 0.9 }),
    ];
    const deps = makeSelectDeps(async () => {
      throw new Error("cheap-model exploded");
    });

    const out = await selectFrontiersForDeepDevelopment(
      frontiers,
      makeSelectOpts({ maxDeepFrontiers: 2 }),
      deps,
    );

    expect(out.map((f) => f.id)).toEqual(["f3", "f2"]);
  });

  test("does not mutate the input frontiers", async () => {
    const frontiers: readonly Frontier[] = [
      makeFrontier("f1", "Alpha"),
      makeFrontier("f2", "Beta"),
    ];
    const frontiersCopy = [...frontiers];
    const deps = makeSelectDeps(async () => [makeScored("f1", "health", 0.9)]);

    await selectFrontiersForDeepDevelopment(frontiers, makeSelectOpts(), deps);

    expect(frontiers).toEqual(frontiersCopy);
  });
});
