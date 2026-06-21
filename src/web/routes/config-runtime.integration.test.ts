/**
 * Integration tests for the runtime-config HTTP routes.
 *
 * Key contracts:
 * - GET  /server  — returns effective web host/port/logLevel/browserEnabled + source
 * - PUT  /server  — persists a partial config/server override; rejects unknown/invalid
 * - GET  /sandbox — returns effective tools sandbox/devToolsAllowNetwork/allowUnsandboxed
 * - PUT  /sandbox — persists a partial config/sandbox override; rejects unknown/invalid
 *
 * Note: auth middleware lives in app.ts and is NOT mounted here (mirrors the
 * secrets/features route integration tests). This file exercises the handler
 * logic + DB round-trip directly.
 *
 * Lane: *.integration.test.ts — run with `bun run test:integration`
 * Requires: docker compose up -d postgres
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb, getDb } from "../../store/db";
import { createConfigRuntimeRoutes } from "./config-runtime";

const BASE = "http://localhost";

function makeApp() {
  return createConfigRuntimeRoutes();
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

async function clearOverrides() {
  const db = getDb();
  await db.unsafe(
    `DELETE FROM config_overrides WHERE namespace = 'config' AND key IN ('server', 'sandbox')`,
  );
}

beforeEach(async () => {
  await initDb(process.env.DATABASE_URL);
  await clearOverrides();
});

afterEach(async () => {
  await clearOverrides();
  await closeDb();
});

// ---------------------------------------------------------------------------
// GET /server
// ---------------------------------------------------------------------------

describe("GET /server", () => {
  it("200 + effective server fields", async () => {
    const app = makeApp();
    const res = await get(app, "/server");
    expect(res.status).toBe(200);
    const body = await json<{
      success: boolean;
      data: {
        webHost: string;
        webPort: number;
        logLevel: string;
        browserEnabled: boolean;
        source: string;
        restartRequired: string[];
      };
    }>(res);
    expect(body.success).toBe(true);
    expect(typeof body.data.webHost).toBe("string");
    expect(typeof body.data.webPort).toBe("number");
    expect(["debug", "info", "warn", "error"]).toContain(body.data.logLevel);
    expect(typeof body.data.browserEnabled).toBe("boolean");
    expect(body.data.restartRequired).toContain("webPort");
  });
});

// ---------------------------------------------------------------------------
// PUT /server
// ---------------------------------------------------------------------------

describe("PUT /server", () => {
  it("200 on a valid partial + reflects in GET as source=db", async () => {
    const app = makeApp();
    const putRes = await put(app, "/server", { logLevel: "debug" });
    expect(putRes.status).toBe(200);
    const putBody = await json<{ success: boolean; data: { logLevel: string } }>(
      putRes,
    );
    expect(putBody.success).toBe(true);
    expect(putBody.data.logLevel).toBe("debug");

    const getRes = await get(app, "/server");
    const getBody = await json<{
      data: { logLevel: string; source: string };
    }>(getRes);
    expect(getBody.data.logLevel).toBe("debug");
    expect(getBody.data.source).toBe("db");
  });

  it("merges sequential partials without clobbering prior fields", async () => {
    const app = makeApp();
    await put(app, "/server", { webPort: 51234 });
    await put(app, "/server", { logLevel: "warn" });

    const db = getDb();
    const rows = (await db.unsafe(
      `SELECT value_json FROM config_overrides WHERE namespace='config' AND key='server'`,
    )) as Array<{ value_json: string }>;
    expect(rows.length).toBe(1);
    const stored = JSON.parse(rows[0]!.value_json);
    expect(stored.webPort).toBe(51234);
    expect(stored.logLevel).toBe("warn");
  });

  it("400 on an unknown key (strict)", async () => {
    const app = makeApp();
    const res = await put(app, "/server", { bogusField: 1 });
    expect(res.status).toBe(400);
    expect((await json<{ success: boolean }>(res)).success).toBe(false);
  });

  it("400 on an out-of-range port", async () => {
    const app = makeApp();
    const res = await put(app, "/server", { webPort: 99999 });
    expect(res.status).toBe(400);
  });

  it("400 on an invalid log level", async () => {
    const app = makeApp();
    const res = await put(app, "/server", { logLevel: "trace" });
    expect(res.status).toBe(400);
  });

  it("400 on malformed JSON", async () => {
    const app = makeApp();
    const res = await Promise.resolve(
      app.fetch(
        new Request(`${BASE}/server`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: "{{nope",
        }),
      ),
    );
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// GET /sandbox
// ---------------------------------------------------------------------------

describe("GET /sandbox", () => {
  it("200 + effective sandbox fields + danger list", async () => {
    const app = makeApp();
    const res = await get(app, "/sandbox");
    expect(res.status).toBe(200);
    const body = await json<{
      success: boolean;
      data: {
        toolsSandbox: string;
        devToolsAllowNetwork: boolean;
        allowUnsandboxedDevTools: boolean;
        dangerous: string[];
        restartRequired: string[];
      };
    }>(res);
    expect(body.success).toBe(true);
    expect(["off", "best-effort", "required"]).toContain(body.data.toolsSandbox);
    expect(typeof body.data.devToolsAllowNetwork).toBe("boolean");
    expect(body.data.dangerous).toContain("allowUnsandboxedDevTools");
    expect(body.data.dangerous).toContain("devToolsAllowNetwork");
  });
});

// ---------------------------------------------------------------------------
// PUT /sandbox
// ---------------------------------------------------------------------------

describe("PUT /sandbox", () => {
  it("200 on a valid partial + reflects in GET as source=db", async () => {
    const app = makeApp();
    const putRes = await put(app, "/sandbox", { toolsSandbox: "required" });
    expect(putRes.status).toBe(200);

    const getRes = await get(app, "/sandbox");
    const getBody = await json<{
      data: { toolsSandbox: string; source: string };
    }>(getRes);
    expect(getBody.data.toolsSandbox).toBe("required");
    expect(getBody.data.source).toBe("db");
  });

  it("persists the dangerous flags", async () => {
    const app = makeApp();
    await put(app, "/sandbox", {
      devToolsAllowNetwork: true,
      allowUnsandboxedDevTools: true,
    });
    const db = getDb();
    const rows = (await db.unsafe(
      `SELECT value_json FROM config_overrides WHERE namespace='config' AND key='sandbox'`,
    )) as Array<{ value_json: string }>;
    const stored = JSON.parse(rows[0]!.value_json);
    expect(stored.devToolsAllowNetwork).toBe(true);
    expect(stored.allowUnsandboxedDevTools).toBe(true);
  });

  it("400 on an unknown sandbox mode", async () => {
    const app = makeApp();
    const res = await put(app, "/sandbox", { toolsSandbox: "loose" });
    expect(res.status).toBe(400);
  });

  it("400 on an unknown key (strict)", async () => {
    const app = makeApp();
    const res = await put(app, "/sandbox", { extra: true });
    expect(res.status).toBe(400);
  });
});
