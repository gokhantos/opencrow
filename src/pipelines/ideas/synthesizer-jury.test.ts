import { describe, expect, test } from "bun:test";
import { GIANT_AXIS_KEYS, type GiantAxisScores } from "./giant";
import type { JudgeModel, JudgeResult } from "./jury";
import {
  DEFAULT_JURY_PENALTY_WEIGHT,
  applyIndependentJuryPenalty,
  applyMinLeanPenalty,
  giantCompositeOf,
} from "./synthesizer-jury";
import type { GeneratedIdeaCandidate } from "./types";
import type { AgentResponse } from "../../agent/types";

// ── pure min-lean penalty math ───────────────────────────────────────────────

describe("applyMinLeanPenalty", () => {
  test("jury BELOW giant ⇒ penalized < giant, proportional to gap × agreement", () => {
    // giant 4.0, jury 2.0, full agreement, λ=0.7 ⇒ 4 - 0.7*1*(4-2) = 2.6
    expect(applyMinLeanPenalty(4, 2, 1, 0.7)).toBeCloseTo(2.6, 6);
    // a LARGER gap ⇒ a LARGER pull (jury 1.0): 4 - 0.7*1*(4-1) = 1.9
    expect(applyMinLeanPenalty(4, 1, 1, 0.7)).toBeCloseTo(1.9, 6);
    // both are below the giant
    expect(applyMinLeanPenalty(4, 2, 1, 0.7)).toBeLessThan(4);
  });

  test("jury AT or ABOVE giant ⇒ UNCHANGED (never inflates)", () => {
    expect(applyMinLeanPenalty(3, 3, 1, 0.7)).toBeCloseTo(3, 6); // equal
    expect(applyMinLeanPenalty(3, 4.5, 1, 0.7)).toBeCloseTo(3, 6); // jury higher
    expect(applyMinLeanPenalty(3, 5, 1, 0.7)).toBeCloseTo(3, 6); // jury max
  });

  test("LOW agreement ⇒ WEAK penalty (confidence-weighted)", () => {
    const high = applyMinLeanPenalty(4, 2, 1.0, 0.7); // 2.6
    const low = applyMinLeanPenalty(4, 2, 0.2, 0.7); // 4 - 0.7*0.2*2 = 3.72
    expect(low).toBeGreaterThan(high);
    expect(low).toBeCloseTo(3.72, 6);
    // zero agreement ⇒ no pull at all
    expect(applyMinLeanPenalty(4, 1, 0, 0.7)).toBeCloseTo(4, 6);
  });

  test("λ scales the maximum pull", () => {
    expect(applyMinLeanPenalty(4, 1, 1, 0)).toBeCloseTo(4, 6); // λ=0 ⇒ no penalty
    expect(applyMinLeanPenalty(4, 1, 1, 1)).toBeCloseTo(1, 6); // λ=1 ⇒ pull to jury
    // default λ when omitted
    expect(applyMinLeanPenalty(4, 1, 1)).toBeCloseTo(
      applyMinLeanPenalty(4, 1, 1, DEFAULT_JURY_PENALTY_WEIGHT),
      6,
    );
  });

  test("clamps to 0..5 and handles non-finite inputs", () => {
    expect(applyMinLeanPenalty(10, 10, 1, 0.7)).toBe(5); // clamp high (no shortfall, giant>5)
    expect(applyMinLeanPenalty(-3, -5, 1, 0.7)).toBe(0); // clamp low
    expect(applyMinLeanPenalty(Number.NaN, 2, 1, 0.7)).toBe(0); // bad giant ⇒ 0
    expect(applyMinLeanPenalty(4, Number.NaN, 1, 0.7)).toBeCloseTo(4, 6); // bad jury ⇒ giant
    expect(applyMinLeanPenalty(4, 2, Number.NaN, 0.7)).toBeCloseTo(4, 6); // bad agreement ⇒ no pull
    expect(applyMinLeanPenalty(4, 2, 1, Number.NaN)).toBeCloseTo(
      applyMinLeanPenalty(4, 2, 1, DEFAULT_JURY_PENALTY_WEIGHT),
      6,
    ); // bad λ ⇒ default
  });
});

describe("giantCompositeOf", () => {
  test("prefers giantComposite, falls back to qualityScore, then 0", () => {
    expect(giantCompositeOf(cand("a", 3, 4.2))).toBeCloseTo(4.2, 6);
    expect(giantCompositeOf(cand("b", 3))).toBeCloseTo(3, 6); // no giantComposite
    expect(giantCompositeOf(cand("c", Number.NaN))).toBe(0);
  });
});

// ── orchestration with an injected (mocked) jury — no live provider key ───────

