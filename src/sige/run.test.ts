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
} from "./run";
import type { SigeReport } from "./types";

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
