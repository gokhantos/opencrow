import { describe, expect, it, mock, beforeEach } from "bun:test";
// Real (unmocked) import, resolved at file-load time BEFORE any
// `mock.module` call runs — mirrors app-enrichment.isolated.test.ts /
// keyword-gaps.isolated.test.ts: re-exported from every
// `../shared/ssrf-safe-fetch` mock below so `app-lookup.ts`'s own
// `import { ssrfSafeFetch } from "../shared/ssrf-safe-fetch"` (transitively
// used by `newborn-reobservation.ts` via `fetchLookupBatch`) always finds a
// real named export for `RateLimitError`.
import { RateLimitError } from "../shared/ssrf-safe-fetch";
import type { NewbornVelocityAppRow } from "./app-velocity-store";

// A fixed 30-days-ago ISO date, computed at file-load time rather than
// hardcoded — keeps every "still newborn" fixture well under
// `app-velocity.ts`'s `NEWBORN_AGE_DAYS_MAX` (540) regardless of when the
// suite runs. Mirrors app-enrichment.isolated.test.ts's THIRTY_DAYS_AGO_ISO.
const THIRTY_DAYS_AGO_ISO = new Date(Date.now() - 30 * 86_400_000).toISOString();
// Comfortably past NEWBORN_AGE_DAYS_MAX (540 days) either way.
const THOUSAND_DAYS_AGO_ISO = new Date(Date.now() - 1_000 * 86_400_000).toISOString();

function lookupResultJson(id: string, overrides: Record<string, unknown> = {}) {
  return {
    wrapperType: "software",
    trackId: Number(id),
    trackName: `App ${id}`,
    userRatingCount: 500,
    averageUserRating: 4.5,
    releaseDate: THIRTY_DAYS_AGO_ISO,
    currentVersionReleaseDate: "2024-06-01T00:00:00Z",
    version: "1.0.0",
    price: 0,
    formattedPrice: "Free",
    primaryGenreId: "6000",
    primaryGenreName: "Business",
    artistId: "1",
    artistName: "Acme",
    bundleId: `com.acme.${id}`,
    trackViewUrl: `https://apps.apple.com/app/id${id}`,
    artworkUrl100: "https://example.com/icon.png",
    ...overrides,
  };
}

/** Every `./app-velocity-store` export `newborn-reobservation.ts` imports, with inert defaults. */
function appVelocityStoreMockBase(population: readonly NewbornVelocityAppRow[] = []) {
  return {
    getNewbornVelocityAppIds: async () => population,
    insertObservation: async () => true,
  };
}

