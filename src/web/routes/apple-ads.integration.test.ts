/**
 * Integration tests for the Apple Ads connection-foundation routes:
 * - GET  /appstore/apple-ads/config — per-key presence booleans only, never
 *   values.
 * - POST /appstore/apple-ads/config — persists the 5 creds to the DB secrets
 *   namespace (config_overrides).
 * - POST /appstore/apple-ads/test and /probe — inert ({ok:false}/{state:
 *   "NOT_CONFIGURED"}) when no creds are configured, so the surface never
 *   makes a network call in a deployment that hasn't set up Apple Ads.
 *
 * Lane: *.integration.test.ts — `bun run test:integration`.
 * Requires: a reachable Postgres via DATABASE_URL / docker compose up -d postgres.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { initDb, getDb } from "../../store/db";
import { createAppleAdsRoutes } from "./apple-ads";

const BASE = "http://localhost";

const APPLE_ADS_SECRET_KEYS = [
  "APPLE_ADS_CLIENT_ID",
  "APPLE_ADS_TEAM_ID",
  "APPLE_ADS_KEY_ID",
  "APPLE_ADS_ORG_ID",
  "APPLE_ADS_PRIVATE_KEY",
] as const;

async function cleanupSecrets(): Promise<void> {
  const db = getDb();
  await db`
    DELETE FROM config_overrides
    WHERE namespace = 'secrets' AND key IN ${db(APPLE_ADS_SECRET_KEYS)}
  `;
}

function makeApp() {
  return createAppleAdsRoutes();
}

async function json<T>(res: Response): Promise<T> {
  return res.json() as Promise<T>;
}

function get(app: ReturnType<typeof makeApp>, path: string): Promise<Response> {
  return Promise.resolve(app.fetch(new Request(`${BASE}${path}`)));
}

function post(app: ReturnType<typeof makeApp>, path: string, body: unknown): Promise<Response> {
  return Promise.resolve(
    app.fetch(
      new Request(`${BASE}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    ),
  );
}

interface StatusResponse {
  readonly success: boolean;
  readonly data: {
    readonly clientIdSet: boolean;
    readonly teamIdSet: boolean;
    readonly keyIdSet: boolean;
    readonly orgIdSet: boolean;
    readonly privateKeySet: boolean;
    readonly configured: boolean;
  };
}

describe("Apple Ads connection-foundation routes", () => {
  beforeAll(async () => {
    await initDb(process.env.DATABASE_URL);
    await cleanupSecrets();
  });

  afterAll(async () => {
    await cleanupSecrets();
  });

  afterEach(async () => {
    await cleanupSecrets();
  });

  it("GET status reports all-false when nothing is configured", async () => {
    const app = makeApp();
    const res = await get(app, "/appstore/apple-ads/config");
    expect(res.status).toBe(200);
    const body = await json<StatusResponse>(res);
    expect(body.success).toBe(true);
    expect(body.data).toEqual({
      clientIdSet: false,
      teamIdSet: false,
      keyIdSet: false,
      orgIdSet: false,
      privateKeySet: false,
      configured: false,
    });
  });

  it("POST config persists to the secrets namespace, and GET status reflects it — never echoing values", async () => {
    const app = makeApp();
    const privateKeyPem = "-----BEGIN PRIVATE KEY-----\nMIGtest\n-----END PRIVATE KEY-----";

    const saveRes = await post(app, "/appstore/apple-ads/config", {
      clientId: "SEARCHADS.integration-test",
      teamId: "TEAM123",
      keyId: "KEY456",
      orgId: "998877",
      privateKey: privateKeyPem,
    });
    expect(saveRes.status).toBe(200);
    const saveBody = await json<{ success: boolean }>(saveRes);
    expect(saveBody.success).toBe(true);

    const statusRes = await get(app, "/appstore/apple-ads/config");
    const statusBody = await json<StatusResponse>(statusRes);
    expect(statusBody.data).toEqual({
      clientIdSet: true,
      teamIdSet: true,
      keyIdSet: true,
      orgIdSet: true,
      privateKeySet: true,
      configured: true,
    });
    // The response body must never contain the private key material.
    const rawText = JSON.stringify(statusBody);
    expect(rawText).not.toContain("MIGtest");
    expect(rawText).not.toContain("BEGIN PRIVATE KEY");

    // Confirm it actually landed in the DB secrets namespace (write-only —
    // no route ever reads this back out, but we verify the persistence
    // contract directly against the store).
    const db = getDb();
    const rows = await db`
      SELECT key, value_json FROM config_overrides
      WHERE namespace = 'secrets' AND key = 'APPLE_ADS_ORG_ID'
    `;
    expect(rows).toHaveLength(1);
    expect(JSON.parse((rows[0] as { value_json: string }).value_json)).toBe("998877");
  });

  it("POST config rejects an invalid body (missing fields) with 400", async () => {
    const app = makeApp();
    const res = await post(app, "/appstore/apple-ads/config", { clientId: "only-one-field" });
    expect(res.status).toBe(400);
    const body = await json<{ success: boolean; error: string }>(res);
    expect(body.success).toBe(false);
  });

  it("POST test is inert ({ok:false, error:'not configured'}) with no creds set — no network call possible", async () => {
    const app = makeApp();
    const res = await post(app, "/appstore/apple-ads/test", {});
    expect(res.status).toBe(200);
    const body = await json<{ success: boolean; data: { ok: boolean; error?: string } }>(res);
    expect(body.data).toEqual({ ok: false, error: "not configured" });
  });

  it("POST probe is inert ({state:'NOT_CONFIGURED'}) with no creds set", async () => {
    const app = makeApp();
    const res = await post(app, "/appstore/apple-ads/probe", { keywords: ["todo app"] });
    expect(res.status).toBe(200);
    const body = await json<{
      success: boolean;
      data: { state: string; rowCount: number; error?: string };
    }>(res);
    expect(body.data.state).toBe("NOT_CONFIGURED");
    expect(body.data.rowCount).toBe(0);
  });

  it("POST probe rejects more than 10 keywords with 400", async () => {
    const app = makeApp();
    const keywords = Array.from({ length: 11 }, (_, i) => `kw-${i}`);
    const res = await post(app, "/appstore/apple-ads/probe", { keywords });
    expect(res.status).toBe(400);
  });

  it("POST probe rejects an empty keywords array with 400", async () => {
    const app = makeApp();
    const res = await post(app, "/appstore/apple-ads/probe", { keywords: [] });
    expect(res.status).toBe(400);
  });
});
