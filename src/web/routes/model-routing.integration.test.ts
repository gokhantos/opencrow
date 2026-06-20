/**
 * Integration tests for the model-routing HTTP routes.
 *
 * Key contracts:
 * - GET /model-routing            — returns all 8 process route rows (seeded by migration 030)
 * - PUT /model-routing/:key       — updates a route and reads back the new value
 * - PUT /model-routing/<unknown>  — 404 for unrecognised keys
 * - PUT /model-routing/:key       — 400 for an invalid provider value
 *
 * Auth middleware lives in the parent app container (app.ts) and is NOT mounted
 * here — route handler logic is tested directly, without bearer auth.
 *
 * Lane: *.integration.test.ts — run with `bun run test:integration`
 * Requires: postgres running (native: `opencrow native up postgres`, or compose)
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb, getDb } from "../../store/db";
import { createModelRoutingRoutes } from "./model-routing";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE = "http://localhost";

function makeApp() {
  return createModelRoutingRoutes();
}

async function json<T>(res: Response): Promise<T> {
  return res.json() as Promise<T>;
}

async function get(app: ReturnType<typeof makeApp>, path: string): Promise<Response> {
  return Promise.resolve(app.fetch(new Request(`${BASE}${path}`)));
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

// ---------------------------------------------------------------------------
// DB lifecycle
// ---------------------------------------------------------------------------

beforeEach(async () => {
  await initDb(process.env.DATABASE_URL);
});

afterEach(async () => {
  // Restore any routes we mutated during tests so subsequent runs start clean
  const db = getDb();
  await db.unsafe(
    `DELETE FROM config_overrides WHERE namespace = 'model-routing' AND key = 'signal.facets'`,
  );
  await closeDb();
});

// ---------------------------------------------------------------------------
// GET /model-routing
// ---------------------------------------------------------------------------

describe("GET /model-routing", () => {
  it("200 + returns all 8 routes after seed", async () => {
    const app = makeApp();
    const res = await get(app, "/model-routing");

    expect(res.status).toBe(200);
    const body = await json<{ routes: Array<{ key: string; provider: string; model: string }> }>(
      res,
    );
    // Migration 030 seeds 8 rows; getAllModelRoutes always returns all 8 keys
    // (falling back to defaults for any missing rows)
    expect(body.routes.length).toBe(8);
  });

  it("each route has key, provider, and model fields", async () => {
    const app = makeApp();
    const res = await get(app, "/model-routing");
    const body = await json<{ routes: Array<{ key: string; provider: string; model: string }> }>(
      res,
    );

    for (const route of body.routes) {
      expect(typeof route.key).toBe("string");
      expect(typeof route.provider).toBe("string");
      expect(typeof route.model).toBe("string");
      expect(route.model.length).toBeGreaterThan(0);
    }
  });

  it("includes all 8 expected process keys", async () => {
    const app = makeApp();
    const res = await get(app, "/model-routing");
    const body = await json<{ routes: Array<{ key: string }> }>(res);
    const keys = body.routes.map((r) => r.key);

    expect(keys).toContain("signal.facets");
    expect(keys).toContain("signal.observations");
    expect(keys).toContain("sige.fast-agent");
    expect(keys).toContain("sige.judge.0");
    expect(keys).toContain("sige.judge.1");
    expect(keys).toContain("sige.judge.2");
    expect(keys).toContain("pipeline.generator");
    expect(keys).toContain("agent-templates");
  });
});

// ---------------------------------------------------------------------------
// PUT /model-routing/:key
// ---------------------------------------------------------------------------

describe("PUT /model-routing/:key", () => {
  it("200 + returns the updated route", async () => {
    const app = makeApp();
    const res = await put(app, "/model-routing/signal.facets", {
      provider: "openrouter",
      model: "x/y",
    });

    expect(res.status).toBe(200);
    const body = await json<{ key: string; provider: string; model: string }>(res);
    expect(body.key).toBe("signal.facets");
    expect(body.provider).toBe("openrouter");
    expect(body.model).toBe("x/y");
  });

  it("PUT updates are reflected in subsequent GET", async () => {
    const app = makeApp();
    await put(app, "/model-routing/signal.facets", { provider: "openrouter", model: "x/y" });

    const res = await get(app, "/model-routing");
    const body = await json<{ routes: Array<{ key: string; provider: string; model: string }> }>(
      res,
    );
    const row = body.routes.find((r) => r.key === "signal.facets");
    expect(row).toBeDefined();
    expect(row!.provider).toBe("openrouter");
    expect(row!.model).toBe("x/y");
  });

  it("404 for an unrecognised key", async () => {
    const app = makeApp();
    const res = await put(app, "/model-routing/nope", {
      provider: "alibaba",
      model: "x",
    });

    expect(res.status).toBe(404);
    const body = await json<{ error: string }>(res);
    expect(body.error).toContain("nope");
  });

  it("400 for an invalid provider value", async () => {
    const app = makeApp();
    const res = await put(app, "/model-routing/signal.facets", {
      provider: "bogus",
      model: "x",
    });

    expect(res.status).toBe(400);
    const body = await json<{ error: string }>(res);
    expect(body.error).toBe("invalid route");
  });

  it("400 for malformed JSON body", async () => {
    const app = makeApp();
    const res = await Promise.resolve(
      app.fetch(
        new Request(`${BASE}/model-routing/signal.facets`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: "{{invalid",
        }),
      ),
    );

    expect(res.status).toBe(400);
    const body = await json<{ error: string }>(res);
    expect(body.error).toBe("invalid JSON body");
  });

  it("400 when model field is missing", async () => {
    const app = makeApp();
    const res = await put(app, "/model-routing/signal.facets", { provider: "alibaba" });

    expect(res.status).toBe(400);
  });
});
