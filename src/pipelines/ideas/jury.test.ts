import { test, expect, describe } from "bun:test";
import {
  anonymizeCandidates,
  rotateForJudge,
  parseJudgeResponse,
  judgeWithJury,
  fuseJury,
  median,
  trimmedMean,
  DEFAULT_JURY_PANEL,
  type JudgeResult,
  type JudgeScorecard,
  type JuryCandidate,
} from "./jury";
import {
  GIANT_AXIS_KEYS,
  AXIS_MAX,
  type GiantAxisScores,
} from "./giant";
import type { AgentResponse } from "../../agent/types";

// ── helpers ──────────────────────────────────────────────────────────────────

/** Build a full 7-axis score vector, defaulting every axis to `fill`. */
function scores(
  fill: number,
  overrides: Partial<GiantAxisScores> = {},
): GiantAxisScores {
  const out = {} as GiantAxisScores;
  for (const key of GIANT_AXIS_KEYS) out[key] = fill;
  return { ...out, ...overrides };
}

/** A judge result for one candidate at a uniform fill score. */
function card(
  candidateId: string,
  fill: number,
  overrides: Partial<GiantAxisScores> = {},
  hasDemandEvidence = false,
): JudgeScorecard {
  return { candidateId, scores: scores(fill, overrides), hasDemandEvidence };
}

function result(judge: string, scorecards: JudgeScorecard[]): JudgeResult {
  return { judge, scorecards };
}

function mockResponse(text: string): AgentResponse {
  return { text, provider: "anthropic" };
}

// ── anonymizeCandidates ──────────────────────────────────────────────────────

describe("anonymizeCandidates", () => {
  test("strips provenance fields so a judge cannot self-prefer", () => {
    const out = anonymizeCandidates([
      {
        id: "a1",
        title: "T",
        description: "D",
        author: "agent-7",
        proposedBy: "red-team",
        source: "claude-sonnet-4-6",
        expertScore: 0.9,
        provider: "anthropic",
        model: "claude-sonnet-4-6",
      },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ id: "a1", title: "T", description: "D" });
    // No provenance keys leaked.
    expect(Object.keys(out[0]!)).toEqual(["id", "title", "description"]);
  });

  test("falls back to summary for description and mints id when missing", () => {
    const out = anonymizeCandidates([{ title: "X", summary: "S" }]);
    expect(out[0]).toEqual({ id: "cand-0", title: "X", description: "S" });
  });

  test("omits description when neither description nor summary present", () => {
    const out = anonymizeCandidates([{ id: "z", title: "Q" }]);
    expect(out[0]).toEqual({ id: "z", title: "Q" });
    expect("description" in out[0]!).toBe(false);
  });
});

// ── rotateForJudge (position bias mitigation) ────────────────────────────────

describe("rotateForJudge", () => {
  test("rotates by offset", () => {
    expect(rotateForJudge([1, 2, 3, 4], 1)).toEqual([2, 3, 4, 1]);
    expect(rotateForJudge([1, 2, 3, 4], 2)).toEqual([3, 4, 1, 2]);
  });

  test("wraps offset modulo length and handles negatives", () => {
    expect(rotateForJudge([1, 2, 3], 3)).toEqual([1, 2, 3]);
    expect(rotateForJudge([1, 2, 3], 4)).toEqual([2, 3, 1]);
    expect(rotateForJudge([1, 2, 3], -1)).toEqual([3, 1, 2]);
  });

  test("is identity for empty/singleton lists and does not mutate input", () => {
    expect(rotateForJudge([], 5)).toEqual([]);
    expect(rotateForJudge([9], 5)).toEqual([9]);
    const src = [1, 2, 3];
    rotateForJudge(src, 1);
    expect(src).toEqual([1, 2, 3]);
  });

  test("every offset is a permutation (no candidate dropped or duplicated)", () => {
    const items = ["a", "b", "c", "d", "e"];
    for (let off = 0; off < items.length; off++) {
      const rotated = rotateForJudge(items, off);
      expect([...rotated].sort()).toEqual([...items].sort());
    }
  });
});

// ── parseJudgeResponse ───────────────────────────────────────────────────────

