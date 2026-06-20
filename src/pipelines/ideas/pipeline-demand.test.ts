import { test, expect, describe } from "bun:test";
import {
  toDemandCandidateText,
  buildEnrichDemandConfig,
  applyDemandRescore,
  buildDemandEvidenceString,
  summarizeDemandCoverage,
  candidateHasDemandEvidence,
} from "./pipeline";
import {
  GIANT_DEFAULT_WEIGHTS,
  aggregateGiant,
  DEMAND_EVIDENCE_CAP,
  type GiantAxisScores,
} from "./giant";
import type { GiantConfig, DemandConfig } from "../../config/schema";
import type { GeneratedIdeaCandidate } from "./types";
import type { DemandArtifact, DemandEvidence } from "./demand";

// ── PHASE 2 (demand-side grounding) pipeline-level pure helpers ────────────────
//
// Pure tests for the pipeline boundary's demand helpers: candidate→DemandCandidateText
// projection, config mapping, the GIANT demand-axis rescore (the Phase 2 unlock),
// the cited evidence-string builder, and the run-level coverage instrumentation.
// No DB / network — every function under test is deterministic.

const GIANT_SHADOW: GiantConfig = {
  enabled: true,
  enforceGates: false,
  weights: { ...GIANT_DEFAULT_WEIGHTS },
};

const DEMAND_CFG: DemandConfig = {
  enabled: true,
  redditIntent: true,
  fundingSignal: true,
  reviewComplaint: true,
  hnIntent: true,
  phSupply: true,
  externalTrends: false,
  minMatches: 2,
  minKeywordHits: 2,
};

/** A baseline scorecard with a high ASSERTED demand (5) the gate will cap. */
const STRONG_SCORES: GiantAxisScores = {
  acuteProblem: 4,
  whyNow: 4,
  demand: 5,
  nonObviousness: 4,
  defensibility: 4,
  marketShape: 4,
  founderFit: 4,
};

function candidate(
  overrides: Partial<GeneratedIdeaCandidate> = {},
): GeneratedIdeaCandidate {
  return {
    title: "Expense report automation for contractors",
    summary: "Tracks receipts and files expense reports automatically",
    reasoning: "Contractors waste hours every month reconciling receipts",
    designDescription: "design",
    monetizationDetail: "monetization",
    sourceLinks: [],
    sourcesUsed: "sources",
    category: "productivity",
    qualityScore: 3,
    targetAudience: "freelance contractors",
    keyFeatures: ["a", "b"],
    revenueModel: "subscription",
    trendIntersection: "receipt scanning + tax automation",
    ...overrides,
  };
}

function artifact(overrides: Partial<DemandArtifact> = {}): DemandArtifact {
  return {
    score: 4,
    confidence: 0.7,
    whitespace: 0.6,
    evidence: [],
    ...overrides,
  };
}

const REDDIT_EVIDENCE: DemandEvidence = {
  kind: "reddit_intent",
  query: "expense report",
  count: 5,
  quote: "Is there a tool that auto-files expense reports for contractors?",
  sourceId: "reddit-42",
};

const FUNDING_EVIDENCE: DemandEvidence = {
  kind: "funding_news",
  query: "expense automation",
  count: 3,
  sourceId: "news-7",
};

// ── toDemandCandidateText ─────────────────────────────────────────────────────

describe("toDemandCandidateText", () => {
  test("projects the candidate's salient text fields (reasoning = problem)", () => {
    const text = toDemandCandidateText(candidate());
    expect(text.title).toBe("Expense report automation for contractors");
    expect(text.reasoning).toBe(
      "Contractors waste hours every month reconciling receipts",
    );
    expect(text.trendIntersection).toBe("receipt scanning + tax automation");
    expect(text.targetAudience).toBe("freelance contractors");
  });
});

// ── buildEnrichDemandConfig ───────────────────────────────────────────────────

