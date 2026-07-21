import { describe, expect, it, mock, beforeEach } from "bun:test";
// Real (unmocked) import, resolved at file-load time BEFORE any
// `mock.module` call runs — re-exported from every `../shared/ssrf-safe-fetch`
// mock below so `app-enrichment.ts`'s own `import { RateLimitError } from
// "../shared/ssrf-safe-fetch"` always finds a real named export. Mirrors
// keyword-gaps.isolated.test.ts / keyword-autocomplete.isolated.test.ts.
import { RateLimitError } from "../shared/ssrf-safe-fetch";
import type { AppMeta, AppMetaSource } from "./app-meta-types";

// NOTE ON SCOPE (deviates from the build plan's literal "mock
// `../shared/ssrf-safe-fetch` only"): `runEnrichmentPass`/`runPortfolioPass`
// call `selectDueForEnrichment`/`getDevelopersDueForPortfolioScan`, which
// sweep the ENTIRE (shared, live) `appstore_app_meta`/`appstore_developers`
// tables with no test-id scoping. Running this pass for real against that
// live registry — with a fetch mock that only recognizes a handful of test
// ids — would mark every OTHER (real, production) due row a "miss" and
// delist it after `delistMissThreshold`. That is a real risk of corrupting
// shared production data, so this file additionally mocks `./app-meta-store`,
// `./app-velocity-store`, and `./developer-store` (the same pattern every
// other isolated test in this source already uses for ITS store deps —
// see keyword-gaps.isolated.test.ts's `keywordStoreMockBase`), giving full,
// safe control over which ids the pass ever sees.

function appMeta(overrides: Partial<AppMeta> = {}): AppMeta {
  return {
    id: "1000001",
    name: "Found App",
    firstSeenAt: 1_700_000_000,
    firstSeenSource: "serp" as AppMetaSource,
    firstSeenStorefront: "us",
    firstSeenKeyword: "budget",
    lastSeenAt: 1_700_000_000,
    enrichedAt: null,
    releaseDate: null,
    currentVersionReleaseDate: null,
    version: null,
    genreId: null,
    genreName: null,
    price: null,
    formattedPrice: null,
    ratingCount: null,
    averageRating: null,
    artistId: null,
    artistName: null,
    bundleId: null,
    trackViewUrl: null,
    artworkUrl: null,
    missCount: 0,
    delistedAt: null,
    relistedAt: null,
    updatedAt: 1_700_000_000,
    ...overrides,
  };
}

// A fixed 30-days-ago ISO date, computed at file-load time rather than
// hardcoded — keeps every fixture "newborn" (well under
// `app-velocity.ts`'s `NEWBORN_AGE_DAYS_MAX` = 540) regardless of when the
// suite actually runs.
const THIRTY_DAYS_AGO_ISO = new Date(Date.now() - 30 * 86_400_000).toISOString();

function lookupResultJson(id: string, overrides: Record<string, unknown> = {}) {
  return {
    wrapperType: "software",
    trackId: Number(id),
    trackName: "Found App",
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
    bundleId: "com.acme.found",
    trackViewUrl: "https://apps.apple.com/app/id" + id,
    artworkUrl100: "https://example.com/icon.png",
    ...overrides,
  };
}

/** Every `./app-meta-store` export `app-enrichment.ts` imports, with inert defaults. */
function appMetaStoreMockBase() {
  return {
    backfillRegistry: async () => 0,
    claimForEnrichment: async () => {},
    countLookupRequestsSince: async () => 0,
    getAppMetaBatch: async () => new Map<string, AppMeta>(),
    pruneLookupRequestLedger: async () => 0,
    recordAppSightings: async () => 0,
    recordEnrichmentMiss: async () => ({ delisted: false }),
    recordLookupRequest: async () => {},
    selectDueForEnrichment: async () => [],
    upsertLookupResult: async () => [],
  };
}

/** Every `./app-velocity-store` export `app-enrichment.ts` imports. */
function appVelocityStoreMockBase() {
  return {
    getTopAcceleratingNewborns: async () => [],
    insertObservation: async () => true,
  };
}

