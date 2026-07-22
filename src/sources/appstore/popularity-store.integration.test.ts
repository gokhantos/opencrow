import { describe, expect, it, beforeAll, afterAll, afterEach } from "bun:test";
import { initDb, getDb } from "../../store/db";
import { getLatestPopularity, upsertPopularity } from "./popularity-store";

/** Every keyword any test in this file inserts — centralized for reliable cleanup. */
const TEST_KEYWORDS: readonly string[] = [
  "zzz-pop-upsert-kw",
  "zzz-pop-conflict-kw",
  "zzz-pop-latest-kw",
  "zzz-pop-source-kw",
  "zzz-pop-missing-kw",
];

async function cleanupTestRows(): Promise<void> {
  const db = getDb();
  await db`DELETE FROM appstore_search_popularity WHERE keyword IN ${db(TEST_KEYWORDS)}`;
}

describe("popularity-store", () => {
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

  describe("upsertPopularity", () => {
    it("inserts a new row", async () => {
      const written = await upsertPopularity([
        {
          keyword: "zzz-pop-upsert-kw",
          source: "asa",
          value: 1,
          storefront: "US",
          checkedAt: 1_753_000_000,
        },
      ]);
      expect(written).toBe(1);

      const latest = await getLatestPopularity("zzz-pop-upsert-kw");
      expect(latest).not.toBeNull();
      expect(latest?.value).toBe(1);
      expect(latest?.storefront).toBe("US");
      expect(latest?.checkedAt).toBe(1_753_000_000);
      expect(latest?.source).toBe("asa");
    });

    it("refreshes value/checked_at in place on a re-import of the same (keyword, source, storefront)", async () => {
      await upsertPopularity([
        {
          keyword: "zzz-pop-conflict-kw",
          source: "asa",
          value: 1,
          storefront: "US",
          checkedAt: 1_000_000,
        },
      ]);
      await upsertPopularity([
        {
          keyword: "zzz-pop-conflict-kw",
          source: "asa",
          value: 3,
          storefront: "US",
          checkedAt: 2_000_000,
        },
      ]);

      const db = getDb();
      const rows = await db`
        SELECT * FROM appstore_search_popularity WHERE keyword = 'zzz-pop-conflict-kw'
      `;
      expect(rows.length).toBe(1);

      const latest = await getLatestPopularity("zzz-pop-conflict-kw");
      expect(latest?.value).toBe(3);
      expect(latest?.checkedAt).toBe(2_000_000);
    });

    it("returns 0 for an empty batch", async () => {
      const written = await upsertPopularity([]);
      expect(written).toBe(0);
    });
  });

  describe("getLatestPopularity", () => {
    it("returns the most recent row across storefronts", async () => {
      await upsertPopularity([
        {
          keyword: "zzz-pop-latest-kw",
          source: "asa",
          value: 1,
          storefront: "US",
          checkedAt: 1_000_000,
        },
        {
          keyword: "zzz-pop-latest-kw",
          source: "asa",
          value: 5,
          storefront: "GB",
          checkedAt: 2_000_000,
        },
      ]);

      const latest = await getLatestPopularity("zzz-pop-latest-kw");
      expect(latest?.storefront).toBe("GB");
      expect(latest?.value).toBe(5);
    });

    it("is scoped by source — a 'hint' row does not satisfy an 'asa' lookup", async () => {
      await upsertPopularity([
        {
          keyword: "zzz-pop-source-kw",
          source: "hint",
          value: 4,
          storefront: "US",
          checkedAt: 1_000_000,
        },
      ]);

      const asaLatest = await getLatestPopularity("zzz-pop-source-kw", "asa");
      expect(asaLatest).toBeNull();

      const hintLatest = await getLatestPopularity("zzz-pop-source-kw", "hint");
      expect(hintLatest?.value).toBe(4);
    });

    it("returns null for a keyword never recorded", async () => {
      const latest = await getLatestPopularity("zzz-pop-missing-kw");
      expect(latest).toBeNull();
    });
  });
});
