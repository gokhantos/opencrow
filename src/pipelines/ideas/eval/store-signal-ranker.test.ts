import { test, expect, describe } from "bun:test";
import { projectSignalRankerRows } from "./store";

// projectSignalRankerRows is a PURE DB-row → RankerEvalRow projection. It must
// not require a live DB (getDb is lazy), so it is unit-testable in isolation.

describe("projectSignalRankerRows", () => {
  test("maps terminal kinds to success/failure", () => {
    const rows = projectSignalRankerRows([
      { importance: "high", category: "ai", relevance_to_ideas: 0.8, kind: "validated" },
      { importance: "high", category: null, relevance_to_ideas: 0.7, kind: "built" },
      { importance: "low", category: null, relevance_to_ideas: 0.2, kind: "archived" },
      { importance: "low", category: null, relevance_to_ideas: 0.1, kind: "dismissed" },
    ]);
    expect(rows.map((r) => r.success)).toEqual([true, true, false, false]);
  });

  test("drops non-terminal / unknown kinds", () => {
    const rows = projectSignalRankerRows([
      { importance: "high", category: null, relevance_to_ideas: 0.9, kind: "idea" },
      { importance: "high", category: null, relevance_to_ideas: 0.9, kind: null },
      { importance: "high", category: null, relevance_to_ideas: 0.9, kind: "validated" },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.success).toBe(true);
  });

  test("drops rows with an unparseable importance bucket", () => {
    const rows = projectSignalRankerRows([
      { importance: "bogus", category: null, relevance_to_ideas: 0.5, kind: "validated" },
      { importance: null, category: null, relevance_to_ideas: 0.5, kind: "validated" },
      { importance: "medium", category: null, relevance_to_ideas: 0.5, kind: "validated" },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.importance).toBe("medium");
  });

  test("carries through relevance, parsing numeric strings and clamping range", () => {
    const rows = projectSignalRankerRows([
      { importance: "high", category: null, relevance_to_ideas: "0.42", kind: "validated" },
      { importance: "high", category: null, relevance_to_ideas: 1.7, kind: "validated" },
      { importance: "high", category: null, relevance_to_ideas: -0.3, kind: "validated" },
      { importance: "high", category: null, relevance_to_ideas: null, kind: "validated" },
    ]);
    expect(rows[0]!.relevanceToIdeas).toBe(0.42);
    expect(rows[1]!.relevanceToIdeas).toBe(1); // clamped
    expect(rows[2]!.relevanceToIdeas).toBe(0); // clamped
    expect(rows[3]!.relevanceToIdeas).toBeUndefined(); // null → omitted
  });

  test("normalizes blank category to undefined, trims otherwise", () => {
    const rows = projectSignalRankerRows([
      { importance: "high", category: "  ", relevance_to_ideas: 0.5, kind: "validated" },
      { importance: "high", category: "  ml  ", relevance_to_ideas: 0.5, kind: "validated" },
    ]);
    expect(rows[0]!.category).toBeUndefined();
    expect(rows[1]!.category).toBe("ml");
  });

  test("empty input → empty output", () => {
    expect(projectSignalRankerRows([])).toEqual([]);
  });
});