describe("runNewbornReobservationPass", () => {
  let fetchedUrls: string[];
  let insertCalls: Array<{ appId: string; reviews: number; rating: number; keyword: string; rank: number | null }>;

  beforeEach(() => {
    fetchedUrls = [];
    insertCalls = [];

    mock.module("../shared/ssrf-safe-fetch", () => ({
      RateLimitError,
      ssrfSafeFetch: async (url: string) => {
        fetchedUrls.push(url);
        // Echo back a lookup result for every id embedded in the request URL
        // (`app-lookup.ts`'s `buildLookupUrl` — `?id=a,b,c`).
        const idsParam = new URL(url).searchParams.get("id") ?? "";
        const ids = idsParam.split(",").filter(Boolean);
        return {
          ok: true,
          json: async () => ({ results: ids.map((id) => lookupResultJson(id)) }),
        };
      },
    }));

    mock.module("./app-velocity-store", () => ({
      ...appVelocityStoreMockBase([
        { appId: "1000001", releaseDate: null },
        { appId: "1000002", releaseDate: THIRTY_DAYS_AGO_ISO },
      ]),
      insertObservation: async (input: {
        appId: string;
        reviews: number;
        rating: number;
        keyword: string;
        rank: number | null;
      }) => {
        insertCalls.push(input);
        return true;
      },
    }));
  });

  it("re-observes every app in the population and writes rank:null observations tagged with the lane keyword", async () => {
    const { runNewbornReobservationPass, NEWBORN_REOBSERVATION_KEYWORD } = await import(
      "./newborn-reobservation"
    );
    const result = await runNewbornReobservationPass({
      batchSize: 200,
      maxAgeDays: 540,
      delayMs: 0,
    });

    expect(result.skipped).toBe(false);
    expect(result.candidateCount).toBe(2);
    expect(result.stillNewbornCount).toBe(2);
    expect(result.observed).toBe(2);
    expect(result.attempted).toBe(1); // both ids fit in one batch
    expect(insertCalls).toHaveLength(2);
    for (const call of insertCalls) {
      expect(call.rank).toBeNull();
      expect(call.keyword).toBe(NEWBORN_REOBSERVATION_KEYWORD);
    }
    expect(fetchedUrls[0]).toContain("1000001");
    expect(fetchedUrls[0]).toContain("1000002");
  });

  it("drops apps confidently aged past maxAgeDays from the population BEFORE fetching (never queries them)", async () => {
    mock.module("./app-velocity-store", () => ({
      ...appVelocityStoreMockBase([
        { appId: "1000001", releaseDate: THIRTY_DAYS_AGO_ISO }, // still newborn
        { appId: "9999999", releaseDate: THOUSAND_DAYS_AGO_ISO }, // aged out
      ]),
      insertObservation: async (input: unknown) => {
        insertCalls.push(input as (typeof insertCalls)[number]);
        return true;
      },
    }));

    const { runNewbornReobservationPass } = await import("./newborn-reobservation");
    const result = await runNewbornReobservationPass({ batchSize: 200, maxAgeDays: 540, delayMs: 0 });

    expect(result.candidateCount).toBe(2);
    expect(result.stillNewbornCount).toBe(1);
    expect(fetchedUrls[0]).toContain("1000001");
    expect(fetchedUrls[0]).not.toContain("9999999");
  });

  it("does not record an observation when the FRESH lookup-reported release date shows the app has aged out since the pre-filter ran", async () => {
    mock.module("../shared/ssrf-safe-fetch", () => ({
      RateLimitError,
      ssrfSafeFetch: async (url: string) => {
        fetchedUrls.push(url);
        return {
          ok: true,
          // The lookup itself reports an old release date even though the
          // pre-filter (app-meta's possibly-stale data) thought it unknown/newborn.
          json: async () => ({ results: [lookupResultJson("1000001", { releaseDate: THOUSAND_DAYS_AGO_ISO })] }),
        };
      },
    }));
    mock.module("./app-velocity-store", () => ({
      ...appVelocityStoreMockBase([{ appId: "1000001", releaseDate: null }]),
      insertObservation: async (input: unknown) => {
        insertCalls.push(input as (typeof insertCalls)[number]);
        return true;
      },
    }));

    const { runNewbornReobservationPass } = await import("./newborn-reobservation");
    const result = await runNewbornReobservationPass({ batchSize: 200, maxAgeDays: 540, delayMs: 0 });

    expect(result.stillNewbornCount).toBe(1); // pre-filter kept it (unknown age)
    expect(result.agedOut).toBe(1); // authoritative fresh check dropped it
    expect(result.observed).toBe(0);
    expect(insertCalls).toEqual([]);
  });

  it("returns the skipped result immediately when batchSize is 0, without querying the population", async () => {
    mock.module("./app-velocity-store", () => ({
      getNewbornVelocityAppIds: async () => {
        throw new Error("must not be called when batchSize is 0");
      },
      insertObservation: async () => true,
    }));

    const { runNewbornReobservationPass } = await import("./newborn-reobservation");
    const result = await runNewbornReobservationPass({ batchSize: 0, maxAgeDays: 540, delayMs: 0 });

    expect(result).toEqual({
      candidateCount: 0,
      stillNewbornCount: 0,
      observed: 0,
      missing: 0,
      agedOut: 0,
      attempted: 0,
      rateLimitErrors: 0,
      bailed: false,
      skipped: true,
    });
  });

  it("bails after 5 consecutive rate-limited batch failures, counting each as a rate-limit error", async () => {
    const population: NewbornVelocityAppRow[] = Array.from({ length: 6 }, (_, i) => ({
      appId: `app-${i}`,
      releaseDate: THIRTY_DAYS_AGO_ISO,
    }));
    mock.module("../shared/ssrf-safe-fetch", () => ({
      RateLimitError,
      ssrfSafeFetch: async (url: string) => {
        fetchedUrls.push(url);
        throw new RateLimitError("rate limited", 429, undefined);
      },
    }));
    mock.module("./app-velocity-store", () => appVelocityStoreMockBase(population));

    const { runNewbornReobservationPass } = await import("./newborn-reobservation");
    // batchSize 1 -> 6 batches (one id each) so the 5-consecutive-failure
    // bail fires before the population is exhausted.
    const result = await runNewbornReobservationPass({ batchSize: 1, maxAgeDays: 540, delayMs: 0 });

    expect(result.bailed).toBe(true);
    expect(result.attempted).toBe(5); // bails exactly at the 5th consecutive failure
    expect(result.rateLimitErrors).toBe(5);
  });

  // MANDATORY per the throughput-wave design: this lane rides the SAME
  // shared `keywordSweepTick` single-flight guard as every other deep-scrape
  // lane (see scraper.ts) — a single slow-but-not-failing upstream must never
  // be allowed to wedge that tick for every other lane, which is exactly the
  // 2026-07-21 incident `pass-deadline.ts`'s `isPassOverBudget` guards
  // against (PR #327). This test forces the wall-clock guard to trip after
  // partial progress, proving the pass actually calls + honors it rather
  // than only relying on the (unrelated) consecutive-failure counter.
  it("bails via the wall-clock pass-deadline guard even when every batch is succeeding", async () => {
    const population: NewbornVelocityAppRow[] = Array.from({ length: 10 }, (_, i) => ({
      appId: `app-${i}`,
      releaseDate: THIRTY_DAYS_AGO_ISO,
    }));
    mock.module("./app-velocity-store", () => appVelocityStoreMockBase(population));

    let budgetChecks = 0;
    mock.module("../shared/pass-deadline", () => ({
      // Allow the first 3 batches through, then report over-budget — proves
      // the loop consults `isPassOverBudget` on every iteration and bails
      // the moment it trips, not just on a failure-count heuristic.
      isPassOverBudget: () => {
        budgetChecks++;
        return budgetChecks > 3;
      },
    }));

    const { runNewbornReobservationPass } = await import("./newborn-reobservation");
    // batchSize 1 -> 10 batches total; every fetch succeeds (no rate limits),
    // so ONLY the wall-clock guard can produce a bail here.
    const result = await runNewbornReobservationPass({ batchSize: 1, maxAgeDays: 540, delayMs: 0 });

    expect(result.bailed).toBe(true);
    expect(result.attempted).toBe(3); // 3 batches ran before the 4th check tripped the guard
    expect(result.rateLimitErrors).toBe(0);
    expect(budgetChecks).toBe(4);
  });
});
