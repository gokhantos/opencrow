/**
 * Integration tests for the web API bearer-auth middleware.
 *
 * The `/api/*` surface is guarded by a fail-closed bearer-auth middleware that
 * resolves the token from the DB (config_overrides/secrets) then env. These tests
 * verify:
 * - No token configured → 503 (fail-closed, not 401)
 * - Wrong bearer token → 401
 * - Correct bearer token → 200 (request passes through to the route)
 *
 * We use a well-known route (GET /api/workflows) as the probe — it only needs
 * Postgres and has no other external deps.
 *
 * Lane: *.integration.test.ts — run with `bun run test:integration`
 * Requires: docker compose up -d postgres
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb, getDb } from "../../store/db";
import { createAgentRegistry } from "../../agents/registry";
import { createWebApp } from "../app";
import type { WebAppDeps } from "../app";

// ---------------------------------------------------------------------------
// Minimal WebAppDeps for auth probing
// ---------------------------------------------------------------------------

const TEST_TOKEN = "integration-test-bearer-token-xyz";
const SECRET_KEY = "OPENCROW_WEB_TOKEN";

function makeMinimalDeps(): WebAppDeps {
  const agentRegistry = createAgentRegistry([], {
    model: "claude-sonnet-4-6",
    systemPrompt: "test",
    retry: { attempts: 3, minDelayMs: 500, maxDelayMs: 30_000, jitter: 0.15 },
    compaction: {
      maxContextTokens: 180_000,
      targetHistoryTokens: 60_000,
      summaryMaxTokens: 2048,
      stripToolResultsAfterTurns: 3,
    },
    failover: undefined,
  });

  return {
    config: {
      agent: {
        model: "claude-sonnet-4-6",
        systemPrompt: "test",
        retry: { attempts: 3, minDelayMs: 500, maxDelayMs: 30_000, jitter: 0.15 },
        compaction: {
          maxContextTokens: 180_000,
          targetHistoryTokens: 60_000,
          summaryMaxTokens: 2048,
          stripToolResultsAfterTurns: 3,
        },
      },
      channels: {
        telegram: { botToken: "" },
        whatsapp: { enabled: false },
      },
      web: { port: 48080, host: "127.0.0.1" },
    } as unknown as WebAppDeps["config"],
    channels: new Map(),
    agentRegistry,
    getDefaultAgentOptions: async () => ({}) as never,
  } as unknown as WebAppDeps;
}

// ---------------------------------------------------------------------------
// DB lifecycle
// ---------------------------------------------------------------------------

beforeEach(async () => {
  await initDb(process.env.DATABASE_URL);
  const db = getDb();
  // Remove any stale test token from DB
  await db.unsafe(`DELETE FROM config_overrides WHERE namespace = 'secrets' AND key = '${SECRET_KEY}'`);
  // Clear env token so tests control it explicitly
  delete process.env[SECRET_KEY];
});

afterEach(async () => {
  const db = getDb();
  await db.unsafe(`DELETE FROM config_overrides WHERE namespace = 'secrets' AND key = '${SECRET_KEY}'`);
  delete process.env[SECRET_KEY];
  await closeDb();
});

// ---------------------------------------------------------------------------
// Auth tests
// ---------------------------------------------------------------------------

describe("web API bearer auth middleware", () => {
  it("503 when OPENCROW_WEB_TOKEN is not configured at all", async () => {
    // No token in env, no token in DB
    const app = createWebApp(makeMinimalDeps());
    const res = await app.fetch(new Request("http://localhost/api/workflows"));

    expect(res.status).toBe(503);
    const body = await res.json() as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toContain("not configured");
  });

  it("401 when wrong bearer token is provided (token in env)", async () => {
    process.env[SECRET_KEY] = TEST_TOKEN;
    const app = createWebApp(makeMinimalDeps());

    const res = await app.fetch(
      new Request("http://localhost/api/workflows", {
        headers: { Authorization: "Bearer wrong-token" },
      }),
    );

    expect(res.status).toBe(401);
  });

  it("401 when Authorization header is absent but token is configured", async () => {
    process.env[SECRET_KEY] = TEST_TOKEN;
    const app = createWebApp(makeMinimalDeps());

    const res = await app.fetch(new Request("http://localhost/api/workflows"));

    expect(res.status).toBe(401);
  });

  it("200 when correct bearer token is sent (token from env)", async () => {
    process.env[SECRET_KEY] = TEST_TOKEN;
    const app = createWebApp(makeMinimalDeps());

    const res = await app.fetch(
      new Request("http://localhost/api/workflows", {
        headers: { Authorization: `Bearer ${TEST_TOKEN}` },
      }),
    );

    // 200 from the workflows list route
    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean };
    expect(body.success).toBe(true);
  });

  it("200 when correct bearer token is sent (token from DB)", async () => {
    // Store the token in the DB config_overrides table instead of env
    const db = getDb();
    await db.unsafe(
      `INSERT INTO config_overrides (namespace, key, value_json, updated_at)
       VALUES ('secrets', '${SECRET_KEY}', '"${TEST_TOKEN}"',
               extract(epoch from now())::bigint)
       ON CONFLICT (namespace, key) DO UPDATE SET value_json = EXCLUDED.value_json`,
    );

    const app = createWebApp(makeMinimalDeps());
    const res = await app.fetch(
      new Request("http://localhost/api/workflows", {
        headers: { Authorization: `Bearer ${TEST_TOKEN}` },
      }),
    );

    expect(res.status).toBe(200);
  });

  it("/health endpoint is not behind auth (no token required)", async () => {
    // Health is mounted before the /api/* auth block
    const app = createWebApp(makeMinimalDeps());
    const res = await app.fetch(new Request("http://localhost/health"));

    expect(res.status).toBe(200);
    const body = await res.json() as { status: string };
    expect(body.status).toBe("ok");
  });

  it("401 on bad token does not expose token value in response body", async () => {
    process.env[SECRET_KEY] = TEST_TOKEN;
    const app = createWebApp(makeMinimalDeps());

    const res = await app.fetch(
      new Request("http://localhost/api/workflows", {
        headers: { Authorization: "Bearer bad-token-secret" },
      }),
    );

    expect(res.status).toBe(401);
    // Read as raw text: the 401 body is not guaranteed to be JSON, and the
    // security contract is simply that neither token value appears in it.
    const bodyStr = await res.text();
    expect(bodyStr).not.toContain(TEST_TOKEN);
    expect(bodyStr).not.toContain("bad-token-secret");
  });
});
