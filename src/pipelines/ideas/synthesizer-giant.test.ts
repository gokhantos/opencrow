import { test, expect, describe } from "bun:test";
import { hasDemandEvidence, compositeToQualityScore } from "./synthesizer";
import { parseGiant, type ParsedGiant } from "./giant";

// ── hasDemandEvidence (demand evidence-gate input) ─────────────────────────
//
// Un-evidenced demand must stay capped (returns false); a cited demand artifact
// OR a signal-bound whyNow shift counts as evidence (returns true). Pure.

function giantWith(overrides: {
  demandEvidence?: string;
  whyNow?: ParsedGiant["whyNow"];
}): ParsedGiant {
  return parseGiant({
    scores: {
      acuteProblem: 4,
      whyNow: 4,
      demand: 5,
      nonObviousness: 3,
      defensibility: 3,
      marketShape: 3,
      founderFit: 3,
    },
    archetype: "hair-on-fire",
    whyNow: overrides.whyNow ?? [],
    evidence: { demand: overrides.demandEvidence ?? "" },
  });
}

describe("hasDemandEvidence", () => {
  test("false when demand evidence is empty and no signal-bound whyNow", () => {
    expect(hasDemandEvidence(giantWith({}))).toBe(false);
  });

  test("false when demand evidence is only whitespace", () => {
    expect(hasDemandEvidence(giantWith({ demandEvidence: "   " }))).toBe(false);
  });

  test("true when a non-empty demand evidence citation exists", () => {
    expect(
      hasDemandEvidence(
        giantWith({ demandEvidence: "1.2k jobs posted on LinkedIn in Q1" }),
      ),
    ).toBe(true);
  });

  test("true when a whyNow shift is bound to a real signal id", () => {
    expect(
      hasDemandEvidence(
        giantWith({
          whyNow: [
            {
              axis: "behavioral",
              claim: "spike in waitlist signups",
              boundSignalId: "producthunt_2",
              strength: 0.8,
            },
          ],
        }),
      ),
    ).toBe(true);
  });

  test("false when a whyNow shift exists but is not signal-bound", () => {
    expect(
      hasDemandEvidence(
        giantWith({
          whyNow: [{ axis: "technological", claim: "AI got cheaper", strength: 0.6 }],
        }),
      ),
    ).toBe(false);
  });
});

// ── compositeToQualityScore (GIANT composite -> legacy qualityScore) ────────
//
// The composite is already on a 0..5 scale; the derivation is an identity clamp
// into [0, 5] so existing downstream sort/MMR/persistence keep working. Pure.

describe("compositeToQualityScore", () => {
  test("passes a mid-range composite through unchanged", () => {
    expect(compositeToQualityScore(3.27)).toBeCloseTo(3.27, 5);
  });

  test("passes the bounds through unchanged", () => {
    expect(compositeToQualityScore(0)).toBe(0);
    expect(compositeToQualityScore(5)).toBe(5);
  });

  test("clamps an above-range composite to 5", () => {
    expect(compositeToQualityScore(7.5)).toBe(5);
  });

  test("clamps a below-range composite to 0", () => {
    expect(compositeToQualityScore(-2)).toBe(0);
  });

  test("maps a non-finite composite to 0 (never NaN downstream)", () => {
    expect(compositeToQualityScore(Number.NaN)).toBe(0);
    expect(compositeToQualityScore(Number.POSITIVE_INFINITY)).toBe(0);
  });
});
