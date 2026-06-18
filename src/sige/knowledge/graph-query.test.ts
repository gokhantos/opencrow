import { describe, expect, test } from "bun:test";
import {
  getDefaultKnowledgeFilter,
  getFilteredGraphView,
  getFullGraph,
  mem0ResultToGraphView,
} from "./graph-query";
import type { Mem0Client, Mem0Memory, Mem0Relation, Mem0SearchResult } from "./mem0-client";

// ─── Fakes ──────────────────────────────────────────────────────────────────

type SearchParams = Parameters<Mem0Client["search"]>[0];

/**
 * Minimal Mem0Client stub. getFullGraph / getFilteredGraphView only call
 * `.search()` and `.isUnavailable()`, so we stub just those and cast.
 */
function fakeClient(
  result: Mem0SearchResult,
  opts?: { readonly unavailable?: boolean; readonly onSearch?: (p: SearchParams) => void },
): Mem0Client {
  return {
    search: async (params: SearchParams): Promise<Mem0SearchResult> => {
      opts?.onSearch?.(params);
      return result;
    },
    isUnavailable: () => opts?.unavailable ?? false,
  } as unknown as Mem0Client;
}

function mem(
  id: string,
  text: string,
  extra?: Partial<Mem0Memory> & { readonly metadata?: Record<string, unknown> },
): Mem0Memory {
  return { id, memory: text, ...extra };
}

const NO_RELATIONS: readonly Mem0Relation[] = [];

// ─── mem0ResultToGraphView: metadata lifting ─────────────────────────────────

describe("mem0ResultToGraphView metadata lifting", () => {
  test("lifts score, credibility, and source_type onto nodes when present", () => {
    const view = mem0ResultToGraphView(
      [
        mem("a", "Alpha entity", {
          score: 0.9,
          metadata: { credibility: 0.8, source_type: "appstore_review" },
        }),
      ],
      NO_RELATIONS,
    );

    const node = view.nodes[0];
    expect(node?.relevanceScore).toBe(0.9);
    expect(node?.credibility).toBe(0.8);
    expect(node?.sourceType).toBe("appstore_review");
  });

  test("leaves enrichment fields undefined when metadata absent (backward-compatible)", () => {
    const view = mem0ResultToGraphView([mem("a", "Alpha")], NO_RELATIONS);
    const node = view.nodes[0];
    expect(node?.relevanceScore).toBeUndefined();
    expect(node?.credibility).toBeUndefined();
    expect(node?.sourceType).toBeUndefined();
  });

  test("ignores out-of-range credibility values", () => {
    const view = mem0ResultToGraphView(
      [
        mem("a", "Alpha", { metadata: { credibility: 1.5 } }),
        mem("b", "Beta", { metadata: { credibility: -0.2 } }),
        mem("c", "Gamma", { metadata: { credibility: "high" } }),
      ],
      NO_RELATIONS,
    );
    expect(view.nodes[0]?.credibility).toBeUndefined();
    expect(view.nodes[1]?.credibility).toBeUndefined();
    expect(view.nodes[2]?.credibility).toBeUndefined();
  });
});

// ─── getFullGraph: relevance ranking before truncation ───────────────────────

describe("getFullGraph relevance ranking", () => {
  test("ranks by mem0 score so the most relevant survive maxNodes truncation", async () => {
    // low-score node listed first, high-score node listed last
    const client = fakeClient({
      memories: [
        mem("low", "Low relevance fact", { score: 0.1 }),
        mem("high", "High relevance fact", { score: 0.95 }),
      ],
      relations: NO_RELATIONS,
    });

    const view = await getFullGraph(client, "user-1", { maxNodes: 1 });

    expect(view.nodes).toHaveLength(1);
    expect(view.nodes[0]?.uuid).toBe("high");
  });

  test("preserves original order when no scores are present", async () => {
    const client = fakeClient({
      memories: [mem("a", "First"), mem("b", "Second"), mem("c", "Third")],
      relations: NO_RELATIONS,
    });

    const view = await getFullGraph(client, "user-1", { maxNodes: 2 });

    expect(view.nodes.map((n) => n.uuid)).toEqual(["a", "b"]);
  });

  test("scored nodes outrank unscored ones", async () => {
    const client = fakeClient({
      memories: [
        mem("unscored", "No score"),
        mem("scored", "Has score", { score: 0.5 }),
      ],
      relations: NO_RELATIONS,
    });

    const view = await getFullGraph(client, "user-1", { maxNodes: 1 });
    expect(view.nodes[0]?.uuid).toBe("scored");
  });

  test("uses scopeQuery as the search query when provided", async () => {
    let observed: string | undefined;
    const client = fakeClient(
      { memories: [mem("a", "Alpha")], relations: NO_RELATIONS },
      { onSearch: (p) => (observed = p.query) },
    );

    await getFullGraph(client, "user-1", { scopeQuery: "fitness tracking apps" });
    expect(observed).toBe("fitness tracking apps");
  });

  test("falls back to broad query when scopeQuery is blank", async () => {
    let observed: string | undefined;
    const client = fakeClient(
      { memories: [mem("a", "Alpha")], relations: NO_RELATIONS },
      { onSearch: (p) => (observed = p.query) },
    );

    await getFullGraph(client, "user-1", { scopeQuery: "   " });
    expect(observed).toBe("key entities relationships concepts");
  });

  test("returns empty graph gracefully when search throws", async () => {
    const client = {
      search: async () => {
        throw new Error("boom");
      },
      isUnavailable: () => true,
    } as unknown as Mem0Client;

    const view = await getFullGraph(client, "user-1");
    expect(view.nodes).toHaveLength(0);
    expect(view.edges).toHaveLength(0);
  });
});

// ─── getFilteredGraphView: credibility weighting ─────────────────────────────

describe("getFilteredGraphView credibility weighting", () => {
  // Pick a role with concrete amplified entities so filter scores are exercised.
  const role = "user_researcher" as const;
  const filter = getDefaultKnowledgeFilter(role);

  test("higher credibility ranks ahead when filter scores tie", async () => {
    const client = fakeClient({
      memories: [
        // Both mention an amplified entity ("review"/"user") → equal filter score.
        mem("lowcred", "user review about onboarding", { metadata: { credibility: 0.2 } }),
        mem("highcred", "user review about pricing", { metadata: { credibility: 0.9 } }),
      ],
      relations: NO_RELATIONS,
    });

    const view = await getFilteredGraphView(client, "user-1", role, filter);
    expect(view.nodes[0]?.uuid).toBe("highcred");
  });

  test("absent credibility does not change ordering vs baseline", async () => {
    const client = fakeClient({
      memories: [
        mem("a", "user review one"),
        mem("b", "user review two"),
      ],
      relations: NO_RELATIONS,
    });

    const view = await getFilteredGraphView(client, "user-1", role, filter);
    // No credibility, equal filter score, no mem0 score → stable original order.
    expect(view.nodes.map((n) => n.uuid)).toEqual(["a", "b"]);
  });

  test("amplified-entity match still dominates credibility", async () => {
    const client = fakeClient({
      memories: [
        // Matches amplified "user"/"review" (+10) but low credibility.
        mem("relevant", "user complaint review", { metadata: { credibility: 0.1 } }),
        // No amplified match (0) but max credibility (+5).
        mem("credible", "quarterly earnings", { metadata: { credibility: 1 } }),
      ],
      relations: NO_RELATIONS,
    });

    const view = await getFilteredGraphView(client, "user-1", role, filter);
    expect(view.nodes[0]?.uuid).toBe("relevant");
  });
});