describe("parseJudgeResponse", () => {
  const ids = new Set(["a", "b"]);

  test("parses a fenced JSON array and binds by id", () => {
    const text =
      '```json\n[{"id":"a","scores":{"acuteProblem":4,"whyNow":3,"demand":2,"nonObviousness":5,"defensibility":1,"marketShape":2,"founderFit":3},"hasDemandEvidence":true}]\n```';
    const out = parseJudgeResponse(text, ids);
    expect(out).toHaveLength(1);
    expect(out[0]!.candidateId).toBe("a");
    expect(out[0]!.scores.acuteProblem).toBe(4);
    expect(out[0]!.hasDemandEvidence).toBe(true);
  });

  test("parses an unfenced array embedded in prose", () => {
    const text = 'here you go [{"id":"b","scores":{"acuteProblem":1}}] done';
    const out = parseJudgeResponse(text, ids);
    expect(out).toHaveLength(1);
    expect(out[0]!.candidateId).toBe("b");
    // Missing axes coerced to 0 via parseGiant.
    expect(out[0]!.scores.whyNow).toBe(0);
  });

  test("drops rows with unknown ids and de-dupes repeated ids", () => {
    const text =
      '[{"id":"a","scores":{}},{"id":"ghost","scores":{}},{"id":"a","scores":{}}]';
    const out = parseJudgeResponse(text, ids);
    expect(out.map((c) => c.candidateId)).toEqual(["a"]);
  });

  test("returns [] on malformed or array-less input (never throws)", () => {
    expect(parseJudgeResponse("not json at all", ids)).toEqual([]);
    expect(parseJudgeResponse("[ broken", ids)).toEqual([]);
    expect(parseJudgeResponse('{"id":"a"}', ids)).toEqual([]);
  });

  test("clamps out-of-range axis scores into [0,5]", () => {
    const text = '[{"id":"a","scores":{"acuteProblem":99,"whyNow":-4}}]';
    const out = parseJudgeResponse(text, ids);
    expect(out[0]!.scores.acuteProblem).toBe(AXIS_MAX);
    expect(out[0]!.scores.whyNow).toBe(0);
  });
});

// ── robust statistics ────────────────────────────────────────────────────────

describe("median", () => {
  test("odd and even length", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });
  test("empty -> 0 and does not mutate input", () => {
    expect(median([])).toBe(0);
    const src = [3, 1, 2];
    median(src);
    expect(src).toEqual([3, 1, 2]);
  });
  test("robust to a single extreme outlier", () => {
    expect(median([4, 4, 4, 100])).toBe(4);
  });
});

describe("trimmedMean", () => {
  test("drops single lowest and highest then averages", () => {
    // sorted [1,4,4,4,100] -> inner [4,4,4] -> 4
    expect(trimmedMean([4, 1, 4, 100, 4])).toBe(4);
  });
  test("falls back to plain mean for <=2 values", () => {
    expect(trimmedMean([2, 6])).toBe(4);
    expect(trimmedMean([5])).toBe(5);
    expect(trimmedMean([])).toBe(0);
  });
});

// ── fuseJury ─────────────────────────────────────────────────────────────────

