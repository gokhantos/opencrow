import { describe, expect, test } from "bun:test";
import { parseDemandArtifact, rowToEvalIdea, rowToEvalOutcome } from "./load";

describe("parseDemandArtifact", () => {
  test("returns null for null/undefined/malformed input", () => {
    expect(parseDemandArtifact(null)).toBeNull();
    expect(parseDemandArtifact(undefined)).toBeNull();
    expect(parseDemandArtifact("not json")).toBeNull();
    expect(parseDemandArtifact("null")).toBeNull();
    expect(parseDemandArtifact([1, 2, 3])).toBeNull();
    expect(parseDemandArtifact({ score: 3 })).toBeNull(); // missing confidence/whitespace
  });

  test("parses an already-parsed object (JSONB auto-parse case)", () => {
    const artifact = parseDemandArtifact({
      score: 3.5,
      confidence: 0.8,
      whitespace: 0.4,
      evidence: [{ kind: "reddit_posts", query: "meal planning", count: 12, sourceId: "r1" }],
    });
    expect(artifact).not.toBeNull();
    expect(artifact?.score).toBe(3.5);
    expect(artifact?.confidence).toBe(0.8);
    expect(artifact?.whitespace).toBe(0.4);
    expect(artifact?.evidence).toHaveLength(1);
    expect(artifact?.evidence[0]?.query).toBe("meal planning");
  });

  test("parses a JSON-string value (raw-driver text case)", () => {
    const raw = JSON.stringify({ score: 1, confidence: 0.2, whitespace: 0.1, evidence: [] });
    const artifact = parseDemandArtifact(raw);
    expect(artifact).not.toBeNull();
    expect(artifact?.evidence).toEqual([]);
  });

  test("drops malformed evidence entries but keeps well-formed ones", () => {
    const artifact = parseDemandArtifact({
      score: 2,
      confidence: 0.5,
      whitespace: 0.3,
      evidence: [
        { kind: "news_articles", query: "ok", count: 3 },
        { kind: "news_articles", query: "missing count" }, // dropped
        "not an object", // dropped
        null, // dropped
      ],
    });
    expect(artifact?.evidence).toHaveLength(1);
    expect(artifact?.evidence[0]?.query).toBe("ok");
  });
});

describe("rowToEvalIdea", () => {
  const baseRow = {
    id: "idea-1",
    category: "productivity",
    pipeline_stage: "validated",
    critique_subscores_json: null,
    created_at: 1_700_000_000,
    title: "Some idea",
    summary: "Some summary",
    demand_json: null,
    demand_score: null,
    whitespace: null,
  };

  test("maps critique_subscores_json (COLUMN) to critique_subscores (FIELD)", () => {
    const row = {
      ...baseRow,
      critique_subscores_json: { novelty: 0.7, feasibility: 0.6, signalGrounding: 0.9 },
    };
    const idea = rowToEvalIdea(row);
    expect(idea.critique_subscores).toEqual({
      novelty: 0.7,
      feasibility: 0.6,
      signalGrounding: 0.9,
    });
  });

  test("handles jsonb-as-string critique_subscores_json", () => {
    const row = {
      ...baseRow,
      critique_subscores_json: JSON.stringify({ novelty: 0.5 }),
    };
    const idea = rowToEvalIdea(row);
    expect(idea.critique_subscores).toEqual({ novelty: 0.5 });
  });

  test("tolerates null/missing columns", () => {
    const row = {
      ...baseRow,
      category: null,
      pipeline_stage: null,
      critique_subscores_json: null,
      title: null,
      summary: null,
      demand_json: null,
      demand_score: null,
      whitespace: null,
    };
    const idea = rowToEvalIdea(row);
    expect(idea.category).toBe("");
    expect(idea.pipeline_stage).toBeNull();
    expect(idea.critique_subscores).toBeNull();
    expect(idea.title).toBeUndefined();
    expect(idea.summary).toBeUndefined();
    expect(idea.demand).toBeNull();
    expect(idea.demand_score).toBeNull();
    expect(idea.whitespace).toBeNull();
  });

  test("coerces string-typed numeric columns (real/integer sometimes returned as text)", () => {
    const row = {
      ...baseRow,
      created_at: "1700000000",
      demand_score: "3.5",
      whitespace: "0.42",
    };
    const idea = rowToEvalIdea(row);
    expect(idea.created_at).toBe(1_700_000_000);
    expect(idea.demand_score).toBe(3.5);
    expect(idea.whitespace).toBe(0.42);
  });

  test("falls back to 0 for a non-finite created_at rather than throwing", () => {
    const row = { ...baseRow, created_at: "not-a-number" };
    const idea = rowToEvalIdea(row);
    expect(idea.created_at).toBe(0);
  });
});

describe("rowToEvalOutcome", () => {
  test("maps idea_feedback columns 1:1 and null-coalesces actor", () => {
    expect(rowToEvalOutcome({ idea_id: "idea-1", kind: "validated", actor: "human" })).toEqual({
      idea_id: "idea-1",
      kind: "validated",
      actor: "human",
    });
    expect(rowToEvalOutcome({ idea_id: "idea-2", kind: "archived", actor: null })).toEqual({
      idea_id: "idea-2",
      kind: "archived",
      actor: null,
    });
  });
});
