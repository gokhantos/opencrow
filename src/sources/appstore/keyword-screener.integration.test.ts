/**
 * Integration tests for the newborn-velocity screener's persistence layer:
 * migration 039 (`appstore_signature_hits`), `runScreener` /
 * `getScreenerCandidates` / `upsertSignatureHit` (keyword-screener.ts,
 * signature-hits-store.ts), and the
 * `GET /appstore/signature-hits` + `PATCH /appstore/signature-hits/:keyword`
 * routes.
 *
 * The pure signature logic (`computeSignature`) is exhaustively unit-tested
 * in keyword-screener.test.ts with no DB — this file only exercises the SQL
 * prefilter, the upsert's conflict semantics, and the route layer against a
 * real Postgres.
 *
 * Cleanup is UNCONDITIONAL (beforeEach + afterEach) and scoped by the
 * distinctive `zzv-%` keyword prefix, so it can never touch the real corpus
 * nor the `zzz-%` / `zzc-%` fixtures owned by sibling test files.
 *
 * Lane: *.integration.test.ts — `bun run test:integration`.
 * Requires: a live Postgres at DATABASE_URL (see CLAUDE.md for the local
 * native connection string).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { getDb, initDb } from "../../store/db";
import { createAppStoreSignatureHitsRoutes } from "../../web/routes/appstore-signature-hits";
import { insertScan, upsertKeywords } from "./keyword-store";
import { runScreener } from "./keyword-screener";
import {
  getSignatureHits,
  setSignatureHitStatus,
  upsertSignatureHit,
  type SignatureHitUpsertInput,
} from "./signature-hits-store";
import type { KeywordGapProfile, TopApp } from "./keyword-types";

const BASE = "http://localhost";

const HIT_KEYWORD = "zzv-newborn-hit";
const DECOY_COMP_KEYWORD = "zzv-decoy-competitiveness";
const DECOY_ENTERTAINMENT_KEYWORD = "zzv-decoy-entertainment";
const DISMISS_ROUTE_KEYWORD = "zzv-route-dismiss";
const LIST_ROUTE_KEYWORD = "zzv-route-list";

const TEST_KEYWORDS: readonly string[] = [
  HIT_KEYWORD,
  DECOY_COMP_KEYWORD,
  DECOY_ENTERTAINMENT_KEYWORD,
  DISMISS_ROUTE_KEYWORD,
  LIST_ROUTE_KEYWORD,
];

async function cleanup(): Promise<void> {
  const db = getDb();
  await db`DELETE FROM appstore_signature_hits WHERE keyword LIKE 'zzv-%'`;
  await db`DELETE FROM appstore_keyword_scans WHERE keyword IN ${db(TEST_KEYWORDS)}`;
  await db`DELETE FROM appstore_keywords WHERE keyword IN ${db(TEST_KEYWORDS)}`;
}

function app(overrides: Partial<TopApp> = {}): TopApp {
  return {
    id: "1",
    name: "Toy",
    reviews: 300,
    rating: 4.0,
    ageDays: 200,
    ratingsPerDay: 5,
    titleMatch: true,
    ...overrides,
  };
}

/** A textbook window-opening SERP — see keyword-screener.test.ts's identical fixture. */
function textbookApps(): readonly TopApp[] {
  return [
    app({ id: "newcomer-1", ageDays: 200, ratingsPerDay: 5, reviews: 300 }),
    app({ id: "newcomer-2", ageDays: 300, ratingsPerDay: 8, reviews: 500 }),
    app({ id: "established-1", ageDays: 600, ratingsPerDay: 2, reviews: 2000, lastUpdatedDays: 200 }),
  ];
}

function makeScan(
  keyword: string,
  overrides: Partial<KeywordGapProfile> = {},
): KeywordGapProfile {
  const now = Math.floor(Date.now() / 1000);
  return {
    keyword,
    store: "app",
    competitiveness: 25,
    demand: 10,
    incumbentWeakness: 0.7,
    opportunity: 0.4,
    trend: "heating",
    topAppReviews: 2000,
    avgRating: 4.0,
    avgAgeDays: 400,
    topApps: textbookApps(),
    scannedAt: now,
    lowConfidence: false,
    brandNavigational: false,
    ...overrides,
  };
}

function makeApp() {
  return createAppStoreSignatureHitsRoutes();
}

