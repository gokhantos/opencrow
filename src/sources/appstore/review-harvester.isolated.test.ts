import { describe, expect, it, mock, beforeEach } from "bun:test";
// Real (unmocked) import, resolved at file-load time BEFORE any
// `mock.module` call runs — re-exported from the `../shared/ssrf-safe-fetch`
// mock below so `review-harvester.ts`'s own `import { RateLimitError } from
// "../shared/ssrf-safe-fetch"` always finds a real named export. Mirrors
// app-enrichment.isolated.test.ts / charts-intl.isolated.test.ts.
import { RateLimitError } from "../shared/ssrf-safe-fetch";
import { REVIEW_PAGE_SIZE } from "./review-rss";
import type { ReviewHarvestEnrollment } from "./review-harvest-store";
import type { AppReviewRow } from "./store";

// NOTE ON SCOPE (same deviation as app-enrichment.isolated.test.ts's own
// note, build plan §0.4's literal "mock `../shared/ssrf-safe-fetch` only"):
// `harvestDueApps`/`runCohortRefresh` also call `./app-meta-store` and
// `./review-harvest-store` — both real DB reads/writes against the SHARED
// local Postgres, with candidate/due-selection queries that sweep the
// entire live tables. Mocking those (plus `./store`'s `upsertReviews`,
// which would otherwise write live review rows) keeps this suite fully
// isolated with no live-DB side effects. `./review-rss` and
// `./review-harvest-scheduling` are left UNMOCKED — both are pure logic
// this suite wants exercised for real.

function enrollment(overrides: Partial<ReviewHarvestEnrollment> = {}): ReviewHarvestEnrollment {
  return {
    appId: "1000001",
    enrolledAt: 1_700_000_000,
    enrolledVia: "velocity",
    cohort: "daily",
    active: true,
    firstHarvestDone: false,
    lastHarvestedAt: null,
    lastPageReached: null,
    consecutiveEmptyHarvests: 0,
    deactivatedAt: null,
    updatedAt: 1_700_000_000,
    ...overrides,
  };
}

/** One synthetic RSS review `entry` — real-shape fields (see review-rss.test.ts). */
function fixtureEntry(id: string): Record<string, unknown> {
  return {
    author: { name: { label: "Someone" } },
    updated: { label: "2026-07-19T21:15:58-07:00" },
    "im:rating": { label: "4" },
    "im:version": { label: "1.0" },
    id: { label: id },
    title: { label: "Fine" },
    content: { label: "It's fine." },
    "im:voteSum": { label: "0" },
    "im:voteCount": { label: "0" },
  };
}

/** A feed page with exactly `count` synthetic entries, ids `${idPrefix}-0`.. */
function feedPage(count: number, idPrefix: string): { feed: { entry: Record<string, unknown>[] } } {
  return { feed: { entry: Array.from({ length: count }, (_, i) => fixtureEntry(`${idPrefix}-${i}`)) } };
}

