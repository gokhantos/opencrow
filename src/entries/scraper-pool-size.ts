/**
 * Per-scraper DB connection-pool sizing.
 *
 * Every scraper process used to bootstrap with a hard-coded `dbPoolSize: 2`,
 * which assumed the shape of a SIMPLE scraper: one timer, one sequential
 * fetch->parse->write chain, so two connections (one working + one spare) were
 * plenty. The App Store scraper stopped having that shape once the keyword
 * subsystem grew independent timers — it now runs FOUR concurrent lanes off
 * `createAppStoreScraper().start()`:
 *
 *   1. `tick()`               — the hourly charts/rankings/reviews scrape
 *   2. `keywordSweepTick()`   — the direct keyword-gap sweep (60s)
 *   3. `auxiliaryLanesTick()` — the ~12 auxiliary keyword lanes (60s)
 *   4. `proxyStreamTick()`    — the proxied second scan stream (60s, PR #345)
 *
 * plus the supervisor's `process_commands` heartbeat. Four lanes contending
 * for two connections is what turned a single stuck query into a total
 * subsystem outage on 2026-07-24/25: a `config_overrides` read never settled
 * client-side (Postgres reported the connection `state='idle'` — the server
 * had answered — while the Bun SQL promise never resolved), permanently
 * checking out 1 of the 2 connections. The remaining connection could not
 * serve four lanes: the direct sweep and the hourly tick parked on their first
 * `await` while holding their single-flight locks (`keywordSweepRunning` /
 * `running`), so they went silent for 11.5h — the only visible symptom was an
 * hourly "App Store scrape already running, skipping" — and the proxied lane
 * degraded from one sweep per 60s to one empty sweep per 28-43 min. Zero rows
 * reached `appstore_keyword_scans` between 20:48 and the 08:21 restart.
 *
 * Sizing rule: a scraper's pool must cover its CONCURRENT lanes with enough
 * headroom that one wedged connection degrades throughput instead of stopping
 * the process. `DEFAULT_SCRAPER_POOL_SIZE` stays 2 for the single-lane
 * scrapers (hackernews, reddit, producthunt, playstore, x-*); only scrapers
 * listed here override it.
 *
 * Capacity: Postgres runs with `max_connections = 100`; the whole stack
 * currently sits at ~48 (cron 10, web/agent/sige 5 each, ingestion 3, core 3,
 * 8 scrapers x 2). Raising ONLY the App Store scraper to 8 adds 6 connections
 * (~54/100), leaving the usual headroom for CLI/psql/maintenance. Raise the
 * default for all scrapers only alongside a `max_connections` review.
 *
 * NOTE: a right-sized pool is damage CONTROL, not the cure — a leaked
 * connection is still leaked, and a process that leaks one per ~12h will
 * exhaust any finite pool. The leak itself (an unbounded `config_overrides`
 * read; PR #349 bounded only `getSecret`'s call site, so the hang relocated to
 * another reader) needs fixing separately.
 */

/** Pool size for a scraper that runs a single sequential lane. */
export const DEFAULT_SCRAPER_POOL_SIZE = 2;

/**
 * Scrapers whose concurrency exceeds the default. Keyed by
 * `OPENCROW_SCRAPER_ID`; see this module's doc comment for the sizing rule and
 * the capacity budget before adding an entry.
 */
const SCRAPER_POOL_SIZES: Readonly<Record<string, number>> = {
  // 4 concurrent lanes + supervisor heartbeat + headroom.
  appstore: 8,
};

/**
 * DB pool size for `scraperId`, falling back to
 * `DEFAULT_SCRAPER_POOL_SIZE` for any scraper without an explicit entry.
 */
export function scraperDbPoolSize(scraperId: string): number {
  return SCRAPER_POOL_SIZES[scraperId] ?? DEFAULT_SCRAPER_POOL_SIZE;
}