describe("buildEnrichDemandConfig", () => {
  test("maps the smart.demand flags through faithfully", () => {
    const cfg = buildEnrichDemandConfig(DEMAND_CFG);
    expect(cfg).toEqual({
      enabled: true,
      redditIntent: true,
      fundingSignal: true,
      reviewComplaint: true,
      hnIntent: true,
      phSupply: true,
      externalTrends: false,
      minMatches: 2,
      minKeywordHits: 2,
    });
  });

  test("threads optional window/limit/supplyDensity knobs when supplied", () => {
    const cfg = buildEnrichDemandConfig(DEMAND_CFG, {
      windowSec: 100,
      limit: 30,
      supplyDensity: 0.4,
    });
    expect(cfg.windowSec).toBe(100);
    expect(cfg.limit).toBe(30);
    expect(cfg.supplyDensity).toBe(0.4);
  });

  test("omits absent knobs (no undefined keys leak into the config)", () => {
    const cfg = buildEnrichDemandConfig(DEMAND_CFG);
    expect("windowSec" in cfg).toBe(false);
    expect("limit" in cfg).toBe(false);
    expect("supplyDensity" in cfg).toBe(false);
  });
});

// ── applyDemandRescore (THE PHASE 2 UNLOCK) ───────────────────────────────────

describe("applyDemandRescore", () => {
  test("returns the candidate unchanged when no raw GIANT scorecard", () => {
    const c = candidate(); // no .giant
    const out = applyDemandRescore(c, artifact({ evidence: [REDDIT_EVIDENCE] }), GIANT_SHADOW);
    expect(out).toBe(c);
  });

  test("immutable: original candidate is not mutated", () => {
    const c = candidate({ giant: { ...STRONG_SCORES } });
    const out = applyDemandRescore(
      c,
      artifact({ score: 4, evidence: [REDDIT_EVIDENCE] }),
      GIANT_SHADOW,
    );
    expect(c.giant!.demand).toBe(5); // untouched
    expect(out).not.toBe(c);
    expect(out.giant!.demand).toBe(4); // rescored from artifact.score
  });

  test("CITED demand opens the gate — composite matches hasDemandEvidence=true", () => {
    const c = candidate({ giant: { ...STRONG_SCORES } });
    const art = artifact({ score: 4, evidence: [REDDIT_EVIDENCE, FUNDING_EVIDENCE] });
    const out = applyDemandRescore(c, art, GIANT_SHADOW);

    const expected = aggregateGiant(
      { ...STRONG_SCORES, demand: 4 },
      {
        weights: GIANT_DEFAULT_WEIGHTS,
        enforceGates: false,
        hasDemandEvidence: true,
      },
    );
    expect(out.giantComposite).toBeCloseTo(expected.composite, 10);
    expect(out.qualityScore).toBeCloseTo(expected.composite, 10);
  });

  test("cited rescore stamps giantEvidence.demand so downstream gate agrees", () => {
    const c = candidate({ giant: { ...STRONG_SCORES } });
    const out = applyDemandRescore(
      c,
      artifact({ score: 4, evidence: [REDDIT_EVIDENCE] }),
      GIANT_SHADOW,
    );
    expect(candidateHasDemandEvidence(out)).toBe(true);
    expect(out.giantEvidence?.demand).toContain("auto-files expense reports");
  });

  test("absence artifact keeps the gate CLOSED (demand capped, no evidence stamp)", () => {
    const c = candidate({ giant: { ...STRONG_SCORES } });
    // Absence: score at the cap, empty evidence -> hasCitedDemand false.
    const out = applyDemandRescore(c, artifact({ score: 1, evidence: [] }), GIANT_SHADOW);

    const expected = aggregateGiant(
      { ...STRONG_SCORES, demand: 1 },
      {
        weights: GIANT_DEFAULT_WEIGHTS,
        enforceGates: false,
        hasDemandEvidence: false,
      },
    );
    expect(out.giantComposite).toBeCloseTo(expected.composite, 10);
    expect(out.giantEvidence).toBeUndefined();
  });

  test("the unlock: cited demand beats the capped (gate-closed) composite", () => {
    const c = candidate({ giant: { ...STRONG_SCORES } });
    const cited = applyDemandRescore(
      c,
      artifact({ score: 5, evidence: [REDDIT_EVIDENCE, FUNDING_EVIDENCE] }),
      GIANT_SHADOW,
    );
    // Same asserted demand=5 but NO cited evidence -> capped at DEMAND_EVIDENCE_CAP.
    const capped = aggregateGiant(STRONG_SCORES, {
      weights: GIANT_DEFAULT_WEIGHTS,
      enforceGates: false,
      hasDemandEvidence: false,
    });
    expect(DEMAND_EVIDENCE_CAP).toBe(2);
    expect(cited.giantComposite!).toBeGreaterThan(capped.composite);
  });
});

