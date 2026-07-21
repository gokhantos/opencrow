import { describe, expect, it, mock, beforeEach } from "bun:test";
// Real (unmocked) import, resolved at file-load time BEFORE any
// `mock.module` call runs — re-exported from the `../shared/ssrf-safe-fetch`
// mock below so `charts-intl.ts`'s own `import { RateLimitError } from
// "../shared/ssrf-safe-fetch"` always finds a real named export. Mirrors
// app-enrichment.isolated.test.ts / keyword-gaps.isolated.test.ts.
import { RateLimitError } from "../shared/ssrf-safe-fetch";

// NOTE ON SCOPE (same deviation as app-enrichment.isolated.test.ts's own
// note): the build plan's §0.4 invariant says "mock `../shared/ssrf-safe-fetch`
// only", but `runIntlChartsSweep` also calls `upsertRankings` (./store) and
// `recordAppSightings` (./app-meta-store) — both real DB writes against the
// SHARED local Postgres. Running this pass for real here would write live
// rows tagged with a fake test storefront into a table other tests/tools
// read from. Mocking those two (capturing calls instead of writing) keeps
// this suite fully isolated with no live-DB side effects.

/** A single synthetic RSS `entry` — same minimal shape charts.test.ts uses. */
function fixtureEntry(id: string, name: string): Record<string, unknown> {
  return {
    id: { attributes: { "im:id": id, "im:bundleId": `com.example.${id}` } },
    "im:name": { label: name },
    "im:artist": { label: "Example Dev" },
    category: { attributes: { label: "Games" } },
    "im:image": [{ label: `https://example.com/${id}.png` }],
    link: { attributes: { href: `https://apps.apple.com/app/id${id}` } },
    summary: { label: "A synthetic test app." },
    "im:price": { attributes: { amount: "0" } },
    "im:releaseDate": { attributes: { label: "2026-01-01T00:00:00-07:00" } },
  };
}

function feedJson(id: string): { feed: { entry: Record<string, unknown> } } {
  return { feed: { entry: fixtureEntry(id, `App ${id}`) } };
}

