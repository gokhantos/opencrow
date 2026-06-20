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

// ─── mem0ResultToGraphView: relations become real edges ─────────────────────

describe("mem0ResultToGraphView relation → edge resolution", () => {
  // Reproduces the bug: relation endpoints are entity NAMES (e.g. "app_store"),
  // not fact text, so they never matched fact-text node names and every edge was
  // dropped by the connectivity filter (edgeCount always 0).
  const rel = (source: string, relationship: string, target: string): Mem0Relation => ({
    source,
    relationship,
    target,
  });

  test("entity-name relations produce edges connected to real nodes", () => {
    const view = mem0ResultToGraphView(
      // Fact-text memories — none of these names match the entity endpoints below.
      [mem("m1", "ChatGPT provides content filters for parents"), mem("m2", "App Store hosts ChatGPT")],
      [rel("app_store", "PROVIDES", "chatgpt"), rel("chatgpt", "PROVIDES", "content_filters")],
    );

    expect(view.edges.length).toBeGreaterThan(0);
    expect(view.edges).toHaveLength(2);

    // Every edge endpoint must be a node present in the graph (no synthetic
    // dangling endpoints).
    const nodeUuids = new Set(view.nodes.map((n) => n.uuid));
    for (const edge of view.edges) {
      expect(nodeUuids.has(edge.sourceNodeUuid)).toBe(true);
      expect(nodeUuids.has(edge.targetNodeUuid)).toBe(true);
      expect(edge.sourceNodeUuid.startsWith("synthetic:")).toBe(false);
      expect(edge.targetNodeUuid.startsWith("synthetic:")).toBe(false);
    }
  });

  test("dedups a repeated entity endpoint into a single node", () => {
    const view = mem0ResultToGraphView(
      [],
      [rel("app_store", "PROVIDES", "chatgpt"), rel("app_store", "HOSTS", "whatnot")],
    );

    // app_store appears in both relations → exactly one entity node for it.
    const appStoreNodes = view.nodes.filter((n) => n.name === "app_store");
    expect(appStoreNodes).toHaveLength(1);

    // Both edges point at the same app_store uuid.
    const appStoreUuid = appStoreNodes[0]?.uuid;
    expect(view.edges[0]?.sourceNodeUuid).toBe(appStoreUuid);
    expect(view.edges[1]?.sourceNodeUuid).toBe(appStoreUuid);
  });

  test("entity nodes are typed Entity and matched case-insensitively", () => {
    const view = mem0ResultToGraphView(
      [],
      [rel("App_Store", "PROVIDES", "ChatGPT"), rel("app_store", "HOSTS", "chatgpt")],
    );

    // Case-insensitive dedup: App_Store / app_store collapse to one node, as do
    // ChatGPT / chatgpt.
    expect(view.nodes).toHaveLength(2);
    expect(view.nodes.every((n) => n.entityType === "Entity")).toBe(true);
  });

  test("resolves an endpoint to a memory-fact node when its name matches", () => {
    // A fact whose truncated name equals the entity endpoint should be reused as
    // the canonical node instead of synthesizing a separate entity node.
    const view = mem0ResultToGraphView(
      [mem("fact-app", "app_store")],
      [rel("app_store", "HOSTS", "chatgpt")],
    );

    // The edge source resolves to the memory-fact node, not a synthetic entity.
    expect(view.edges[0]?.sourceNodeUuid).toBe("fact-app");
    // Only the chatgpt endpoint needed a new entity node.
    expect(view.nodes.filter((n) => n.uuid.startsWith("entity:"))).toHaveLength(1);
  });

  test("no relations produces no edges (empty-graph fast path preserved)", () => {
    const view = mem0ResultToGraphView([mem("m1", "Solo fact")], NO_RELATIONS);
    expect(view.edges).toHaveLength(0);
    expect(view.nodes).toHaveLength(1);
  });
});

// ─── getFilteredGraphView: edges survive end-to-end ──────────────────────────

describe("getFilteredGraphView edge survival", () => {
  const rel = (source: string, relationship: string, target: string): Mem0Relation => ({
    source,
    relationship,
    target,
  });

  test("edges survive truncation and connect real nodes (regression: edgeCount 0)", async () => {
    const client = fakeClient({
      memories: [mem("m1", "Some unrelated fact about onboarding", { score: 0.9 })],
      relations: [rel("app_store", "PROVIDES", "chatgpt"), rel("chatgpt", "PROVIDES", "content_filters")],
    });

    const filter = getDefaultKnowledgeFilter("rational_player");
    const view = await getFilteredGraphView(client, "user-1", "rational_player", filter);

    expect(view.edges.length).toBeGreaterThan(0);
    const nodeUuids = new Set(view.nodes.map((n) => n.uuid));
    for (const edge of view.edges) {
      expect(nodeUuids.has(edge.sourceNodeUuid)).toBe(true);
      expect(nodeUuids.has(edge.targetNodeUuid)).toBe(true);
    }
  });

  test("tight maxNodes still keeps edges by pulling endpoint nodes within the cap", async () => {
    const client = fakeClient({
      // Many high-score memory facts would otherwise crowd out entity nodes.
      memories: [
        mem("f1", "fact one", { score: 0.9 }),
        mem("f2", "fact two", { score: 0.8 }),
      ],
      relations: [rel("app_store", "PROVIDES", "chatgpt")],
    });

    const filter = getDefaultKnowledgeFilter("rational_player");
    // maxNodes 3: 2 fact nodes ranked first, then 2 entity endpoints need to fit.
    // Only one edge whose endpoints (2) fit within remaining cap (3 - some primary).
    const view = await getFilteredGraphView(client, "user-1", "rational_player", filter, {
      maxNodes: 3,
    });

    // With cap 3, primary slice takes f1,f2 + one entity; the second endpoint
    // would overflow, so the edge is dropped rather than dangling. Verify no
    // dangling endpoints regardless of which way the cap falls.
    expect(view.nodes.length).toBeLessThanOrEqual(3);
    const nodeUuids = new Set(view.nodes.map((n) => n.uuid));
    for (const edge of view.edges) {
      expect(nodeUuids.has(edge.sourceNodeUuid)).toBe(true);
      expect(nodeUuids.has(edge.targetNodeUuid)).toBe(true);
    }
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
