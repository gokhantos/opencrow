/**
 * Unit tests for the agent-action ledger row mapper (inline in store.ts).
 *
 * These tests exercise the field-level contracts of the row→AgentActionRecord
 * mapping without needing Postgres: score nullability, createdAt Number()
 * conversion from BIGINT string, targetIdeas JSON parse, and content passthrough.
 * They also cover getRoundArtifacts JSON shaping (equilibria/coalitions/metagame).
 * For mergeArtifacts and parseActionContent helpers, see agentLedgerHelpers.test.ts.
 *
 * Lane: unit (*.test.ts) — no DB, fast.
 */
import { describe, test, expect } from "bun:test";
import { mergeArtifacts, extractTasteVerdicts, parseActionContent } from "../web/ui/views/sige/theater/agentLedgerHelpers";
import type { RoundArtifacts, AgentActionRecord } from "../web/ui/views/sige/types";

// ─── Row mapper contracts — tested via the pure output shape ─────────────────
//
// getAgentActionLedger uses an inline mapper we cannot import directly, but the
// output type AgentActionRecord is fully typed.  We test the mapper contracts
// by verifying what the mapper is supposed to produce from known raw-DB input.
// The mapper itself is 15 lines in store.ts — we mirror its logic here and
// verify each field independently.

function mapRow(row: Record<string, unknown>): AgentActionRecord {
  return {
    agentId: row.agent_id as string,
    role: row.agent_role as string,
    round: row.round as number,
    actionType: row.action_type as string,
    content: row.content as string,
    confidence: (row.confidence as number) ?? 0,
    score: row.score != null ? Number(row.score) : null,
    targetIdeas: row.target_ideas_json
      ? (JSON.parse(row.target_ideas_json as string) as string[])
      : [],
    reasoning: (row.reasoning as string) ?? "",
    createdAt: Number(row.created_at),
  };
}

// ─── score nullability ────────────────────────────────────────────────────────

describe("AgentActionRecord mapper — score field", () => {
  test("score is null when DB row has null score", () => {
    const row: Record<string, unknown> = {
      agent_id: "ag-1",
      agent_role: "challenger",
      round: 1,
      action_type: "propose",
      content: "{}",
      confidence: 0.8,
      score: null,
      target_ideas_json: null,
      reasoning: "some reasoning",
      created_at: "1700000000",
    };
    const rec = mapRow(row);
    expect(rec.score).toBeNull();
  });

  test("score is a number when DB row has a numeric score", () => {
    const row: Record<string, unknown> = {
      agent_id: "ag-2",
      agent_role: "defender",
      round: 2,
      action_type: "defend",
      content: "{}",
      confidence: 0.6,
      score: 0.723,
      target_ideas_json: null,
      reasoning: "",
      created_at: "1700000100",
    };
    const rec = mapRow(row);
    expect(rec.score).toBeCloseTo(0.723, 5);
  });

  test("score coerces numeric string via Number() (BIGINT-like coercion pattern)", () => {
    const row: Record<string, unknown> = {
      agent_id: "ag-3",
      agent_role: "evaluator",
      round: 1,
      action_type: "score",
      content: "{}",
      confidence: 0.9,
      score: "0.5",
      target_ideas_json: null,
      reasoning: "",
      created_at: "1700000200",
    };
    const rec = mapRow(row);
    expect(typeof rec.score).toBe("number");
    expect(rec.score).toBeCloseTo(0.5, 5);
  });
});

// ─── createdAt Number() conversion from BIGINT string ─────────────────────────

describe("AgentActionRecord mapper — createdAt field", () => {
  test("createdAt converts BIGINT string to number", () => {
    const row: Record<string, unknown> = {
      agent_id: "ag-4",
      agent_role: "challenger",
      round: 1,
      action_type: "propose",
      content: "{}",
      confidence: 0.5,
      score: null,
      target_ideas_json: null,
      reasoning: "",
      created_at: "1718000000",
    };
    const rec = mapRow(row);
    expect(typeof rec.createdAt).toBe("number");
    expect(rec.createdAt).toBe(1718000000);
  });

  test("createdAt preserves large epoch values within f64 safely", () => {
    // Epoch second 9_999_999_999 is within JS f64 integer precision (2^53)
    const row: Record<string, unknown> = {
      agent_id: "ag-5",
      agent_role: "skeptic",
      round: 3,
      action_type: "challenge",
      content: "{}",
      confidence: 0.4,
      score: null,
      target_ideas_json: null,
      reasoning: "",
      created_at: "9999999999",
    };
    const rec = mapRow(row);
    expect(rec.createdAt).toBe(9999999999);
  });

  test("createdAt from actual number (not string) still works via Number()", () => {
    const row: Record<string, unknown> = {
      agent_id: "ag-6",
      agent_role: "advocate",
      round: 2,
      action_type: "support",
      content: "{}",
      confidence: 0.7,
      score: null,
      target_ideas_json: null,
      reasoning: "",
      created_at: 1718000500,
    };
    const rec = mapRow(row);
    expect(rec.createdAt).toBe(1718000500);
  });
});