function get(path: string): Promise<Response> {
  return Promise.resolve(makeApp().fetch(new Request(`${BASE}${path}`)));
}

function patch(path: string, body: unknown): Promise<Response> {
  return Promise.resolve(
    makeApp().fetch(
      new Request(`${BASE}${path}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    ),
  );
}

describe("newborn-velocity screener — persistence + routes", () => {
  beforeAll(async () => {
    await initDb(process.env.DATABASE_URL);
    await cleanup();
  });

  beforeEach(async () => {
    await cleanup();
  });

  afterEach(async () => {
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
  });

  describe("runScreener", () => {
    it("detects a textbook hit end-to-end and excludes decoys the SQL prefilter should drop", async () => {
      await upsertKeywords([
        { keyword: HIT_KEYWORD, genreZone: "health", source: "seed" },
        { keyword: DECOY_COMP_KEYWORD, genreZone: "health", source: "seed" },
        { keyword: DECOY_ENTERTAINMENT_KEYWORD, genreZone: "entertainment", source: "seed" },
      ]);
      await insertScan(makeScan(HIT_KEYWORD));
      // Competitiveness above the SQL prefilter's threshold — must never reach computeSignature.
      await insertScan(makeScan(DECOY_COMP_KEYWORD, { competitiveness: 90 }));
      // Otherwise-matching scan, but genre_zone is 'entertainment' — excluded by the SQL prefilter.
      await insertScan(makeScan(DECOY_ENTERTAINMENT_KEYWORD));

      const result = await runScreener();

      expect(result.newHitKeywords).toContain(HIT_KEYWORD);
      expect(result.newHitKeywords).not.toContain(DECOY_COMP_KEYWORD);
      expect(result.newHitKeywords).not.toContain(DECOY_ENTERTAINMENT_KEYWORD);

      const hits = await getSignatureHits({ limit: 1000 });
      const persisted = hits.find((h) => h.keyword === HIT_KEYWORD);
      expect(persisted).toBeDefined();
      expect(persisted?.status).toBe("new");
      expect(persisted?.timesSeen).toBe(1);
      expect(persisted?.fastNewcomers).toBe(2);
      expect(persisted?.velocityRatio).toBeCloseTo(3.25, 6);
      expect(persisted?.genreZone).toBe("health");
      // top_apps_snapshot round-trips through the double-encoded jsonb column
      // (see signature-hits-store.ts's parseJson doc comment) back into a real array.
      expect(persisted?.topAppsSnapshot.length).toBe(3);
      expect(persisted?.topAppsSnapshot.map((a) => a.id).sort()).toEqual(
        ["established-1", "newcomer-1", "newcomer-2"].sort(),
      );

      expect(hits.some((h) => h.keyword === DECOY_COMP_KEYWORD)).toBe(false);
      expect(hits.some((h) => h.keyword === DECOY_ENTERTAINMENT_KEYWORD)).toBe(false);
    });
  });

  describe("upsertSignatureHit — conflict semantics", () => {
    function baseInput(overrides: Partial<SignatureHitUpsertInput> = {}): SignatureHitUpsertInput {
      return {
        keyword: HIT_KEYWORD,
        competitiveness: 20,
        demand: 8,
        trend: "heating",
        newcomerRpd: 6,
        establishedRpd: 2,
        velocityRatio: 3,
        fastNewcomers: 2,
        acceleratingApps: 0,
        maxReviews: 1000,
        genreZone: "health",
        topApps: textbookApps(),
        ...overrides,
      };
    }

    it("inserts a fresh 'new' hit, then a re-hit refreshes metrics without touching status", async () => {
      const now = Math.floor(Date.now() / 1000);
      const first = await upsertSignatureHit(baseInput(), now);
      expect(first.isNew).toBe(true);

      const afterInsert = await getSignatureHits({ limit: 1000 });
      const row = afterInsert.find((h) => h.keyword === HIT_KEYWORD);
      expect(row?.status).toBe("new");
      expect(row?.timesSeen).toBe(1);

      // Operator acknowledges it.
      await setSignatureHitStatus(HIT_KEYWORD, "active");

      // A later re-hit with different metrics must NOT revive it back to 'new'.
      const second = await upsertSignatureHit(
        baseInput({ competitiveness: 22, velocityRatio: 4 }),
        now + 3600,
      );
      expect(second.isNew).toBe(false);

      const afterRehit = await getSignatureHits({ limit: 1000 });
      const updated = afterRehit.find((h) => h.keyword === HIT_KEYWORD);
      expect(updated?.status).toBe("active"); // preserved, not reset to 'new'
      expect(updated?.timesSeen).toBe(2);
      expect(updated?.lastSeenAt).toBe(now + 3600);
      expect(updated?.competitiveness).toBeCloseTo(22, 6);
      expect(updated?.velocityRatio).toBeCloseTo(4, 6);
    });

    it("a dismissed hit stays dismissed across a re-hit", async () => {
      const now = Math.floor(Date.now() / 1000);
      await upsertSignatureHit(baseInput(), now);
      await setSignatureHitStatus(HIT_KEYWORD, "dismissed");

      await upsertSignatureHit(baseInput(), now + 60);

      const hits = await getSignatureHits({ status: "dismissed", limit: 1000 });
      expect(hits.some((h) => h.keyword === HIT_KEYWORD)).toBe(true);
    });
  });

  describe("routes", () => {
    it("GET /appstore/signature-hits lists hits, newest-first, filterable by status", async () => {
      const now = Math.floor(Date.now() / 1000);
      await upsertSignatureHit(
        {
          keyword: LIST_ROUTE_KEYWORD,
          competitiveness: 20,
          demand: 8,
          trend: "heating",
          newcomerRpd: 6,
          establishedRpd: 2,
          velocityRatio: 3,
          fastNewcomers: 2,
          acceleratingApps: 1,
          maxReviews: 1000,
          genreZone: "health",
          topApps: textbookApps(),
        },
        now,
      );

      const res = await get("/appstore/signature-hits?status=new&limit=500");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { success: boolean; data: Array<{ keyword: string }> };
      expect(body.success).toBe(true);
      expect(body.data.some((h) => h.keyword === LIST_ROUTE_KEYWORD)).toBe(true);

      const dismissedRes = await get("/appstore/signature-hits?status=dismissed&limit=500");
      const dismissedBody = (await dismissedRes.json()) as { data: Array<{ keyword: string }> };
      expect(dismissedBody.data.some((h) => h.keyword === LIST_ROUTE_KEYWORD)).toBe(false);
    });

    it("PATCH /appstore/signature-hits/:keyword dismisses a hit", async () => {
      const now = Math.floor(Date.now() / 1000);
      await upsertSignatureHit(
        {
          keyword: DISMISS_ROUTE_KEYWORD,
          competitiveness: 20,
          demand: 8,
          trend: "heating",
          newcomerRpd: 6,
          establishedRpd: 2,
          velocityRatio: 3,
          fastNewcomers: 2,
          acceleratingApps: 0,
          maxReviews: 1000,
          genreZone: "health",
          topApps: textbookApps(),
        },
        now,
      );

      const res = await patch(
        `/appstore/signature-hits/${encodeURIComponent(DISMISS_ROUTE_KEYWORD)}`,
        { status: "dismissed" },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { success: boolean; data: { status: string } };
      expect(body.success).toBe(true);
      expect(body.data.status).toBe("dismissed");

      const hits = await getSignatureHits({ status: "dismissed", limit: 1000 });
      expect(hits.some((h) => h.keyword === DISMISS_ROUTE_KEYWORD)).toBe(true);
    });

    it("PATCH on an unknown keyword returns 404", async () => {
      const res = await patch("/appstore/signature-hits/zzv-does-not-exist", {
        status: "dismissed",
      });
      expect(res.status).toBe(404);
    });

    it("PATCH with an invalid status returns 400", async () => {
      await upsertSignatureHit(
        {
          keyword: DISMISS_ROUTE_KEYWORD,
          competitiveness: 20,
          demand: 8,
          trend: "heating",
          newcomerRpd: null,
          establishedRpd: null,
          velocityRatio: null,
          fastNewcomers: 2,
          acceleratingApps: 0,
          maxReviews: 1000,
          genreZone: "health",
          topApps: textbookApps(),
        },
        Math.floor(Date.now() / 1000),
      );

      const res = await patch(
        `/appstore/signature-hits/${encodeURIComponent(DISMISS_ROUTE_KEYWORD)}`,
        { status: "new" }, // 'new' is not a settable transition
      );
      expect(res.status).toBe(400);
    });
  });
});