/** Every `./developer-store` export `app-enrichment.ts` imports. */
function developerStoreMockBase() {
  return {
    getDevelopersDueForPortfolioScan: async () => [],
    markPortfolioScanned: async () => {},
    upsertDeveloper: async () => {},
  };
}

describe("runEnrichmentPass", () => {
  let fetchedUrls: string[];
  let upsertCalls: Array<{ appId: string; result: unknown; previous: unknown }>;
  let missCalls: Array<{ appId: string; previous: unknown }>;
  let insertObservationCalls: Array<{ appId: string; keyword: string; rank: number | null }>;
  let ledgerCalls: Array<{ requestType: string; idCount: number; success: boolean }>;

  beforeEach(() => {
    fetchedUrls = [];
    upsertCalls = [];
    missCalls = [];
    insertObservationCalls = [];
    ledgerCalls = [];

    mock.module("../shared/ssrf-safe-fetch", () => ({
      RateLimitError,
      ssrfSafeFetch: async (url: string) => {
        fetchedUrls.push(url);
        return {
          ok: true,
          json: async () => ({ results: [lookupResultJson("1000001")] }),
        };
      },
    }));

    mock.module("./app-meta-store", () => ({
      ...appMetaStoreMockBase(),
      countLookupRequestsSince: async () => 0,
      getAppMetaBatch: async (ids: readonly string[]) => {
        const map = new Map<string, AppMeta>();
        for (const id of ids) {
          if (id === "1000001") map.set(id, appMeta({ id }));
          if (id === "1000002") map.set(id, appMeta({ id, missCount: 0 }));
        }
        return map;
      },
      selectDueForEnrichment: async () => ["1000001", "1000002"],
      upsertLookupResult: async (appId: string, result: unknown, _now: number, previous: unknown) => {
        upsertCalls.push({ appId, result, previous });
        return [];
      },
      recordEnrichmentMiss: async (appId: string, _now: number, previous: unknown) => {
        missCalls.push({ appId, previous });
        return { delisted: true };
      },
      recordLookupRequest: async (requestType: "lookup" | "portfolio", idCount: number, success: boolean) => {
        ledgerCalls.push({ requestType, idCount, success });
      },
    }));

    mock.module("./app-velocity-store", () => ({
      ...appVelocityStoreMockBase(),
      insertObservation: async (input: { appId: string; keyword: string; rank: number | null }) => {
        insertObservationCalls.push(input);
        return true;
      },
    }));

    mock.module("./developer-store", () => developerStoreMockBase());
  });

  it("enriches ids found in the lookup response and records misses for absent ones", async () => {
    const { runEnrichmentPass } = await import("./app-enrichment");
    const result = await runEnrichmentPass({
      batchSize: 200,
      maxBatches: 4,
      staleAfterSeconds: 86_400,
      acceleratingLimit: 50,
      dailyRequestBudget: 1200,
      delistMissThreshold: 1,
    });

    expect(result.skipped).toBe(false);
    expect(result.enrichedCount).toBe(1);
    expect(result.missCount).toBe(1);
    expect(result.delistedCount).toBe(1);
    expect(result.attempted).toBe(1); // one batch (both ids fit in one batch)

    expect(upsertCalls.map((c) => c.appId)).toEqual(["1000001"]);
    expect(missCalls.map((c) => c.appId)).toEqual(["1000002"]);
    expect(ledgerCalls).toEqual([{ requestType: "lookup", idCount: 2, success: true }]);
    expect(fetchedUrls[0]).toContain("1000001");
    expect(fetchedUrls[0]).toContain("1000002");
  });

  it("fires the chart-newborn velocity hook for a chart-sourced, newborn app", async () => {
    mock.module("./app-meta-store", () => ({
      ...appMetaStoreMockBase(),
      getAppMetaBatch: async () =>
        new Map([["1000001", appMeta({ id: "1000001", firstSeenSource: "chart" })]]),
      selectDueForEnrichment: async () => ["1000001"],
      upsertLookupResult: async () => [],
      recordLookupRequest: async () => {},
    }));

    const { runEnrichmentPass, CHART_FIRST_SEEN_KEYWORD } = await import("./app-enrichment");
    const result = await runEnrichmentPass({
      batchSize: 200,
      maxBatches: 4,
      staleAfterSeconds: 86_400,
      acceleratingLimit: 50,
      dailyRequestBudget: 1200,
      delistMissThreshold: 1,
    });

    expect(result.chartNewbornVelocityCount).toBe(1);
    expect(insertObservationCalls.length).toBe(1);
    expect(insertObservationCalls[0]).toMatchObject({
      appId: "1000001",
      keyword: CHART_FIRST_SEEN_KEYWORD,
      rank: null,
    });
  });

  it("does NOT fire the chart-newborn hook for a serp-sourced app", async () => {
    mock.module("./app-meta-store", () => ({
      ...appMetaStoreMockBase(),
      getAppMetaBatch: async () =>
        new Map([["1000001", appMeta({ id: "1000001", firstSeenSource: "serp" })]]),
      selectDueForEnrichment: async () => ["1000001"],
      upsertLookupResult: async () => [],
      recordLookupRequest: async () => {},
    }));

    const { runEnrichmentPass } = await import("./app-enrichment");
    await runEnrichmentPass({
      batchSize: 200,
      maxBatches: 4,
      staleAfterSeconds: 86_400,
      acceleratingLimit: 50,
      dailyRequestBudget: 1200,
      delistMissThreshold: 1,
    });

    expect(insertObservationCalls).toEqual([]);
  });

  it("skips the whole pass when the rolling-24h request budget is already reached", async () => {
    mock.module("./app-meta-store", () => ({
      ...appMetaStoreMockBase(),
      countLookupRequestsSince: async () => 1200,
      selectDueForEnrichment: async () => {
        throw new Error("selectDueForEnrichment must not be called when the budget is exhausted");
      },
    }));

    const { runEnrichmentPass } = await import("./app-enrichment");
    const result = await runEnrichmentPass({
      batchSize: 200,
      maxBatches: 4,
      staleAfterSeconds: 86_400,
      acceleratingLimit: 50,
      dailyRequestBudget: 1200,
      delistMissThreshold: 1,
    });

    expect(result.skipped).toBe(true);
    expect(fetchedUrls).toEqual([]);
  });

  it("skips (returns skipped) when maxBatches is 0, without touching the DB", async () => {
    mock.module("./app-meta-store", () => ({
      ...appMetaStoreMockBase(),
      countLookupRequestsSince: async () => {
        throw new Error("must not be called when maxBatches is 0");
      },
    }));

    const { runEnrichmentPass } = await import("./app-enrichment");
    const result = await runEnrichmentPass({
      batchSize: 200,
      maxBatches: 0,
      staleAfterSeconds: 86_400,
      acceleratingLimit: 50,
      dailyRequestBudget: 1200,
      delistMissThreshold: 1,
    });

    expect(result).toEqual({
      enrichedCount: 0,
      missCount: 0,
      delistedCount: 0,
      relistedCount: 0,
      chartNewbornVelocityCount: 0,
      attempted: 0,
      rateLimitErrors: 0,
      bailed: false,
      skipped: true,
    });
  });

  it("bails after 5 consecutive rate-limited batch failures, counting each as a rate-limit error", async () => {
    // 6 batches of 1 id each (batchSize 1) — every fetch throws RateLimitError.
    const dueIds = Array.from({ length: 6 }, (_, i) => `app-${i}`);
    mock.module("../shared/ssrf-safe-fetch", () => ({
      RateLimitError,
      ssrfSafeFetch: async (url: string) => {
        fetchedUrls.push(url);
        throw new RateLimitError("rate limited", 429, undefined);
      },
    }));
    mock.module("./app-meta-store", () => ({
      ...appMetaStoreMockBase(),
      getAppMetaBatch: async (ids: readonly string[]) => {
        const map = new Map<string, AppMeta>();
        for (const id of ids) map.set(id, appMeta({ id }));
        return map;
      },
      selectDueForEnrichment: async () => dueIds,
      recordLookupRequest: async (requestType: "lookup" | "portfolio", idCount: number, success: boolean) => {
        ledgerCalls.push({ requestType, idCount, success });
      },
    }));

    const { runEnrichmentPass } = await import("./app-enrichment");
    const result = await runEnrichmentPass({
      batchSize: 1,
      maxBatches: 6,
      staleAfterSeconds: 86_400,
      acceleratingLimit: 50,
      dailyRequestBudget: 1200,
      delistMissThreshold: 1,
    });

    expect(result.bailed).toBe(true);
    expect(result.attempted).toBe(5); // bails exactly at the 5th consecutive failure
    expect(result.rateLimitErrors).toBe(5);
    expect(ledgerCalls.every((c) => c.success === false)).toBe(true);
  });

  it("passes acceleratingLimit through to getTopAcceleratingNewborns", async () => {
    let capturedLimit: number | undefined;
    mock.module("./app-velocity-store", () => ({
      ...appVelocityStoreMockBase(),
      getTopAcceleratingNewborns: async (opts: { limit: number }) => {
        capturedLimit = opts.limit;
        return [];
      },
    }));
    mock.module("./app-meta-store", () => ({
      ...appMetaStoreMockBase(),
      selectDueForEnrichment: async () => [],
    }));

    const { runEnrichmentPass } = await import("./app-enrichment");
    await runEnrichmentPass({
      batchSize: 200,
      maxBatches: 4,
      staleAfterSeconds: 86_400,
      acceleratingLimit: 37,
      dailyRequestBudget: 1200,
      delistMissThreshold: 1,
    });

    expect(capturedLimit).toBe(37);
  });
});

