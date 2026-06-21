/**
 * Integration tests for the graph-reasoning config HTTP route.
 *
 * Strategy: mount only the route sub-app (no auth middleware) against a real
 * Postgres database so the full request→config_overrides→loader→response cycle
 * is exercised (GET effective values, PUT persist + deep-merge, zod rejection).
 *
 * Lane: *.integration.test.ts — run with `bun run test:integration`
 * Requires: docker compose up -d postgres
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb, getDb } from "../../store/db";
import { deleteOverride } from "../../store/config-overrides";
import { createConfigGraphRoutes, NAMESPACE, KEY } from "./config-graph";

const BASE = "http://localhost";

function makeApp() {
  return createConfigGraphRoutes();
}

async function json<T>(res: Response): Promise<T> {
  return res.json() as Promise<T>;
}

async function get(app: ReturnType<typeof makeApp>): Promise<Response> {
  return Promise.resolve(app.fetch(new Request(`${BASE}/`)));
}

async function put(app: ReturnType<typeof makeApp>, body: unknown): Promise<Response> {
  return Promise.resolve(
    app.fetch(
      new Request(`${BASE}/`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    ),
  );
}

interface GraphData {
  readonly enabled: boolean;
  readonly maxHops: number;
  readonly maxPaths: number;
  readonly searchLimit: number;
  readonly minDegree: number;
  readonly maxDegree: number;
}

beforeEach(async () => {
  await initDb(process.env.DATABASE_URL);
  await deleteOverride(NAMESPACE, KEY);
});

afterEach(async () => {
  await deleteOverride(NAMESPACE, KEY);
  await closeDb();
});

describe("GET /config/graph", () => {
  it("200 + effective default config with restartRequired flag", async () => {
    const app = makeApp();
    const res = await get(app);
    expect(res.status).toBe(200);

    const body = await json<{
      success: boolean;
      data: GraphData;
      restartRequired: boolean;
    }>(res);
    expect(body.success).toBe(true);
    expect(body.restartRequired).toBe(true);
    expect(typeof body.data.enabled).toBe("boolean");
    expect(typeof body.data.maxHops).toBe("number");
    expect(typeof body.data.maxDegree).toBe("number");
  });

  it("reflects a persisted override (DB wins)", async () => {
    const app = makeApp();
    await put(app, { enabled: true, maxHops: 4 });

    const res = await get(app);
    const body = await json<{ data: GraphData }>(res);
    expect(body.data.enabled).toBe(true);
    expect(body.data.maxHops).toBe(4);
  });
});

describe("PUT /config/graph", () => {
  it("200 + deep-merges a partial override onto defaults", async () => {
    const app = makeApp();
    const res = await put(app, { maxPaths: 12 });
    expect(res.status).toBe(200);

    const body = await json<{ success: boolean; data: GraphData }>(res);
    expect(body.success).toBe(true);
    expect(body.data.maxPaths).toBe(12);
    // Unspecified fields keep their default (deep-merge, not replace).
    expect(typeof body.data.maxHops).toBe("number");

    // Verify it actually landed in config_overrides.
    const db = getDb();
    const rows = await db`
      SELECT value_json FROM config_overrides
      WHERE namespace = ${NAMESPACE} AND key = ${KEY}
    `;
    expect(rows.length).toBe(1);
  });

  it("400 on unknown key (strict)", async () => {
    const app = makeApp();
    const res = await put(app, { enabled: true, bogus: 1 });
    expect(res.status).toBe(400);
    const body = await json<{ success: boolean }>(res);
    expect(body.success).toBe(false);
  });

  it("400 on out-of-bounds value (maxHops > 6)", async () => {
    const app = makeApp();
    const res = await put(app, { maxHops: 99 });
    expect(res.status).toBe(400);
    const body = await json<{ success: boolean }>(res);
    expect(body.success).toBe(false);
  });

  it("400 on empty body (no fields)", async () => {
    const app = makeApp();
    const res = await put(app, {});
    expect(res.status).toBe(400);
  });

  it("400 on minDegree greater than maxDegree", async () => {
    const app = makeApp();
    const res = await put(app, { minDegree: 900, maxDegree: 10 });
    expect(res.status).toBe(400);
  });

  it("400 on malformed JSON body", async () => {
    const app = makeApp();
    const res = await Promise.resolve(
      app.fetch(
        new Request(`${BASE}/`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: "{{not-json",
        }),
      ),
    );
    expect(res.status).toBe(400);
  });
});
