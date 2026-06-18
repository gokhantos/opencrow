/**
 * Integration tests for the cron HTTP routes.
 *
 * Strategy: mount the route sub-app with a real CronStore against a real
 * Postgres database so the full request→DB→response cycle is exercised.
 *
 * Lane: *.integration.test.ts — run with `bun run test:integration`
 * Requires: docker compose up -d postgres
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb, getDb } from "../../store/db";
import { createCronStore } from "../../cron/store";
import { createCronRoutes } from "./cron";
import type { WebAppDeps } from "../app";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE = "http://localhost";

function makeApp() {
  const cronStore = createCronStore();
  // Minimal WebAppDeps — only cronStore is needed for cron routes
  const deps = {
    cronStore,
    cronScheduler: undefined,
    coreClient: undefined,
  } as unknown as WebAppDeps;
  return { app: createCronRoutes(deps), cronStore };
}

async function json<T>(res: Response): Promise<T> {
  return res.json() as Promise<T>;
}

async function post(
  app: ReturnType<typeof makeApp>["app"],
  path: string,
  body: unknown,
): Promise<Response> {
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

async function patch(
  app: ReturnType<typeof makeApp>["app"],
  path: string,
  body: unknown,
): Promise<Response> {
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

async function get(app: ReturnType<typeof makeApp>["app"], path: string): Promise<Response> {
  return Promise.resolve(app.fetch(new Request(`${BASE}${path}`)));
}

async function del(app: ReturnType<typeof makeApp>["app"], path: string): Promise<Response> {
  return Promise.resolve(app.fetch(new Request(`${BASE}${path}`, { method: "DELETE" })));
}

// Valid minimal job body
const minimalJobBody = () => ({
  name: "route-test-cron-job",
  schedule: { kind: "every" as const, everyMs: 60_000 },
  payload: { kind: "agentTurn" as const, message: "hello" },
});

// ---------------------------------------------------------------------------
// DB lifecycle
// ---------------------------------------------------------------------------

beforeEach(async () => {
  await initDb(process.env.DATABASE_URL);
  const db = getDb();
  await db.unsafe("DELETE FROM cron_runs");
  await db.unsafe("DELETE FROM cron_jobs WHERE name LIKE 'route-test-%'");
});

afterEach(async () => {
  const db = getDb();
  await db.unsafe("DELETE FROM cron_runs");
  await db.unsafe("DELETE FROM cron_jobs WHERE name LIKE 'route-test-%'");
  await closeDb();
});

// ---------------------------------------------------------------------------
// POST /cron/jobs — create
// ---------------------------------------------------------------------------

describe("POST /cron/jobs", () => {
  it("201 + created job on valid body (every schedule)", async () => {
    const { app } = makeApp();
    const res = await post(app, "/cron/jobs", minimalJobBody());

    expect(res.status).toBe(201);
    const body = await json<{
      success: boolean;
      data: { id: string; name: string; enabled: boolean };
    }>(res);
    expect(body.success).toBe(true);
    expect(body.data.name).toBe("route-test-cron-job");
    expect(typeof body.data.id).toBe("string");
    expect(body.data.enabled).toBe(true);
  });

  it("201 + created job with cron schedule", async () => {
    const { app } = makeApp();
    const res = await post(app, "/cron/jobs", {
      name: "route-test-cron-expr",
      schedule: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
      payload: { kind: "agentTurn", message: "daily check" },
    });

    expect(res.status).toBe(201);
    const body = await json<{ success: boolean; data: { name: string } }>(res);
    expect(body.success).toBe(true);
    expect(body.data.name).toBe("route-test-cron-expr");
  });

  it("400 on missing name", async () => {
    const { app } = makeApp();
    const { name: _name, ...withoutName } = minimalJobBody();
    const res = await post(app, "/cron/jobs", withoutName);

    expect(res.status).toBe(400);
    const body = await json<{ success: boolean }>(res);
    expect(body.success).toBe(false);
  });

  it("400 on invalid schedule kind", async () => {
    const { app } = makeApp();
    const res = await post(app, "/cron/jobs", {
      ...minimalJobBody(),
      schedule: { kind: "invalid", everyMs: 1000 },
    });

    expect(res.status).toBe(400);
    const body = await json<{ success: boolean }>(res);
    expect(body.success).toBe(false);
  });

  it("400 on everyMs too small (< 1000)", async () => {
    const { app } = makeApp();
    const res = await post(app, "/cron/jobs", {
      ...minimalJobBody(),
      schedule: { kind: "every", everyMs: 500 },
    });

    expect(res.status).toBe(400);
    const body = await json<{ success: boolean }>(res);
    expect(body.success).toBe(false);
  });

  it("400 on empty message in payload", async () => {
    const { app } = makeApp();
    const res = await post(app, "/cron/jobs", {
      ...minimalJobBody(),
      payload: { kind: "agentTurn", message: "" },
    });

    expect(res.status).toBe(400);
    const body = await json<{ success: boolean }>(res);
    expect(body.success).toBe(false);
  });

  it("400 on priority out of range (> 20)", async () => {
    const { app } = makeApp();
    const res = await post(app, "/cron/jobs", {
      ...minimalJobBody(),
      priority: 99,
    });

    expect(res.status).toBe(400);
    const body = await json<{ success: boolean }>(res);
    expect(body.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// GET /cron/jobs — list
// ---------------------------------------------------------------------------

describe("GET /cron/jobs", () => {
  it("200 + array containing the created job", async () => {
    const { app } = makeApp();
    await post(app, "/cron/jobs", { ...minimalJobBody(), name: "route-test-list-cron" });

    const res = await get(app, "/cron/jobs");
    expect(res.status).toBe(200);

    const body = await json<{ success: boolean; data: Array<{ name: string }> }>(res);
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.map((j) => j.name)).toContain("route-test-list-cron");
  });
});

// ---------------------------------------------------------------------------
// PATCH /cron/jobs/:id
// ---------------------------------------------------------------------------

describe("PATCH /cron/jobs/:id", () => {
  it("200 + updated enabled field", async () => {
    const { app } = makeApp();
    const created = await post(app, "/cron/jobs", {
      ...minimalJobBody(),
      name: "route-test-patch-cron",
    });
    const { data: job } = await json<{ data: { id: string } }>(created);

    const res = await patch(app, `/cron/jobs/${job.id}`, { enabled: false });
    expect(res.status).toBe(200);

    const body = await json<{ success: boolean; data: { enabled: boolean } }>(res);
    expect(body.success).toBe(true);
    expect(body.data.enabled).toBe(false);
  });

  it("200 + updated name", async () => {
    const { app } = makeApp();
    const created = await post(app, "/cron/jobs", {
      ...minimalJobBody(),
      name: "route-test-patch-name-orig",
    });
    const { data: job } = await json<{ data: { id: string } }>(created);

    const res = await patch(app, `/cron/jobs/${job.id}`, { name: "route-test-patch-name-new" });
    expect(res.status).toBe(200);

    const body = await json<{ success: boolean; data: { name: string } }>(res);
    expect(body.success).toBe(true);
    expect(body.data.name).toBe("route-test-patch-name-new");
  });

  it("404 for nonexistent job id", async () => {
    const { app } = makeApp();
    const res = await patch(app, "/cron/jobs/00000000-0000-0000-0000-000000000099", {
      enabled: false,
    });

    expect(res.status).toBe(404);
    const body = await json<{ success: boolean }>(res);
    expect(body.success).toBe(false);
  });

  it("400 on invalid priority value", async () => {
    const { app } = makeApp();
    const created = await post(app, "/cron/jobs", {
      ...minimalJobBody(),
      name: "route-test-patch-invalid",
    });
    const { data: job } = await json<{ data: { id: string } }>(created);

    const res = await patch(app, `/cron/jobs/${job.id}`, { priority: 100 });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// DELETE /cron/jobs/:id
// ---------------------------------------------------------------------------

describe("DELETE /cron/jobs/:id", () => {
  it("200 on successful delete", async () => {
    const { app } = makeApp();
    const created = await post(app, "/cron/jobs", {
      ...minimalJobBody(),
      name: "route-test-delete-cron",
    });
    const { data: job } = await json<{ data: { id: string } }>(created);

    const res = await del(app, `/cron/jobs/${job.id}`);
    expect(res.status).toBe(200);
    const body = await json<{ success: boolean }>(res);
    expect(body.success).toBe(true);
  });

  it("404 after second delete attempt", async () => {
    const { app } = makeApp();
    const created = await post(app, "/cron/jobs", {
      ...minimalJobBody(),
      name: "route-test-delete-twice",
    });
    const { data: job } = await json<{ data: { id: string } }>(created);

    await del(app, `/cron/jobs/${job.id}`);
    const second = await del(app, `/cron/jobs/${job.id}`);

    expect(second.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// POST /cron/jobs/:id/toggle
// ---------------------------------------------------------------------------

describe("POST /cron/jobs/:id/toggle", () => {
  it("flips enabled from true to false", async () => {
    const { app } = makeApp();
    const created = await post(app, "/cron/jobs", {
      ...minimalJobBody(),
      name: "route-test-toggle-cron",
      enabled: true,
    });
    const { data: job } = await json<{ data: { id: string; enabled: boolean } }>(created);
    expect(job.enabled).toBe(true);

    const res = await post(app, `/cron/jobs/${job.id}/toggle`, {});
    expect(res.status).toBe(200);
    const body = await json<{ success: boolean; data: { enabled: boolean } }>(res);
    expect(body.success).toBe(true);
    expect(body.data.enabled).toBe(false);
  });

  it("404 for nonexistent job id", async () => {
    const { app } = makeApp();
    const res = await post(app, "/cron/jobs/00000000-0000-0000-0000-000000000099/toggle", {});

    expect(res.status).toBe(404);
    const body = await json<{ success: boolean }>(res);
    expect(body.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// GET /cron/jobs/:id/runs
// ---------------------------------------------------------------------------

describe("GET /cron/jobs/:id/runs", () => {
  it("200 + empty array for a new job with no runs", async () => {
    const { app } = makeApp();
    const created = await post(app, "/cron/jobs", {
      ...minimalJobBody(),
      name: "route-test-runs-list",
    });
    const { data: job } = await json<{ data: { id: string } }>(created);

    const res = await get(app, `/cron/jobs/${job.id}/runs`);
    expect(res.status).toBe(200);

    const body = await json<{ success: boolean; data: unknown[] }>(res);
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// GET /cron/status
// ---------------------------------------------------------------------------

describe("GET /cron/status", () => {
  it("200 + status object with expected shape", async () => {
    const { app } = makeApp();
    const res = await get(app, "/cron/status");

    expect(res.status).toBe(200);
    const body = await json<{
      success: boolean;
      data: { running: boolean; jobCount: number; nextDueAt: number | null };
    }>(res);
    expect(body.success).toBe(true);
    expect(typeof body.data.running).toBe("boolean");
    expect(typeof body.data.jobCount).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// GET /cron/active-runs
// ---------------------------------------------------------------------------

describe("GET /cron/active-runs", () => {
  it("200 + empty array when no runs are active", async () => {
    const { app } = makeApp();
    const res = await get(app, "/cron/active-runs");

    expect(res.status).toBe(200);
    const body = await json<{ success: boolean; data: unknown[] }>(res);
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
  });
});
