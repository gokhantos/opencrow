/**
 * Integration tests for the semantic keyword clustering serving layer:
 * `getOpportunityClusters` / `getClusterMembers` (keyword-store.ts) and the
 * `GET /appstore/opportunity-clusters[/:clusterId]` routes (appstore.ts).
 *
 * The pure clustering core (`clusterByCosine` etc.) is unit-tested in
 * keyword-clustering.test.ts with a fake embedder — this file does NOT run the
 * live embedding job. It seeds nonce scans + hand-written cluster rows and
 * asserts the read path aggregates, member-filters, and paginates correctly.
 *
 * ROBUST TO A PRE-POPULATED clusters table (the live job produces thousands of
 * real clusters). Like keyword-store.integration.test.ts handles real scan
 * data: cleanup is UNCONDITIONAL (beforeEach + afterEach, so a throwing test
 * can't leave a duplicate-key landmine), scoped by the distinctive `zzc-%`
 * keyword prefix; and assertions are nonce-SCOPED (find our clusters by their
 * high, collision-proof ids among the returned set) or `>=`, never absolute.
 *
 * Lane: *.integration.test.ts — `bun run test:integration`.
 * Requires: docker compose up -d postgres (or DATABASE_URL to a live PG).
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from "bun:test";
import { initDb, getDb } from "../../store/db";
import { upsertKeywords, insertScan, getOpportunityClusters, getClusterMembers } from "./keyword-store";
import { computeBuildability } from "./keyword-scoring";
import { createAppStoreRoutes } from "../../web/routes/appstore";
import type { KeywordGapProfile, TopApp } from "./keyword-types";

const BASE = "http://localhost";

// High, collision-proof ids so we can find our fixtures among the real clusters
// (which the live job assigns small ids 0..N).
const CLUSTER_A = 970_001;
const CLUSTER_B = 970_002;
const CLUSTER_C = 970_003;
const NONCE_CLUSTER_IDS: readonly number[] = [CLUSTER_A, CLUSTER_B, CLUSTER_C];

// A cluster id that the live job will never assign — for the "unknown id" test.
const UNKNOWN_CLUSTER_ID = 979_999;

// Fetch limit large enough to return the WHOLE clusters table, so our seeded
// clusters are always in the result regardless of how they sort against real
// data (the route caps limit at 100; these store-level calls do not).
const ALL = 1_000_000;

function isNonce(clusterId: number): boolean {
  return NONCE_CLUSTER_IDS.includes(clusterId);
}

interface Seed {
  readonly keyword: string;
  readonly clusterId: number;
  readonly label: string;
  readonly demand: number;
  readonly opportunity: number;
  readonly topAppReviews: number;
  readonly avgRating: number;
}

const SEEDS: readonly Seed[] = [
  { keyword: "zzc-music-1", clusterId: CLUSTER_A, label: "zzc-music-1", demand: 10, opportunity: 0.9, topAppReviews: 10, avgRating: 2.0 },
  { keyword: "zzc-music-2", clusterId: CLUSTER_A, label: "zzc-music-1", demand: 8, opportunity: 0.7, topAppReviews: 50, avgRating: 2.5 },
  { keyword: "zzc-music-3", clusterId: CLUSTER_A, label: "zzc-music-1", demand: 6, opportunity: 0.5, topAppReviews: 200, avgRating: 3.0 },
  { keyword: "zzc-shop-1", clusterId: CLUSTER_B, label: "zzc-shop-1", demand: 5, opportunity: 0.4, topAppReviews: 100, avgRating: 3.0 },
  { keyword: "zzc-shop-2", clusterId: CLUSTER_B, label: "zzc-shop-1", demand: 3, opportunity: 0.2, topAppReviews: 300, avgRating: 3.5 },
  { keyword: "zzc-lonely-1", clusterId: CLUSTER_C, label: "zzc-lonely-1", demand: 1, opportunity: 0.1, topAppReviews: 500, avgRating: 4.0 },
];

function makeTopApp(overrides: Partial<TopApp> = {}): TopApp {
  return {
    id: "1",
    name: "Toy",
    reviews: 11,
    rating: 3.4,
    ageDays: 500,
    ratingsPerDay: 0.02,
    titleMatch: true,
    ...overrides,
  };
}

function makeScan(seed: Seed, now: number): KeywordGapProfile {
  return {
    keyword: seed.keyword,
    store: "app",
    competitiveness: 20,
    demand: seed.demand,
    incumbentWeakness: 0.8,
    opportunity: seed.opportunity,
    trend: "heating",
    topAppReviews: seed.topAppReviews,
    avgRating: seed.avgRating,
    avgAgeDays: 500,
    topApps: [makeTopApp()],
    scannedAt: now,
    lowConfidence: false,
    brandNavigational: false,
  };
}

/**
 * Unconditional, idempotent cleanup of every nonce fixture — scoped by the
 * distinctive `zzc-%` prefix so it can NEVER touch the real corpus/clusters
 * (which the live job writes under real keywords) nor the `zzz-%` fixtures the
 * sibling keyword-store test owns. Safe to run before AND after every test.
 */
