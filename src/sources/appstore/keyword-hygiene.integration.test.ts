import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { getDb, initDb } from "../../store/db";
import {
  applyDerivedZones,
  getRetiredFamilyRoots,
  getRetirementStats,
  insertScan,
  markRetirementChecked,
  retireKeywords,
  selectRetirementCandidateRows,
  selectZoneDerivationRows,
  upsertKeywords,
} from "./keyword-store";
import type { KeywordGapProfile, TopApp } from "./keyword-types";

// Self-contained `zzz`-prefixed fixture set + cleanup, matching
// `keyword-store.integration.test.ts`'s convention — this file runs against the
// SHARED corpus DB, so it may only ever create and delete rows it owns, and
// every assertion must be scoped to those rows (never to corpus-wide counts,
// which move under the live scanner).
const TEST_KEYWORDS = [
  "zzz-hyg-junk-тест",
  "zzz-hyg-brand",
  "zzz-hyg-brand pro",
  "zzz-hyg-keep",
  "zzz-hyg-protected",
  "zzz-hyg-zone",
  "zzz-hyg-zone-unclassified",
] as const;

/**
 * Both `select*Rows` functions page by their own cursor column ordered
 * `ASC NULLS FIRST`, and this file runs against the SHARED live corpus DB
 * where ~94,000 rows sit in the NULL bucket ahead of any fixture. Ordering
 * WITHIN that bucket is arbitrary, so the only reliable way to assert on a
 * fixture row is a limit that provably covers the whole eligible pool rather
 * than a limit that "should" reach it. Deliberately far above the live corpus
 * size (~145k rows total) so this stays true as the corpus grows.
 */
const WHOLE_CORPUS_LIMIT = 1_000_000;

async function cleanup(): Promise<void> {
  const db = getDb();
  await db`DELETE FROM appstore_keyword_scans WHERE keyword IN ${db([...TEST_KEYWORDS])}`;
  await db`DELETE FROM appstore_keywords WHERE keyword IN ${db([...TEST_KEYWORDS])}`;
}

function topApp(overrides: Partial<TopApp> = {}): TopApp {
  return {
    id: "zzz-hyg-app-1",
    name: "Some App",
    reviews: 100,
    rating: 4,
    ageDays: 400,
    ratingsPerDay: 0.25,
    titleMatch: false,
    ...overrides,
  };
}

function profile(overrides: Partial<KeywordGapProfile> = {}): KeywordGapProfile {
  return {
    keyword: "zzz-hyg-keep",
    store: "app",
    competitiveness: 10,
    demand: 5,
    incumbentWeakness: 10,
    opportunity: 0.1,
    trend: "stable",
    topAppReviews: 100,
    avgRating: 4,
    avgAgeDays: 400,
    topApps: [topApp()],
    scannedAt: Math.floor(Date.now() / 1000),
    lowConfidence: false,
    brandNavigational: false,
    ...overrides,
  };
}

