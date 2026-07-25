import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { getDb, initDb } from "../../store/db";
import {
  countHintProbes,
  getDirectProbeCandidates,
  getHintProbeRecords,
  recordHintProbes,
} from "./hint-probe-store";
import {
  getHintEvidence,
  insertAutocompleteHints,
  insertScan,
  upsertKeywords,
} from "./keyword-store";
import { resolveHintCoverage } from "./hint-coverage";
import type { KeywordGapProfile, TopApp } from "./keyword-types";

/**
 * Distinctive prefix so every row this file writes is identifiable and
 * removable, and so it can never collide with real corpus keywords — the local
 * Postgres this lane runs against holds the live 145k-keyword corpus, so
 * scoped `DELETE`s (never `TRUNCATE`) are mandatory. Mirrors
 * `keyword-store.integration.test.ts`'s `TEST_KEYWORDS` convention.
 */
const PREFIX = "zzhintprobe";
const KW_NEVER = `${PREFIX} never probed`;
const KW_FRESH = `${PREFIX} fresh probe`;
const KW_STALE = `${PREFIX} stale probe`;
const KW_MINED_HIGH = `${PREFIX} mined winner`;
const KW_MINED_LOW = `${PREFIX} mined dud`;
const TEST_KEYWORDS = [KW_NEVER, KW_FRESH, KW_STALE, KW_MINED_HIGH, KW_MINED_LOW];

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86_400;

function topApp(id: string): TopApp {
  return {
    id,
    name: `App ${id}`,
    reviews: 100,
    rating: 4,
    ageDays: 400,
    ratingsPerDay: 0.25,
    titleMatch: true,
  };
}

function profile(keyword: string, opportunity: number): KeywordGapProfile {
  return {
    keyword,
    store: "app",
    scannedAt: NOW - DAY,
    competitiveness: 0.4,
    demand: 0.5,
    incumbentWeakness: 0.5,
    opportunity,
    trend: "stable",
    topAppReviews: 100,
    avgRating: 4,
    avgAgeDays: 400,
    topApps: [topApp("1")],
    lowConfidence: false,
    brandNavigational: false,
  };
}

async function cleanup(): Promise<void> {
  const db = getDb();
  await db`DELETE FROM appstore_autocomplete_probes WHERE query LIKE ${`${PREFIX}%`}`;
  await db`DELETE FROM appstore_autocomplete_hints WHERE seed LIKE ${`${PREFIX}%`} OR term LIKE ${`${PREFIX}%`}`;
  await db`DELETE FROM appstore_keyword_scans WHERE keyword IN ${db(TEST_KEYWORDS)}`;
  await db`DELETE FROM appstore_keywords WHERE keyword IN ${db(TEST_KEYWORDS)}`;
}