describe("fuseJury", () => {
  test("single-judge fallback: keeps the vector, agreement 1, dissent 0", () => {
    const out = fuseJury([result("j1", [card("a", 3)])]);
    expect(out).toHaveLength(1);
    expect(out[0]!.candidateId).toBe("a");
    expect(out[0]!.giantScores).toEqual(scores(3));
    expect(out[0]!.juryAgreement).toBe(1);
    expect(out[0]!.dissent).toBe(0);
    expect(out[0]!.judgeCount).toBe(1);
  });

  test("median is robust to a single outlier judge", () => {
    // Three judges score axis-uniform 4,4,0; median per axis = 4.
    const verdicts = fuseJury([
      result("j1", [card("a", 4)]),
      result("j2", [card("a", 4)]),
      result("j3", [card("a", 0)]),
    ]);
    expect(verdicts[0]!.giantScores).toEqual(scores(4));
    expect(verdicts[0]!.judgeCount).toBe(3);
  });

  test("trimmed-mean method down-weights both extremes", () => {
    // Per axis samples [1,4,4,4,5] -> trim -> [4,4,4] -> 4.
    const verdicts = fuseJury(
      [
        result("j1", [card("a", 1)]),
        result("j2", [card("a", 4)]),
        result("j3", [card("a", 4)]),
        result("j4", [card("a", 4)]),
        result("j5", [card("a", 5)]),
      ],
      { method: "trimmed-mean" },
    );
    expect(verdicts[0]!.giantScores).toEqual(scores(4));
  });

  test("dissent equals the mean per-axis spread (max-min)", () => {
    // axis spread = 5-1 = 4 on every axis -> dissent 4.
    const verdicts = fuseJury([
      result("j1", [card("a", 1)]),
      result("j2", [card("a", 5)]),
    ]);
    expect(verdicts[0]!.dissent).toBeCloseTo(4, 10);
    // High dissent => low agreement (well below 1).
    expect(verdicts[0]!.juryAgreement).toBeLessThan(0.2);
  });

  test("perfect agreement yields agreement 1 and dissent 0", () => {
    const verdicts = fuseJury([
      result("j1", [card("a", 3)]),
      result("j2", [card("a", 3)]),
      result("j3", [card("a", 3)]),
    ]);
    expect(verdicts[0]!.dissent).toBe(0);
    expect(verdicts[0]!.juryAgreement).toBe(1);
  });

  test("partial disagreement: agreement between 0 and 1, dissent > 0", () => {
    // Disagree on ONE axis only (acuteProblem 1 vs 5), rest identical at 3.
    const verdicts = fuseJury([
      result("j1", [card("a", 3, { acuteProblem: 1 })]),
      result("j2", [card("a", 3, { acuteProblem: 5 })]),
    ]);
    const v = verdicts[0]!;
    expect(v.dissent).toBeGreaterThan(0);
    expect(v.dissent).toBeLessThan(4); // only one axis disagrees
    expect(v.juryAgreement).toBeGreaterThan(0);
    expect(v.juryAgreement).toBeLessThan(1);
  });

  test("juryScore is the non-compensatory GIANT composite (a near-zero axis tanks it)", () => {
    // Strong everywhere but acuteProblem near 0 -> composite far below 4.
    const verdicts = fuseJury([
      result("j1", [card("a", 4, { acuteProblem: 0 })]),
    ]);
    expect(verdicts[0]!.juryScore).toBeLessThan(2);
    expect(verdicts[0]!.juryScore).toBeGreaterThanOrEqual(0);
  });

  test("majority demand-evidence vote lifts the demand cap", () => {
    // demand=5 on every judge; 2 of 3 assert evidence -> majority -> not capped.
    const capped = fuseJury([
      result("j1", [card("a", 4, { demand: 5 }, false)]),
      result("j2", [card("a", 4, { demand: 5 }, false)]),
      result("j3", [card("a", 4, { demand: 5 }, false)]),
    ]);
    const lifted = fuseJury([
      result("j1", [card("a", 4, { demand: 5 }, true)]),
      result("j2", [card("a", 4, { demand: 5 }, true)]),
      result("j3", [card("a", 4, { demand: 5 }, false)]),
    ]);
    // With evidence, the demand axis isn't capped at 2 -> higher composite.
    expect(lifted[0]!.juryScore).toBeGreaterThan(capped[0]!.juryScore);
  });

  test("preserves candidate order of first appearance across judges", () => {
    const verdicts = fuseJury([
      result("j1", [card("b", 3), card("a", 3)]),
      result("j2", [card("a", 3), card("c", 3)]),
    ]);
    expect(verdicts.map((v) => v.candidateId)).toEqual(["b", "a", "c"]);
  });

  test("a candidate scored by only one judge still gets a verdict (graceful)", () => {
    const verdicts = fuseJury([
      result("j1", [card("a", 4), card("solo", 2)]),
      result("j2", [card("a", 2)]),
    ]);
    const solo = verdicts.find((v) => v.candidateId === "solo")!;
    expect(solo.judgeCount).toBe(1);
    expect(solo.juryAgreement).toBe(1);
    expect(solo.dissent).toBe(0);
  });

  test("empty input yields empty output", () => {
    expect(fuseJury([])).toEqual([]);
  });

  test("clamps fused axis scores into [0,5]", () => {
    // Out-of-range incoming scores must be clamped on the way in and out.
    const out = fuseJury([
      result("j1", [{ candidateId: "a", scores: scores(99), hasDemandEvidence: false }]),
    ]);
    for (const key of GIANT_AXIS_KEYS) {
      expect(out[0]!.giantScores[key]).toBeLessThanOrEqual(AXIS_MAX);
    }
  });
});

// ── judgeWithJury (orchestration, injected chat + secrets) ───────────────────