async function cleanup(): Promise<void> {
  const db = getDb();
  await db`DELETE FROM appstore_keyword_clusters WHERE keyword LIKE 'zzc-%'`;
  await db`DELETE FROM appstore_keyword_scans WHERE keyword LIKE 'zzc-%'`;
  await db`DELETE FROM appstore_keywords WHERE keyword LIKE 'zzc-%'`;
}

async function seedAll(): Promise<void> {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  await upsertKeywords(
    SEEDS.map((s) => ({ keyword: s.keyword, genreZone: "zzc-cluster-zone", source: "seed" as const })),
  );
  for (const seed of SEEDS) {
    await insertScan(makeScan(seed, now));
    // ON CONFLICT keeps seeding idempotent even if a prior row somehow survived.
    await db`
      INSERT INTO appstore_keyword_clusters (keyword, cluster_id, cluster_label, similarity, updated_at)
      VALUES (${seed.keyword}, ${seed.clusterId}, ${seed.label}, ${0.9}, ${now})
      ON CONFLICT (keyword) DO UPDATE SET
        cluster_id = EXCLUDED.cluster_id,
        cluster_label = EXCLUDED.cluster_label,
        similarity = EXCLUDED.similarity,
        updated_at = EXCLUDED.updated_at
    `;
  }
}

function makeApp() {
  return createAppStoreRoutes();
}

function get(app: ReturnType<typeof makeApp>, path: string): Promise<Response> {
  return Promise.resolve(app.fetch(new Request(`${BASE}${path}`)));
}