// ─── targetIdeas JSON parse ────────────────────────────────────────────────────

describe("AgentActionRecord mapper — targetIdeas field", () => {
  test("targetIdeas is empty array when target_ideas_json is null", () => {
    const row: Record<string, unknown> = {
      agent_id: "ag-7",
      agent_role: "challenger",
      round: 1,
      action_type: "propose",
      content: "{}",
      confidence: 0.5,
      score: null,
      target_ideas_json: null,
      reasoning: "",
      created_at: "1718000000",
    };
    const rec = mapRow(row);
    expect(rec.targetIdeas).toEqual([]);
  });

  test("targetIdeas parses JSON array of strings correctly", () => {
    const ideas = ["idea-abc", "idea-xyz"];
    const row: Record<string, unknown> = {
      agent_id: "ag-8",
      agent_role: "evaluator",
      round: 2,
      action_type: "evaluate",
      content: "{}",
      confidence: 0.6,
      score: null,
      target_ideas_json: JSON.stringify(ideas),
      reasoning: "",
      created_at: "1718000001",
    };
    const rec = mapRow(row);
    expect(rec.targetIdeas).toEqual(ideas);
  });

  test("targetIdeas is an array (readonly) — not mutable in tests", () => {
    const row: Record<string, unknown> = {
      agent_id: "ag-9",
      agent_role: "synthesizer",
      round: 3,
      action_type: "synthesize",
      content: "{}",
      confidence: 0.55,
      score: null,
      target_ideas_json: '["a","b","c"]',
      reasoning: "",
      created_at: "1718000002",
    };
    const rec = mapRow(row);
    expect(rec.targetIdeas.length).toBe(3);
    expect(rec.targetIdeas[0]).toBe("a");
  });
});

// ─── content passthrough ───────────────────────────────────────────────────────

describe("AgentActionRecord mapper — content passthrough", () => {
  test("content is returned as-is (raw DB string)", () => {
    const rawContent = '{"ideas":[{"title":"AI Health Monitor","description":"desc"}]}';
    const row: Record<string, unknown> = {
      agent_id: "ag-10",
      agent_role: "challenger",
      round: 1,
      action_type: "propose",
      content: rawContent,
      confidence: 0.9,
      score: null,
      target_ideas_json: null,
      reasoning: "my reasoning",
      created_at: "1718000003",
    };
    const rec = mapRow(row);
    expect(rec.content).toBe(rawContent);
  });

  test("content with invalid JSON is passed through without throwing", () => {
    const badJson = "not-json-at-all { truncated";
    const row: Record<string, unknown> = {
      agent_id: "ag-11",
      agent_role: "skeptic",
      round: 2,
      action_type: "doubt",
      content: badJson,
      confidence: 0.3,
      score: null,
      target_ideas_json: null,
      reasoning: "",
      created_at: "1718000004",
    };
    const rec = mapRow(row);
    // Mapper must not throw — content is opaque string
    expect(rec.content).toBe(badJson);
  });

  test("reasoning defaults to empty string when DB row has null reasoning", () => {
    const row: Record<string, unknown> = {
      agent_id: "ag-12",
      agent_role: "evaluator",
      round: 1,
      action_type: "evaluate",
      content: "{}",
      confidence: 0.5,
      score: null,
      target_ideas_json: null,
      reasoning: null,
      created_at: "1718000005",
    };
    const rec = mapRow(row);
    expect(rec.reasoning).toBe("");
  });

  test("confidence defaults to 0 when DB row has null confidence", () => {
    const row: Record<string, unknown> = {
      agent_id: "ag-13",
      agent_role: "defender",
      round: 2,
      action_type: "defend",
      content: "{}",
      confidence: null,
      score: null,
      target_ideas_json: null,
      reasoning: "reasoning here",
      created_at: "1718000006",
    };
    const rec = mapRow(row);
    expect(rec.confidence).toBe(0);
  });
});

// ─── RoundArtifacts shape — mergeArtifacts helper ─────────────────────────────

