/**
 * Integration tests for the SIGE config HTTP routes (config-as-data).
 *
 * Covers:
 * - GET  /config/sige          — current effective core + autonomous values
 * - PUT  /config/sige/core     — persists a partial config/sige override row
 * - PUT  /config/sige/auto     — persists a partial config/smart.sigeAuto row
 * - PUT round-trip is reflected in a subsequent GET
 * - zod rejection (400) for invalid bodies / unknown keys
 *
 * Auth middleware lives in the parent app container (app.ts) and is NOT mounted
 * here — route handler logic is tested directly, without bearer auth.
 *
 * Lane: *.integration.test.ts — run with `bun run test:integration`
 * Requires: postgres running (native: `opencrow native up postgres`, or compose)
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb } from "../../store/db";
import { deleteOverride } from "../../store/config-overrides";
import { createConfigSigeRoutes } from "./config-sige";

const BASE = "http://localhost";

function makeApp() {
  return createConfigSigeRoutes();
}

async function json<T>(res: Response): Promise<T> {
  return res.json() as Promise<T>;
}

async function get(app: ReturnType<typeof makeApp>, path: string): Promise<Response> {
  return Promise.resolve(app.fetch(new Request(`${BASE}${path}`)));
}

async function put(
  app: ReturnType<typeof makeApp>,
  path: string,
  body: unknown,
): Promise<Response> {
  return Promise.resolve(
    app.fetch(
      new Request(`${BASE}${path}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
    ),
  );
}

interface SigeConfigData {
  readonly core: {
    readonly enabled: boolean;
    readonly mem0: { readonly baseUrl: string };
    readonly neo4j: { readonly enabled: boolean; readonly boltUrl: string; readonly user: string };
    readonly source: string;
  };
  readonly auto: {
    readonly enabled: boolean;
    readonly cadence: string;
    readonly maxDeepFrontiers: number;
    readonly broadPoolSize: number;
    readonly maxConcurrent: number;
    readonly memoryWriteback: boolean;
    readonly source: string;
  };
}

beforeEach(async () => {
  await initDb(process.env.DATABASE_URL);
  // Start from a clean slate so prior runs (shared dev DB) don't leak override rows.
  await deleteOverride("config", "sige");
  await deleteOverride("config", "smart.sigeAuto");
});

afterEach(async () => {
  // Remove the override rows this suite created so the shared DB stays clean and
  // the loader's effective config reverts to schema/env defaults.
  await deleteOverride("config", "sige");
  await deleteOverride("config", "smart.sigeAuto");
  await closeDb();
});

describe("GET /config/sige", () => {
  it("200 + returns core + auto effective values with sources", async () => {
    const app = makeApp();
    const res = await get(app, "/config/sige");

    expect(res.status).toBe(200);
    const body = await json<{ success: boolean; data: SigeConfigData }>(res);
    expect(body.success).toBe(true);
    expect(typeof body.data.core.enabled).toBe("boolean");
    expect(typeof body.data.core.mem0.baseUrl).toBe("string");
    expect(typeof body.data.core.neo4j.boltUrl).toBe("string");
    // No override rows after cleanup → both subtrees source from config.
    expect(body.data.core.source).toBe("config");
    expect(body.data.auto.source).toBe("config");
  });

  it("autonomous SIGE defaults to manual-only (enabled false)", async () => {
    const app = makeApp();
    const res = await get(app, "/config/sige");
    const body = await json<{ data: SigeConfigData }>(res);
    // sigeAuto schema default is enabled:false — SIGE stays manual until opted in.
    expect(body.data.auto.enabled).toBe(false);
  });
});

describe("PUT /config/sige/core", () => {
  it("200 + persists a partial core override and GET reflects it", async () => {
    const app = makeApp();
    const putRes = await put(app, "/config/sige/core", {
      enabled: true,
      neo4j: { enabled: true },
    });
    expect(putRes.status).toBe(200);

    const res = await get(app, "/config/sige");
    const body = await json<{ data: SigeConfigData }>(res);
    expect(body.data.core.enabled).toBe(true);
    expect(body.data.core.neo4j.enabled).toBe(true);
    expect(body.data.core.source).toBe("db");
  });

  it("partial PUT does not clobber previously-stored sibling fields", async () => {
    const app = makeApp();
    await put(app, "/config/sige/core", { mem0: { baseUrl: "http://127.0.0.1:9999" } });
    await put(app, "/config/sige/core", { enabled: true });

    const res = await get(app, "/config/sige");
    const body = await json<{ data: SigeConfigData }>(res);
    expect(body.data.core.enabled).toBe(true);
    expect(body.data.core.mem0.baseUrl).toBe("http://127.0.0.1:9999");
  });

  it("400 for an unknown top-level key (strict zod)", async () => {
    const app = makeApp();
    const res = await put(app, "/config/sige/core", { bogus: 1 });
    expect(res.status).toBe(400);
  });

  it("400 for a non-url mem0.baseUrl", async () => {
    const app = makeApp();
    const res = await put(app, "/config/sige/core", { mem0: { baseUrl: "nope" } });
    expect(res.status).toBe(400);
  });

  it("400 for malformed JSON body", async () => {
    const app = makeApp();
    const res = await put(app, "/config/sige/core", "{{invalid");
    expect(res.status).toBe(400);
  });
});

describe("PUT /config/sige/auto", () => {
  it("200 + persists a manual-only autonomous override and GET reflects it", async () => {
    const app = makeApp();
    const putRes = await put(app, "/config/sige/auto", {
      enabled: false,
      cadence: "manual",
      broadPoolSize: 25,
    });
    expect(putRes.status).toBe(200);

    const res = await get(app, "/config/sige");
    const body = await json<{ data: SigeConfigData }>(res);
    expect(body.data.auto.enabled).toBe(false);
    expect(body.data.auto.cadence).toBe("manual");
    expect(body.data.auto.broadPoolSize).toBe(25);
    expect(body.data.auto.source).toBe("db");
  });

  it("400 for cadence outside the enum", async () => {
    const app = makeApp();
    const res = await put(app, "/config/sige/auto", { cadence: "hourly" });
    expect(res.status).toBe(400);
  });

  it("400 for maxDeepFrontiers above the hard cap of 8", async () => {
    const app = makeApp();
    const res = await put(app, "/config/sige/auto", { maxDeepFrontiers: 9 });
    expect(res.status).toBe(400);
  });

  it("400 for an unknown key (strict zod)", async () => {
    const app = makeApp();
    const res = await put(app, "/config/sige/auto", { perRunCostCeilingUsd: 5 });
    expect(res.status).toBe(400);
  });
});
