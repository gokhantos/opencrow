/**
 * Unit tests for outcome-competability-correlation.ts — pure correlation logic.
 *
 * Coverage:
 *   - highMoats: names dimensions >= HIGH_MOAT_THRESHOLD, strongest-first; empty when none.
 *   - buildMoatLearningsDirective:
 *       * AVOID line when MIN_CORRELATION_SAMPLES+ archived high-moat outcomes (with moat names).
 *       * REINFORCE line when MIN_CORRELATION_SAMPLES+ validated low-moat outcomes.
 *       * BOTH lines together when both sides have evidence.
 *       * below-floor sample counts emit nothing (noise guard).
 *       * no competability slice on any memory → "" (absent-data == today).
 *       * empty input → "".
 */

import { describe, test, expect } from "bun:test";
import {
  HIGH_MOAT_THRESHOLD,
  MIN_CORRELATION_SAMPLES,
  buildMoatLearningsDirective,
  highMoats,
} from "./outcome-competability-correlation";
import type { OutcomeCompetability, OutcomeMemory, RetrievedOutcome } from "./outcome-memory";

// ── fixtures ──────────────────────────────────────────────────────────────────

function competability(over: Partial<OutcomeCompetability> = {}): OutcomeCompetability {
  return {
    dimensions: { capital: 1, networkEffect: 1, logistics: 1, regulated: 1 },
    overall: 4,
    rawOverall: null,
    gated: false,
    matchedExpertiseDomain: null,
    ...over,
  };
}

function memory(over: Partial<OutcomeMemory> = {}): OutcomeMemory {
  return {
    kind: "idea-outcome",
    verdict: "validated",
    verdictSource: "human",
    ideaId: "idea-x",
    segment: "b2b-saas",
    archetype: "hair-on-fire",
    giantComposite: 3.5,
    failingAxes: [],
    juryDissent: null,
    convergenceVeto: false,
    demandScore: 4,
    whitespace: 0.5,
    competability: undefined,
    runId: "run-1",
    promptVersion: "v1",
    model: "m",
    createdAtSec: 1,
    ...over,
  };
}

function retrieved(m: OutcomeMemory): RetrievedOutcome {
  return { memory: "body", metadata: m, relevance: 1 };
}

/** A high-moat ARCHIVED outcome (low can-win + a dominant logistics moat). */
function archivedHighMoat(id: string): RetrievedOutcome {
  return retrieved(
    memory({
      ideaId: id,
      verdict: "archived",
      competability: competability({
        overall: 1.5,
        dimensions: { capital: 2, networkEffect: 1, logistics: 5, regulated: 1 },
      }),
    }),
  );
}

/** A low-moat VALIDATED outcome (wide-open: high can-win, no dominant moat). */
function validatedLowMoat(id: string): RetrievedOutcome {
  return retrieved(
    memory({
      ideaId: id,
      verdict: "validated",
      competability: competability({
        overall: 4.2,
        dimensions: { capital: 1, networkEffect: 1, logistics: 1, regulated: 1 },
      }),
    }),
  );
}

// ── highMoats ─────────────────────────────────────────────────────────────────

describe("highMoats", () => {
  test("names dimensions >= HIGH_MOAT_THRESHOLD, strongest first", () => {
    const c = competability({
      dimensions: { capital: 4, networkEffect: 5, logistics: 1, regulated: 3.5 },
    });
    expect(highMoats(c)).toEqual(["network", "capital", "regulated"]);
  });

  test("empty when no dimension is high", () => {
    const c = competability({
      dimensions: { capital: 1, networkEffect: 2, logistics: 3, regulated: 3.4 },
    });
    expect(highMoats(c)).toEqual([]);
  });

  test("threshold is inclusive at HIGH_MOAT_THRESHOLD", () => {
    const c = competability({
      dimensions: {
        capital: HIGH_MOAT_THRESHOLD,
        networkEffect: 0,
        logistics: 0,
        regulated: 0,
      },
    });
    expect(highMoats(c)).toEqual(["capital"]);
  });
});

// ── buildMoatLearningsDirective ───────────────────────────────────────────────

describe("buildMoatLearningsDirective", () => {
  test("empty input → empty string", () => {
    expect(buildMoatLearningsDirective([])).toBe("");
  });

  test("no competability slice on any memory → empty string (absent-data == today)", () => {
    const items = [
      retrieved(memory({ verdict: "validated", competability: undefined })),
      retrieved(memory({ verdict: "archived", competability: undefined })),
      retrieved(memory({ verdict: "validated", competability: undefined })),
    ];
    expect(buildMoatLearningsDirective(items)).toBe("");
  });

  test("emits AVOID line when MIN+ archived high-moat outcomes, naming moats", () => {
    const items = Array.from({ length: MIN_CORRELATION_SAMPLES }, (_, i) =>
      archivedHighMoat(`a-${i}`),
    );
    const out = buildMoatLearningsDirective(items);
    expect(out).toContain("MOAT LEARNINGS");
    expect(out).toContain("AVOID");
    expect(out).toContain(`${MIN_CORRELATION_SAMPLES} high-moat ideas were ARCHIVED`);
    expect(out).toContain("logistics");
    expect(out).not.toContain("REINFORCE");
  });

  test("emits REINFORCE line when MIN+ validated low-moat outcomes", () => {
    const items = Array.from({ length: MIN_CORRELATION_SAMPLES }, (_, i) =>
      validatedLowMoat(`v-${i}`),
    );
    const out = buildMoatLearningsDirective(items);
    expect(out).toContain("REINFORCE");
    expect(out).toContain(`${MIN_CORRELATION_SAMPLES} low-moat (wide-open) ideas were VALIDATED`);
    expect(out).not.toContain("AVOID");
  });

  test("emits BOTH lines when both sides clear the sample floor", () => {
    const items = [
      ...Array.from({ length: MIN_CORRELATION_SAMPLES }, (_, i) => archivedHighMoat(`a-${i}`)),
      ...Array.from({ length: MIN_CORRELATION_SAMPLES }, (_, i) => validatedLowMoat(`v-${i}`)),
    ];
    const out = buildMoatLearningsDirective(items);
    expect(out).toContain("AVOID");
    expect(out).toContain("REINFORCE");
  });

  test("below the sample floor emits nothing (noise guard)", () => {
    const items = [
      ...Array.from({ length: MIN_CORRELATION_SAMPLES - 1 }, (_, i) => archivedHighMoat(`a-${i}`)),
      ...Array.from({ length: MIN_CORRELATION_SAMPLES - 1 }, (_, i) => validatedLowMoat(`v-${i}`)),
    ];
    expect(buildMoatLearningsDirective(items)).toBe("");
  });

  test("does not count a validated high-moat as a low-moat reinforce signal", () => {
    // Validated but HIGH moat → not a "wide-open validated" signal.
    const items = Array.from({ length: MIN_CORRELATION_SAMPLES + 1 }, (_, i) =>
      retrieved(
        memory({
          ideaId: `vh-${i}`,
          verdict: "validated",
          competability: competability({
            overall: 4,
            dimensions: { capital: 1, networkEffect: 5, logistics: 1, regulated: 1 },
          }),
        }),
      ),
    );
    expect(buildMoatLearningsDirective(items)).toBe("");
  });
});
