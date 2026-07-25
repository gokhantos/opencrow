/**
 * Unit tests for per-scraper DB pool sizing.
 *
 * Regression basis: the 2026-07-24/25 App Store keyword-scanner outage, where
 * four concurrent lanes shared a hard-coded 2-connection pool and one wedged
 * connection stopped the whole subsystem for 11.5h — see
 * `scraper-pool-size.ts`'s doc comment.
 */
import { describe, it, expect } from "bun:test";
import {
  DEFAULT_SCRAPER_POOL_SIZE,
  scraperDbPoolSize,
} from "./scraper-pool-size";

describe("scraperDbPoolSize", () => {
  it("gives the App Store scraper a pool that covers its four concurrent lanes", () => {
    // tick + keywordSweepTick + auxiliaryLanesTick + proxyStreamTick, plus the
    // supervisor heartbeat: a pool at or below the lane count means one stuck
    // connection can park a lane that holds a single-flight lock.
    expect(scraperDbPoolSize("appstore")).toBeGreaterThan(4);
  });

  it("leaves single-lane scrapers on the default", () => {
    for (const id of ["hackernews", "reddit", "producthunt", "playstore"]) {
      expect(scraperDbPoolSize(id)).toBe(DEFAULT_SCRAPER_POOL_SIZE);
    }
  });

  it("falls back to the default for an unknown scraper id", () => {
    expect(scraperDbPoolSize("not-a-real-scraper")).toBe(
      DEFAULT_SCRAPER_POOL_SIZE,
    );
  });

  it("keeps the whole stack inside the Postgres connection budget", () => {
    // max_connections = 100. Everything else (cron 10, web/agent/sige 5 each,
    // ingestion 3, core 3) plus 8 scraper processes must leave headroom for
    // CLI/psql/maintenance; guard against a future raise that quietly eats it.
    const scraperIds = [
      "appstore",
      "hackernews",
      "reddit",
      "producthunt",
      "playstore",
      "x-bookmarks",
      "x-autolike",
      "x-autofollow",
    ];
    const scraperTotal = scraperIds.reduce(
      (sum, id) => sum + scraperDbPoolSize(id),
      0,
    );
    const nonScraperTotal = 10 + 5 + 5 + 5 + 3 + 3;
    expect(scraperTotal + nonScraperTotal).toBeLessThanOrEqual(70);
  });
});
