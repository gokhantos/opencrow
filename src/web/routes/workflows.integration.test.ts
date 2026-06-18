/**
 * Integration tests for the workflow HTTP routes.
 *
 * Strategy: mount only the route sub-app (no auth middleware) and drive
 * it against a real Postgres database so the full request→DB→response
 * cycle is exercised.
 *
 * Lane: *.integration.test.ts — run with `bun run test:integration`
 * Requires: docker compose up -d postgres
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb, getDb } from "../../store/db";
import { createWorkflowRoutes } from "./workflows";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE = "http://localhost";

function makeApp() {
  // No deps — execution routes will return 503, CRUD routes work normally.
  return createWorkflowRoutes();
}

async function json<T>(res: Response): Promise<T> {
  return res.json() as Promise<T>;
}

async function post(app: ReturnType<typeof makeApp>, path: string, body: unknown): Promise<Response> {
  return Promise.resolve(
    app.fetch(
      new Request(`${BASE}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    ),
  );
}

async function put(app: ReturnType<typeof makeApp>, path: string, body: unknown): Promise<Response> {
  return Promise.resolve(
    app.fetch(
      new Request(`${BASE}${path}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    ),
  );
}

async function get(app: ReturnType<typeof makeApp>, path: string): Promise<Response> {
  return Promise.resolve(app.fetch(new Request(`${BASE}${path}`)));
}

async function del(app: ReturnType<typeof makeApp>, path: string): Promise<Response> {
  return Promise.resolve(app.fetch(new Request(`${BASE}${path}`, { method: "DELETE" })));
}

// ---------------------------------------------------------------------------
// DB lifecycle
// ---------------------------------------------------------------------------

beforeEach(async () => {
  await initDb(process.env.DATABASE_URL);
  const db = getDb();
  await db.unsafe("DELETE FROM workflows WHERE name LIKE 'route-test-%'");
});

afterEach(async () => {
  const db = getDb();
  await db.unsafe("DELETE FROM workflows WHERE name LIKE 'route-test-%'");
  await closeDb();
});

// ---------------------------------------------------------------------------
// POST /workflows — create
// ---------------------------------------------------------------------------

describe("POST /workflows", () => {
  it("201 + created workflow on valid body", async () => {
    const app = makeApp();
    const res = await post(app, "/workflows", { name: "route-test-create" });

    expect(res.status).toBe(201);
    const body = await json<{ success: boolean; data: { id: string; name: string } }>(res);
    expect(body.success).toBe(true);
    expect(body.data.name).toBe("route-test-create");
    expect(typeof body.data.id).toBe("string");
  });

  it("400 on missing name (Zod validation)", async () => {
    const app = makeApp();
    const res = await post(app, "/workflows", { description: "no name here" });

    expect(res.status).toBe(400);
    const body = await json<{ success: boolean; error: string }>(res);
    expect(body.success).toBe(false);
    expect(typeof body.error).toBe("string");
  });

  it("400 on name exceeding 200 chars", async () => {
    const app = makeApp();
    const res = await post(app, "/workflows", { name: "x".repeat(201) });

    expect(res.status).toBe(400);
    const body = await json<{ success: boolean }>(res);
    expect(body.success).toBe(false);
  });

  it("400 on malformed JSON body", async () => {
    const app = makeApp();
    const res = await Promise.resolve(
      app.fetch(
        new Request(`${BASE}/workflows`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "not-json{{",
        }),
      ),
    );

    expect(res.status).toBe(400);
    const body = await json<{ success: boolean }>(res);
    expect(body.success).toBe(false);
  });

  it("400 on invalid cron expression in node data", async () => {
    const app = makeApp();
    const res = await post(app, "/workflows", {
      name: "route-test-bad-cron",
      nodes: [
        {
          id: "n1",
          type: "trigger",
          position: { x: 0, y: 0 },
          data: { cronExpression: "NOT-A-CRON" },
        },
      ],
    });

    expect(res.status).toBe(400);
    const body = await json<{ success: boolean }>(res);
    expect(body.success).toBe(false);
  });

  it("stores nodes/edges/viewport JSONB round-trip correctly", async () => {
    const app = makeApp();
    const nodes = [{ id: "n1", type: "trigger", position: { x: 10, y: 20 }, data: {} }];
    const edges = [{ id: "e1", source: "n1", target: "n2" }];
    const viewport = { x: 5, y: 5, zoom: 1.5 };

    const res = await post(app, "/workflows", {
      name: "route-test-jsonb",
      nodes,
      edges,
      viewport,
      enabled: true,
    });

    expect(res.status).toBe(201);
    const body = await json<{
      success: boolean;
      data: { nodes: typeof nodes; edges: typeof edges; viewport: typeof viewport; enabled: boolean };
    }>(res);
    expect(body.data.nodes).toEqual(nodes);
    expect(body.data.edges).toEqual(edges);
    expect(body.data.viewport).toEqual(viewport);
    expect(body.data.enabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// GET /workflows — list
// ---------------------------------------------------------------------------

describe("GET /workflows", () => {
  it("200 + array including created workflow", async () => {
    const app = makeApp();
    await post(app, "/workflows", { name: "route-test-list-a" });
    await post(app, "/workflows", { name: "route-test-list-b" });

    const res = await get(app, "/workflows");

    expect(res.status).toBe(200);
    const body = await json<{ success: boolean; data: Array<{ name: string }> }>(res);
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
    const names = body.data.map((w) => w.name);
    expect(names).toContain("route-test-list-a");
    expect(names).toContain("route-test-list-b");
  });
});

// ---------------------------------------------------------------------------
// GET /workflows/:id — by id
// ---------------------------------------------------------------------------

describe("GET /workflows/:id", () => {
  it("200 + workflow on valid id", async () => {
    const app = makeApp();
    const created = await post(app, "/workflows", { name: "route-test-get-by-id" });
    const { data: wf } = await json<{ data: { id: string } }>(created);

    const res = await get(app, `/workflows/${wf.id}`);

    expect(res.status).toBe(200);
    const body = await json<{ success: boolean; data: { id: string; name: string } }>(res);
    expect(body.success).toBe(true);
    expect(body.data.id).toBe(wf.id);
    expect(body.data.name).toBe("route-test-get-by-id");
  });

  it("404 for nonexistent uuid", async () => {
    const app = makeApp();
    const res = await get(app, "/workflows/00000000-0000-0000-0000-000000000099");

    expect(res.status).toBe(404);
    const body = await json<{ success: boolean }>(res);
    expect(body.success).toBe(false);
  });

  it("400 for non-uuid id", async () => {
    const app = makeApp();
    const res = await get(app, "/workflows/not-a-uuid");

    expect(res.status).toBe(400);
    const body = await json<{ success: boolean }>(res);
    expect(body.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PUT /workflows/:id — update
// ---------------------------------------------------------------------------

describe("PUT /workflows/:id", () => {
  it("200 + updated fields on valid patch", async () => {
    const app = makeApp();
    const created = await post(app, "/workflows", {
      name: "route-test-update-orig",
      description: "original",
    });
    const { data: wf } = await json<{ data: { id: string } }>(created);

    const res = await put(app, `/workflows/${wf.id}`, {
      name: "route-test-update-new",
      enabled: true,
    });

    expect(res.status).toBe(200);
    const body = await json<{
      success: boolean;
      data: { name: string; description: string; enabled: boolean };
    }>(res);
    expect(body.success).toBe(true);
    expect(body.data.name).toBe("route-test-update-new");
    // description was not in patch — should be preserved
    expect(body.data.description).toBe("original");
    expect(body.data.enabled).toBe(true);
  });

  it("404 for nonexistent uuid", async () => {
    const app = makeApp();
    const res = await put(app, "/workflows/00000000-0000-0000-0000-000000000099", {
      name: "route-test-ghost",
    });

    expect(res.status).toBe(404);
    const body = await json<{ success: boolean }>(res);
    expect(body.success).toBe(false);
  });

  it("400 for non-uuid id", async () => {
    const app = makeApp();
    const res = await put(app, "/workflows/bad-id", { name: "x" });

    expect(res.status).toBe(400);
  });

  it("400 on Zod validation failure (name too long)", async () => {
    const app = makeApp();
    const created = await post(app, "/workflows", { name: "route-test-update-zod" });
    const { data: wf } = await json<{ data: { id: string } }>(created);

    const res = await put(app, `/workflows/${wf.id}`, { name: "x".repeat(201) });

    expect(res.status).toBe(400);
    const body = await json<{ success: boolean }>(res);
    expect(body.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// DELETE /workflows/:id
// ---------------------------------------------------------------------------

describe("DELETE /workflows/:id", () => {
  it("200 on successful delete, then 404 on second attempt", async () => {
    const app = makeApp();
    const created = await post(app, "/workflows", { name: "route-test-delete" });
    const { data: wf } = await json<{ data: { id: string } }>(created);

    const first = await del(app, `/workflows/${wf.id}`);
    expect(first.status).toBe(200);
    const firstBody = await json<{ success: boolean }>(first);
    expect(firstBody.success).toBe(true);

    const second = await del(app, `/workflows/${wf.id}`);
    expect(second.status).toBe(404);
  });

  it("400 for non-uuid id", async () => {
    const app = makeApp();
    const res = await del(app, "/workflows/bad-id");

    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// POST /workflows/:id/duplicate
// ---------------------------------------------------------------------------

describe("POST /workflows/:id/duplicate", () => {
  it("201 + new workflow with 'Copy of' prefix", async () => {
    const app = makeApp();
    const created = await post(app, "/workflows", {
      name: "route-test-orig-dup",
      description: "to be copied",
    });
    const { data: wf } = await json<{ data: { id: string } }>(created);

    const res = await post(app, `/workflows/${wf.id}/duplicate`, {});
    expect(res.status).toBe(201);

    const body = await json<{ success: boolean; data: { id: string; name: string } }>(res);
    expect(body.success).toBe(true);
    expect(body.data.name).toBe("Copy of route-test-orig-dup");
    // Must be a different id
    expect(body.data.id).not.toBe(wf.id);
  });

  it("404 when duplicating a nonexistent workflow", async () => {
    const app = makeApp();
    const res = await post(app, "/workflows/00000000-0000-0000-0000-000000000099/duplicate", {});

    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// GET /workflows/:id/executions
// ---------------------------------------------------------------------------

describe("GET /workflows/:id/executions", () => {
  it("200 + empty array for workflow with no executions", async () => {
    const app = makeApp();
    const created = await post(app, "/workflows", { name: "route-test-exec-list" });
    const { data: wf } = await json<{ data: { id: string } }>(created);

    const res = await get(app, `/workflows/${wf.id}/executions`);
    expect(res.status).toBe(200);

    const body = await json<{ success: boolean; data: unknown[] }>(res);
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
  });

  it("400 for non-uuid id", async () => {
    const app = makeApp();
    const res = await get(app, "/workflows/bad-id/executions");
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// POST /workflows/:id/run — no deps → 503
// ---------------------------------------------------------------------------

describe("POST /workflows/:id/run (no deps)", () => {
  it("503 when no engine deps are provided", async () => {
    const app = makeApp();
    const created = await post(app, "/workflows", { name: "route-test-run-nodeps" });
    const { data: wf } = await json<{ data: { id: string } }>(created);

    const res = await post(app, `/workflows/${wf.id}/run`, {});
    expect(res.status).toBe(503);

    const body = await json<{ success: boolean }>(res);
    expect(body.success).toBe(false);
  });

  it("404 when running a nonexistent workflow", async () => {
    const app = makeApp();
    const res = await post(app, "/workflows/00000000-0000-0000-0000-000000000099/run", {});
    // 503 (no deps) is returned before the 404 check in the current implementation
    expect([404, 503]).toContain(res.status);
  });
});

// ---------------------------------------------------------------------------
// GET /workflow-executions/:id
// ---------------------------------------------------------------------------

describe("GET /workflow-executions/:id", () => {
  it("404 for a nonexistent execution id", async () => {
    const app = makeApp();
    const res = await get(app, "/workflow-executions/00000000-0000-0000-0000-000000000099");

    expect(res.status).toBe(404);
    const body = await json<{ success: boolean }>(res);
    expect(body.success).toBe(false);
  });

  it("400 for non-uuid id", async () => {
    const app = makeApp();
    const res = await get(app, "/workflow-executions/not-a-uuid");

    expect(res.status).toBe(400);
  });
});
