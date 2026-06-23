import { test, expect, describe } from "bun:test";
import {
  combineGiantScores,
  normalizeDissent,
  buildJuryPanel,
  buildPairwiseWins,
  paretoSelect,
  computeSigeConvergenceVeto,
  mapEvolvedEvaluation,
  synthesizeEnrichedSeed,
  type SigeSignals,
} from "./pipeline";
import { GIANT_DEFAULT_WEIGHTS, type GiantAxisScores } from "./giant";
import type { GeneratedIdeaCandidate } from "./types";

// ── PHASE 3 (SIGE hardening) — pure pipeline logic ─────────────────────────────
//
// These cover the NEW pure building blocks the hardened SIGE path composes around
// the impure jury/SIGE calls: jury fusion → GIANT combine, dissent normalization,
// the configured-panel mapper (graceful provider gating), position-switched
// pairwise vote construction, Pareto+Bradley-Terry top-K selection, the
// convergence-veto proxy, the evolved-child read-back mapper, and the
// always-non-empty enriched seed. No DB / network — deterministic.

const STRONG: GiantAxisScores = {
  acuteProblem: 4,
  whyNow: 4,
  demand: 4,
  monetization: 4,
  feasibility: 4,
  nonObviousness: 4,
  defensibility: 4,
  marketShape: 4,
  founderFit: 4,
};

const WEAK: GiantAxisScores = {
  acuteProblem: 1,
  whyNow: 1,
  demand: 1,
  monetization: 1,
  feasibility: 1,
  nonObviousness: 1,
  defensibility: 1,
  marketShape: 1,
  founderFit: 1,
};

function candidate(overrides: Partial<GeneratedIdeaCandidate> = {}): GeneratedIdeaCandidate {
  return {
    title: "Test idea",
    summary: "summary",
    reasoning: "reasoning",
    designDescription: "design",
    monetizationDetail: "monetization",
    sourceLinks: [],
    sourcesUsed: "sources",
    category: "productivity",
    qualityScore: 3,
    targetAudience: "audience",
    keyFeatures: ["a", "b"],
    revenueModel: "subscription",
    trendIntersection: "intersection",
    ...overrides,
  };
}

// ── combineGiantScores ─────────────────────────────────────────────────────────

describe("combineGiantScores", () => {
  test("returns undefined when neither source is present", () => {
    expect(combineGiantScores(undefined, undefined)).toBeUndefined();
  });

  test("returns the present source when only one is given", () => {
    expect(combineGiantScores(STRONG, undefined)).toEqual(STRONG);
    expect(combineGiantScores(undefined, WEAK)).toEqual(WEAK);
  });

  test("blends per-axis at the given jury weight", () => {
    const blended = combineGiantScores(STRONG, WEAK, 0.5);
    expect(blended).toBeDefined();
    // (4 + 1) / 2 = 2.5 on every axis
    for (const v of Object.values(blended!)) expect(v).toBeCloseTo(2.5);
  });

  test("jury weight 1 takes the jury vector; 0 takes SIGE", () => {
    expect(combineGiantScores(STRONG, WEAK, 1)).toEqual(WEAK);
    expect(combineGiantScores(STRONG, WEAK, 0)).toEqual(STRONG);
  });

  test("clamps an out-of-range weight", () => {
    expect(combineGiantScores(STRONG, WEAK, 5)).toEqual(WEAK);
    expect(combineGiantScores(STRONG, WEAK, -5)).toEqual(STRONG);
  });
});

// ── normalizeDissent ───────────────────────────────────────────────────────────

describe("normalizeDissent", () => {
  test("maps a 0..5 axis spread into [0,1]", () => {
    expect(normalizeDissent(0)).toBe(0);
    expect(normalizeDissent(2.5)).toBeCloseTo(0.5);
    expect(normalizeDissent(5)).toBe(1);
  });

  test("clamps over/under-range and treats undefined/NaN as 0", () => {
    expect(normalizeDissent(10)).toBe(1);
    expect(normalizeDissent(-3)).toBe(0);
    expect(normalizeDissent(undefined)).toBe(0);
    expect(normalizeDissent(Number.NaN)).toBe(0);
  });
});

// ── buildJuryPanel (graceful provider gating) ─────────────────────────────────