// ── buildDemandEvidenceString ─────────────────────────────────────────────────

describe("buildDemandEvidenceString", () => {
  test("reuses a verbatim quote (anti-hallucination: never invented)", () => {
    const s = buildDemandEvidenceString(artifact({ evidence: [REDDIT_EVIDENCE] }));
    expect(s).toContain("auto-files expense reports for contractors");
    expect(s).toContain("reddit-42");
  });

  test("summarizes matched counts by kind when no quote is present", () => {
    const s = buildDemandEvidenceString(artifact({ evidence: [FUNDING_EVIDENCE] }));
    expect(s).toContain("funding_news:3");
    expect(s).not.toContain('"');
  });
});

// ── summarizeDemandCoverage ───────────────────────────────────────────────────

describe("summarizeDemandCoverage", () => {
  test("counts cited share and averages score + whitespace over the full set", () => {
    const c1 = candidate({ giant: { ...STRONG_SCORES } });
    const c2 = candidate({ giant: { ...STRONG_SCORES }, title: "Second idea" });
    const c3 = candidate({ giant: { ...STRONG_SCORES }, title: "Third idea" });

    const map = new Map<GeneratedIdeaCandidate, DemandArtifact>([
      // cited (evidence + score>1)
      [c1, artifact({ score: 4, whitespace: 0.6, evidence: [REDDIT_EVIDENCE] })],
      // absence (no evidence, score at cap) -> NOT cited
      [c2, artifact({ score: 1, whitespace: 0, evidence: [] })],
      // cited
      [c3, artifact({ score: 3, whitespace: 0.4, evidence: [FUNDING_EVIDENCE] })],
    ]);

    const stats = summarizeDemandCoverage([c1, c2, c3], map);
    expect(stats.total).toBe(3);
    expect(stats.cited).toBe(2);
    expect(stats.citedShare).toBeCloseTo(2 / 3, 10);
    expect(stats.meanDemandScore).toBeCloseTo((4 + 1 + 3) / 3, 10);
    expect(stats.meanWhitespace).toBeCloseTo((0.6 + 0 + 0.4) / 3, 10);
  });

  test("candidates with no artifact count toward total with zero contribution", () => {
    const c1 = candidate({ giant: { ...STRONG_SCORES } });
    const c2 = candidate({ giant: { ...STRONG_SCORES }, title: "Second" });
    const map = new Map<GeneratedIdeaCandidate, DemandArtifact>([
      [c1, artifact({ score: 4, whitespace: 0.5, evidence: [REDDIT_EVIDENCE] })],
    ]);
    const stats = summarizeDemandCoverage([c1, c2], map);
    expect(stats.total).toBe(2);
    expect(stats.cited).toBe(1);
    expect(stats.citedShare).toBeCloseTo(0.5, 10);
    expect(stats.meanDemandScore).toBeCloseTo(4 / 2, 10);
    expect(stats.meanWhitespace).toBeCloseTo(0.5 / 2, 10);
  });

  test("empty candidate set yields zeroed stats (no division by zero)", () => {
    const stats = summarizeDemandCoverage([], new Map());
    expect(stats).toEqual({
      total: 0,
      cited: 0,
      citedShare: 0,
      meanDemandScore: 0,
      meanWhitespace: 0,
    });
  });
});
