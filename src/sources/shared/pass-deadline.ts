/**
 * pass-deadline.ts — wall-clock budget guard for sequential per-item scrape
 * passes (app-store deep-scrape lanes: intl charts, review harvest, app-meta
 * enrichment, app-page HTML fetch).
 *
 * Root cause this guards against (2026-07-21 incident, PR #326 deep-scrape
 * lanes dormant post-deploy): each pass's loop already bails after
 * `MAX_CONSECUTIVE_FAILURES` (5) — but that only fires when requests
 * *throw* or return non-ok. An upstream that responds SLOWLY but
 * successfully (each request taking close to but under its own per-request
 * timeout) never trips the failure counter, so a large work list — e.g.
 * `charts-intl.ts`'s intl-charts sweep, up to `storefronts × 23 categories ×
 * listTypes` (207 items at the schema default) — can run for 60–100+
 * minutes on a degraded-but-technically-up upstream. Every one of these
 * passes runs on `scraper.ts`'s single-flight `keywordSweepTick` — while ONE
 * pass is still running, the single-flight guard (`keywordSweepRunning`)
 * silently skips every subsequent tick, so a single slow-but-not-failing
 * lane can wedge ALL EIGHT lanes on that tick (not just itself) for as long
 * as it keeps making "successful" but slow requests. This is exactly what
 * was observed live: zero completions logged for ANY of the eight lanes —
 * including ones with no relation to the stuck lane — for 95+ minutes
 * straight, with the scraper process's own DB connections sitting `idle`
 * (i.e. not stuck on a query — consistent with being stuck in a sequential
 * network-fetch loop instead).
 *
 * `isPassOverBudget` is a pure function (injectable `nowMs`) so it's
 * trivially unit-testable without faking timers or sleeping in tests.
 */
export function isPassOverBudget(
  passStartedAtMs: number,
  maxDurationMs: number,
  nowMs: number = Date.now(),
): boolean {
  return nowMs - passStartedAtMs >= maxDurationMs;
}
