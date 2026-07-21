import { describe, expect, it, mock, beforeEach } from "bun:test";
// Real (unmocked) import, resolved at file-load time BEFORE any
// `mock.module` call runs — re-exported from the `../shared/ssrf-safe-fetch`
// mock below so `app-pages.ts`'s own `import { RateLimitError } from
// "../shared/ssrf-safe-fetch"` always finds a real named export. Mirrors
// review-harvester.isolated.test.ts / app-enrichment.isolated.test.ts.
import { RateLimitError } from "../shared/ssrf-safe-fetch";
import type { TrackedAppPage } from "./app-pages-store";

// Scope note (mirrors review-harvester.isolated.test.ts's own): build plan
// §0.4 says "mock `../shared/ssrf-safe-fetch` only", but `app-pages.ts` also
// calls `./app-pages-store` (real DB reads/writes against the shared local
// Postgres, sweeping the whole `appstore_app_pages` table for due-selection).
// Mocking that too keeps this suite fully isolated with no live-DB side
// effects. `./app-page-parse` is left UNMOCKED — it's pure logic this suite
// wants exercised for real (the fixture builder below feeds it real HTML).

/** Minimal synthetic `serialized-server-data` HTML fixture — real shape, ~1-2KB (not the 818KB real page). */
function fixtureHtml(opts: {
  readonly appId: string;
  readonly ratingCounts?: readonly [number, number, number, number, number];
  readonly ratingAverage?: number;
  readonly iap?: readonly { readonly name: string; readonly price: string }[];
  readonly similar?: readonly { readonly adamId: string; readonly title: string }[];
}): string {
  const shelfMapping: Record<string, unknown> = {};

  if (opts.ratingCounts) {
    shelfMapping.productRatings = {
      items: [
        {
          ratingAverage: opts.ratingAverage ?? 4.5,
          totalNumberOfRatings: opts.ratingCounts.reduce((s, c) => s + c, 0),
          ratingCounts: opts.ratingCounts,
        },
      ],
    };
  }

  if (opts.iap) {
    shelfMapping.information = {
      items: [
        {
          title: "In-App Purchases",
          items_V3: opts.iap.map((p) => ({ $kind: "textPair", leadingText: p.name, trailingText: p.price })),
        },
      ],
    };
  }

  if (opts.similar) {
    shelfMapping.similarItems = {
      items: opts.similar.map((s) => ({ $kind: "Lockup", adamId: s.adamId, title: s.title, bundleId: null })),
    };
  }

  const serverData = { data: [{ intent: { id: opts.appId }, data: { shelfMapping } }] };
  return `<!doctype html><html><body><script type="application/json" id="serialized-server-data">${JSON.stringify(serverData)}</script></body></html>`;
}

function trackedApp(overrides: Partial<TrackedAppPage> = {}): TrackedAppPage {
  return {
    appId: "1000001",
    tier: "hot",
    trackedSince: 1_700_000_000,
    lastFetchedAt: null,
    lastSuccessAt: null,
    lastStatus: null,
    consecutiveFailures: 0,
    goneAt: null,
    iapCount: null,
    relatedCount: null,
    updatedAt: 1_700_000_000,
    ...overrides,
  };
}

function appPagesStoreMockBase() {
  return {
    countPageFetchesSince: async () => 0,
    getDueAppPages: async () => [] as readonly TrackedAppPage[],
    getTrackedAppPage: async () => null,
    recordPageFailure: async () => {},
    recordPageGone: async () => {},
    recordPageSuccess: async () => {},
    syncTrackedAppPages: async () => ({ hotCandidates: 0, newlyTracked: 0, promoted: 0, demoted: 0, rollingAdded: 0 }),
    upsertRelatedApps: async () => {},
  };
}

const DEFAULT_OPTS = {
  pagesPerBatch: 3,
  storefront: "us",
  requestDelayMs: 0,
  dailyPageBudget: 3_000,
  hotIntervalSeconds: 86_400,
  rollingIntervalSeconds: 14 * 86_400,
  canaryMinBatchSize: 10,
  canaryParseFailureThreshold: 0.5,
};

