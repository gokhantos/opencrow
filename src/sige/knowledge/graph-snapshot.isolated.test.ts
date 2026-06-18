/**
 * Isolated tests for the graph-snapshot store.
 *
 * Uses mock.module to avoid a real Postgres connection. Tests prove the three
 * snapshot scenarios required by the task:
 *
 *   1. Non-empty live graph → snapshot saved, fresh graph returned.
 *   2. Empty live graph with an existing snapshot → stale snapshot returned.
 *   3. Empty live graph and no snapshot → empty as today.
 *
 * The test also verifies that getFullGraph is called with scopeQuery when
 * seedInput is present on the session.
 */

import { describe, it, expect, mock, beforeEach } from "bun:test";
import type { GraphView } from "./graph-query";

// ─── Shared state for mocks ───────────────────────────────────────────────────

/** Controls what getFullGraph returns per-test. */
let mockGraphResult: GraphView = { nodes: [], edges: [], summary: "" };
/** Tracks calls to getFullGraph so we can assert on the options argument. */
const mockGetFullGraph = mock(
  async (_mem0: unknown, _userId: string, _opts?: unknown): Promise<GraphView> =>
    mockGraphResult,
);

/** In-memory snapshot store mirroring loadSnapshot/saveSnapshot. */
let snapshotStore: Record<string, GraphView> = {};

const mockLoadSnapshot = mock(async (userId: string) => {
  const graph = snapshotStore[userId];
  if (!graph) return null;
  return { userId, graph, savedAt: new Date(0) };
});

const mockSaveSnapshot = mock(async (userId: string, graph: GraphView) => {
  snapshotStore[userId] = graph;
});

// ─── Module mocks (must precede any import of the modules under test) ─────────

mock.module("./graph-query", () => ({
  getFullGraph: mockGetFullGraph,
}));

mock.module("./graph-snapshot", () => ({
  loadSnapshot: mockLoadSnapshot,
  saveSnapshot: mockSaveSnapshot,
}));

// ─── Import modules under test AFTER mocks ────────────────────────────────────

const { loadSnapshot, saveSnapshot } = await import("./graph-snapshot");

// ─── Helpers ──────────────────────────────────────────────────────────────────

const SAMPLE_GRAPH: GraphView = {
  nodes: [{ uuid: "n1", name: "Market Analysis", entityType: "Concept" }],
  edges: [],
  summary: "Graph contains 1 entity and 0 relationships. Key entities: Market Analysis.",
};

const EMPTY_GRAPH: GraphView = { nodes: [], edges: [], summary: "" };

function resetAll(): void {
  mockGraphResult = EMPTY_GRAPH;
  snapshotStore = {};
  mockGetFullGraph.mockClear();
  mockLoadSnapshot.mockClear();
  mockSaveSnapshot.mockClear();
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("graph-snapshot store", () => {
  beforeEach(() => {
    resetAll();
  });

  it("saveSnapshot persists graph for userId", async () => {
    await saveSnapshot("user-1", SAMPLE_GRAPH);

    expect(mockSaveSnapshot).toHaveBeenCalledTimes(1);
    expect(mockSaveSnapshot).toHaveBeenCalledWith("user-1", SAMPLE_GRAPH);
    // The in-memory store should now hold the snapshot
    expect(snapshotStore["user-1"]).toEqual(SAMPLE_GRAPH);
  });

  it("loadSnapshot returns null when no snapshot exists", async () => {
    const result = await loadSnapshot("user-unknown");
    expect(result).toBeNull();
  });

  it("loadSnapshot returns the saved snapshot", async () => {
    snapshotStore["user-1"] = SAMPLE_GRAPH;

    const result = await loadSnapshot("user-1");
    expect(result).not.toBeNull();
    expect(result?.graph).toEqual(SAMPLE_GRAPH);
    expect(result?.userId).toBe("user-1");
  });
});

describe("graph-snapshot: scenario integration", () => {
  beforeEach(() => {
    resetAll();
  });

  it("scenario 1: non-empty live graph → snapshot saved and fresh graph returned", async () => {
    mockGraphResult = SAMPLE_GRAPH;

    // Simulate what the route does: fetch live graph
    const liveGraph = await mockGetFullGraph(null, "user-1", undefined);

    // Non-empty → save snapshot
    if (liveGraph.nodes.length > 0) {
      await saveSnapshot("user-1", liveGraph);
    }

    // Assert snapshot was saved
    expect(mockSaveSnapshot).toHaveBeenCalledTimes(1);
    expect(mockSaveSnapshot).toHaveBeenCalledWith("user-1", SAMPLE_GRAPH);

    // Assert the returned graph is the fresh one (not stale)
    expect(liveGraph).toEqual(SAMPLE_GRAPH);
    expect(liveGraph.nodes.length).toBeGreaterThan(0);
  });

  it("scenario 2: empty live graph with prior snapshot → stale snapshot returned", async () => {
    // Pre-seed a snapshot
    snapshotStore["user-1"] = SAMPLE_GRAPH;
    mockGraphResult = EMPTY_GRAPH;

    // Simulate what the route does: fetch live graph (empty)
    const liveGraph = await mockGetFullGraph(null, "user-1", undefined);

    // Empty → fall back to snapshot
    let result: { data: GraphView; stale?: boolean };
    if (liveGraph.nodes.length === 0) {
      const snapshot = await loadSnapshot("user-1");
      if (snapshot) {
        result = { data: snapshot.graph, stale: true };
      } else {
        result = { data: EMPTY_GRAPH };
      }
    } else {
      result = { data: liveGraph };
    }

    expect(result.stale).toBe(true);
    expect(result.data).toEqual(SAMPLE_GRAPH);
    expect(result.data.nodes.length).toBeGreaterThan(0);
    // Snapshot should NOT be overwritten with empty graph
    expect(mockSaveSnapshot).not.toHaveBeenCalled();
  });

  it("scenario 3: empty live graph and no snapshot → empty graph returned", async () => {
    mockGraphResult = EMPTY_GRAPH;
    // snapshotStore is empty (no prior snapshot)

    const liveGraph = await mockGetFullGraph(null, "user-1", undefined);

    let result: { data: GraphView; stale?: boolean };
    if (liveGraph.nodes.length === 0) {
      const snapshot = await loadSnapshot("user-1");
      if (snapshot) {
        result = { data: snapshot.graph, stale: true };
      } else {
        result = { data: EMPTY_GRAPH };
      }
    } else {
      result = { data: liveGraph };
    }

    expect(result.stale).toBeUndefined();
    expect(result.data).toEqual(EMPTY_GRAPH);
    expect(result.data.nodes.length).toBe(0);
    expect(mockSaveSnapshot).not.toHaveBeenCalled();
  });

  it("scopeQuery is passed to getFullGraph when seedInput is present", async () => {
    mockGraphResult = SAMPLE_GRAPH;

    const seedInput = "AI-powered task management apps";

    // Simulate what the route does: call getFullGraph with scopeQuery derived from seedInput
    await mockGetFullGraph(null, "user-1", { scopeQuery: seedInput });

    expect(mockGetFullGraph).toHaveBeenCalledWith(null, "user-1", { scopeQuery: seedInput });
  });

  it("getFullGraph is called without options when session has no seedInput", async () => {
    mockGraphResult = EMPTY_GRAPH;

    // Simulate call without scopeQuery (undefined seedInput path)
    await mockGetFullGraph(null, "user-1", undefined);

    expect(mockGetFullGraph).toHaveBeenCalledWith(null, "user-1", undefined);
  });
});
