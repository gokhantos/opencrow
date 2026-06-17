import { test, expect, describe } from "bun:test";
import { parseJudgeVerdicts, verdictToSubscores } from "./judge";
import { parseCritiqueSubscores } from "./store";

// ── parseJudgeVerdicts (pure) ───────────────────────────────────────────────────

describe("parseJudgeVerdicts", () => {
  test("parses and clamps scores, accepts snake_case grounding", () => {
    const verdicts = parseJudgeVerdicts({
      verdicts: [
        { id: "a", novelty: 1.4, feasibility: -0.2, signal_grounding: 0.6, rationale: "x" },
      ],
    });
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]).toEqual({
      id: "a",
      novelty: 1, // clamped
      feasibility: 0, // clamped
      signalGrounding: 0.6,
      rationale: "x",
    });
  });

  test("accepts camelCase signalGrounding fallback", () => {
    const v = parseJudgeVerdicts({ verdicts: [{ id: "a", signalGrounding: 0.3 }] });
    expect(v[0]!.signalGrounding).toBe(0.3);
  });

  test("coerces string scores", () => {
    const v = parseJudgeVerdicts({ verdicts: [{ id: "a", novelty: "0.5" }] });
    expect(v[0]!.novelty).toBe(0.5);
  });

  test("drops entries without a valid id", () => {
    const v = parseJudgeVerdicts({
      verdicts: [{ novelty: 0.5 }, { id: "  ", novelty: 0.5 }, { id: "b", novelty: 0.5 }],
    });
    expect(v).toHaveLength(1);
    expect(v[0]!.id).toBe("b");
  });

  test("non-array verdicts → empty", () => {
    expect(parseJudgeVerdicts({ verdicts: "nope" })).toEqual([]);
    expect(parseJudgeVerdicts({})).toEqual([]);
  });

  test("missing scores default to 0", () => {
    const v = parseJudgeVerdicts({ verdicts: [{ id: "a" }] });
    expect(v[0]).toEqual({
      id: "a",
      novelty: 0,
      feasibility: 0,
      signalGrounding: 0,
      rationale: "",
    });
  });
});

// ── verdictToSubscores ──────────────────────────────────────────────────────────

describe("verdictToSubscores", () => {
  test("maps verdict to critique subscores shape", () => {
    const sub = verdictToSubscores({
      id: "a",
      novelty: 0.7,
      feasibility: 0.8,
      signalGrounding: 0.9,
      rationale: "r",
    });
    expect(sub).toEqual({ novelty: 0.7, feasibility: 0.8, signalGrounding: 0.9 });
  });
});

// ── parseCritiqueSubscores (pure) ───────────────────────────────────────────────

describe("parseCritiqueSubscores", () => {
  test("null / undefined → null", () => {
    expect(parseCritiqueSubscores(null)).toBeNull();
    expect(parseCritiqueSubscores(undefined)).toBeNull();
  });

  test("parses JSON string", () => {
    expect(parseCritiqueSubscores('{"signalGrounding":0.7}')).toEqual({
      signalGrounding: 0.7,
    });
  });

  test("accepts already-parsed object (JSONB)", () => {
    expect(parseCritiqueSubscores({ novelty: 0.5, feasibility: 0.6 })).toEqual({
      novelty: 0.5,
      feasibility: 0.6,
    });
  });

  test("drops non-numeric fields", () => {
    expect(
      parseCritiqueSubscores({ novelty: 0.5, label: "x", bad: null }),
    ).toEqual({ novelty: 0.5 });
  });

  test("malformed JSON → null", () => {
    expect(parseCritiqueSubscores("{not json")).toBeNull();
  });

  test("empty object → null", () => {
    expect(parseCritiqueSubscores({})).toBeNull();
    expect(parseCritiqueSubscores("{}")).toBeNull();
  });

  test("'null' string and empty string → null", () => {
    expect(parseCritiqueSubscores("null")).toBeNull();
    expect(parseCritiqueSubscores("")).toBeNull();
  });

  test("array → null (not a subscores object)", () => {
    expect(parseCritiqueSubscores([1, 2])).toBeNull();
  });

  test("ignores non-finite numbers", () => {
    expect(parseCritiqueSubscores({ novelty: Number.NaN, feasibility: 0.5 })).toEqual({
      feasibility: 0.5,
    });
  });
});