describe("judgeWithJury", () => {
  const cands: JuryCandidate[] = [
    { id: "c1", title: "Alpha", description: "first" },
    { id: "c2", title: "Beta", description: "second" },
  ];

  function uniformJudgeText(fill: number): string {
    const rows = cands.map(
      (c) =>
        `{"id":"${c.id}","scores":{"acuteProblem":${fill},"whyNow":${fill},"demand":${fill},"nonObviousness":${fill},"defensibility":${fill},"marketShape":${fill},"founderFit":${fill}},"hasDemandEvidence":false}`,
    );
    return `[${rows.join(",")}]`;
  }

  test("skips a judge whose required secret is absent", async () => {
    const results = await judgeWithJury(
      cands,
      [
        { label: "has-key", provider: "openrouter", model: "m", requiredSecret: "PRESENT" },
        { label: "no-key", provider: "alibaba", model: "m", requiredSecret: "MISSING" },
      ],
      {
        secretFn: async (k) => (k === "PRESENT" ? "sk-xxx" : undefined),
        chatFn: async () => mockResponse(uniformJudgeText(3)),
      },
    );
    expect(results.map((r) => r.judge)).toEqual(["has-key"]);
    expect(results[0]!.scorecards).toHaveLength(2);
  });

  test("a judge with no requiredSecret always runs (anthropic/OAuth path)", async () => {
    const results = await judgeWithJury(
      cands,
      [{ label: "anthropic", provider: "anthropic", model: "claude-sonnet-4-6" }],
      {
        secretFn: async () => undefined,
        chatFn: async () => mockResponse(uniformJudgeText(4)),
      },
    );
    expect(results).toHaveLength(1);
    expect(results[0]!.scorecards).toHaveLength(2);
  });

  test("a judge that throws is gracefully skipped (run never breaks)", async () => {
    let calls = 0;
    const results = await judgeWithJury(
      cands,
      [
        { label: "good", provider: "anthropic", model: "m" },
        { label: "bad", provider: "anthropic", model: "m" },
      ],
      {
        chatFn: async (_msgs, opts) => {
          calls++;
          if (opts.agentId === "jury:bad") throw new Error("provider down");
          return mockResponse(uniformJudgeText(3));
        },
      },
    );
    expect(calls).toBe(2);
    expect(results.map((r) => r.judge)).toEqual(["good"]);
  });

  test("a judge returning unparseable text is skipped", async () => {
    const results = await judgeWithJury(
      cands,
      [{ label: "garbage", provider: "anthropic", model: "m" }],
      { chatFn: async () => mockResponse("sorry, I cannot comply") },
    );
    expect(results).toEqual([]);
  });

  test("returns empty when no judge is available (caller falls back)", async () => {
    const results = await judgeWithJury(
      cands,
      [{ label: "x", provider: "openrouter", model: "m", requiredSecret: "NOPE" }],
      { secretFn: async () => undefined, chatFn: async () => mockResponse("[]") },
    );
    expect(results).toEqual([]);
  });

  test("returns empty for empty candidates or empty panel", async () => {
    expect(
      await judgeWithJury([], DEFAULT_JURY_PANEL, { chatFn: async () => mockResponse("[]") }),
    ).toEqual([]);
    expect(
      await judgeWithJury(cands, [], { chatFn: async () => mockResponse("[]") }),
    ).toEqual([]);
  });

  test("position-switches: each judge receives a distinct candidate order", async () => {
    const seenFirstIds: string[] = [];
    await judgeWithJury(
      cands,
      [
        { label: "j0", provider: "anthropic", model: "m" },
        { label: "j1", provider: "anthropic", model: "m" },
      ],
      {
        chatFn: async (msgs) => {
          // The prompt lists candidates "[#1] id=<first>" — capture which id is first.
          const m = msgs[0]!.content.match(/\[#1\] id=(\S+)/);
          if (m) seenFirstIds.push(m[1]!);
          return mockResponse(uniformJudgeText(3));
        },
      },
    );
    // Two judges, two candidates -> offsets 0 and 1 -> different first ids.
    expect(new Set(seenFirstIds).size).toBe(2);
    expect(seenFirstIds).toContain("c1");
    expect(seenFirstIds).toContain("c2");
  });

  test("end-to-end: judgeWithJury output fuses into a stable verdict", async () => {
    const results = await judgeWithJury(
      cands,
      [
        { label: "a", provider: "anthropic", model: "m" },
        { label: "b", provider: "anthropic", model: "m" },
      ],
      { chatFn: async () => mockResponse(uniformJudgeText(4)) },
    );
    const verdicts = fuseJury(results);
    expect(verdicts).toHaveLength(2);
    for (const v of verdicts) {
      expect(v.judgeCount).toBe(2);
      expect(v.juryAgreement).toBe(1);
      expect(v.dissent).toBe(0);
      expect(v.giantScores).toEqual(scores(4));
    }
  });
});

// ── DEFAULT_JURY_PANEL ───────────────────────────────────────────────────────

describe("DEFAULT_JURY_PANEL", () => {
  test("spans three distinct model-family providers", () => {
    const providers = new Set(DEFAULT_JURY_PANEL.map((j) => j.provider));
    expect(providers).toEqual(new Set(["anthropic", "openrouter", "alibaba"]));
  });
  test("non-anthropic judges are key-gated", () => {
    for (const j of DEFAULT_JURY_PANEL) {
      if (j.provider !== "anthropic") expect(j.requiredSecret).toBeTruthy();
    }
  });
});