describe("runAppPageFetchPass", () => {
  let fetchedUrls: string[];
  let fetchedHeaders: Array<Record<string, string> | undefined>;
  let fetchedOpts: Array<{ retryOnRateLimit?: boolean }>;
  let successCalls: Array<{ appId: string }>;
  let failureCalls: string[];
  let goneCalls: string[];

  beforeEach(() => {
    fetchedUrls = [];
    fetchedHeaders = [];
    fetchedOpts = [];
    successCalls = [];
    failureCalls = [];
    goneCalls = [];

    mock.module("../shared/ssrf-safe-fetch", () => ({
      RateLimitError,
      ssrfSafeFetch: async (url: string, opts: { headers?: Record<string, string>; retryOnRateLimit?: boolean }) => {
        fetchedUrls.push(url);
        fetchedHeaders.push(opts.headers);
        fetchedOpts.push(opts);
        return { ok: true, status: 200, text: async () => fixtureHtml({ appId: url.match(/id(\d+)/)?.[1] ?? "" }) };
      },
    }));

    mock.module("./app-pages-store", () => ({
      ...appPagesStoreMockBase(),
      recordPageSuccess: async (appId: string) => {
        successCalls.push({ appId });
      },
      recordPageFailure: async (appId: string) => {
        failureCalls.push(appId);
      },
      recordPageGone: async (appId: string) => {
        goneCalls.push(appId);
      },
    }));
  });

  it("returns the skipped result immediately when pagesPerBatch is 0, without touching the DB", async () => {
    mock.module("./app-pages-store", () => ({
      ...appPagesStoreMockBase(),
      countPageFetchesSince: async () => {
        throw new Error("must not be called when pagesPerBatch is 0");
      },
    }));

    const { runAppPageFetchPass } = await import("./app-pages");
    const result = await runAppPageFetchPass({ ...DEFAULT_OPTS, pagesPerBatch: 0 });

    expect(result.skipped).toBe(true);
    expect(fetchedUrls).toEqual([]);
  });

  it("skips the whole pass when the rolling-24h page-fetch budget is already reached", async () => {
    mock.module("./app-pages-store", () => ({
      ...appPagesStoreMockBase(),
      countPageFetchesSince: async () => 3_000,
      getDueAppPages: async () => {
        throw new Error("must not be called when the budget is exhausted");
      },
    }));

    const { runAppPageFetchPass } = await import("./app-pages");
    const result = await runAppPageFetchPass(DEFAULT_OPTS);

    expect(result.skipped).toBe(true);
    expect(fetchedUrls).toEqual([]);
  });

  it("fetches with a User-Agent header and retryOnRateLimit set", async () => {
    mock.module("./app-pages-store", () => ({
      ...appPagesStoreMockBase(),
      getDueAppPages: async () => [trackedApp()],
      recordPageSuccess: async (appId: string) => successCalls.push({ appId }),
    }));

    const { runAppPageFetchPass } = await import("./app-pages");
    await runAppPageFetchPass(DEFAULT_OPTS);

    expect(fetchedUrls).toHaveLength(1);
    expect(fetchedUrls[0]).toContain("apps.apple.com/us/app/id1000001");
    expect(fetchedHeaders[0]?.["User-Agent"]).toBeTruthy();
    expect(fetchedOpts[0]?.retryOnRateLimit).toBe(true);
  });

  it("parses and persists a successful fetch", async () => {
    mock.module("./app-pages-store", () => ({
      ...appPagesStoreMockBase(),
      getDueAppPages: async () => [trackedApp()],
      recordPageSuccess: async (appId: string) => successCalls.push({ appId }),
    }));

    const { runAppPageFetchPass } = await import("./app-pages");
    const result = await runAppPageFetchPass(DEFAULT_OPTS);

    expect(result.skipped).toBe(false);
    expect(result.succeeded).toBe(1);
    expect(result.attempted).toBe(1);
    expect(successCalls).toEqual([{ appId: "1000001" }]);
  });

  it("records a verified 404 as gone, not as a failure — and does not count it toward the consecutive-failure bail", async () => {
    mock.module("../shared/ssrf-safe-fetch", () => ({
      RateLimitError,
      ssrfSafeFetch: async (url: string) => {
        fetchedUrls.push(url);
        return { ok: false, status: 404, text: async () => "" };
      },
    }));
    mock.module("./app-pages-store", () => ({
      ...appPagesStoreMockBase(),
      getDueAppPages: async () => [trackedApp()],
      recordPageGone: async (appId: string) => goneCalls.push(appId),
    }));

    const { runAppPageFetchPass } = await import("./app-pages");
    const result = await runAppPageFetchPass(DEFAULT_OPTS);

    expect(result.gone).toBe(1);
    expect(result.failed).toBe(0);
    expect(goneCalls).toEqual(["1000001"]);
  });

  it("counts a parse failure as `failed` + `parseFailed`, records it via recordPageFailure", async () => {
    mock.module("../shared/ssrf-safe-fetch", () => ({
      RateLimitError,
      ssrfSafeFetch: async (url: string) => {
        fetchedUrls.push(url);
        return { ok: true, status: 200, text: async () => "<html><body>no server data here</body></html>" };
      },
    }));
    mock.module("./app-pages-store", () => ({
      ...appPagesStoreMockBase(),
      getDueAppPages: async () => [trackedApp()],
      recordPageFailure: async (appId: string) => failureCalls.push(appId),
    }));

    const { runAppPageFetchPass } = await import("./app-pages");
    const result = await runAppPageFetchPass(DEFAULT_OPTS);

    expect(result.failed).toBe(1);
    expect(result.parseFailed).toBe(1);
    expect(result.succeeded).toBe(0);
    expect(failureCalls).toEqual(["1000001"]);
  });

  it("trips the batch canary when parse-failure rate exceeds the threshold over a large-enough batch", async () => {
    const dueApps = Array.from({ length: 10 }, (_, i) => trackedApp({ appId: `app-${i}` }));
    mock.module("../shared/ssrf-safe-fetch", () => ({
      RateLimitError,
      ssrfSafeFetch: async (url: string) => {
        fetchedUrls.push(url);
        return { ok: true, status: 200, text: async () => "<html><body>structure changed</body></html>" };
      },
    }));
    mock.module("./app-pages-store", () => ({
      ...appPagesStoreMockBase(),
      getDueAppPages: async () => dueApps,
      recordPageFailure: async (appId: string) => failureCalls.push(appId),
    }));

    const { runAppPageFetchPass } = await import("./app-pages");
    // 10 apps, but the pass bails after 5 consecutive failures — still well
    // over the canary's minBatchSize(10 attempted isn't reached because of
    // the bail, so lower minBatchSize to exercise the canary at 5 attempted).
    const result = await runAppPageFetchPass({ ...DEFAULT_OPTS, canaryMinBatchSize: 5 });

    expect(result.bailed).toBe(true);
    expect(result.attempted).toBe(5);
    expect(result.parseFailed).toBe(5);
    expect(result.canaryTripped).toBe(true);
  });

  it("does NOT trip the canary when the batch is under minBatchSize", async () => {
    mock.module("../shared/ssrf-safe-fetch", () => ({
      RateLimitError,
      ssrfSafeFetch: async (url: string) => {
        fetchedUrls.push(url);
        return { ok: true, status: 200, text: async () => "<html><body>structure changed</body></html>" };
      },
    }));
    mock.module("./app-pages-store", () => ({
      ...appPagesStoreMockBase(),
      getDueAppPages: async () => [trackedApp()],
      recordPageFailure: async (appId: string) => failureCalls.push(appId),
    }));

    const { runAppPageFetchPass } = await import("./app-pages");
    const result = await runAppPageFetchPass({ ...DEFAULT_OPTS, canaryMinBatchSize: 10 });

    expect(result.canaryTripped).toBe(false);
  });

  it("bails after 5 consecutive rate-limit failures", async () => {
    const dueApps = Array.from({ length: 6 }, (_, i) => trackedApp({ appId: `app-${i}` }));
    mock.module("../shared/ssrf-safe-fetch", () => ({
      RateLimitError,
      ssrfSafeFetch: async (url: string) => {
        fetchedUrls.push(url);
        throw new RateLimitError("rate limited", 429, undefined);
      },
    }));
    mock.module("./app-pages-store", () => ({
      ...appPagesStoreMockBase(),
      getDueAppPages: async () => dueApps,
      recordPageFailure: async (appId: string) => failureCalls.push(appId),
    }));

    const { runAppPageFetchPass } = await import("./app-pages");
    const result = await runAppPageFetchPass({ ...DEFAULT_OPTS, pagesPerBatch: 6 });

    expect(result.bailed).toBe(true);
    expect(result.attempted).toBe(5);
    expect(result.succeeded).toBe(0);
    expect(result.rateLimitErrors).toBe(5);
  });

  it("logs and swallows a recordPageSuccess write failure without crashing the pass", async () => {
    mock.module("./app-pages-store", () => ({
      ...appPagesStoreMockBase(),
      getDueAppPages: async () => [trackedApp()],
      recordPageSuccess: async () => {
        throw new Error("write exploded");
      },
      recordPageFailure: async (appId: string) => failureCalls.push(appId),
    }));

    const { runAppPageFetchPass } = await import("./app-pages");
    const result = await runAppPageFetchPass(DEFAULT_OPTS);

    // The parse succeeded, but persisting it threw — counted as a failure
    // (via the outer catch), not a crash of the whole pass.
    expect(result.failed).toBe(1);
    expect(result.succeeded).toBe(0);
  });

  it("threads the storefront through to the fetched URL", async () => {
    mock.module("./app-pages-store", () => ({
      ...appPagesStoreMockBase(),
      getDueAppPages: async () => [trackedApp()],
    }));

    const { runAppPageFetchPass } = await import("./app-pages");
    await runAppPageFetchPass({ ...DEFAULT_OPTS, storefront: "gb" });

    expect(fetchedUrls[0]).toContain("apps.apple.com/gb/app/id");
  });
});

describe("runAppPageSyncPass", () => {
  it("delegates to app-pages-store.ts's syncTrackedAppPages", async () => {
    let capturedOpts: unknown;
    mock.module("./app-pages-store", () => ({
      ...appPagesStoreMockBase(),
      syncTrackedAppPages: async (opts: unknown) => {
        capturedOpts = opts;
        return { hotCandidates: 5, newlyTracked: 2, promoted: 1, demoted: 0, rollingAdded: 10 };
      },
    }));

    const { runAppPageSyncPass } = await import("./app-pages");
    const result = await runAppPageSyncPass({ hotSignatureHitCap: 100, hotVelocityCap: 50, rollingAddPerSync: 500 });

    expect(result).toEqual({ hotCandidates: 5, newlyTracked: 2, promoted: 1, demoted: 0, rollingAdded: 10 });
    expect(capturedOpts).toEqual({ hotSignatureHitCap: 100, hotVelocityCap: 50, rollingAddPerSync: 500 });
  });
});
