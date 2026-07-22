/**
 * Integration test for the ASA popularity manual-import route (`POST
 * /appstore/search-popularity`).
 *
 * Auth lives in app.ts and is NOT mounted here (matches
 * appstore-velocity/appstore-signature-hits route test convention).
 *
 * Lane: *.integration.test.ts — `bun run test:integration`.
 * Requires: docker compose up -d postgres (or a local Postgres).
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { initDb, getDb } from "../../store/db";
import { getLatestPopularity } from "../../sources/appstore/popularity-store";
import { createAppStoreSearchPopularityRoutes } from "./appstore-search-popularity";

const BASE = "http://localhost";

const TEST_KEYWORDS: readonly string[] = [
  "zzz-route-pop-single",
  "zzz-route-pop-batch-a",
  "zzz-route-pop-batch-b",
  "zzz-route-pop-conflict",
  "zzz-route-pop-default-storefront",
];

async function cleanupTestRows(): Promise<void> {
  const db = getDb();
  await db`DELETE FROM appstore_search_popularity WHERE keyword IN ${db(TEST_KEYWORDS)}`;
}

function makeApp() {
  return createAppStoreSearchPopularityRoutes();
}

async function json<T>(res: Response): Promise<T> {
  return res.json() as Promise<T>;
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

describe("appstore-search-popularity route", () => {
  beforeAll(async () => {
    await initDb(process.env.DATABASE_URL);
    await cleanupTestRows();
  });

  afterEach(async () => {
    await cleanupTestRows();
  });

  afterAll(async () => {
    await cleanupTestRows();
  });

  it("imports a single row and persists it as source='asa'", async () => {
    const app = makeApp();
    const res = await post(app, "/appstore/search-popularity", [
      { keyword: "zzz-route-pop-single", popularity: 1, storefront: "US" },
    ]);
    expect(res.status).toBe(200);
    const body = await json<{ success: boolean; data: { written: number } }>(res);
    expect(body.success).toBe(true);
    expect(body.data.written).toBe(1);

    const latest = await getLatestPopularity("zzz-route-pop-single");
    expect(latest?.value).toBe(1);
    expect(latest?.storefront).toBe("US");
    expect(latest?.source).toBe("asa");
  });

  it("imports a batch of rows in one request", async () => {
    const app = makeApp();
    const res = await post(app, "/appstore/search-popularity", [
      { keyword: "zzz-route-pop-batch-a", popularity: 1, storefront: "US" },
      { keyword: "zzz-route-pop-batch-b", popularity: 4, storefront: "US" },
    ]);
    expect(res.status).toBe(200);
    const body = await json<{ data: { written: number } }>(res);
    expect(body.data.written).toBe(2);

    expect((await getLatestPopularity("zzz-route-pop-batch-a"))?.value).toBe(1);
    expect((await getLatestPopularity("zzz-route-pop-batch-b"))?.value).toBe(4);
  });

  it("defaults storefront to US when omitted", async () => {
    const app = makeApp();
    const res = await post(app, "/appstore/search-popularity", [
      { keyword: "zzz-route-pop-default-storefront", popularity: 2 },
    ]);
    expect(res.status).toBe(200);
    const latest = await getLatestPopularity("zzz-route-pop-default-storefront");
    expect(latest?.storefront).toBe("US");
  });

  it("re-importing the same (keyword, source, storefront) refreshes the value in place", async () => {
    const app = makeApp();
    await post(app, "/appstore/search-popularity", [
      { keyword: "zzz-route-pop-conflict", popularity: 1, storefront: "US" },
    ]);
    await post(app, "/appstore/search-popularity", [
      { keyword: "zzz-route-pop-conflict", popularity: 5, storefront: "US" },
    ]);

    const latest = await getLatestPopularity("zzz-route-pop-conflict");
    expect(latest?.value).toBe(5);
  });

  it("rejects a popularity value above 5 with 400", async () => {
    const app = makeApp();
    const res = await post(app, "/appstore/search-popularity", [
      { keyword: "zzz-route-pop-single", popularity: 6, storefront: "US" },
    ]);
    expect(res.status).toBe(400);
    const body = await json<{ success: boolean; error: string }>(res);
    expect(body.success).toBe(false);
  });

  it("rejects a malformed storefront with 400", async () => {
    const app = makeApp();
    const res = await post(app, "/appstore/search-popularity", [
      { keyword: "zzz-route-pop-single", popularity: 1, storefront: "USA" },
    ]);
    expect(res.status).toBe(400);
  });

  it("rejects an empty array with 400", async () => {
    const app = makeApp();
    const res = await post(app, "/appstore/search-popularity", []);
    expect(res.status).toBe(400);
  });

  it("rejects a non-array body with 400", async () => {
    const app = makeApp();
    const res = await post(app, "/appstore/search-popularity", {
      keyword: "zzz-route-pop-single",
      popularity: 1,
    });
    expect(res.status).toBe(400);
  });

  it("rejects invalid JSON with 400", async () => {
    const app = makeApp();
    const res = await app.fetch(
      new Request(`${BASE}/appstore/search-popularity`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not json",
      }),
    );
    expect(res.status).toBe(400);
  });
});
