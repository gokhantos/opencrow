import { describe, expect, it, beforeAll, afterAll, afterEach } from "bun:test";
import { initDb, getDb } from "../../store/db";
import { getDeveloper, getDevelopersDueForPortfolioScan, markPortfolioScanned, upsertDeveloper } from "./developer-store";

/** Every artist_id any test in this file inserts — centralized for reliable cleanup. */
const TEST_ARTIST_IDS: readonly string[] = [
  "zzz-dev-upsert",
  "zzz-dev-never-scanned",
  "zzz-dev-stale",
  "zzz-dev-fresh",
];

async function cleanupTestDevelopers(): Promise<void> {
  const db = getDb();
  await db`DELETE FROM appstore_developers WHERE artist_id IN ${db(TEST_ARTIST_IDS)}`;
}

describe("developer-store", () => {
  beforeAll(async () => {
    await initDb(process.env.DATABASE_URL);
    await cleanupTestDevelopers();
  });

  afterEach(async () => {
    await cleanupTestDevelopers();
  });

  afterAll(async () => {
    await cleanupTestDevelopers();
  });

  describe("upsertDeveloper", () => {
    it("inserts a fresh developer row", async () => {
      const now = Math.floor(Date.now() / 1000);
      await upsertDeveloper({ artistId: "zzz-dev-upsert", name: "Acme Inc" }, now);

      const dev = await getDeveloper("zzz-dev-upsert");
      expect(dev?.name).toBe("Acme Inc");
      expect(dev?.lastPortfolioScanAt).toBeNull();
      expect(dev?.appCount).toBe(0);
    });

    it("refreshes the name on conflict without touching last_portfolio_scan_at", async () => {
      const now = Math.floor(Date.now() / 1000);
      await upsertDeveloper({ artistId: "zzz-dev-upsert", name: "Old Name" }, now);
      await markPortfolioScanned("zzz-dev-upsert", 5, now);

      await upsertDeveloper({ artistId: "zzz-dev-upsert", name: "New Name" }, now + 10);

      const dev = await getDeveloper("zzz-dev-upsert");
      expect(dev?.name).toBe("New Name");
      expect(dev?.lastPortfolioScanAt).toBe(now); // untouched by upsertDeveloper
    });

    it("keeps the existing name when given an empty name on conflict", async () => {
      const now = Math.floor(Date.now() / 1000);
      await upsertDeveloper({ artistId: "zzz-dev-upsert", name: "Keep Me" }, now);
      await upsertDeveloper({ artistId: "zzz-dev-upsert", name: "" }, now + 10);

      const dev = await getDeveloper("zzz-dev-upsert");
      expect(dev?.name).toBe("Keep Me");
    });

    it("is a no-op for an empty artistId", async () => {
      await upsertDeveloper({ artistId: "", name: "Nobody" }, Math.floor(Date.now() / 1000));
      const dev = await getDeveloper("");
      expect(dev).toBeNull();
    });
  });

  describe("markPortfolioScanned", () => {
    it("stamps last_portfolio_scan_at and app_count", async () => {
      const now = Math.floor(Date.now() / 1000);
      await upsertDeveloper({ artistId: "zzz-dev-upsert", name: "Acme" }, now);
      await markPortfolioScanned("zzz-dev-upsert", 12, now + 5);

      const dev = await getDeveloper("zzz-dev-upsert");
      expect(dev?.lastPortfolioScanAt).toBe(now + 5);
      expect(dev?.appCount).toBe(12);
    });
  });

  describe("getDevelopersDueForPortfolioScan", () => {
    it("prioritizes never-scanned developers and returns stale ones, excludes fresh ones", async () => {
      const now = Math.floor(Date.now() / 1000);
      await upsertDeveloper({ artistId: "zzz-dev-never-scanned", name: "Never" }, now);
      await upsertDeveloper({ artistId: "zzz-dev-stale", name: "Stale" }, now);
      await markPortfolioScanned("zzz-dev-stale", 1, now - 1_000_000);
      await upsertDeveloper({ artistId: "zzz-dev-fresh", name: "Fresh" }, now);
      await markPortfolioScanned("zzz-dev-fresh", 1, now);

      const due = await getDevelopersDueForPortfolioScan({ limit: 500, minIntervalSeconds: 86_400 });
      expect(due).toContain("zzz-dev-never-scanned");
      expect(due).toContain("zzz-dev-stale");
      expect(due).not.toContain("zzz-dev-fresh");
    });

    it("returns [] for a zero limit", async () => {
      expect(await getDevelopersDueForPortfolioScan({ limit: 0, minIntervalSeconds: 0 })).toEqual([]);
    });
  });

  describe("getDeveloper", () => {
    it("returns null for an unknown artistId", async () => {
      expect(await getDeveloper("zzz-dev-does-not-exist")).toBeNull();
    });
  });
});