describe("runIntlChartsSweep", () => {
  let fetchedUrls: string[];
  let upsertRankingsCalls: Array<readonly { id: string; storefront?: string }[]>;
  let sightingCalls: Array<{ rows: unknown[]; source: string; opts: unknown }>;

  beforeEach(() => {
    fetchedUrls = [];
    upsertRankingsCalls = [];
    sightingCalls = [];

    mock.module("../shared/ssrf-safe-fetch", () => ({
      RateLimitError,
      ssrfSafeFetch: async (url: string) => {
        fetchedUrls.push(url);
        return { ok: true, json: async () => feedJson("100") };
      },
    }));

    mock.module("./store", () => ({
      upsertRankings: async (rows: readonly { id: string; storefront?: string }[]) => {
        upsertRankingsCalls.push(rows);
        return rows.length;
      },
    }));

    mock.module("./app-meta-store", () => ({
      recordAppSightings: async (rows: unknown[], source: string, opts: unknown) => {
        sightingCalls.push({ rows, source, opts });
        return rows.length;
      },
    }));
  });

  it("threads the storefront through to fetched URLs, upserted rows, and sightings", async () => {
    const { runIntlChartsSweep } = await import("./charts-intl");
    const result = await runIntlChartsSweep({
      storefronts: ["gb"],
      listTypes: ["top-free"],
      perCategoryLimit: 200,
      delayMs: 0,
      throttleMultiplier: 1,
    });

    expect(result.bailed).toBe(false);
    expect(fetchedUrls.length).toBeGreaterThan(0);
    expect(fetchedUrls.every((u) => u.includes("/gb/rss/"))).toBe(true);

    expect(upsertRankingsCalls).toHaveLength(1);
    expect(upsertRankingsCalls[0]?.every((r) => r.storefront === "gb")).toBe(true);

    expect(sightingCalls).toHaveLength(1);
    expect(sightingCalls[0]?.source).toBe("chart-intl");
    expect(sightingCalls[0]?.opts).toEqual({ storefront: "gb" });
  });

  it("truncates the work list by the throttle multiplier", async () => {
    const { runIntlChartsSweep } = await import("./charts-intl");
    // Full work list at 3 storefronts x 1 listType x (25 categories, per
    // charts.ts's ITUNES_CATEGORIES) = 75 items. A 0.1 multiplier truncates
    // to floor(75 * 0.1) = 7.
    const result = await runIntlChartsSweep({
      storefronts: ["gb", "ca", "au"],
      listTypes: ["top-free"],
      perCategoryLimit: 200,
      delayMs: 0,
      throttleMultiplier: 0.1,
    });

    expect(fetchedUrls).toHaveLength(7);
    expect(result.scanned).toBe(7);
  });

  it("returns an empty result without fetching when the multiplier truncates the work list to 0", async () => {
    const { runIntlChartsSweep } = await import("./charts-intl");
    const result = await runIntlChartsSweep({
      storefronts: ["gb"],
      listTypes: ["top-free"],
      perCategoryLimit: 200,
      delayMs: 0,
      throttleMultiplier: 0,
    });

    expect(result).toEqual({
      scanned: 0,
      failed: 0,
      bailed: false,
      rateLimitErrors: 0,
      sightingsRecorded: 0,
    });
    expect(fetchedUrls).toEqual([]);
  });

  it("counts rate-limit errors without bailing when failures aren't consecutive", async () => {
    let call = 0;
    mock.module("../shared/ssrf-safe-fetch", () => ({
      RateLimitError,
      ssrfSafeFetch: async (url: string) => {
        call++;
        fetchedUrls.push(url);
        // Fail every other call — never 5 consecutive failures.
        if (call % 2 === 0) {
          throw new RateLimitError("rate limited", 429, undefined);
        }
        return { ok: true, json: async () => feedJson(String(call)) };
      },
    }));

    const { runIntlChartsSweep } = await import("./charts-intl");
    const result = await runIntlChartsSweep({
      storefronts: ["gb"],
      listTypes: ["top-free"],
      perCategoryLimit: 200,
      delayMs: 0,
      throttleMultiplier: 1,
    });

    expect(result.bailed).toBe(false);
    expect(result.rateLimitErrors).toBeGreaterThan(0);
    expect(result.failed).toBe(result.rateLimitErrors);
  });

  it("bails after 5 consecutive rate-limited failures", async () => {
    mock.module("../shared/ssrf-safe-fetch", () => ({
      RateLimitError,
      ssrfSafeFetch: async (url: string) => {
        fetchedUrls.push(url);
        throw new RateLimitError("rate limited", 429, undefined);
      },
    }));

    const { runIntlChartsSweep } = await import("./charts-intl");
    const result = await runIntlChartsSweep({
      storefronts: ["gb", "ca", "au"],
      listTypes: ["top-free", "top-paid", "top-grossing"],
      perCategoryLimit: 200,
      delayMs: 0,
      throttleMultiplier: 1,
    });

    expect(result.bailed).toBe(true);
    expect(result.scanned).toBe(0);
    expect(result.failed).toBe(5);
    expect(result.rateLimitErrors).toBe(5);
    // Bails before ever reaching upsert/sightings — nothing was fetched
    // successfully.
    expect(upsertRankingsCalls).toEqual([]);
    expect(sightingCalls).toEqual([]);
  });

  it("treats a non-ok HTTP response as a failure (not a throw from json())", async () => {
    mock.module("../shared/ssrf-safe-fetch", () => ({
      RateLimitError,
      ssrfSafeFetch: async (url: string) => {
        fetchedUrls.push(url);
        return { ok: false, status: 500, json: async () => ({}) };
      },
    }));

    const { runIntlChartsSweep } = await import("./charts-intl");
    const result = await runIntlChartsSweep({
      storefronts: ["gb"],
      listTypes: ["top-free"],
      perCategoryLimit: 200,
      delayMs: 0,
      throttleMultiplier: 1,
    });

    // Every fetch is a 500, so the pass bails at the 5th consecutive failure
    // rather than working through all 25 categories.
    expect(result.bailed).toBe(true);
    expect(result.failed).toBe(5);
    expect(result.rateLimitErrors).toBe(0);
  });
});
