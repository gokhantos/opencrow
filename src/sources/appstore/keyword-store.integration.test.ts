import { describe, expect, it, beforeAll } from "bun:test";
import { initDb } from "../../store/db";
import {
  upsertKeywords,
  getStaleKeywords,
  markScanned,
  insertScan,
  getLatestScan,
  getTopOpportunities,
} from "./keyword-store";

describe("keyword-store", () => {
  beforeAll(async () => {
    await initDb(process.env.DATABASE_URL);
  });

  it("upserts corpus and reads a stale slice", async () => {
    await upsertKeywords([{ keyword: "fatty liver diet", genreZone: "health", source: "seed" }]);
    const stale = await getStaleKeywords("health", 10);
    expect(stale).toContain("fatty liver diet");
  });

  it("persists a scan and reads it back as latest + top opportunity", async () => {
    const now = Math.floor(Date.now() / 1000);
    await upsertKeywords([{ keyword: "zzz test gap", genreZone: "health", source: "seed" }]);
    await insertScan({
      keyword: "zzz test gap",
      store: "app",
      competitiveness: 20,
      demand: 13,
      incumbentWeakness: 0.8,
      opportunity: 0.53,
      trend: "heating",
      topAppReviews: 11,
      avgRating: 3.4,
      avgAgeDays: 500,
      topApps: [
        {
          id: "1",
          name: "Toy",
          reviews: 11,
          rating: 3.4,
          ageDays: 500,
          ratingsPerDay: 0.02,
          titleMatch: true,
        },
      ],
      scannedAt: now,
    });
    await markScanned(["zzz test gap"], now);
    const latest = await getLatestScan("zzz test gap");
    expect(latest?.opportunity).toBeCloseTo(0.53, 2);
    const top = await getTopOpportunities({ limit: 5 });
    expect(top.some((r) => r.keyword === "zzz test gap")).toBe(true);
  });
});