describe("corpus hygiene store layer", () => {
  beforeAll(async () => {
    await initDb(process.env.DATABASE_URL);
    await cleanup();
  });
  afterEach(cleanup);
  afterAll(cleanup);

  describe("retireKeywords", () => {
    it("stamps retired_at/retired_reason and deactivates, idempotently", async () => {
      await upsertKeywords([
        { keyword: "zzz-hyg-brand", genreZone: "zzz-hyg-zone-label", source: "autocomplete" },
      ]);

      const first = await retireKeywords(
        [{ keyword: "zzz-hyg-brand", reason: "brand-lexical" }],
        1_800_000_000,
      );
      expect(first).toBe(1);

      const db = getDb();
      const rows = await db`
        SELECT active, retired_at, retired_reason FROM appstore_keywords
        WHERE keyword = 'zzz-hyg-brand'
      `;
      // `BIGINT` comes back from Bun's SQL driver as a STRING, not a number —
      // hence `Number(...)` on every epoch-second column asserted in this file.
      expect(rows[0]).toMatchObject({ active: false, retired_reason: "brand-lexical" });
      expect(Number((rows[0] as { retired_at: number | string }).retired_at)).toBe(1_800_000_000);

      // Re-retiring must NOT restamp — the audit trail records the FIRST
      // retirement, and a repeated sweep pass must be a no-op.
      const second = await retireKeywords(
        [{ keyword: "zzz-hyg-brand", reason: "structural-junk" }],
        1_900_000_000,
      );
      expect(second).toBe(0);
      const after = await db`
        SELECT retired_at, retired_reason FROM appstore_keywords WHERE keyword = 'zzz-hyg-brand'
      `;
      expect(after[0]).toMatchObject({ retired_reason: "brand-lexical" });
      expect(Number((after[0] as { retired_at: number | string }).retired_at)).toBe(1_800_000_000);
    });

    it("refuses to retire a protected manual/seed keyword", async () => {
      await upsertKeywords([
        { keyword: "zzz-hyg-protected", genreZone: "zzz-hyg-zone-label", source: "seed" },
      ]);
      const retired = await retireKeywords(
        [{ keyword: "zzz-hyg-protected", reason: "structural-junk" }],
        1_800_000_000,
      );
      expect(retired).toBe(0);
      const db = getDb();
      const rows = await db`
        SELECT active, retired_at FROM appstore_keywords WHERE keyword = 'zzz-hyg-protected'
      `;
      expect(rows[0]).toMatchObject({ active: true, retired_at: null });
    });
  });

  describe("getRetiredFamilyRoots + upsertKeywords discovery guard", () => {
    it("returns only brand-reason roots among the probed prefixes", async () => {
      await upsertKeywords([
        { keyword: "zzz-hyg-brand", genreZone: "zzz-hyg-zone-label", source: "autocomplete" },
        { keyword: "zzz-hyg-junk-тест", genreZone: "zzz-hyg-zone-label", source: "mined" },
      ]);
      await retireKeywords(
        [
          { keyword: "zzz-hyg-brand", reason: "brand-lexical" },
          // A junk retirement must NOT become a family root.
          { keyword: "zzz-hyg-junk-тест", reason: "structural-junk" },
        ],
        1_800_000_000,
      );

      const roots = await getRetiredFamilyRoots(
        ["zzz-hyg-brand", "zzz-hyg-junk-тест", "zzz-hyg-keep"],
        ["brand-lexical", "brand-serp-shape"],
      );
      expect([...roots]).toEqual(["zzz-hyg-brand"]);
    });

    it("refuses to re-admit a descendant of a retired brand family root", async () => {
      await upsertKeywords([
        { keyword: "zzz-hyg-brand", genreZone: "zzz-hyg-zone-label", source: "autocomplete" },
      ]);
      await retireKeywords(
        [{ keyword: "zzz-hyg-brand", reason: "brand-lexical" }],
        1_800_000_000,
      );

      // "zzz-hyg-brand pro" is a whole-token extension of the retired root.
      const admitted = await upsertKeywords([
        { keyword: "zzz-hyg-brand pro", genreZone: "zzz-hyg-zone-label", source: "autocomplete" },
        { keyword: "zzz-hyg-keep", genreZone: "zzz-hyg-zone-label", source: "autocomplete" },
      ]);
      expect(admitted).toBe(1);

      const db = getDb();
      const rows = await db`
        SELECT keyword FROM appstore_keywords WHERE keyword IN ('zzz-hyg-brand pro', 'zzz-hyg-keep')
      `;
      expect((rows as ReadonlyArray<{ keyword: string }>).map((r) => r.keyword)).toEqual([
        "zzz-hyg-keep",
      ]);
    });

    it("still admits a manual/seed row inside a retired family — a human outranks the heuristic", async () => {
      await upsertKeywords([
        { keyword: "zzz-hyg-brand", genreZone: "zzz-hyg-zone-label", source: "autocomplete" },
      ]);
      await retireKeywords(
        [{ keyword: "zzz-hyg-brand", reason: "brand-lexical" }],
        1_800_000_000,
      );
      const admitted = await upsertKeywords([
        { keyword: "zzz-hyg-brand pro", genreZone: "zzz-hyg-zone-label", source: "manual" },
      ]);
      expect(admitted).toBe(1);
    });
  });

  describe("selectRetirementCandidateRows", () => {
    it("computes the SERP shape from the latest US scan and excludes retired rows", async () => {
      await upsertKeywords([
        { keyword: "zzz-hyg-keep", genreZone: "zzz-hyg-zone-label", source: "autocomplete" },
      ]);
      // A brand-shaped field: rank 1's title IS the keyword and holds most of
      // the review mass; 2 of 3 titles start with the keyword at a boundary.
      await insertScan(
        profile({
          keyword: "zzz-hyg-keep",
          topApps: [
            topApp({ id: "a1", name: "zzz-hyg-keep", reviews: 900, titleMatch: true }),
            topApp({ id: "a2", name: "zzz-hyg-keep - extra", reviews: 50 }),
            topApp({ id: "a3", name: "Unrelated App", reviews: 50 }),
          ],
        }),
      );
      await markRetirementChecked(["zzz-hyg-keep"], 1);

      const rows = await selectRetirementCandidateRows(WHOLE_CORPUS_LIMIT);
      const row = rows.find((r) => r.keyword === "zzz-hyg-keep");
      expect(row).toBeDefined();
      expect(row?.fieldSize).toBe(3);
      expect(row?.exactBrandTitleCount).toBe(2);
      expect(row?.rankOneExactBrandTitle).toBe(true);
      expect(row?.rankOneReviewShare).toBeCloseTo(0.9, 5);
      expect(row?.scanCount).toBe(1);
      expect(row?.hasSignatureHit).toBe(false);

      await retireKeywords(
        [{ keyword: "zzz-hyg-keep", reason: "brand-serp-shape" }],
        1_800_000_000,
      );
      const after = await selectRetirementCandidateRows(WHOLE_CORPUS_LIMIT);
      expect(after.find((r) => r.keyword === "zzz-hyg-keep")).toBeUndefined();
    });

    it("reports a zero field size for a never-scanned keyword rather than a fake shape", async () => {
      await upsertKeywords([
        { keyword: "zzz-hyg-keep", genreZone: "zzz-hyg-zone-label", source: "mined" },
      ]);
      await markRetirementChecked(["zzz-hyg-keep"], 1);
      const rows = await selectRetirementCandidateRows(WHOLE_CORPUS_LIMIT);
      const row = rows.find((r) => r.keyword === "zzz-hyg-keep");
      expect(row).toMatchObject({
        fieldSize: 0,
        exactBrandTitleCount: 0,
        rankOneExactBrandTitle: false,
        rankOneReviewShare: 0,
      });
    });
  });

  describe("getRetirementStats", () => {
    it("counts the fixture retirement under its reason", async () => {
      const before = await getRetirementStats();
      await upsertKeywords([
        { keyword: "zzz-hyg-brand", genreZone: "zzz-hyg-zone-label", source: "autocomplete" },
      ]);
      await retireKeywords(
        [{ keyword: "zzz-hyg-brand", reason: "brand-lexical" }],
        1_800_000_000,
      );
      const after = await getRetirementStats();
      expect(after.total).toBe(before.total + 1);
      expect(after.byReason["brand-lexical"] ?? 0).toBe((before.byReason["brand-lexical"] ?? 0) + 1);
    });
  });

  describe("selectZoneDerivationRows + applyDerivedZones", () => {
    it("returns the incumbents' raw genres and never touches the legacy genre_zone", async () => {
      await upsertKeywords([
        { keyword: "zzz-hyg-zone", genreZone: "zzz-hyg-legacy-zone", source: "mined" },
      ]);
      await insertScan(
        profile({
          keyword: "zzz-hyg-zone",
          topApps: [
            topApp({ id: "z1", genre: "Finance" }),
            topApp({ id: "z2", genre: "Finance" }),
            topApp({ id: "z3", genre: "Finance" }),
            topApp({ id: "z4", genre: "Travel" }),
          ],
        }),
      );

      const rows = await selectZoneDerivationRows(WHOLE_CORPUS_LIMIT);
      const row = rows.find((r) => r.keyword === "zzz-hyg-zone");
      expect(row).toBeDefined();
      expect([...(row?.genres ?? [])].sort()).toEqual(["Finance", "Finance", "Finance", "Travel"]);

      await applyDerivedZones(
        [{ keyword: "zzz-hyg-zone", zone: "finance", confidence: 0.75 }],
        1_800_000_000,
      );
      const db = getDb();
      const stored = await db`
        SELECT genre_zone, genre_zone_derived, genre_zone_confidence, genre_zone_derived_at
        FROM appstore_keywords WHERE keyword = 'zzz-hyg-zone'
      `;
      expect(stored[0]).toMatchObject({
        // The hand-assigned legacy label survives untouched.
        genre_zone: "zzz-hyg-legacy-zone",
        genre_zone_derived: "finance",
      });
      const zoneRow = stored[0] as {
        genre_zone_confidence: number | string;
        genre_zone_derived_at: number | string;
      };
      expect(Number(zoneRow.genre_zone_confidence)).toBeCloseTo(0.75, 5);
      expect(Number(zoneRow.genre_zone_derived_at)).toBe(1_800_000_000);
    });

    it("persists an unclassified keyword AS NULL and still advances its cursor", async () => {
      await upsertKeywords([
        {
          keyword: "zzz-hyg-zone-unclassified",
          genreZone: "zzz-hyg-legacy-zone",
          source: "mined",
        },
      ]);
      await applyDerivedZones(
        [{ keyword: "zzz-hyg-zone-unclassified", zone: null, confidence: null }],
        1_800_000_000,
      );
      const db = getDb();
      const stored = await db`
        SELECT genre_zone_derived, genre_zone_confidence, genre_zone_derived_at
        FROM appstore_keywords WHERE keyword = 'zzz-hyg-zone-unclassified'
      `;
      expect(stored[0]).toMatchObject({ genre_zone_derived: null, genre_zone_confidence: null });
      // The cursor moved even though nothing was classified — otherwise the
      // pass would re-derive this keyword forever.
      expect(
        Number((stored[0] as { genre_zone_derived_at: number | string }).genre_zone_derived_at),
      ).toBe(1_800_000_000);
    });
  });
});
