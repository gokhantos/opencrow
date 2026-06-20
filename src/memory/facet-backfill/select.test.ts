/**
 * Unit tests for the facet-backfill selection/transform logic.
 *
 * Lane: unit (no DB, no network, no mock.module). Covers the rules that decide
 * which scrolled points get re-enriched and how they group by source.
 */

import { describe, expect, test } from "bun:test";
import type { QdrantScrollPoint } from "../qdrant";
import {
  buildPayloadPatch,
  groupBySource,
  needsBackfill,
  REQUIRED_FACET_KEYS,
  toCandidate,
  type CandidatePoint,
} from "./select";

function point(
  id: string,
  payload: Record<string, string | number>,
): QdrantScrollPoint {
  return { id, payload };
}

describe("needsBackfill", () => {
  test("selects a signal-kind point missing a required facet", () => {
    expect(
      needsBackfill({ kind: "hackernews_story", signalCategory: "x" }),
    ).toBe(true); // missing facetProblemType
  });

  test("selects a signal-kind point missing signalCategory", () => {
    expect(
      needsBackfill({ kind: "reddit_post", facetProblemType: "bug" }),
    ).toBe(true);
  });

  test("skips a signal-kind point that already has every required facet", () => {
    expect(
      needsBackfill({
        kind: "hackernews_story",
        facetProblemType: "bug",
        signalCategory: "tooling",
      }),
    ).toBe(false);
  });

  test("treats an empty-string facet value as missing", () => {
    expect(
      needsBackfill({
        kind: "hackernews_story",
        facetProblemType: "   ",
        signalCategory: "tooling",
      }),
    ).toBe(true);
  });

  test("skips non-signal kinds even when facets are absent", () => {
    expect(needsBackfill({ kind: "observation" })).toBe(false);
    expect(needsBackfill({ kind: "idea" })).toBe(false);
    expect(needsBackfill({ kind: "note" })).toBe(false);
  });

  test("skips points with no kind payload", () => {
    expect(needsBackfill({ sourceId: "s1" })).toBe(false);
  });

  test("honors a custom required-keys set", () => {
    expect(
      needsBackfill(
        { kind: "hackernews_story", facetProblemType: "bug" },
        ["facetProblemType"],
      ),
    ).toBe(false);
    expect(
      needsBackfill({ kind: "hackernews_story" }, ["facetTargetAudience"]),
    ).toBe(true);
  });
});

describe("toCandidate", () => {
  test("projects a selectable point with sourceId/kind/chunkIndex", () => {
    const c = toCandidate(
      point("p1", {
        kind: "hackernews_story",
        sourceId: "src-1",
        chunkIndex: 3,
      }),
    );
    expect(c).toEqual({
      id: "p1",
      sourceId: "src-1",
      chunkIndex: 3,
      kind: "hackernews_story",
    });
  });

  test("defaults chunkIndex to 0 when absent or non-numeric", () => {
    const c = toCandidate(
      point("p1", { kind: "reddit_post", sourceId: "src-1" }),
    );
    expect(c?.chunkIndex).toBe(0);
  });

  test("returns null when the point does not need backfill", () => {
    expect(
      toCandidate(
        point("p1", {
          kind: "hackernews_story",
          sourceId: "src-1",
          facetProblemType: "bug",
          signalCategory: "tooling",
        }),
      ),
    ).toBeNull();
  });

  test("returns null when sourceId is missing or empty", () => {
    expect(toCandidate(point("p1", { kind: "hackernews_story" }))).toBeNull();
    expect(
      toCandidate(point("p1", { kind: "hackernews_story", sourceId: "" })),
    ).toBeNull();
  });
});

describe("groupBySource", () => {
  test("groups points by sourceId preserving first-seen order", () => {
    const candidates: CandidatePoint[] = [
      { id: "a", sourceId: "s1", chunkIndex: 0, kind: "hackernews_story" },
      { id: "b", sourceId: "s2", chunkIndex: 0, kind: "reddit_post" },
      { id: "c", sourceId: "s1", chunkIndex: 1, kind: "hackernews_story" },
    ];
    const groups = groupBySource(candidates);
    expect(groups).toEqual([
      { sourceId: "s1", kind: "hackernews_story", pointIds: ["a", "c"] },
      { sourceId: "s2", kind: "reddit_post", pointIds: ["b"] },
    ]);
  });

  test("returns an empty array for no candidates", () => {
    expect(groupBySource([])).toEqual([]);
  });
});

describe("buildPayloadPatch", () => {
  test("returns an empty patch when facets are null and ranking is empty", () => {
    expect(buildPayloadPatch(null, {})).toEqual({});
  });

  test("flattens facets and lets ranking payload win on overlap", () => {
    const patch = buildPayloadPatch(
      {
        sentiment: "negative",
        problemType: "bug",
        targetAudience: "devs",
        jtbd: "ship faster",
        entities: ["foo", "bar"],
        importance: "high",
        relevanceToIdeas: 0.9,
        category: "tooling",
      },
      { signalCategory: "tooling", signalImportanceRank: 3 },
    );
    expect(patch.facetSentiment).toBe("negative");
    expect(patch.facetProblemType).toBe("bug");
    expect(patch.facetEntities).toBe("foo, bar");
    expect(patch.signalCategory).toBe("tooling");
    expect(patch.signalImportanceRank).toBe(3);
  });
});

describe("REQUIRED_FACET_KEYS", () => {
  test("is the documented low-coverage facet set", () => {
    expect([...REQUIRED_FACET_KEYS]).toEqual([
      "facetProblemType",
      "signalCategory",
    ]);
  });
});
