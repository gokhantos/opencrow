/**
 * Integration tests for the secrets HTTP routes.
 *
 * Key contracts:
 * - GET /secrets — lists all managed keys with masked values and source
 * - PUT /secrets/:key — stores a secret in DB; rejects unknown keys, empty values
 * - DELETE /secrets/:key — removes DB-stored secret; rejects unknown keys
 *
 * Note: The auth middleware lives in the web app container (app.ts) and is NOT
 * mounted here — auth coverage for the secrets surface is provided by the app-level
 * auth integration tests. This file tests the route handler logic directly.
 *
 * Lane: *.integration.test.ts — run with `bun run test:integration`
 * Requires: docker compose up -d postgres
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb, getDb } from "../../store/db";
import { createSecretsRoutes } from "./secrets";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE = "http://localhost";

function makeApp() {
  return createSecretsRoutes();
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

async function del(app: ReturnType<typeof makeApp>, path: string): Promise<Response> {
  return Promise.resolve(app.fetch(new Request(`${BASE}${path}`, { method: "DELETE" })));
}

// A key we can write + delete safely (it's in MANAGED_KEYS and test-owned)
const TEST_KEY = "VOYAGE_API_KEY";

// ---------------------------------------------------------------------------
// DB lifecycle
// ---------------------------------------------------------------------------

beforeEach(async () => {
  await initDb(process.env.DATABASE_URL);
  const db = getDb();
  // Clear any leftover test secret
  await db.unsafe(`DELETE FROM config_overrides WHERE namespace = 'secrets' AND key = '${TEST_KEY}'`);
});

afterEach(async () => {
  const db = getDb();
  await db.unsafe(`DELETE FROM config_overrides WHERE namespace = 'secrets' AND key = '${TEST_KEY}'`);
  await closeDb();
});

// ---------------------------------------------------------------------------
// GET /secrets
// ---------------------------------------------------------------------------

describe("GET /secrets", () => {
  it("200 + array of all managed keys", async () => {
    const app = makeApp();
    const res = await get(app, "/secrets");

    expect(res.status).toBe(200);
    const body = await json<{
      success: boolean;
      data: Array<{ key: string; set: boolean; source: string | null }>;
    }>(res);
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
    // Must include at minimum the managed keys
    const keys = body.data.map((s) => s.key);
    expect(keys).toContain("OPENCROW_WEB_TOKEN");
    expect(keys).toContain("OPENROUTER_API_KEY");
    expect(keys).toContain(TEST_KEY);
  });

  it("each entry has the expected shape", async () => {
    const app = makeApp();
    const res = await get(app, "/secrets");
    const body = await json<{
      data: Array<{ key: string; set: boolean; source: unknown; masked: string | null }>;
    }>(res);

    for (const entry of body.data) {
      expect(typeof entry.key).toBe("string");
      expect(typeof entry.set).toBe("boolean");
      // source is null | "db" | "env"
      expect(entry.source === null || entry.source === "db" || entry.source === "env").toBe(true);
      // masked is null when not set, string when set
      if (entry.set) {
        expect(typeof entry.masked).toBe("string");
      } else {
        expect(entry.masked).toBeNull();
      }
    }
  });
});

// ---------------------------------------------------------------------------
// PUT /secrets/:key
// ---------------------------------------------------------------------------

describe("PUT /secrets/:key", () => {
  it("200 on valid key + value", async () => {
    const app = makeApp();
    const res = await put(app, `/secrets/${TEST_KEY}`, { value: "test-secret-value-abc" });

    expect(res.status).toBe(200);
    const body = await json<{ success: boolean }>(res);
    expect(body.success).toBe(true);
  });

  it("stored secret shows in GET /secrets as source=db", async () => {
    const app = makeApp();
    await put(app, `/secrets/${TEST_KEY}`, { value: "route-test-secret-xyz" });

    const res = await get(app, "/secrets");
    const body = await json<{
      data: Array<{ key: string; set: boolean; source: string | null; masked: string | null }>;
    }>(res);

    const entry = body.data.find((s) => s.key === TEST_KEY);
    expect(entry).toBeDefined();
    expect(entry!.set).toBe(true);
    expect(entry!.source).toBe("db");
    // Masked value should not expose the full secret
    expect(entry!.masked).toBeDefined();
    expect(entry!.masked).not.toBe("route-test-secret-xyz");
  });

  it("400 on unknown key", async () => {
    const app = makeApp();
    const res = await put(app, "/secrets/UNKNOWN_MADE_UP_KEY", { value: "x" });

    expect(res.status).toBe(400);
    const body = await json<{ success: boolean; error: string }>(res);
    expect(body.success).toBe(false);
    expect(body.error).toContain("Unknown secret key");
  });

  it("400 on empty value", async () => {
    const app = makeApp();
    const res = await put(app, `/secrets/${TEST_KEY}`, { value: "" });

    expect(res.status).toBe(400);
    const body = await json<{ success: boolean }>(res);
    expect(body.success).toBe(false);
  });

  it("400 on missing value field", async () => {
    const app = makeApp();
    const res = await put(app, `/secrets/${TEST_KEY}`, { notvalue: "x" });

    expect(res.status).toBe(400);
    const body = await json<{ success: boolean }>(res);
    expect(body.success).toBe(false);
  });

  it("400 on malformed JSON body", async () => {
    const app = makeApp();
    const res = await Promise.resolve(
      app.fetch(
        new Request(`${BASE}/secrets/${TEST_KEY}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: "{{invalid",
        }),
      ),
    );

    expect(res.status).toBe(400);
    const body = await json<{ success: boolean }>(res);
    expect(body.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// DELETE /secrets/:key
// ---------------------------------------------------------------------------

describe("DELETE /secrets/:key", () => {
  it("200 after successfully removing a DB-stored secret", async () => {
    const app = makeApp();
    // First store it
    await put(app, `/secrets/${TEST_KEY}`, { value: "to-be-deleted" });

    // Then delete it
    const res = await del(app, `/secrets/${TEST_KEY}`);
    expect(res.status).toBe(200);
    const body = await json<{ success: boolean }>(res);
    expect(body.success).toBe(true);
  });

  it("200 deleting a key that was never stored (idempotent, no error)", async () => {
    const app = makeApp();
    // Delete without prior set — should still succeed (deleteOverride is idempotent)
    const res = await del(app, `/secrets/${TEST_KEY}`);
    expect(res.status).toBe(200);
    const body = await json<{ success: boolean }>(res);
    expect(body.success).toBe(true);
  });

  it("400 on unknown key", async () => {
    const app = makeApp();
    const res = await del(app, "/secrets/UNKNOWN_MADE_UP_KEY");

    expect(res.status).toBe(400);
    const body = await json<{ success: boolean; error: string }>(res);
    expect(body.success).toBe(false);
    expect(body.error).toContain("Unknown secret key");
  });
});

// ---------------------------------------------------------------------------
// Masking — never returns raw value
// ---------------------------------------------------------------------------

describe("secret masking contract", () => {
  it("masked value never equals the raw stored value", async () => {
    const app = makeApp();
    const raw = "super-secret-token-12345678";
    await put(app, `/secrets/${TEST_KEY}`, { value: raw });

    const res = await get(app, "/secrets");
    const body = await json<{
      data: Array<{ key: string; masked: string | null }>;
    }>(res);

    const entry = body.data.find((s) => s.key === TEST_KEY);
    expect(entry?.masked).not.toBe(raw);
    // Must not contain the middle portion of the raw value
    expect(entry?.masked).not.toContain("secret-token-123");
  });
});