describe("buildJuryPanel", () => {
  test("maps known providers and gates non-anthropic on their secret", () => {
    const panel = buildJuryPanel([
      { provider: "anthropic", model: "claude-haiku-4-5" },
      { provider: "openrouter", model: "deepseek/deepseek-chat-v3.1" },
      { provider: "alibaba", model: "qwen3.5-plus" },
    ]);
    expect(panel).toHaveLength(3);
    const anthropic = panel.find((p) => p.provider === "anthropic");
    const openrouter = panel.find((p) => p.provider === "openrouter");
    expect(anthropic?.requiredSecret).toBeUndefined();
    expect(openrouter?.requiredSecret).toBe("OPENROUTER_API_KEY");
  });

  test("drops unknown providers and empty models", () => {
    const panel = buildJuryPanel([
      { provider: "mystery", model: "x" },
      { provider: "anthropic", model: "" },
      { provider: "anthropic", model: "claude-haiku-4-5" },
    ]);
    expect(panel).toHaveLength(1);
    expect(panel[0]!.model).toBe("claude-haiku-4-5");
  });

  test("falls back to the default panel when no entry is usable", () => {
    const panel = buildJuryPanel([{ provider: "nope", model: "" }]);
    expect(panel.length).toBeGreaterThan(0);
  });
});

// ── buildPairwiseWins (position-switched) ─────────────────────────────────────

describe("buildPairwiseWins", () => {
  test("emits two framings per ordered pair, winner = higher juryScore", () => {
    const wins = buildPairwiseWins([
      { candidateId: "a", juryScore: 4 },
      { candidateId: "b", juryScore: 2 },
    ]);
    expect(wins).toHaveLength(2);
    for (const w of wins) {
      expect(w.winner).toBe("a");
      expect(w.loser).toBe("b");
    }
  });

  test("emits no vote for a genuine tie", () => {
    const wins = buildPairwiseWins([
      { candidateId: "a", juryScore: 3 },
      { candidateId: "b", juryScore: 3 },
    ]);
    expect(wins).toHaveLength(0);
  });

  test("winner is symmetric to input order (position-bias defeat)", () => {
    const ab = buildPairwiseWins([
      { candidateId: "a", juryScore: 1 },
      { candidateId: "b", juryScore: 5 },
    ]);
    const ba = buildPairwiseWins([
      { candidateId: "b", juryScore: 5 },
      { candidateId: "a", juryScore: 1 },
    ]);
    expect(ab.every((w) => w.winner === "b")).toBe(true);
    expect(ba.every((w) => w.winner === "b")).toBe(true);
  });
});

// ── paretoSelect ───────────────────────────────────────────────────────────────

describe("paretoSelect", () => {
  test("returns all candidates unchanged when pool <= limit", () => {
    const cands = [candidate({ title: "x" }), candidate({ title: "y" })];
    const out = paretoSelect(cands, new Map(), 5, 0.3);
    expect(out).toHaveLength(2);
  });

  test("a high-quality but derivative idea can lose to an original peer", () => {
    // generic: top quality, zero originality. novel: equal quality, max originality.
    const generic = candidate({ title: "generic", originality: 0 });
    const novel = candidate({ title: "novel", originality: 1 });
    const filler1 = candidate({ title: "f1", originality: 0.1 });
    const filler2 = candidate({ title: "f2", originality: 0.1 });
    const signals = new Map<string, SigeSignals>([
      ["generic", { expertScore: 1, juryScore: 5 }],
      ["novel", { expertScore: 1, juryScore: 5 }],
      ["f1", { expertScore: 0.2, juryScore: 1 }],
      ["f2", { expertScore: 0.2, juryScore: 1 }],
    ]);
    const out = paretoSelect([generic, novel, filler1, filler2], signals, 2, 0.3);
    const titles = out.map((c) => c.title);
    // The novel idea dominates generic (equal quality, more originality) so it is
    // on the frontier and selected; both fillers are dominated.
    expect(titles).toContain("novel");
  });

  test("dissent shaves quality so a polarizing idea ranks below a calm peer", () => {
    const calm = candidate({ title: "calm", originality: 0.5 });
    const polar = candidate({ title: "polar", originality: 0.5 });
    const extra = candidate({ title: "extra", originality: 0.5 });
    const signals = new Map<string, SigeSignals>([
      ["calm", { expertScore: 0.8, juryScore: 4, dissent: 0 }],
      ["polar", { expertScore: 0.8, juryScore: 4, dissent: 1 }],
      ["extra", { expertScore: 0.1, juryScore: 1, dissent: 0 }],
    ]);
    const out = paretoSelect([polar, calm, extra], signals, 1, 0.5);
    expect(out[0]!.title).toBe("calm");
  });

  test("falls back to qualityScore when no signals exist", () => {
    const hi = candidate({ title: "hi", qualityScore: 5, originality: 0.5 });
    const lo = candidate({ title: "lo", qualityScore: 1, originality: 0.5 });
    const mid = candidate({ title: "mid", qualityScore: 2, originality: 0.5 });
    const out = paretoSelect([lo, hi, mid], new Map(), 1, 0.3);
    expect(out[0]!.title).toBe("hi");
  });

  test("degrades gracefully when the frontier is smaller than K", () => {
    const a = candidate({ title: "a", originality: 1 });
    const b = candidate({ title: "b", originality: 0.5 });
    const c = candidate({ title: "c", originality: 0.1 });
    const signals = new Map<string, SigeSignals>([
      ["a", { expertScore: 1, juryScore: 5 }],
      ["b", { expertScore: 0.5, juryScore: 3 }],
      ["c", { expertScore: 0.2, juryScore: 1 }],
    ]);
    const out = paretoSelect([a, b, c], signals, 2, 0.3);
    expect(out).toHaveLength(2);
    expect(out[0]!.title).toBe("a");
  });
});

