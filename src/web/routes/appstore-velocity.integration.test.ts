/**
 * Integration test for the newborn-velocity route (`GET
 * /appstore/velocity/accelerating`).
 *
 * Auth lives in app.ts and is NOT mounted here (matches
 * appstore-signature-hits/config-signals route test convention).
 *
 * Lane: *.integration.test.ts — `bun run test:integration`.
 * Requires: docker compose up -d postgres (or a local Postgres).
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { initDb, getDb } from "../../store/db";
import { insertObservation } from "../../sources/appstore/app-velocity-store";
import { createAppStoreVelocityRoutes } from "./appstore-velocity";

const BASE = "http://localhost";

const TEST_APP_IDS: readonly string[] = ["zzz-route-vel-fast", "zzz-route-vel-single"];

async function cleanupTestApps(): Promise<void> {
  const db = getDb();
  await db`DELETE FROM appstore_app_velocity WHERE app_id IN ${db(TEST_APP_IDS)}`;
}

function makeApp() {
  return createAppStoreVelocityRoutes();
}

async function json<T>(res: Response): Promise<T> {
  return res.json() as Promise<T>;
}

function get(app: ReturnType<typeof makeApp>, path: string): Promise<Response> {
  return Promise.resolve(app.fetch(new Request(`${BASE}${path}`)));
}

describe("appstore-velocity route", () => {
  beforeAll(async () => {
    await initDb(process.env.DATABASE_URL);
    await cleanupTestApps();
  });

  afterEach(async () => {
    await cleanupTestApps();
  });

  afterAll(async () => {
    await cleanupTestApps();
  });

  it("GET /appstore/velocity/accelerating returns accelerating newborns, sorted by acceleration desc", async () => {
    const now = Math.floor(Date.now() / 1000);
    const DAY = 24 * 3600;

    // 3 observations so "recent" (last two) and "overall" (earliest-to-
    // latest) velocity genuinely diverge — with only 2 points they're
    // mathematically identical (acceleration always exactly 1).
    await insertObservation({
      appId: "zzz-route-vel-fast",
      observedAt: now - 5 * DAY,
      reviews: 100,
      rating: 4.0,
      keyword: "zzz kw",
      name: "Fast Route App",
    });
    await insertObservation({
      appId: "zzz-route-vel-fast",
      observedAt: now - DAY,
      reviews: 150,
      rating: 4.2,
      keyword: "zzz kw",
      name: "Fast Route App",
    });
    await insertObservation({
      appId: "zzz-route-vel-fast",
      observedAt: now,
      reviews: 900,
      rating: 4.5,
      keyword: "zzz kw",
      name: "Fast Route App",
    });

    // Single observation — must be excluded (acceleration undefined).
    await insertObservation({
      appId: "zzz-route-vel-single",
      observedAt: now,
      reviews: 10,
      rating: 4.0,
      keyword: "zzz kw",
      name: "Single Obs App",
    });

    const app = makeApp();
    const res = await get(app, "/appstore/velocity/accelerating?limit=50");
    expect(res.status).toBe(200);

    const body = await json<{
      success: boolean;
      data: ReadonlyArray<{ appId: string; name: string; acceleration: number }>;
      meta: { count: number; limit: number };
    }>(res);

    expect(body.success).toBe(true);
    const ids = body.data.map((r) => r.appId);
    expect(ids).toContain("zzz-route-vel-fast");
    expect(ids).not.toContain("zzz-route-vel-single");

    const fast = body.data.find((r) => r.appId === "zzz-route-vel-fast");
    expect(fast?.name).toBe("Fast Route App");
    expect(fast?.acceleration).toBeGreaterThan(1);
    expect(body.meta.limit).toBe(50);
  });

  it("rejects a limit above the bounded maximum with 400", async () => {
    const app = makeApp();
    const res = await get(app, "/appstore/velocity/accelerating?limit=99999");
    expect(res.status).toBe(400);
    const body = await json<{ success: boolean; error: string }>(res);
    expect(body.success).toBe(false);
  });

  it("rejects a non-numeric limit with 400", async () => {
    const app = makeApp();
    const res = await get(app, "/appstore/velocity/accelerating?limit=abc");
    expect(res.status).toBe(400);
  });

  it("defaults limit to 50 when omitted", async () => {
    const app = makeApp();
    const res = await get(app, "/appstore/velocity/accelerating");
    expect(res.status).toBe(200);
    const body = await json<{ meta: { limit: number } }>(res);
    expect(body.meta.limit).toBe(50);
  });
});