describe("runPortfolioPass", () => {
  beforeEach(() => {
    mock.module("../shared/ssrf-safe-fetch", () => ({
      RateLimitError,
      ssrfSafeFetch: async () => ({
        ok: true,
        json: async () => ({
          results: [lookupResultJson("2000001"), lookupResultJson("2000002")],
        }),
      }),
    }));
    mock.module("./app-meta-store", () => appMetaStoreMockBase());
    mock.module("./app-velocity-store", () => appVelocityStoreMockBase());
  });

  it("records sightings for every app in a due developer's portfolio and marks them scanned", async () => {
    const recordedSightings: Array<{ rows: unknown; source: string }> = [];
    const scannedCalls: Array<{ artistId: string; appCount: number }> = [];

    mock.module("./app-meta-store", () => ({
      ...appMetaStoreMockBase(),
      recordAppSightings: async (rows: unknown, source: string) => {
        recordedSightings.push({ rows, source });
        return (rows as unknown[]).length;
      },
    }));
    mock.module("./developer-store", () => ({
      ...developerStoreMockBase(),
      getDevelopersDueForPortfolioScan: async () => ["artist-1"],
      markPortfolioScanned: async (artistId: string, appCount: number) => {
        scannedCalls.push({ artistId, appCount });
      },
    }));

    const { runPortfolioPass } = await import("./app-enrichment");
    const result = await runPortfolioPass({
      developerLimit: 5,
      portfolioLimit: 200,
      minIntervalSeconds: 86_400,
    });

    expect(result.developersScanned).toBe(1);
    expect(result.newSightings).toBe(2);
    expect(recordedSightings[0]?.source).toBe("portfolio");
    expect(scannedCalls).toEqual([{ artistId: "artist-1", appCount: 2 }]);
  });

  it("returns the empty result immediately when developerLimit is 0", async () => {
    mock.module("./developer-store", () => ({
      ...developerStoreMockBase(),
      getDevelopersDueForPortfolioScan: async () => {
        throw new Error("must not be called when developerLimit is 0");
      },
    }));

    const { runPortfolioPass } = await import("./app-enrichment");
    const result = await runPortfolioPass({ developerLimit: 0, portfolioLimit: 200, minIntervalSeconds: 0 });
    expect(result).toEqual({
      developersScanned: 0,
      newSightings: 0,
      attempted: 0,
      rateLimitErrors: 0,
      bailed: false,
    });
  });
});
