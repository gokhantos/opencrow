import { describe, expect, it } from "bun:test";
import {
  computeLessonLifts,
  computeLiftDelta,
  graphPathsToLessons,
  lessonKey,
  outcomeItemsToLessons,
  renderGraphPathText,
  safeRate,
  toArmRates,
  type ArmCounts,
} from "./lift-attribution";
import type { RetrievedOutcome } from "./outcome-memory";
import type { GraphPath } from "../../sige/knowledge/neo4j-client";

const outcome = (memory: string, ideaId: string | null): RetrievedOutcome => ({
  memory,
  relevance: 0,
  metadata: {
    kind: "idea-outcome",
    verdict: "validated",
    verdictSource: "human",
    ideaId,
    segment: null,
    archetype: null,
    giantComposite: null,
    failingAxes: [],
    juryDissent: null,
    convergenceVeto: false,
    demandScore: null,
    whitespace: null,
    runId: "r",
    promptVersion: "v",
    model: "m",
    createdAtSec: 0,
  },
});

describe("safeRate", () => {
  it("guards divide-by-zero", () => {
    expect(safeRate(5, 0)).toBe(0);
    expect(safeRate(0, 0)).toBe(0);
    expect(safeRate(3, 6)).toBe(0.5);
  });
});

describe("toArmRates", () => {
  it("projects counts into guarded rates", () => {
    const counts: ArmCounts = { runs: 4, ideas: 10, validated: 3, kept: 8 };
    expect(toArmRates(counts)).toEqual({
      runs: 4,
      ideas: 10,
      validatedRate: 0.3,
      keptRate: 0.8,
    });
  });

  it("returns zero rates for an empty (zero-idea) arm", () => {
    const counts: ArmCounts = { runs: 0, ideas: 0, validated: 0, kept: 0 };
    expect(toArmRates(counts)).toEqual({
      runs: 0,
      ideas: 0,
      validatedRate: 0,
      keptRate: 0,
    });
  });
});

describe("computeLiftDelta", () => {
  it("computes guided-minus-blind validated/kept lift", () => {
    const guided: ArmCounts = { runs: 5, ideas: 20, validated: 8, kept: 18 };
    const blind: ArmCounts = { runs: 5, ideas: 20, validated: 4, kept: 16 };
    const delta = computeLiftDelta(guided, blind);
    expect(delta.validatedLift).toBeCloseTo(0.4 - 0.2, 10);
    expect(delta.keptLift).toBeCloseTo(0.9 - 0.8, 10);
  });

  it("is safe on empty windows (both arms zero)", () => {
    const empty: ArmCounts = { runs: 0, ideas: 0, validated: 0, kept: 0 };
    const delta = computeLiftDelta(empty, empty);
    expect(delta.validatedLift).toBe(0);
    expect(delta.keptLift).toBe(0);
  });
});

describe("computeLessonLifts", () => {
  it("computes each lesson's rate vs the baseline, divide-by-zero guarded", () => {
    const lifts = computeLessonLifts(
      [
        { lessonKey: "k1", lessonKind: "reinforce", lessonText: "a", runs: 2, ideas: 10, validated: 5 },
        { lessonKey: "k2", lessonKind: "avoid", lessonText: "b", runs: 1, ideas: 0, validated: 0 },
      ],
      0.3,
    );
    expect(lifts[0]?.validatedRate).toBe(0.5);
    expect(lifts[0]?.liftVsBaseline).toBeCloseTo(0.2, 10);
    expect(lifts[1]?.validatedRate).toBe(0); // ideas=0 → guarded
    expect(lifts[1]?.liftVsBaseline).toBeCloseTo(-0.3, 10);
  });
});

describe("outcomeItemsToLessons", () => {
  it("maps reinforce/avoid items, carrying source idea id when present", () => {
    const lessons = outcomeItemsToLessons(
      [outcome("validated pattern", "idea-1")],
      [outcome("archived pattern", null)],
    );
    expect(lessons).toEqual([
      { kind: "reinforce", text: "validated pattern", sourceIdeaId: "idea-1" },
      { kind: "avoid", text: "archived pattern", sourceIdeaId: null },
    ]);
  });
});

describe("graph path rendering", () => {
  const path: GraphPath = {
    seed: "slow sync",
    steps: [
      { rel: "RELATES_TO", node: "offline mode" },
      { rel: "ENABLES", node: "local-first" },
    ],
  };

  it("renders a stable chain string", () => {
    expect(renderGraphPathText(path)).toBe("slow sync —RELATES_TO→ offline mode —ENABLES→ local-first");
  });

  it("maps paths onto graph_path lessons", () => {
    const lessons = graphPathsToLessons([path]);
    expect(lessons).toHaveLength(1);
    expect(lessons[0]?.kind).toBe("graph_path");
    expect(lessons[0]?.sourceIdeaId).toBeNull();
  });
});

describe("lessonKey", () => {
  it("is stable for identical (kind, text) and differs across kind/text", () => {
    expect(lessonKey("reinforce", "abc")).toBe(lessonKey("reinforce", "abc"));
    expect(lessonKey("reinforce", "abc")).not.toBe(lessonKey("avoid", "abc"));
    expect(lessonKey("reinforce", "abc")).not.toBe(lessonKey("reinforce", "xyz"));
  });
});
