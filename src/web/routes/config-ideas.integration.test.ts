/**
 * Integration tests for the Ideas/funnel config-as-data HTTP routes.
 *
 * Key contracts:
 * - GET  /ideas — returns effective values (merged config) + raw per-section overrides
 * - PUT  /ideas/:section — zod-validates a PARTIAL body, persists via config_overrides;
 *   round-trips into both GET overrides AND the merged effective config (DB > default)
 * - rejects unknown sections, unknown keys, out-of-range values, malformed JSON
 *
 * Note: the auth middleware lives in app.ts and is NOT mounted here — this file
 * tests the route handler logic directly, mirroring secrets.integration.test.ts.
 *
 * Lane: *.integration.test.ts — run with `bun run test:integration`
 * Requires: docker compose up -d postgres
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { closeDb, getDb, initDb } from "../../store/db";
import { createConfigIdeasRoutes } from "./config-ideas";

const BASE = "http://localhost";

function makeApp() {
  return createConfigIdeasRoutes();
}

async function json<T>(res: Response): Promise<T> {
  return res.json() as Promise<T>;
}

function get(app: ReturnType<typeof makeApp>, path: string): Promise<Response> {
  return Promise.resolve(app.fetch(new Request(`${BASE}${path}`)));
}

function put(app: ReturnType<typeof makeApp>, path: string, body: unknown): Promise<Response> {
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

// All keys this route owns, so we can clean up between tests.
const OWNED = [
  { namespace: "config", key: "smart.outcomeMemory" },
  { namespace: "config", key: "smart.incumbentExclusion" },
  { namespace: "config", key: "smart.diversityGuard" },
  { namespace: "config", key: "competability" },
] as const;

async function clearOwned() {
  const db = getDb();
  for (const { namespace, key } of OWNED) {
    await db`DELETE FROM config_overrides WHERE namespace = ${namespace} AND key = ${key}`;
  }
}

beforeEach(async () => {
  await initDb(process.env.DATABASE_URL);
  await clearOwned();
});

afterEach(async () => {
  await clearOwned();
  await closeDb();
});

interface IdeasGetResponse {
  success: boolean;
  data: {
    effective: {
      outcomeMemory: { writeBack: boolean; reinforceCap: number };
      incumbentExclusion: { enabled: boolean; topN: number };
      diversityGuard: { enabled: boolean; maxBucketShare: number; bucketBy: string };
      competability: {
        enforceGate: boolean;
        builderProfile: { capital: string; teamSize: number; expertiseDomains: string[] };
      };
    };
    overrides: Record<string, unknown>;
  };
}

describe("GET /ideas", () => {
  it("200 + effective values from merged config, null overrides when none", async () => {
    const app = makeApp();
    const res = await get(app, "/ideas");
    expect(res.status).toBe(200);
    const body = await json<IdeasGetResponse>(res);
    expect(body.success).toBe(true);
    // Defaults from the schema flow through the merged config.
    expect(typeof body.data.effective.outcomeMemory.writeBack).toBe("boolean");
    expect(typeof body.data.effective.incumbentExclusion.topN).toBe("number");
    expect(body.data.effective.diversityGuard.bucketBy).toBeDefined();
    expect(Array.isArray(body.data.effective.competability.builderProfile.expertiseDomains)).toBe(
      true,
    );
    for (const section of OWNED) {
      const id = section.key.replace("smart.", "");
      expect(body.data.overrides[id]).toBeNull();
    }
  });
});

describe("PUT /ideas/:section round-trip", () => {
  it("persists diversityGuard and reflects it in GET overrides + effective config", async () => {
    const app = makeApp();
    const putRes = await put(app, "/ideas/diversityGuard", {
      enabled: false,
      maxBucketShare: 0.3,
      bucketBy: "category",
    });
    expect(putRes.status).toBe(200);
    const putBody = await json<{ success: boolean }>(putRes);
    expect(putBody.success).toBe(true);

    const getRes = await get(app, "/ideas");
    const body = await json<IdeasGetResponse>(getRes);
    expect(body.data.overrides.diversityGuard).toEqual({
      enabled: false,
      maxBucketShare: 0.3,
      bucketBy: "category",
    });
    // DB override wins in the merged effective config.
    expect(body.data.effective.diversityGuard.enabled).toBe(false);
    expect(body.data.effective.diversityGuard.maxBucketShare).toBe(0.3);
    expect(body.data.effective.diversityGuard.bucketBy).toBe("category");
  });

  it("persists competability builderProfile.expertiseDomains list", async () => {
    const app = makeApp();
    const putRes = await put(app, "/ideas/competability", {
      enforceGate: true,
      builderProfile: { capital: "seed", teamSize: 4, expertiseDomains: ["fintech", "ml"] },
    });
    expect(putRes.status).toBe(200);

    const body = await json<IdeasGetResponse>(await get(app, "/ideas"));
    expect(body.data.effective.competability.enforceGate).toBe(true);
    expect(body.data.effective.competability.builderProfile.capital).toBe("seed");
    expect(body.data.effective.competability.builderProfile.teamSize).toBe(4);
    expect(body.data.effective.competability.builderProfile.expertiseDomains).toEqual([
      "fintech",
      "ml",
    ]);
  });

  it("persists outcomeMemory with the writeBack (capital B) field", async () => {
    const app = makeApp();
    const putRes = await put(app, "/ideas/outcomeMemory", { writeBack: false, reinforceCap: 9 });
    expect(putRes.status).toBe(200);

    const body = await json<IdeasGetResponse>(await get(app, "/ideas"));
    expect(body.data.effective.outcomeMemory.writeBack).toBe(false);
    expect(body.data.effective.outcomeMemory.reinforceCap).toBe(9);
  });
});

describe("PUT /ideas/:section validation", () => {
  it("400 on unknown section", async () => {
    const app = makeApp();
    const res = await put(app, "/ideas/bogusSection", { enabled: true });
    expect(res.status).toBe(400);
    const body = await json<{ success: boolean; error: string }>(res);
    expect(body.success).toBe(false);
    expect(body.error).toContain("Unknown ideas config section");
  });

  it("400 on unknown key (strict)", async () => {
    const app = makeApp();
    const res = await put(app, "/ideas/incumbentExclusion", { bogus: 1 });
    expect(res.status).toBe(400);
    expect((await json<{ success: boolean }>(res)).success).toBe(false);
  });

  it("400 on the lowercase writeback typo", async () => {
    const app = makeApp();
    const res = await put(app, "/ideas/outcomeMemory", { writeback: false });
    expect(res.status).toBe(400);
    expect((await json<{ success: boolean }>(res)).success).toBe(false);
  });

  it("400 on out-of-range value", async () => {
    const app = makeApp();
    const res = await put(app, "/ideas/diversityGuard", { maxBucketShare: 2 });
    expect(res.status).toBe(400);
    expect((await json<{ success: boolean }>(res)).success).toBe(false);
  });

  it("400 on malformed JSON body", async () => {
    const app = makeApp();
    const res = await Promise.resolve(
      app.fetch(
        new Request(`${BASE}/ideas/diversityGuard`, {
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