function cand(
  title: string,
  qualityScore: number,
  giantComposite?: number,
): GeneratedIdeaCandidate {
  return {
    title,
    summary: `${title} summary`,
    reasoning: "",
    designDescription: "",
    monetizationDetail: "",
    sourceLinks: [],
    sourcesUsed: "",
    category: "",
    qualityScore,
    targetAudience: "",
    keyFeatures: [],
    revenueModel: "",
    trendIntersection: "",
    ...(giantComposite !== undefined ? { giantComposite } : {}),
  };
}

function axisScores(fill: number): GiantAxisScores {
  const out = {} as GiantAxisScores;
  for (const key of GIANT_AXIS_KEYS) out[key] = fill;
  return out;
}

/**
 * A judge response that scores `lowIds` at a LOW uniform fill and everything
 * else at a HIGH uniform fill, keyed by the anonymized candidate id the jury
 * passes through (the lowercased title join id).
 */
function judgeText(ids: readonly string[], lowIds: ReadonlySet<string>): string {
  const cards = ids.map((id) => {
    const s = axisScores(lowIds.has(id) ? 1 : 5);
    return {
      id,
      scores: s,
      hasDemandEvidence: false,
    };
  });
  return JSON.stringify(cards);
}

const TEST_PANEL: readonly JudgeModel[] = [
  { label: "test-judge", provider: "anthropic", model: "claude-sonnet-4-6" },
];

function mockResponse(text: string): AgentResponse {
  return { text, provider: "anthropic" };
}

describe("applyIndependentJuryPenalty", () => {
  test("EMPTY panel ⇒ candidates UNCHANGED (the common local, no-key case)", async () => {
    const cands = [cand("Self-Inflated Idea", 4.5, 4.5), cand("Honest Idea", 3, 3)];
    const out = await applyIndependentJuryPenalty(cands, []);
    expect(out.candidates).toBe(cands); // same reference — untouched
    expect(out.stats.judges).toBe(0);
    expect(out.stats.penalized).toBe(0);
  });

  test("jury returns NOTHING (no provider key) ⇒ UNCHANGED, never zeroed", async () => {
    const cands = [cand("Idea A", 4.5, 4.5)];
    const out = await applyIndependentJuryPenalty(cands, TEST_PANEL, {
      secretFn: async () => undefined, // no key ⇒ judge skipped
      chatFn: async () => mockResponse("[]"),
    });
    expect(out.candidates).toBe(cands);
    expect(out.candidates[0]!.qualityScore).toBe(4.5);
    expect(out.stats.judges).toBe(0);
  });

  test("end-to-end: pulls DOWN the self-inflated idea, leaves the agreed one", async () => {
    const inflated = cand("Self-Inflated Idea", 4.8, 4.8);
    const honest = cand("Honest Idea", 2.0, 2.0);
    const cands = [inflated, honest];

    const lowIds = new Set([inflated.title.toLowerCase().trim()]);

    const out = await applyIndependentJuryPenalty(cands, TEST_PANEL, {
      // Anthropic via SDK/OAuth: no requiredSecret ⇒ judge attempts; provide a
      // key anyway so availability is deterministic regardless of env.
      secretFn: async () => "sk-test",
      chatFn: async (_msgs, _opts) => {
        const ids = cands.map((c) => c.title.toLowerCase().trim());
        return mockResponse(judgeText(ids, lowIds));
      },
      lambda: 0.7,
    });

    const byTitle = new Map(out.candidates.map((c) => [c.title, c] as const));
    const newInflated = byTitle.get(inflated.title)!;
    const newHonest = byTitle.get(honest.title)!;

    // Self-inflated idea (giant 4.8, jury ~1) is pulled DOWN hard.
    expect(newInflated.qualityScore).toBeLessThan(inflated.qualityScore);
    // Honest idea (giant 2.0, jury ~5 ≥ giant) is UNCHANGED — no inflation.
    expect(newHonest.qualityScore).toBeCloseTo(honest.qualityScore, 6);

    expect(out.stats.judges).toBe(1);
    expect(out.stats.penalized).toBe(1);
    expect(out.stats.meanPenalty).toBeGreaterThan(0);
  });

  test("a malformed judge response degrades gracefully (UNCHANGED)", async () => {
    const cands = [cand("Idea A", 4.5, 4.5)];
    const out = await applyIndependentJuryPenalty(cands, TEST_PANEL, {
      secretFn: async () => "sk-test",
      chatFn: async () => mockResponse("not json at all"),
    });
    // No parseable scorecards ⇒ no verdicts ⇒ unchanged.
    expect(out.candidates[0]!.qualityScore).toBe(4.5);
  });
});

// Touch JudgeResult so the type import is exercised (keeps the import honest).
const _typeProbe: JudgeResult | undefined = undefined;
void _typeProbe;