/** Extracts the `page=N` segment from a review-feed URL (see `review-rss.ts`'s `buildReviewFeedUrl`). */
function pageFromUrl(url: string): number {
  const match = url.match(/\/page=(\d+)\//);
  return match?.[1] ? Number(match[1]) : 1;
}

function reviewHarvestStoreMockBase() {
  return {
    countReviewPagesFetchedSince: async () => 0,
    deactivateEnrollment: async () => {},
    getChartNewbornCandidates: async () => [] as readonly string[],
    getDueEnrollments: async () => [] as readonly ReviewHarvestEnrollment[],
    getSignatureHitCandidates: async () => [] as readonly string[],
    getVelocityCandidates: async () => [] as readonly string[],
    pruneReviewHarvestLedger: async () => 0,
    recordHarvestOutcome: async () => ({ consecutiveEmptyHarvests: 0 }),
    upsertEnrollment: async () => ({ isNew: true }),
  };
}

// Full export surface of `./app-meta-store` (not just the `getAppMeta` this
// file's code under test actually calls) — `mock.module` replaces the WHOLE
// module for the rest of the process, and other isolated test files
// (`app-enrichment.isolated.test.ts`, `charts-intl.isolated.test.ts`)
// dynamically re-`import()` modules that themselves import OTHER exports of
// `./app-meta-store` (e.g. `upsertLookupResult`, `selectDueForEnrichment`).
// A partial mock here would leave those `undefined` if this mock's module
// identity is still active when such a re-import resolves — the exact
// "isolated lane mock leak" gotcha the other isolated test files' own
// `appMetaStoreMockBase()` helpers already guard against by providing every
// export as an inert no-op, mirrored here.
function appMetaStoreMockBase() {
  return {
    backfillRegistry: async () => 0,
    claimForEnrichment: async () => {},
    countLookupRequestsSince: async () => 0,
    getAppMeta: async () => null,
    getAppMetaBatch: async () => new Map(),
    pruneLookupRequestLedger: async () => 0,
    recordAppSightings: async () => 0,
    recordEnrichmentMiss: async () => ({ delisted: false }),
    recordLookupRequest: async () => {},
    selectDueForEnrichment: async () => [],
    upsertLookupResult: async () => [],
  };
}

// Full export surface of `./store` — same "isolated lane mock leak"
// rationale as `appMetaStoreMockBase` above: `charts-intl.isolated.test.ts`
// also mocks `./store` (for `upsertRankings`), and this file's own dynamic
// `import("./review-harvester")` calls resolve through whatever `./store`
// mock is currently active process-wide.
function storeMockBase() {
  return {
    upsertApps: async () => 0,
    insertRankingHistory: async () => 0,
    upsertRankings: async () => 0,
    upsertReviews: async (rows: readonly AppReviewRow[]) => ({
      upserted: rows.length,
      newIds: rows.map((r) => r.id),
    }),
    getRankings: async () => [],
    getDiscoveredApps: async () => [],
    getRankingsByCategory: async () => [],
    getLowRatedReviews: async () => [],
    getUnindexedReviews: async () => [],
    markReviewsIndexed: async () => {},
    getUnindexedRankings: async () => [],
    getDiscoveredAppIds: async () => new Set<string>(),
    markRankingsIndexed: async () => {},
  };
}

describe("harvestDueApps", () => {
  let fetchedUrls: string[];
  let recordOutcomeCalls: Array<{ appId: string; pagesFetched: number; reviewsFound: number; newReviews: number }>;
  let deactivateCalls: string[];
  let upsertReviewsCalls: Array<readonly AppReviewRow[]>;

  beforeEach(() => {
    fetchedUrls = [];
    recordOutcomeCalls = [];
    deactivateCalls = [];
    upsertReviewsCalls = [];

    mock.module("../shared/ssrf-safe-fetch", () => ({
      RateLimitError,
      ssrfSafeFetch: async (url: string) => {
        fetchedUrls.push(url);
        // Page 1 full (50), page 2 short (10) — natural end after 2 pages.
        const page = pageFromUrl(url);
        const count = page === 1 ? REVIEW_PAGE_SIZE : 10;
        return { ok: true, status: 200, json: async () => feedPage(count, `p${page}`) };
      },
    }));

    mock.module("./app-meta-store", () => appMetaStoreMockBase());

    mock.module("./review-harvest-store", () => ({
      ...reviewHarvestStoreMockBase(),
      getDueEnrollments: async () => [enrollment()],
      recordHarvestOutcome: async (input: { appId: string; pagesFetched: number; reviewsFound: number; newReviews: number }) => {
        recordOutcomeCalls.push(input);
        return { consecutiveEmptyHarvests: 0 };
      },
      deactivateEnrollment: async (appId: string) => {
        deactivateCalls.push(appId);
      },
    }));

    mock.module("./store", () => ({
      ...storeMockBase(),
      upsertReviews: async (rows: readonly AppReviewRow[]) => {
        upsertReviewsCalls.push(rows);
        return { upserted: rows.length, newIds: rows.map((r) => r.id) };
      },
    }));
  });

  it("returns the skipped result immediately when appsPerTick is 0, without touching the DB", async () => {
    mock.module("./review-harvest-store", () => ({
      ...reviewHarvestStoreMockBase(),
      countReviewPagesFetchedSince: async () => {
        throw new Error("must not be called when appsPerTick is 0");
      },
    }));

    const { harvestDueApps } = await import("./review-harvester");
    const result = await harvestDueApps({
      appsPerTick: 0,
      storefront: "us",
      pageDelayMs: 0,
      dailyRequestBudget: 10_000,
      maxConsecutiveEmptyHarvests: 5,
      memoryIndexing: "all",
    });

    expect(result).toEqual({
      appsHarvested: 0,
      pagesFetched: 0,
      reviewsFound: 0,
      newReviews: 0,
      deactivated: 0,
      attempted: 0,
      rateLimitErrors: 0,
      bailed: false,
      skipped: true,
    });
  });

  it("skips the whole pass when the rolling-24h page-fetch budget is already reached", async () => {
    mock.module("./review-harvest-store", () => ({
      ...reviewHarvestStoreMockBase(),
      countReviewPagesFetchedSince: async () => 10_000,
      getDueEnrollments: async () => {
        throw new Error("must not be called when the budget is exhausted");
      },
    }));

    const { harvestDueApps } = await import("./review-harvester");
    const result = await harvestDueApps({
      appsPerTick: 3,
      storefront: "us",
      pageDelayMs: 0,
      dailyRequestBudget: 10_000,
      maxConsecutiveEmptyHarvests: 5,
      memoryIndexing: "all",
    });

    expect(result.skipped).toBe(true);
    expect(fetchedUrls).toEqual([]);
  });

  it("pages until a short page naturally ends the app's harvest", async () => {
    const { harvestDueApps } = await import("./review-harvester");
    const result = await harvestDueApps({
      appsPerTick: 3,
      storefront: "us",
      pageDelayMs: 0,
      dailyRequestBudget: 10_000,
      maxConsecutiveEmptyHarvests: 5,
      memoryIndexing: "all",
    });

    expect(result.skipped).toBe(false);
    expect(result.appsHarvested).toBe(1);
    expect(result.pagesFetched).toBe(2); // page 1 (50) + page 2 (10, short -> stop)
    expect(result.reviewsFound).toBe(60);
    expect(fetchedUrls).toHaveLength(2);
    expect(recordOutcomeCalls).toHaveLength(1);
    expect(recordOutcomeCalls[0]).toMatchObject({ appId: "1000001", pagesFetched: 2, reviewsFound: 60, newReviews: 60 });
  });

  it("first-harvest legacy-remnant rule: keeps paging even though page 1 is fully known", async () => {
    mock.module("./review-harvest-store", () => ({
      ...reviewHarvestStoreMockBase(),
      getDueEnrollments: async () => [enrollment({ firstHarvestDone: false })],
      recordHarvestOutcome: async (input: { appId: string; pagesFetched: number }) => {
        recordOutcomeCalls.push(input as (typeof recordOutcomeCalls)[number]);
        return { consecutiveEmptyHarvests: 0 };
      },
    }));
    // Every page's reviews are already known (upsertReviews reports no new ids).
    mock.module("./store", () => ({
      ...storeMockBase(),
      upsertReviews: async (rows: readonly AppReviewRow[]) => {
        upsertReviewsCalls.push(rows);
        return { upserted: rows.length, newIds: [] };
      },
    }));

    const { harvestDueApps } = await import("./review-harvester");
    const result = await harvestDueApps({
      appsPerTick: 1,
      storefront: "us",
      pageDelayMs: 0,
      dailyRequestBudget: 10_000,
      maxConsecutiveEmptyHarvests: 5,
      memoryIndexing: "all",
    });

    // Page 1 (50, fully known) does NOT stop the pass on a first harvest;
    // page 2 (10, short) is what naturally ends it.
    expect(result.pagesFetched).toBe(2);
    expect(fetchedUrls).toHaveLength(2);
  });

  it("a LATER harvest DOES early-stop on a fully-known page", async () => {
    mock.module("./review-harvest-store", () => ({
      ...reviewHarvestStoreMockBase(),
      getDueEnrollments: async () => [enrollment({ firstHarvestDone: true })],
      recordHarvestOutcome: async (input: { appId: string; pagesFetched: number }) => {
        recordOutcomeCalls.push(input as (typeof recordOutcomeCalls)[number]);
        return { consecutiveEmptyHarvests: 0 };
      },
    }));
    mock.module("./store", () => ({
      ...storeMockBase(),
      upsertReviews: async (rows: readonly AppReviewRow[]) => {
        upsertReviewsCalls.push(rows);
        return { upserted: rows.length, newIds: [] };
      },
    }));

    const { harvestDueApps } = await import("./review-harvester");
    const result = await harvestDueApps({
      appsPerTick: 1,
      storefront: "us",
      pageDelayMs: 0,
      dailyRequestBudget: 10_000,
      maxConsecutiveEmptyHarvests: 5,
      memoryIndexing: "all",
    });

    // Page 1 is full (50) AND fully known -> stops immediately on a
    // non-first harvest; page 2 is never fetched.
    expect(result.pagesFetched).toBe(1);
    expect(fetchedUrls).toHaveLength(1);
  });

  it("deactivates an enrollment once shouldDeactivateEnrollment fires (empty-streak threshold reached)", async () => {
    mock.module("./review-harvest-store", () => ({
      ...reviewHarvestStoreMockBase(),
      getDueEnrollments: async () => [enrollment()],
      recordHarvestOutcome: async () => ({ consecutiveEmptyHarvests: 5 }),
      deactivateEnrollment: async (appId: string) => {
        deactivateCalls.push(appId);
      },
    }));

    const { harvestDueApps } = await import("./review-harvester");
    const result = await harvestDueApps({
      appsPerTick: 1,
      storefront: "us",
      pageDelayMs: 0,
      dailyRequestBudget: 10_000,
      maxConsecutiveEmptyHarvests: 5,
      memoryIndexing: "all",
    });

    expect(result.deactivated).toBe(1);
    expect(deactivateCalls).toEqual(["1000001"]);
  });

  it("does not deactivate when the empty-streak is under the threshold", async () => {
    mock.module("./review-harvest-store", () => ({
      ...reviewHarvestStoreMockBase(),
      getDueEnrollments: async () => [enrollment()],
      recordHarvestOutcome: async () => ({ consecutiveEmptyHarvests: 4 }),
      deactivateEnrollment: async (appId: string) => {
        deactivateCalls.push(appId);
      },
    }));

    const { harvestDueApps } = await import("./review-harvester");
    const result = await harvestDueApps({
      appsPerTick: 1,
      storefront: "us",
      pageDelayMs: 0,
      dailyRequestBudget: 10_000,
      maxConsecutiveEmptyHarvests: 5,
      memoryIndexing: "all",
    });

    expect(result.deactivated).toBe(0);
    expect(deactivateCalls).toEqual([]);
  });

  it("bails after 5 consecutive first-page fetch failures", async () => {
    const dueApps = Array.from({ length: 6 }, (_, i) => enrollment({ appId: `app-${i}` }));
    mock.module("../shared/ssrf-safe-fetch", () => ({
      RateLimitError,
      ssrfSafeFetch: async (url: string) => {
        fetchedUrls.push(url);
        throw new RateLimitError("rate limited", 429, undefined);
      },
    }));
    mock.module("./review-harvest-store", () => ({
      ...reviewHarvestStoreMockBase(),
      getDueEnrollments: async () => dueApps,
    }));

    const { harvestDueApps } = await import("./review-harvester");
    const result = await harvestDueApps({
      appsPerTick: 6,
      storefront: "us",
      pageDelayMs: 0,
      dailyRequestBudget: 10_000,
      maxConsecutiveEmptyHarvests: 5,
      memoryIndexing: "all",
    });

    expect(result.bailed).toBe(true);
    expect(result.attempted).toBe(5);
    expect(result.appsHarvested).toBe(0);
    expect(result.rateLimitErrors).toBe(5);
  });

  it("treats a mid-pagination failure (page 2+) as a graceful partial success, not a bail-worthy failure", async () => {
    mock.module("../shared/ssrf-safe-fetch", () => ({
      RateLimitError,
      ssrfSafeFetch: async (url: string) => {
        fetchedUrls.push(url);
        const page = pageFromUrl(url);
        if (page === 1) return { ok: true, status: 200, json: async () => feedPage(REVIEW_PAGE_SIZE, "p1") };
        throw new Error("upstream 500 on page 2");
      },
    }));

    const { harvestDueApps } = await import("./review-harvester");
    const result = await harvestDueApps({
      appsPerTick: 1,
      storefront: "us",
      pageDelayMs: 0,
      dailyRequestBudget: 10_000,
      maxConsecutiveEmptyHarvests: 5,
      memoryIndexing: "all",
    });

    expect(result.bailed).toBe(false);
    expect(result.appsHarvested).toBe(1);
    expect(result.pagesFetched).toBe(1); // only page 1 succeeded
    expect(recordOutcomeCalls).toHaveLength(1);
    expect(recordOutcomeCalls[0]).toMatchObject({ appId: "1000001", pagesFetched: 1, reviewsFound: 50, newReviews: 50 });
  });

  it("treats a non-ok HTTP response on the first page as a full item failure", async () => {
    mock.module("../shared/ssrf-safe-fetch", () => ({
      RateLimitError,
      ssrfSafeFetch: async (url: string) => {
        fetchedUrls.push(url);
        return { ok: false, status: 500, json: async () => ({}) };
      },
    }));

    const { harvestDueApps } = await import("./review-harvester");
    const result = await harvestDueApps({
      appsPerTick: 1,
      storefront: "us",
      pageDelayMs: 0,
      dailyRequestBudget: 10_000,
      maxConsecutiveEmptyHarvests: 5,
      memoryIndexing: "all",
    });

    expect(result.appsHarvested).toBe(0);
    expect(result.attempted).toBe(1);
    expect(recordOutcomeCalls).toEqual([]);
  });

  it("logs and swallows a getAppMeta throw before pagination without failing the app", async () => {
    mock.module("./app-meta-store", () => ({
      getAppMeta: async () => {
        throw new Error("registry lookup exploded");
      },
    }));

    const { harvestDueApps } = await import("./review-harvester");
    const result = await harvestDueApps({
      appsPerTick: 1,
      storefront: "us",
      pageDelayMs: 0,
      dailyRequestBudget: 10_000,
      maxConsecutiveEmptyHarvests: 5,
      memoryIndexing: "all",
    });

    // `getAppMeta` is called via `.catch(() => null)` at both call sites in
    // `harvestDueApps` — a throw there degrades to app_name "" / not-delisted
    // rather than failing the whole app.
    expect(result.appsHarvested).toBe(1);
    expect(result.pagesFetched).toBe(2);
  });

  it("logs and swallows a recordHarvestOutcome throw without crashing the pass", async () => {
    mock.module("./review-harvest-store", () => ({
      ...reviewHarvestStoreMockBase(),
      getDueEnrollments: async () => [enrollment()],
      recordHarvestOutcome: async () => {
        throw new Error("outcome write exploded");
      },
    }));

    const { harvestDueApps } = await import("./review-harvester");
    const result = await harvestDueApps({
      appsPerTick: 1,
      storefront: "us",
      pageDelayMs: 0,
      dailyRequestBudget: 10_000,
      maxConsecutiveEmptyHarvests: 5,
      memoryIndexing: "all",
    });

    // Pages were still fetched/counted — only the outcome-recording write
    // failed, and that failure is logged-and-swallowed per-app.
    expect(result.appsHarvested).toBe(1);
    expect(result.deactivated).toBe(0);
  });

  it("threads the storefront through to the fetched URL", async () => {
    const { harvestDueApps } = await import("./review-harvester");
    await harvestDueApps({
      appsPerTick: 1,
      storefront: "gb",
      pageDelayMs: 0,
      dailyRequestBudget: 10_000,
      maxConsecutiveEmptyHarvests: 5,
      memoryIndexing: "all",
    });

    expect(fetchedUrls.every((u) => u.includes("/gb/rss/"))).toBe(true);
  });

  it("'low-star-only' memoryIndexing policy pre-marks high-star rows indexed before upsert", async () => {
    mock.module("../shared/ssrf-safe-fetch", () => ({
      RateLimitError,
      ssrfSafeFetch: async (url: string) => {
        fetchedUrls.push(url);
        return { ok: true, status: 200, json: async () => feedPage(5, "p1") };
      },
    }));

    const { harvestDueApps } = await import("./review-harvester");
    await harvestDueApps({
      appsPerTick: 1,
      storefront: "us",
      pageDelayMs: 0,
      dailyRequestBudget: 10_000,
      maxConsecutiveEmptyHarvests: 5,
      memoryIndexing: "low-star-only",
    });

    // Every fixture entry is rating 4 -> every upserted row should have
    // indexed_at pre-stamped (not null) under the low-star-only policy.
    expect(upsertReviewsCalls).toHaveLength(1);
    const rows = upsertReviewsCalls[0] as readonly { indexed_at: number | null }[];
    expect(rows.every((r) => r.indexed_at !== null)).toBe(true);
  });
});

describe("runCohortRefresh", () => {
  let upsertCalls: Array<{ appId: string; enrolledVia: string; cohort: string }>;

  beforeEach(() => {
    upsertCalls = [];
    mock.module("./review-harvest-store", () => ({
      ...reviewHarvestStoreMockBase(),
      getSignatureHitCandidates: async () => ["app-hit"],
      getVelocityCandidates: async () => ["app-velocity", "app-both"],
      getChartNewbornCandidates: async () => ["app-newborn", "app-both"],
      upsertEnrollment: async (input: { appId: string; enrolledVia: string; cohort: string }) => {
        upsertCalls.push(input);
        return { isNew: true };
      },
    }));
  });

  it("resolves 'daily wins' for a candidate matched by both a daily and weekly reason", async () => {
    const { runCohortRefresh } = await import("./review-harvester");
    const result = await runCohortRefresh({ signatureHitCap: 100, velocityCap: 50, chartNewbornCap: 200 });

    expect(result.candidatesConsidered).toBe(4); // app-hit, app-velocity, app-both, app-newborn

    const both = upsertCalls.find((c) => c.appId === "app-both");
    expect(both?.cohort).toBe("daily");

    const newbornOnly = upsertCalls.find((c) => c.appId === "app-newborn");
    expect(newbornOnly?.cohort).toBe("weekly");
    expect(newbornOnly?.enrolledVia).toBe("chart-newborn");

    const hitOnly = upsertCalls.find((c) => c.appId === "app-hit");
    expect(hitOnly?.cohort).toBe("daily");
    expect(hitOnly?.enrolledVia).toBe("signature-hit");
  });

  it("returns the empty result without querying when every cap is <= 0", async () => {
    mock.module("./review-harvest-store", () => ({
      ...reviewHarvestStoreMockBase(),
      getSignatureHitCandidates: async () => {
        throw new Error("must not be called when every cap is 0");
      },
    }));

    const { runCohortRefresh } = await import("./review-harvester");
    const result = await runCohortRefresh({ signatureHitCap: 0, velocityCap: 0, chartNewbornCap: 0 });
    expect(result).toEqual({ candidatesConsidered: 0, enrolled: 0, refreshed: 0 });
  });

  it("swallows a single candidate source's failure and still processes the other two", async () => {
    mock.module("./review-harvest-store", () => ({
      ...reviewHarvestStoreMockBase(),
      getSignatureHitCandidates: async () => {
        throw new Error("signature-hit query exploded");
      },
      getVelocityCandidates: async () => ["app-velocity"],
      getChartNewbornCandidates: async () => [],
      upsertEnrollment: async (input: { appId: string; enrolledVia: string; cohort: string }) => {
        upsertCalls.push(input);
        return { isNew: true };
      },
    }));

    const { runCohortRefresh } = await import("./review-harvester");
    const result = await runCohortRefresh({ signatureHitCap: 100, velocityCap: 50, chartNewbornCap: 200 });
    expect(result.candidatesConsidered).toBe(1);
    expect(upsertCalls.map((c) => c.appId)).toEqual(["app-velocity"]);
  });

  it("counts isNew vs refreshed", async () => {
    mock.module("./review-harvest-store", () => ({
      ...reviewHarvestStoreMockBase(),
      getSignatureHitCandidates: async () => ["app-a", "app-b"],
      getVelocityCandidates: async () => [],
      getChartNewbornCandidates: async () => [],
      upsertEnrollment: async (input: { appId: string }) => ({ isNew: input.appId === "app-a" }),
    }));

    const { runCohortRefresh } = await import("./review-harvester");
    const result = await runCohortRefresh({ signatureHitCap: 100, velocityCap: 50, chartNewbornCap: 200 });
    expect(result.enrolled).toBe(1);
    expect(result.refreshed).toBe(1);
  });
});

describe("runReviewHarvestLedgerPrune", () => {
  it("delegates to review-harvest-store.ts's pruneReviewHarvestLedger with a computed cutoff", async () => {
    let capturedCutoff: number | undefined;
    mock.module("./review-harvest-store", () => ({
      ...reviewHarvestStoreMockBase(),
      pruneReviewHarvestLedger: async (cutoff: number) => {
        capturedCutoff = cutoff;
        return 3;
      },
    }));

    const { runReviewHarvestLedgerPrune } = await import("./review-harvester");
    const before = Math.floor(Date.now() / 1000);
    const result = await runReviewHarvestLedgerPrune(3600);
    const after = Math.floor(Date.now() / 1000);

    expect(result).toEqual({ pruned: 3 });
    expect(capturedCutoff).toBeGreaterThanOrEqual(before - 3600 - 1);
    expect(capturedCutoff).toBeLessThanOrEqual(after - 3600 + 1);
  });
});
