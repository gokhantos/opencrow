/**
 * Isolated tests for GET /api/sige/sessions/:id/graph.
 *
 * Key contract: the endpoint MUST return { success: true, data: { nodes: [], edges: [] } }
 * gracefully when Mem0 is unavailable (circuit open, network error, config missing).
 * It must NEVER return a 500.
 *
 * Uses mock.module to stub the sige/store, logger, config, mem0-client and
 * graph-query layers so the test is DB-free and Mem0-free.
 *
 * Lane: *.isolated.test.ts → bun run test:isolated
 */
import { describe, test, expect, mock, beforeEach } from "bun:test";

// ── Module mocks BEFORE imports ───────────────────────────────────────────────

let getFullGraphShouldThrow = false;
let configShouldThrow = false;
let sigeConfigPresent = true;

const mockGetFullGraph = mock(async (_mem0: unknown, _userId: string) => {
  if (getFullGraphShouldThrow) throw new Error("Mem0 unavailable");
  return {
    nodes: [
      { uuid: "n1", name: "AI Safety", entityType: "Concept", summary: "A core concept" },
    ],
    edges: [
      { uuid: "e1", sourceNodeUuid: "n1", targetNodeUuid: "n2", relationType: "related_to", fact: "test" },
    ],
    summary: "Test graph",
  };
});

mock.module("../../sige/knowledge/graph-query", () => ({
  getFullGraph: mockGetFullGraph,
}));

mock.module("../../sige/knowledge/mem0-client", () => ({
  Mem0Client: class MockMem0Client {
    constructor(_opts: unknown) {}
  },
}));

mock.module("../../config/loader", () => ({
  loadConfig: () => {
    if (configShouldThrow) throw new Error("Config load failed");
    if (!sigeConfigPresent) {
      return {}; // no sige key
    }
    return {
      sige: {
        mem0: {
          baseUrl: "http://localhost:8080",
          userId: "test-user",
        },
      },
    };
  },
}));

mock.module("../../sige/store", () => ({
  createSession: mock(async () => {}),
  getSession: mock(async () => null),
  listSessions: mock(async () => []),
  updateSessionStatus: mock(async () => {}),
  getIdeaScores: mock(async () => []),
  getPopulationDynamics: mock(async () => null),
  countPendingSessions: mock(async () => 0),
}));

mock.module("../../logger", () => ({
  createLogger: () => ({
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
    debug: mock(() => {}),
  }),
}));

import { createSigeRoutes } from "./sige";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeApp() {
  return createSigeRoutes();
}

async function getGraph(
  app: ReturnType<typeof makeApp>,
  sessionId = "session-123",
): Promise<Response> {
  const req = new Request(`http://localhost/sige/sessions/${sessionId}/graph`);
  return app.fetch(req);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("GET /sige/sessions/:id/graph — graceful-empty when Mem0 unavailable", () => {
  beforeEach(() => {
    getFullGraphShouldThrow = false;
    configShouldThrow = false;
    sigeConfigPresent = true;
    mockGetFullGraph.mockClear();
  });

  test("returns 200 even when getFullGraph throws (Mem0 down)", async () => {
    getFullGraphShouldThrow = true;
    const app = makeApp();
    const res = await getGraph(app);
    expect(res.status).toBe(200);
  });

  test("returns {nodes:[], edges:[]} when getFullGraph throws", async () => {
    getFullGraphShouldThrow = true;
    const app = makeApp();
    const res = await getGraph(app);
    const body = await res.json() as { success: boolean; data: { nodes: unknown[]; edges: unknown[] } };
    expect(body.success).toBe(true);
    expect(body.data.nodes).toEqual([]);
    expect(body.data.edges).toEqual([]);
  });

  test("returns 200 even when config load throws", async () => {
    configShouldThrow = true;
    const app = makeApp();
    const res = await getGraph(app);
    expect(res.status).toBe(200);
  });

  test("returns empty graph when config load throws", async () => {
    configShouldThrow = true;
    const app = makeApp();
    const res = await getGraph(app);
    const body = await res.json() as { success: boolean; data: { nodes: unknown[]; edges: unknown[] } };
    expect(body.success).toBe(true);
    expect(body.data.nodes).toEqual([]);
    expect(body.data.edges).toEqual([]);
  });

  test("returns 200 when SIGE config is not present in config", async () => {
    sigeConfigPresent = false;
    const app = makeApp();
    const res = await getGraph(app);
    expect(res.status).toBe(200);
  });

  test("returns empty graph when SIGE config is not present", async () => {
    sigeConfigPresent = false;
    const app = makeApp();
    const res = await getGraph(app);
    const body = await res.json() as { success: boolean; data: { nodes: unknown[]; edges: unknown[] } };
    expect(body.success).toBe(true);
    expect(body.data.nodes).toEqual([]);
    expect(body.data.edges).toEqual([]);
  });
});

describe("GET /sige/sessions/:id/graph — happy path", () => {
  beforeEach(() => {
    getFullGraphShouldThrow = false;
    configShouldThrow = false;
    sigeConfigPresent = true;
    mockGetFullGraph.mockClear();
  });

  test("returns 200 on success", async () => {
    const app = makeApp();
    const res = await getGraph(app);
    expect(res.status).toBe(200);
  });

  test("returns success=true on success", async () => {
    const app = makeApp();
    const res = await getGraph(app);
    const body = await res.json() as { success: boolean };
    expect(body.success).toBe(true);
  });

  test("returns nodes from getFullGraph on success", async () => {
    const app = makeApp();
    const res = await getGraph(app);
    const body = await res.json() as { success: boolean; data: { nodes: unknown[] } };
    // The mock returns 1 node
    expect(body.data.nodes.length).toBe(1);
  });

  test("uses 10s cache — second call does not invoke getFullGraph again", async () => {
    const app = makeApp();
    await getGraph(app);
    await getGraph(app);
    // First call populates cache; second should hit cache, not call getFullGraph again
    // (both calls share the same userId="test-user" from the mocked config)
    expect(mockGetFullGraph.mock.calls.length).toBeLessThanOrEqual(1);
  });

  test("accepts any sessionId (forward-compat — returns global graph)", async () => {
    const app = makeApp();
    const res = await getGraph(app, "different-session-id");
    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean };
    expect(body.success).toBe(true);
  });
});