describe("keyword clusters serving layer", () => {
  beforeAll(async () => {
    await initDb(process.env.DATABASE_URL);
  });

  // Belt-and-suspenders: clean BEFORE (leftover from a prior aborted run) and
  // AFTER (unconditional — runs even when the test body throws) every test.
  beforeEach(async () => {
    await cleanup();
  });

  afterEach(async () => {
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
  });

  describe("getOpportunityClusters", () => {
    it("aggregates member scans per cluster (count, avg demand, max buildability/opportunity)", async () => {
      await seedAll();

      const res = await getOpportunityClusters({ limit: ALL });
      const mine = res.clusters.filter((c) => isNonce(c.clusterId));

      // Our three clusters are present; total counts at least them.
      expect(mine.map((c) => c.clusterId).sort()).toEqual([CLUSTER_A, CLUSTER_B, CLUSTER_C]);
      expect(res.total).toBeGreaterThanOrEqual(3);

      const a = mine.find((c) => c.clusterId === CLUSTER_A);
      expect(a).toBeDefined();
      expect(a?.label).toBe("zzc-music-1");
      expect(a?.memberCount).toBe(3);
      expect(a?.avgDemand).toBeCloseTo(8, 5); // (10 + 8 + 6) / 3
      expect(a?.maxOpportunity).toBeCloseTo(0.9, 5);
      expect(a?.minTopAppReviews).toBe(10);
      expect(a?.maxBuildability).toBe(
        computeBuildability({ demand: 10, topAppReviews: 10, avgRating: 2.0 }),
      );

      // topMembers: up to 6, sorted by buildability descending, strongest first.
      const topKeywords = a?.topMembers.map((m) => m.keyword) ?? [];
      expect(topKeywords[0]).toBe("zzc-music-1");
      const builds = a?.topMembers.map((m) => m.buildability) ?? [];
      for (let i = 1; i < builds.length; i++) {
        expect(builds[i - 1] as number).toBeGreaterThanOrEqual(builds[i] as number);
      }
    });

    it("applies member-level filters BEFORE aggregation and drops fully-filtered clusters", async () => {
      await seedAll();

      const res = await getOpportunityClusters({ limit: ALL, minDemand: 5 });
      const mine = res.clusters.filter((c) => isNonce(c.clusterId));

      // Cluster C (sole member demand 1) is entirely filtered out; A + B remain.
      expect(mine.map((c) => c.clusterId).sort()).toEqual([CLUSTER_A, CLUSTER_B]);
      expect(res.total).toBeGreaterThanOrEqual(2);

      // Cluster B keeps only zzc-shop-1 (demand 5); zzc-shop-2 (demand 3) drops.
      const b = mine.find((c) => c.clusterId === CLUSTER_B);
      expect(b?.memberCount).toBe(1);
      expect(b?.avgDemand).toBeCloseTo(5, 5);
    });

    it("sorts by the whitelisted column and reports a limit-independent total", async () => {
      await seedAll();
      // Sort by memberCount asc so our clusters order deterministically among
      // themselves: C(1) < B(2) < A(3). Filtering to our ids preserves order.
      const all = await getOpportunityClusters({ limit: ALL, sort: "memberCount", dir: "asc" });
      const mineOrdered = all.clusters.filter((c) => isNonce(c.clusterId)).map((c) => c.clusterId);
      expect(mineOrdered).toEqual([CLUSTER_C, CLUSTER_B, CLUSTER_A]);

      // total is the same regardless of the page limit.
      const small = await getOpportunityClusters({ limit: 1, sort: "memberCount", dir: "asc" });
      expect(small.total).toBe(all.total);
    });
  });

  describe("getClusterMembers", () => {
    it("returns all member rows of a cluster as full OpportunityRows", async () => {
      await seedAll();
      const members = await getClusterMembers({ clusterId: CLUSTER_A, limit: 100 });
      expect(members.map((m) => m.keyword).sort()).toEqual(["zzc-music-1", "zzc-music-2", "zzc-music-3"]);
      // Full OpportunityRow projection: buildability + peakOpportunity present.
      const strongest = members.find((m) => m.keyword === "zzc-music-1");
      expect(strongest?.buildability).toBeGreaterThan(0);
      expect(typeof strongest?.peakOpportunity).toBe("number");
      // Sorted by buildability descending.
      for (let i = 1; i < members.length; i++) {
        expect(members[i - 1]?.buildability as number).toBeGreaterThanOrEqual(
          members[i]?.buildability as number,
        );
      }
    });

    it("returns an empty array for an unknown cluster id", async () => {
      const members = await getClusterMembers({ clusterId: UNKNOWN_CLUSTER_ID, limit: 100 });
      expect(members).toEqual([]);
    });
  });

  describe("routes", () => {
    it("GET /appstore/opportunity-clusters responds with aggregated clusters + meta.total", async () => {
      await seedAll();
      const app = makeApp();
      const res = await get(app, "/appstore/opportunity-clusters?limit=100");
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        success: boolean;
        data: { clusterId: number; label: string; memberCount: number }[];
        meta: { total: number; limit: number; offset: number };
      };
      expect(body.success).toBe(true);
      expect(Array.isArray(body.data)).toBe(true);
      // At least our three seeded clusters exist in the table.
      expect(body.meta.total).toBeGreaterThanOrEqual(3);
      expect(body.meta.limit).toBe(100);
    });

    it("GET /appstore/opportunity-clusters/:clusterId returns that cluster's members", async () => {
      await seedAll();
      const app = makeApp();
      const res = await get(app, `/appstore/opportunity-clusters/${CLUSTER_A}?limit=100`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        success: boolean;
        data: { keyword: string }[];
        meta: { clusterId: number; count: number };
      };
      expect(body.success).toBe(true);
      expect(body.meta.clusterId).toBe(CLUSTER_A);
      expect(body.data.map((m) => m.keyword).sort()).toEqual(["zzc-music-1", "zzc-music-2", "zzc-music-3"]);
    });

    it("400s on an invalid sort param", async () => {
      const app = makeApp();
      const res = await get(app, "/appstore/opportunity-clusters?sort=nonsense");
      expect(res.status).toBe(400);
    });

    it("400s on an out-of-range limit", async () => {
      const app = makeApp();
      const res = await get(app, "/appstore/opportunity-clusters?limit=0");
      expect(res.status).toBe(400);
    });

    it("400s on a non-numeric cluster id", async () => {
      const app = makeApp();
      const res = await get(app, "/appstore/opportunity-clusters/not-a-number");
      expect(res.status).toBe(400);
    });
  });
});