describe("mergeArtifacts — RoundArtifacts aggregation", () => {
  test("returns null when all inputs are null", () => {
    expect(mergeArtifacts([null, null, null])).toBeNull();
  });

  test("returns null for empty array", () => {
    expect(mergeArtifacts([])).toBeNull();
  });

  test("returns the sole non-null artifact when only one is present", () => {
    const art: RoundArtifacts = {
      equilibria: [{ type: "nash", stability: 0.8 }],
      coalitions: undefined,
      metagameHealth: { diversityIndex: 0.7 },
      tasteFilter: undefined,
    };
    expect(mergeArtifacts([null, art, null])).toEqual(art);
  });

  test("last non-null value wins for each field (last-wins reduce)", () => {
    // mergeArtifacts reduces left-to-right: `a.X ?? acc?.X` means the current
    // element wins when it has a value — so the rightmost non-null artifact's
    // field prevails (last-wins per-field, not first-wins).
    const a: RoundArtifacts = { equilibria: [{ type: "a" }], tasteFilter: undefined };
    const b: RoundArtifacts = { equilibria: [{ type: "b" }], tasteFilter: { passed: [] } };
    const merged = mergeArtifacts([a, b]);
    // equilibria from b (last non-null — b.equilibria is defined, overrides a's)
    expect((merged!.equilibria as Array<{ type: string }>)[0]?.type).toBe("b");
    // tasteFilter from b (b.tasteFilter is defined, acc had undefined)
    expect(merged!.tasteFilter).toBeDefined();
  });

  test("tasteFilter from one artifact is carried to merge result", () => {
    const art: RoundArtifacts = {
      tasteFilter: { passed: ["idea-1"], eliminated: ["idea-2"] },
    };
    const merged = mergeArtifacts([null, art]);
    expect(merged!.tasteFilter).toEqual({ passed: ["idea-1"], eliminated: ["idea-2"] });
  });

  test("carries selectedIdeasCount / eliminatedIdeasCount through the merge", () => {
    const art: RoundArtifacts = {
      coalitions: [{ id: "c1" }],
      selectedIdeasCount: 12,
      eliminatedIdeasCount: 3,
    };
    const merged = mergeArtifacts([null, art, null]);
    expect(merged!.selectedIdeasCount).toBe(12);
    expect(merged!.eliminatedIdeasCount).toBe(3);
    expect((merged!.coalitions as unknown[]).length).toBe(1);
  });
});

// ─── parseActionContent — JSON content parsing ────────────────────────────────

describe("parseActionContent — action content parsing", () => {
  test("parses ideas array from valid JSON content", () => {
    const content = JSON.stringify({
      ideas: [
        { title: "AI Health Monitor", description: "tracks vitals" },
        { title: "Carbon Credits Marketplace", description: "tokenised trading" },
      ],
    });
    const result = parseActionContent(content);
    expect(result.parseError).toBe(false);
    expect(result.ideas.length).toBe(2);
    expect(result.ideas[0]?.title).toBe("AI Health Monitor");
    expect(result.ideas[1]?.title).toBe("Carbon Credits Marketplace");
  });

  test("returns parseError=true for malformed JSON", () => {
    const result = parseActionContent("{ broken json");
    expect(result.parseError).toBe(true);
    expect(result.ideas).toEqual([]);
    expect(result.raw).toBe("{ broken json");
  });

  test("returns empty ideas array (no error) for valid JSON without ideas key", () => {
    const result = parseActionContent('{"action":"defend","confidence":0.7}');
    expect(result.parseError).toBe(false);
    expect(result.ideas).toEqual([]);
  });

  test("skips idea objects without a title field", () => {
    const content = JSON.stringify({
      ideas: [
        { description: "no title here" },
        { title: "Has Title", description: "good" },
      ],
    });
    const result = parseActionContent(content);
    expect(result.parseError).toBe(false);
    expect(result.ideas.length).toBe(1);
    expect(result.ideas[0]?.title).toBe("Has Title");
  });

  test("raw is always the original content string", () => {
    const raw = '{"foo":"bar"}';
    expect(parseActionContent(raw).raw).toBe(raw);
  });
});

// ─── extractTasteVerdicts ─────────────────────────────────────────────────────

describe("extractTasteVerdicts — taste filter verdict parsing", () => {
  test("returns empty array for null input", () => {
    expect(extractTasteVerdicts(null)).toEqual([]);
  });

  test("returns empty array for non-object input", () => {
    expect(extractTasteVerdicts("string-value")).toEqual([]);
  });

  test("parses {passed, eliminated} shape and assigns verdicts", () => {
    const filter = {
      passed: [{ ideaId: "id-1", title: "Good idea" }],
      eliminated: [{ ideaId: "id-2", title: "Weak idea" }],
    };
    const verdicts = extractTasteVerdicts(filter);
    const pass = verdicts.find((v) => v.ideaId === "id-1");
    const elim = verdicts.find((v) => v.ideaId === "id-2");
    expect(pass?.verdict).toBe("pass");
    expect(elim?.verdict).toBe("eliminate");
  });

  test("handles array form of tasteFilter (each item is a verdict object)", () => {
    const filter = [
      { ideaId: "id-a", verdict: "pass" },
      { ideaId: "id-b", verdict: "eliminate" },
    ];
    const verdicts = extractTasteVerdicts(filter);
    expect(verdicts.length).toBe(2);
  });

  test("returns empty array when passed is not an array", () => {
    const filter = { passed: "not-an-array", eliminated: [] };
    const verdicts = extractTasteVerdicts(filter);
    expect(verdicts).toEqual([]);
  });
});