describe("hint-probe-store (probe ledger, migration 057)", () => {
  beforeAll(async () => {
    await initDb();
    await cleanup();
  });

  afterEach(cleanup);
  afterAll(cleanup);

  it("persists a probe and reads it back as the `probed-absent` leg of the tri-state", async () => {
    await recordHintProbes([
      {
        query: KW_NEVER,
        storefront: "us",
        probedAt: NOW,
        returnedAny: true,
        termCount: 4,
        selfRank: null,
      },
    ]);

    const records = await getHintProbeRecords([KW_NEVER], "us");
    const record = records.get(KW_NEVER);
    expect(record).toBeDefined();
    expect(record?.returnedAny).toBe(true);
    expect(record?.termCount).toBe(4);
    expect(record?.selfRank).toBeNull();
    expect(record?.probeCount).toBe(1);
    expect(record?.firstProbedAt).toBe(NOW);
    expect(record?.lastProbedAt).toBe(NOW);
  });

  it("returns no record for a never-probed query (the third state)", async () => {
    const records = await getHintProbeRecords([`${PREFIX} nonexistent`], "us");
    expect(records.size).toBe(0);
  });

  it("persists the EMPTY-response observation that the pre-057 schema could not represent", async () => {
    await recordHintProbes([
      {
        query: KW_NEVER,
        storefront: "us",
        probedAt: NOW,
        returnedAny: false,
        termCount: 0,
        selfRank: null,
      },
    ]);
    expect((await getHintProbeRecords([KW_NEVER], "us")).get(KW_NEVER)?.returnedAny).toBe(false);
  });

  it("upserts latest-wins on the answer while accumulating probe history", async () => {
    await recordHintProbes([
      {
        query: KW_NEVER,
        storefront: "us",
        probedAt: NOW - 10 * DAY,
        returnedAny: false,
        termCount: 0,
        selfRank: null,
      },
    ]);
    await recordHintProbes([
      {
        query: KW_NEVER,
        storefront: "us",
        probedAt: NOW,
        returnedAny: true,
        termCount: 3,
        selfRank: 2,
      },
    ]);

    const record = (await getHintProbeRecords([KW_NEVER], "us")).get(KW_NEVER);
    expect(record?.probeCount).toBe(2);
    // First observation preserved, latest answer wins.
    expect(record?.firstProbedAt).toBe(NOW - 10 * DAY);
    expect(record?.lastProbedAt).toBe(NOW);
    expect(record?.returnedAny).toBe(true);
    expect(record?.selfRank).toBe(2);
  });

  it("keeps US and GB ledgers independent", async () => {
    await recordHintProbes([
      {
        query: KW_NEVER,
        storefront: "us",
        probedAt: NOW,
        returnedAny: true,
        termCount: 2,
        selfRank: 0,
      },
      {
        query: KW_NEVER,
        storefront: "gb",
        probedAt: NOW,
        returnedAny: false,
        termCount: 0,
        selfRank: null,
      },
    ]);

    expect((await getHintProbeRecords([KW_NEVER], "us")).get(KW_NEVER)?.returnedAny).toBe(true);
    expect((await getHintProbeRecords([KW_NEVER], "gb")).get(KW_NEVER)?.returnedAny).toBe(false);
  });

  it("drops a blank query rather than persisting an empty ledger key", async () => {
    await recordHintProbes([
      { query: "   ", storefront: "us", probedAt: NOW, returnedAny: false, termCount: 0, selfRank: null },
    ]);
    const db = getDb();
    const rows = await db`SELECT query FROM appstore_autocomplete_probes WHERE query = '   '`;
    expect((rows as readonly unknown[]).length).toBe(0);
  });

  describe("getDirectProbeCandidates", () => {
    it("selects non-mined corpus keywords and prefers never-probed ones", async () => {
      await upsertKeywords([
        { keyword: KW_NEVER, genreZone: "health", source: "manual" },
        { keyword: KW_FRESH, genreZone: "health", source: "manual" },
      ]);
      await recordHintProbes([
        {
          query: KW_FRESH,
          storefront: "us",
          probedAt: NOW,
          returnedAny: true,
          termCount: 1,
          selfRank: 0,
        },
      ]);

      const candidates = await getDirectProbeCandidates({
        market: "us",
        limit: 200_000,
        reprobeBefore: NOW - 30 * DAY,
        opportunityFloor: 0.35,
        opportunitySince: NOW - 90 * DAY,
      });
      const ours = candidates.filter((c) => c.keyword.startsWith(PREFIX));

      expect(ours.map((c) => c.keyword)).toContain(KW_NEVER);
      // Probed 0 days ago, cutoff is 30 days back — not due.
      expect(ours.map((c) => c.keyword)).not.toContain(KW_FRESH);
      expect(ours.find((c) => c.keyword === KW_NEVER)?.lastProbedAt).toBeNull();
    });

    it("includes a stale probe and reports its `lastProbedAt`", async () => {
      await upsertKeywords([{ keyword: KW_STALE, genreZone: "health", source: "manual" }]);
      await recordHintProbes([
        {
          query: KW_STALE,
          storefront: "us",
          probedAt: NOW - 60 * DAY,
          returnedAny: false,
          termCount: 0,
          selfRank: null,
        },
      ]);

      const candidates = await getDirectProbeCandidates({
        market: "us",
        limit: 200_000,
        reprobeBefore: NOW - 30 * DAY,
        opportunityFloor: 0.35,
        opportunitySince: NOW - 90 * DAY,
      });
      const stale = candidates.find((c) => c.keyword === KW_STALE);
      expect(stale).toBeDefined();
      expect(stale?.lastProbedAt).toBe(NOW - 60 * DAY);
    });

    it("includes a MINED keyword only once it has scored above the floor", async () => {
      // 1,030 of the 1,362 keywords that ever scored >= 0.35 are `mined`
      // (measured 2026-07-26), so this clause is what puts the signal where
      // the actual decisions happen — not a rounding error.
      await upsertKeywords([
        { keyword: KW_MINED_HIGH, genreZone: "health", source: "mined" },
        { keyword: KW_MINED_LOW, genreZone: "health", source: "mined" },
      ]);
      await insertScan(profile(KW_MINED_HIGH, 0.72));
      await insertScan(profile(KW_MINED_LOW, 0.05));

      const candidates = await getDirectProbeCandidates({
        market: "us",
        limit: 200_000,
        reprobeBefore: NOW,
        opportunityFloor: 0.35,
        opportunitySince: NOW - 90 * DAY,
      });
      const keywords = candidates.map((c) => c.keyword);

      expect(keywords).toContain(KW_MINED_HIGH);
      expect(keywords).not.toContain(KW_MINED_LOW);
    });

    it("orders decision-relevant (ever-scored) keywords ahead of the rest", async () => {
      await upsertKeywords([
        { keyword: KW_NEVER, genreZone: "health", source: "manual" },
        { keyword: KW_MINED_HIGH, genreZone: "health", source: "mined" },
      ]);
      await insertScan(profile(KW_MINED_HIGH, 0.72));

      const candidates = await getDirectProbeCandidates({
        market: "us",
        limit: 200_000,
        reprobeBefore: NOW,
        opportunityFloor: 0.35,
        opportunitySince: NOW - 90 * DAY,
      });
      const ours = candidates.filter((c) => c.keyword.startsWith(PREFIX)).map((c) => c.keyword);
      expect(ours.indexOf(KW_MINED_HIGH)).toBeLessThan(ours.indexOf(KW_NEVER));
    });

    it("returns nothing for a non-positive limit", async () => {
      expect(
        await getDirectProbeCandidates({
          market: "us",
          limit: 0,
          reprobeBefore: NOW,
          opportunityFloor: 0.35,
          opportunitySince: NOW - 90 * DAY,
        }),
      ).toEqual([]);
    });
  });

  /**
   * END-TO-END TRI-STATE, against the real schema.
   *
   * Lives here rather than in `keyword-store.integration.test.ts` deliberately:
   * `getHintEvidence` is in the shared `keyword-store.ts` and is being extended
   * concurrently, so the coverage-wave assertions are kept in this file to stay
   * out of that file's way. What's proven here is the seam that matters — the
   * probe ledger reaching `HintEvidence`, and `resolveHintCoverage` turning the
   * two tables into three distinguishable answers.
   */
  describe("tri-state end to end (getHintEvidence + resolveHintCoverage)", () => {
    it("distinguishes present / probed-absent / never-probed", async () => {
      // 1. PRESENT — Apple returned it as a kept hint.
      await insertAutocompleteHints([
        { seed: KW_NEVER, term: KW_FRESH, rank: 2, seenAt: NOW, storefront: "us", kept: true },
      ]);
      // 2. PROBED-ABSENT — the exact phrase was asked, Apple answered with an
      //    EMPTY list. Pre-migration-057 this wrote nothing anywhere, so it was
      //    indistinguishable from case 3.
      await recordHintProbes([
        {
          query: KW_STALE,
          storefront: "us",
          probedAt: NOW,
          returnedAny: false,
          termCount: 0,
          selfRank: null,
        },
      ]);
      // 3. NEVER-PROBED — no hint, no probe.

      const evidence = await getHintEvidence([KW_FRESH, KW_STALE, KW_MINED_LOW]);

      const present = resolveHintCoverage({
        bestRank: evidence.get(KW_FRESH)?.bestRank ?? null,
        probedAt: evidence.get(KW_FRESH)?.probedAt ?? null,
        prefixCovered: evidence.get(KW_FRESH)?.covered ?? false,
      });
      expect(present.state).toBe("present");
      if (present.state === "present") expect(present.bestRank).toBe(2);

      const probedAbsent = resolveHintCoverage({
        bestRank: evidence.get(KW_STALE)?.bestRank ?? null,
        probedAt: evidence.get(KW_STALE)?.probedAt ?? null,
        prefixCovered: evidence.get(KW_STALE)?.covered ?? false,
      });
      expect(probedAbsent.state).toBe("probed-absent");
      // DIRECT, not prefix — the strongest negative, the only one a retirement
      // rule may act on.
      if (probedAbsent.state === "probed-absent") {
        expect(probedAbsent.confidence).toBe("direct");
        expect(probedAbsent.probedAt).toBe(NOW);
      }

      const neverProbed = resolveHintCoverage({
        bestRank: evidence.get(KW_MINED_LOW)?.bestRank ?? null,
        probedAt: evidence.get(KW_MINED_LOW)?.probedAt ?? null,
        prefixCovered: evidence.get(KW_MINED_LOW)?.covered ?? false,
      });
      expect(neverProbed.state).toBe("never-probed");
    });

    it("makes an empty-response probe count as `covered` — the hole the prefix heuristic left", async () => {
      // Before the ledger, an empty response produced no hint row, so the
      // keyword's `seed` never appeared in the coverage check and `covered`
      // stayed false. The most informative negative was invisible.
      const before = await getHintEvidence([KW_STALE]);
      expect(before.get(KW_STALE)?.covered).toBe(false);
      expect(before.get(KW_STALE)?.probedAt).toBeNull();

      await recordHintProbes([
        {
          query: KW_STALE,
          storefront: "us",
          probedAt: NOW,
          returnedAny: false,
          termCount: 0,
          selfRank: null,
        },
      ]);

      const after = await getHintEvidence([KW_STALE]);
      expect(after.get(KW_STALE)?.covered).toBe(true);
      expect(after.get(KW_STALE)?.probedAt).toBe(NOW);
      // Still no rank — coverage is not presence.
      expect(after.get(KW_STALE)?.bestRank).toBeNull();
    });
  });

  it("counts the ledger per storefront", async () => {
    const before = await countHintProbes("us");
    await recordHintProbes([
      {
        query: KW_NEVER,
        storefront: "us",
        probedAt: NOW,
        returnedAny: true,
        termCount: 2,
        selfRank: 1,
      },
      {
        query: KW_STALE,
        storefront: "us",
        probedAt: NOW,
        returnedAny: false,
        termCount: 0,
        selfRank: null,
      },
    ]);
    const after = await countHintProbes("us");

    expect(after.total).toBe(before.total + 2);
    expect(after.returnedAny).toBe(before.returnedAny + 1);
    expect(after.selfSuggested).toBe(before.selfSuggested + 1);
  });
});
