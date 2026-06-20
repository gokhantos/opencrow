/**
 * Integration tests for the signals config HTTP route (config/smart.signal).
 *
 * Contracts:
 * - GET  /signals — returns the effective {facets,ranking,importanceFloor} +
 *   hasOverride + restartRequired, reading the merged app config.
 * - PUT  /signals — validates the partial body, persists it under
 *   config_overrides(namespace='config', key='smart.signal'), and the round-trip
 *   GET reflects it. Rejects unknown keys / empty bodies / bad enums.
 *
 * Auth lives in app.ts and is NOT mounted here (matches secrets/features tests).
 *
 * Lane: *.integration.test.ts — `bun run test:integration`.
 * Requires: docker compose up -d postgres
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb, getDb } from "../../store/db";
import { createConfigSignalsRoutes } from "./config-signals";

const BASE = "http://localhost";
const NAMESPACE = "config";
const KEY = "smart.signal";

function makeApp() {
  return createConfigSignalsRoutes();
}

async function json<T>(res: Response): Promise<T> {
  return res.json() as Promise<T>;
}

function get(app: ReturnType<typeof makeApp>, path: string): Promise<Response> {
  return Promise.resolve(app.fetch(new Request(`${BASE}${path}`)));
}

function put(
  app: ReturnType<typeof makeApp>,
  path: string,
  body: unknown,
): Promise<Response> {
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

async function clearOverride(): Promise<void> {
  const db = getDb();
  await db.unsafe(
    `DELETE FROM config_overrides WHERE namespace = '${NAMESPACE}' AND key = '${KEY}'`,
  );
}

beforeEach(async () => {
  await initDb(process.env.DATABASE_URL);
  await clearOverride();
});

afterEach(async () => {
  await clearOverride();
  await closeDb();
});

interface SignalsState {
  effective: { facets: boolean; ranking: boolean; importanceFloor: string };
  hasOverride: boolean;
  restartRequired: string[];
}

describe("GET /signals", () => {
  it("200 + effective shape with no override", async () => {
    const app = makeApp();
    const res = await get(app, "/signals");
    expect(res.status).toBe(200);

    const body = await json<{ success: boolean; data: SignalsState }>(res);
    expect(body.success).toBe(true);
    expect(typeof body.data.effective.facets).toBe("boolean");
    expect(typeof body.data.effective.ranking).toBe("boolean");
    expect(["low", "medium", "high"]).toContain(
      body.data.effective.importanceFloor,
    );
    expect(body.data.hasOverride).toBe(false);
    expect(body.data.restartRequired).toEqual([
      "facets",
      "ranking",
      "importanceFloor",
    ]);
  });
});

describe("PUT /signals", () => {
  it("200 persists a full body and round-trips through GET", async () => {
    const app = makeApp();
    const res = await put(app, "/signals", {
      facets: true,
      ranking: true,
      importanceFloor: "high",
    });
    expect(res.status).toBe(200);

    const after = await json<{ success: boolean; data: SignalsState }>(
      await get(app, "/signals"),
    );
    expect(after.data.hasOverride).toBe(true);
    expect(after.data.effective.facets).toBe(true);
    expect(after.data.effective.ranking).toBe(true);
    expect(after.data.effective.importanceFloor).toBe("high");
  });

  it("200 partial body preserves previously-saved fields", async () => {
    const app = makeApp();
    await put(app, "/signals", { facets: true, importanceFloor: "medium" });
    // Now update only ranking — facets + floor must survive.
    await put(app, "/signals", { ranking: true });

    const after = await json<{ data: SignalsState }>(await get(app, "/signals"));
    expect(after.data.effective.facets).toBe(true);
    expect(after.data.effective.ranking).toBe(true);
    expect(after.data.effective.importanceFloor).toBe("medium");
  });

  it("400 on unknown key (strict)", async () => {
    const app = makeApp();
    const res = await put(app, "/signals", { facets: true, bogus: 1 });
    expect(res.status).toBe(400);
    expect((await json<{ success: boolean }>(res)).success).toBe(false);
  });

  it("400 on empty body (no fields)", async () => {
    const app = makeApp();
    const res = await put(app, "/signals", {});
    expect(res.status).toBe(400);
    expect((await json<{ success: boolean }>(res)).success).toBe(false);
  });

  it("400 on invalid importanceFloor enum", async () => {
    const app = makeApp();
    const res = await put(app, "/signals", { importanceFloor: "noise" });
    expect(res.status).toBe(400);
    expect((await json<{ success: boolean }>(res)).success).toBe(false);
  });

  it("400 on malformed JSON body", async () => {
    const app = makeApp();
    const res = await Promise.resolve(
      app.fetch(
        new Request(`${BASE}/signals`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: "{{invalid",
        }),
      ),
    );
    expect(res.status).toBe(400);
    expect((await json<{ success: boolean }>(res)).success).toBe(false);
  });
});
