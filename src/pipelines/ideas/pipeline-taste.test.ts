import { test, expect, describe } from "bun:test";
import {
  rotationSeedFromRunId,
  toScoredIdeaRow,
  buildTasteBlocks,
  toScoredIdeaForProxy,
  type TasteBlocks,
} from "./pipeline";
import type { TasteConfig } from "../../config/schema";
import type { GeneratedIdeaCandidate } from "./types";
import type { DemandArtifact } from "./demand";

// ── PHASE 4 (taste loop) — pipeline-level wiring helpers ───────────────────────
//
// Pure tests for the cold-taste-loop helpers the pipeline owns: the per-run
// rotation seed, the generated_ideas → ScoredIdeaRow projection, the
// flag-gated golden + anti block builder, and the candidate → proxy-input
// projection. No DB / network — deterministic pure functions.

const TASTE_DEFAULT: TasteConfig = {
  antiExemplars: true,
  syntheticGolden: true,
  autoProxyLabels: true,
  calibrateGiantWeights: false,
  exemplarCount: 4,
  goldenMinHumanLabels: 10,
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

// ── rotationSeedFromRunId ─────────────────────────────────────────────────────

describe("rotationSeedFromRunId", () => {
  test("is deterministic for the same run id", () => {
    expect(rotationSeedFromRunId("run-abc")).toBe(rotationSeedFromRunId("run-abc"));
  });

  test("differs across distinct run ids (rotates the slice per run)", () => {
    expect(rotationSeedFromRunId("run-a")).not.toBe(rotationSeedFromRunId("run-b"));
  });

  test("returns a non-negative integer", () => {
    const seed = rotationSeedFromRunId("any-run-id-42");
    expect(Number.isInteger(seed)).toBe(true);
    expect(seed).toBeGreaterThanOrEqual(0);
  });

  test("handles the empty string", () => {
    expect(rotationSeedFromRunId("")).toBe(0);
  });
});

// ── toScoredIdeaRow ───────────────────────────────────────────────────────────

describe("toScoredIdeaRow", () => {
  test("unwraps the nested {scores:{}} GIANT blob stampIdeaGiant writes", () => {
    const row = toScoredIdeaRow({
      id: "i1",
      title: "T",
      summary: "S",
      category: "productivity",
      segment: "b2b_saas",
      giant_composite: 3.5,
      giant_scores_json: {
        scores: { acuteProblem: 4, nonObviousness: 3, defensibility: 2 },
        evidence: {},
      },
      archetype: "picks-and-shovels",
      demand_score: 3,
      whitespace: 0.4,
      pipeline_stage: "idea",
    });
    expect(row.giantScores?.acuteProblem).toBe(4);
    expect(row.giantScores?.defensibility).toBe(2);
    expect(row.giantComposite).toBe(3.5);
    expect(row.archetype).toBe("picks-and-shovels");
  });

  test("projects whitespace (REAL 0..1) onto the boolean grounding flag", () => {
    const present = toScoredIdeaRow({
      id: "i1",
      title: "T",
      summary: "S",
      category: null,
      segment: null,
      giant_composite: 3,
      giant_scores_json: null,
      archetype: null,
      demand_score: null,
      whitespace: 0.5,
      pipeline_stage: "idea",
    });
    expect(present.whitespace).toBe(true);

    const absent = toScoredIdeaRow({
      id: "i2",
      title: "T",
      summary: "S",
      category: null,
      segment: null,
      giant_composite: 3,
      giant_scores_json: null,
      archetype: null,
      demand_score: null,
      whitespace: 0,
      pipeline_stage: "idea",
    });
    expect(absent.whitespace).toBe(false);
  });

  test("null GIANT blob → null giantScores (partial rows degrade safely)", () => {
    const row = toScoredIdeaRow({
      id: "i1",
      title: "T",
      summary: "S",
      category: null,
      segment: null,
      giant_composite: null,
      giant_scores_json: null,
      archetype: null,
      demand_score: null,
      whitespace: null,
      pipeline_stage: null,
    });
    expect(row.giantScores).toBeNull();
    expect(row.whitespace).toBeNull();
  });
});

// ── buildTasteBlocks ──────────────────────────────────────────────────────────

const STRONG_ROW_JSON = {
  scores: {
    acuteProblem: 4,
    whyNow: 4,
    demand: 4,
    nonObviousness: 4,
    defensibility: 4,
    marketShape: 4,
    founderFit: 4,
  },
};

function strongScoredDbRow(id: string, segment: string) {
  return {
    id,
    title: `Grounded acute-problem tool ${id}`,
    summary: `A specific, dated, demand-backed product ${id}`,
    category: "productivity",
    segment,
    giant_composite: 4.2,
    giant_scores_json: STRONG_ROW_JSON,
    archetype: "picks-and-shovels",
    demand_score: 4,
    whitespace: 0.5,
    pipeline_stage: "idea",
  };
}

function genericScoredDbRow(id: string) {
  return {
    id,
    title: `AI-powered app for everything ${id}`,
    summary: "Helps people streamline their all-in-one workflow.",
    category: "productivity",
    segment: "consumer",
    giant_composite: 1.5,
    giant_scores_json: {
      scores: { nonObviousness: 1, defensibility: 1 },
    },
    archetype: null,
    demand_score: 0,
    whitespace: 0,
    pipeline_stage: "idea",
  };
}

describe("buildTasteBlocks", () => {
  test("produces a synthetic golden block when below the human-label threshold", () => {
    const rows = [
      strongScoredDbRow("g1", "b2b_saas"),
      strongScoredDbRow("g2", "devtools"),
      strongScoredDbRow("g3", "consumer"),
    ].map(toScoredIdeaRow);

    const blocks = buildTasteBlocks(rows, TASTE_DEFAULT, 0);
    expect(blocks.goldenCount).toBeGreaterThan(0);
    expect(blocks.syntheticGoldenCount).toBe(blocks.goldenCount);
    expect(blocks.goldenBlock).toContain("EXEMPLARS");
  });

  test("produces an anti block from generic / low-GIANT rows", () => {
    const rows = [
      genericScoredDbRow("a1"),
      genericScoredDbRow("a2"),
    ].map(toScoredIdeaRow);

    const blocks = buildTasteBlocks(rows, TASTE_DEFAULT, 0);
    expect(blocks.antiCount).toBeGreaterThan(0);
    expect(blocks.antiBlock).toContain("AVOID");
  });

  test("respects the LOW exemplarCount cap (anti-mode-collapse)", () => {
    const rows = Array.from({ length: 20 }, (_, i) =>
      strongScoredDbRow(`g${i}`, i % 2 === 0 ? "b2b_saas" : "devtools"),
    ).map(toScoredIdeaRow);

    const blocks = buildTasteBlocks(rows, { ...TASTE_DEFAULT, exemplarCount: 3 }, 0);
    expect(blocks.goldenCount).toBeLessThanOrEqual(3);
  });

  test("gates each lever independently (both off → empty blocks)", () => {
    const rows = [strongScoredDbRow("g1", "b2b_saas"), genericScoredDbRow("a1")].map(
      toScoredIdeaRow,
    );
    const off: TasteConfig = {
      ...TASTE_DEFAULT,
      antiExemplars: false,
      syntheticGolden: false,
    };
    const blocks: TasteBlocks = buildTasteBlocks(rows, off, 0);
    expect(blocks.goldenBlock).toBe("");
    expect(blocks.antiBlock).toBe("");
    expect(blocks.goldenCount).toBe(0);
    expect(blocks.antiCount).toBe(0);
  });

  test("rotation seed varies the golden slice across runs", () => {
    const rows = Array.from({ length: 12 }, (_, i) =>
      strongScoredDbRow(`g${i}`, "b2b_saas"),
    ).map(toScoredIdeaRow);

    const a = buildTasteBlocks(rows, { ...TASTE_DEFAULT, exemplarCount: 2 }, 0);
    const b = buildTasteBlocks(rows, { ...TASTE_DEFAULT, exemplarCount: 2 }, 7);
    // Same count, but the rotated slice should not be byte-identical.
    expect(a.goldenCount).toBe(b.goldenCount);
    expect(a.goldenBlock === b.goldenBlock).toBe(false);
  });
});

// ── toScoredIdeaForProxy ──────────────────────────────────────────────────────

describe("toScoredIdeaForProxy", () => {
  test("maps gate composite + demand artifact onto the proxy input", () => {
    const proxy = toScoredIdeaForProxy({
      ideaId: "i1",
      candidate: candidate({ giantComposite: 1.2 }),
      gate: { composite: 1.2, gated: true, gateReasons: ["acuteProblem"] },
      artifact: artifact({ score: 1, whitespace: 0, evidence: [] }),
      distinctSegments: 3,
    });
    expect(proxy.id).toBe("i1");
    expect(proxy.giantComposite).toBe(1.2);
    expect(proxy.demandScore).toBe(1);
    expect(proxy.whitespace).toBe(0);
    expect(proxy.distinctSegments).toBe(3);
  });

  test("derives hasSupplySignal when whitespace was discounted below demand intensity", () => {
    // score 4 → intensity 0.8; whitespace 0.2 < 0.8 ⇒ supply discounted it.
    const proxy = toScoredIdeaForProxy({
      ideaId: "i1",
      candidate: candidate(),
      artifact: artifact({
        score: 4,
        whitespace: 0.2,
        evidence: [
          { kind: "reddit_intent", query: "q", count: 3, sourceId: "r1" },
        ],
      }),
    });
    expect(proxy.hasSupplySignal).toBe(true);
  });

  test("hasSupplySignal is false when whitespace matches full demand intensity", () => {
    // score 4 → intensity 0.8; whitespace 0.8 ⇒ no supply discount.
    const proxy = toScoredIdeaForProxy({
      ideaId: "i1",
      candidate: candidate(),
      artifact: artifact({
        score: 4,
        whitespace: 0.8,
        evidence: [
          { kind: "reddit_intent", query: "q", count: 3, sourceId: "r1" },
        ],
      }),
    });
    expect(proxy.hasSupplySignal).toBe(false);
  });

  test("falls back to candidate.qualityScore when no gate / composite present", () => {
    const proxy = toScoredIdeaForProxy({
      ideaId: "i1",
      candidate: candidate({ qualityScore: 2.7 }),
    });
    expect(proxy.giantComposite).toBe(2.7);
    // Optional derived fields absent ⇒ their rules simply won't fire.
    expect(proxy.demandScore).toBeUndefined();
    expect(proxy.convergenceVeto).toBeUndefined();
  });

  test("threads convergenceVeto through when supplied", () => {
    const proxy = toScoredIdeaForProxy({
      ideaId: "i1",
      candidate: candidate(),
      convergenceVeto: true,
    });
    expect(proxy.convergenceVeto).toBe(true);
  });
});
