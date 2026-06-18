/**
 * Integration tests for the pipeline HTTP routes.
 *
 * Tests the read-only + status-polling paths that only need PostgreSQL:
 * - GET /pipelines — list pipeline definitions with latest run
 * - GET /pipelines/:id — specific pipeline + latest run
 * - GET /pipelines/:id/runs — run list for a pipeline
 * - GET /pipelines-runs — all recent runs
 * - GET /pipelines-runs/:runId — specific run with steps
 * - GET /pipelines-runs/:runId/ideas — ideas for a run
 * - GET /pipeline-ideas — filtered ideas list with pagination
 * - GET /pipeline-ideas/runs — list of runs for filter dropdown
 * - PATCH /pipeline-ideas/:id/stage — validate stage enum + 400 shapes
 * - POST /pipelines/:id/run — 404 on unknown pipeline id + 400 on bad config
 * - POST /pipelines-runs/resume-interrupted — 202 + resumed count
 *
 * Fire-and-forget run triggers (actual pipeline execution) are intentionally
 * NOT exercised in the integration lane — they require the full agent/LLM stack.
 *
 * Lane: *.integration.test.ts — run with `bun run test:integration`
 * Requires: docker compose up -d postgres
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb } from "../../store/db";
import { createPipelineRoutes } from "./pipelines";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE = "http://localhost";

function makeApp() {
  return createPipelineRoutes();
}

async function json<T>(res: Response): Promise<T> {
  return res.json() as Promise<T>;
}

async function get(app: ReturnType<typeof makeApp>, path: string): Promise<Response> {
  return Promise.resolve(app.fetch(new Request(`${BASE}${path}`)));
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

async function patch(app: ReturnType<typeof makeApp>, path: string, body: unknown): Promise<Response> {
  return Promise.resolve(
    app.fetch(
      new Request(`${BASE}${path}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    ),
  );
}

// ---------------------------------------------------------------------------
// DB lifecycle
// ---------------------------------------------------------------------------

beforeEach(async () => {
  await initDb(process.env.DATABASE_URL);
});

afterEach(async () => {
  await closeDb();
});

// ---------------------------------------------------------------------------
// GET /pipelines
// ---------------------------------------------------------------------------

describe("GET /pipelines", () => {
  it("200 + array of pipeline definitions", async () => {
    const app = makeApp();
    const res = await get(app, "/pipelines");

    expect(res.status).toBe(200);
    const body = await json<{ success: boolean; data: Array<{ id: string }> }>(res);
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
  });

  it("each pipeline entry has id, name, and latestRun field", async () => {
    const app = makeApp();
    const res = await get(app, "/pipelines");
    const body = await json<{
      data: Array<{ id: string; name: string; latestRun: unknown }>;
    }>(res);

    for (const pipeline of body.data) {
      expect(typeof pipeline.id).toBe("string");
      expect(typeof pipeline.name).toBe("string");
      // latestRun is either null or an object
      expect(pipeline.latestRun === null || typeof pipeline.latestRun === "object").toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// GET /pipelines/:id
// ---------------------------------------------------------------------------

describe("GET /pipelines/:id", () => {
  it("returns a known pipeline definition if it exists", async () => {
    const app = makeApp();

    // First fetch the list to find a valid id
    const listRes = await get(app, "/pipelines");
    const listBody = await json<{ data: Array<{ id: string }> }>(listRes);

    if (listBody.data.length === 0) {
      // No pipelines registered — skip the happy-path assertion
      return;
    }

    const firstId = listBody.data[0]!.id;
    const res = await get(app, `/pipelines/${firstId}`);
    expect(res.status).toBe(200);

    const body = await json<{ success: boolean; data: { id: string } }>(res);
    expect(body.success).toBe(true);
    expect(body.data.id).toBe(firstId);
  });

  it("404 for unknown pipeline id", async () => {
    const app = makeApp();
    const res = await get(app, "/pipelines/no-such-pipeline-xyz");

    expect(res.status).toBe(404);
    const body = await json<{ success: boolean }>(res);
    expect(body.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// GET /pipelines-runs
// ---------------------------------------------------------------------------

describe("GET /pipelines-runs", () => {
  it("200 + array", async () => {
    const app = makeApp();
    const res = await get(app, "/pipelines-runs");

    expect(res.status).toBe(200);
    const body = await json<{ success: boolean; data: unknown[] }>(res);
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
  });

  it("respects ?limit param", async () => {
    const app = makeApp();
    const res = await get(app, "/pipelines-runs?limit=2");

    expect(res.status).toBe(200);
    const body = await json<{ data: unknown[] }>(res);
    expect(body.data.length).toBeLessThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// GET /pipelines-runs/:runId
// ---------------------------------------------------------------------------

describe("GET /pipelines-runs/:runId", () => {
  it("404 for unknown runId", async () => {
    const app = makeApp();
    const res = await get(app, "/pipelines-runs/no-such-run-id");

    expect(res.status).toBe(404);
    const body = await json<{ success: boolean }>(res);
    expect(body.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// GET /pipelines-runs/:runId/ideas
// ---------------------------------------------------------------------------

describe("GET /pipelines-runs/:runId/ideas", () => {
  it("200 + empty array for unknown run (no ideas)", async () => {
    const app = makeApp();
    const res = await get(app, "/pipelines-runs/no-such-run-id/ideas");

    // The store returns [] for unknown runId — no 404 here
    expect(res.status).toBe(200);
    const body = await json<{ success: boolean; data: unknown[] }>(res);
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// POST /pipelines-runs/resume-interrupted
// ---------------------------------------------------------------------------

describe("POST /pipelines-runs/resume-interrupted", () => {
  it("202 + resumed count (may be 0 on clean DB)", async () => {
    const app = makeApp();
    const res = await post(app, "/pipelines-runs/resume-interrupted", {});

    expect(res.status).toBe(202);
    const body = await json<{ success: boolean; resumed: number }>(res);
    expect(body.success).toBe(true);
    expect(typeof body.resumed).toBe("number");
    expect(body.resumed).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// POST /pipelines/:id/run — validation layer
// ---------------------------------------------------------------------------

describe("POST /pipelines/:id/run", () => {
  it("404 on unknown pipeline id", async () => {
    const app = makeApp();
    const res = await post(app, "/pipelines/no-such-pipeline/run", {});

    expect(res.status).toBe(404);
    const body = await json<{ success: boolean }>(res);
    expect(body.success).toBe(false);
  });

  it("400 on invalid config override (unknown field — strict schema)", async () => {
    const app = makeApp();
    // Fetch a valid pipeline id first
    const listRes = await get(app, "/pipelines");
    const listBody = await json<{ data: Array<{ id: string }> }>(listRes);

    if (listBody.data.length === 0) return; // no pipelines — skip

    const id = listBody.data[0]!.id;
    const res = await post(app, `/pipelines/${id}/run`, { unknownField: "bad" });

    // runConfigSchema is .strict() — extra fields return 400
    expect(res.status).toBe(400);
    const body = await json<{ success: boolean }>(res);
    expect(body.success).toBe(false);
  });

  it("400 on maxIdeas out of range (> 20)", async () => {
    const app = makeApp();
    const listRes = await get(app, "/pipelines");
    const listBody = await json<{ data: Array<{ id: string }> }>(listRes);

    if (listBody.data.length === 0) return;

    const id = listBody.data[0]!.id;
    const res = await post(app, `/pipelines/${id}/run`, { maxIdeas: 999 });

    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// GET /pipeline-ideas
// ---------------------------------------------------------------------------

describe("GET /pipeline-ideas", () => {
  it("200 + data array and meta object", async () => {
    const app = makeApp();
    const res = await get(app, "/pipeline-ideas");

    expect(res.status).toBe(200);
    const body = await json<{
      success: boolean;
      data: unknown[];
      meta: { total: number; limit: number; offset: number };
    }>(res);
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
    expect(typeof body.meta.total).toBe("number");
    expect(typeof body.meta.limit).toBe("number");
    expect(typeof body.meta.offset).toBe("number");
  });

  it("respects ?limit param", async () => {
    const app = makeApp();
    const res = await get(app, "/pipeline-ideas?limit=2");

    expect(res.status).toBe(200);
    const body = await json<{ data: unknown[]; meta: { limit: number } }>(res);
    expect(body.data.length).toBeLessThanOrEqual(2);
    expect(body.meta.limit).toBe(2);
  });

  it("respects ?offset param", async () => {
    const app = makeApp();
    const res = await get(app, "/pipeline-ideas?offset=100&limit=5");

    expect(res.status).toBe(200);
    const body = await json<{ meta: { offset: number } }>(res);
    expect(body.meta.offset).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// GET /pipeline-ideas/runs
// ---------------------------------------------------------------------------

describe("GET /pipeline-ideas/runs", () => {
  it("200 + array", async () => {
    const app = makeApp();
    const res = await get(app, "/pipeline-ideas/runs");

    expect(res.status).toBe(200);
    const body = await json<{ success: boolean; data: unknown[] }>(res);
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// PATCH /pipeline-ideas/:id/stage — validation boundaries
// ---------------------------------------------------------------------------

describe("PATCH /pipeline-ideas/:id/stage", () => {
  it("400 on invalid stage value", async () => {
    const app = makeApp();
    const res = await patch(app, "/pipeline-ideas/any-id/stage", { stage: "invalid-stage" });

    expect(res.status).toBe(400);
    const body = await json<{ success: boolean; error: string }>(res);
    expect(body.success).toBe(false);
    expect(body.error).toContain("stage");
  });

  it("400 on missing stage field", async () => {
    const app = makeApp();
    const res = await patch(app, "/pipeline-ideas/any-id/stage", { notStage: "idea" });

    expect(res.status).toBe(400);
    const body = await json<{ success: boolean }>(res);
    expect(body.success).toBe(false);
  });

  it("400 on malformed JSON body", async () => {
    const app = makeApp();
    const res = await Promise.resolve(
      app.fetch(
        new Request(`${BASE}/pipeline-ideas/any-id/stage`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: "{{broken",
        }),
      ),
    );

    expect(res.status).toBe(400);
    const body = await json<{ success: boolean }>(res);
    expect(body.success).toBe(false);
  });

  it("404 on unknown idea id with valid stage", async () => {
    const app = makeApp();
    const res = await patch(app, "/pipeline-ideas/no-such-idea-id/stage", {
      stage: "validated",
    });

    expect(res.status).toBe(404);
    const body = await json<{ success: boolean }>(res);
    expect(body.success).toBe(false);
  });

  it("accepts valid stage values without rejecting them", async () => {
    // We only verify the validation passes — we can't easily create a real idea
    // in tests without running the full pipeline, so 404 is the expected outcome
    // for an unknown idea id, but the important thing is status is NOT 400.
    const app = makeApp();
    const validStages = ["idea", "validated", "archived"] as const;

    for (const stage of validStages) {
      const res = await patch(app, "/pipeline-ideas/fake-idea-id/stage", { stage });
      // Should be 404 (idea not found) — NOT 400 (validation rejection)
      expect(res.status).toBe(404);
    }
  });
});