// ── computeSigeConvergenceVeto ─────────────────────────────────────────────────

describe("computeSigeConvergenceVeto", () => {
  test("vetoes when jury agreement is near-unanimous (collapse risk)", () => {
    const signals = new Map<string, SigeSignals>([
      ["a", { expertScore: 0.9, juryAgreement: 0.99, dissent: 0 }],
      ["b", { expertScore: 0.9, juryAgreement: 0.98, dissent: 0 }],
    ]);
    const veto = computeSigeConvergenceVeto(signals, 0.85);
    expect(veto.vetoed).toBe(true);
    expect(veto.convergenceRate).toBeGreaterThanOrEqual(0.85);
  });

  test("does not veto a healthy, dissent-rich round", () => {
    const signals = new Map<string, SigeSignals>([
      ["a", { expertScore: 0.6, juryAgreement: 0.4, dissent: 0.5 }],
      ["b", { expertScore: 0.5, juryAgreement: 0.3, dissent: 0.6 }],
    ]);
    const veto = computeSigeConvergenceVeto(signals, 0.85);
    expect(veto.vetoed).toBe(false);
  });

  test("empty signals do not veto", () => {
    const veto = computeSigeConvergenceVeto(new Map(), 0.85);
    expect(veto.vetoed).toBe(false);
  });
});

// ── mapEvolvedEvaluation ───────────────────────────────────────────────────────

describe("mapEvolvedEvaluation", () => {
  test("maps an evolved child carrying description + evidenceRef + giant", () => {
    const child = mapEvolvedEvaluation({
      title: "Recombined idea",
      expertScore: 0.75,
      description: "A novel recombination",
      evidenceRef: ["hn_1", "producthunt_2"],
      giantScores: STRONG,
    });
    expect(child.title).toBe("Recombined idea");
    expect(child.summary).toBe("A novel recombination");
    expect(child.qualityScore).toBeCloseTo(4); // 1 + 0.75*4
    expect(child.supportingSignalIds).toEqual(["hn_1", "producthunt_2"]);
    expect(child.giant).toEqual(STRONG);
    expect(child.sourcesUsed).toContain("sige-evolved");
  });

  test("tolerates an evolved child with no description/evidence/giant", () => {
    const child = mapEvolvedEvaluation({ title: "Bare", expertScore: 0 });
    expect(child.title).toBe("Bare");
    expect(child.summary).toBe("");
    expect(child.qualityScore).toBe(1); // 1 + 0*4
    expect(child.supportingSignalIds).toBeUndefined();
    expect(child.giant).toBeUndefined();
  });
});

// ── synthesizeEnrichedSeed ─────────────────────────────────────────────────────

describe("synthesizeEnrichedSeed", () => {
  test("always returns a non-empty seed from the candidate pool", () => {
    const seed = synthesizeEnrichedSeed([
      candidate({ title: "Idea A", summary: "does X" }),
      candidate({ title: "Idea B", summary: "does Y" }),
    ]);
    expect(seed.length).toBeGreaterThan(0);
    expect(seed).toContain("Idea A");
    expect(seed).toContain("Idea B");
  });

  test("returns a non-empty placeholder even for an empty pool", () => {
    const seed = synthesizeEnrichedSeed([]);
    expect(seed.length).toBeGreaterThan(0);
  });
});

// Touch GIANT_DEFAULT_WEIGHTS so the import is meaningful for composite intent.
test("GIANT default weights are present (composite uses them via aggregateGiant)", () => {
  expect(Object.keys(GIANT_DEFAULT_WEIGHTS).length).toBe(9);
});
