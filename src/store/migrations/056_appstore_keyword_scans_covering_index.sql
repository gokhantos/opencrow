-- Production hazard fix (2026-07-23): a `DISTINCT ON (keyword, store) *`
-- query over `appstore_keyword_scans` ran 12+ minutes and stalled the whole
-- stack (a startup CREATE INDEX queued behind it, then core's child spawn
-- queued behind THAT). Root cause confirmed via EXPLAIN (ANALYZE, BUFFERS)
-- against the live 244k-row/458MB table: `getTopOpportunities`'s
-- `WITH s AS (SELECT DISTINCT ON (keyword, store) * ...)` CTE is referenced
-- as `s.*` downstream, so Postgres cannot prune the projection — the
-- "latest scan per (keyword, store)" dedup pass has to fetch and TOAST-detoast
-- the full row (~1.7KB avg, dominated by the `top_apps`/`serp_tail` JSONB
-- columns) for every one of the ~128k distinct-latest rows via
-- `idx_appstore_keyword_scans_history` (keyword, store, scanned_at DESC).
-- That index supports the ORDER BY (no sort needed — see EXPLAIN "Index Scan
-- using idx_appstore_keyword_scans_history"), but it is NOT covering, so
-- each of those ~128k rows is a random heap-page fetch. Locally this reads
-- ~185k buffer pages (~1.3s on warm NVMe); on production storage with
-- meaningfully higher per-page random-read latency (network volume, cold
-- cache, concurrent write load from the scraper), that random-I/O pattern
-- plausibly stretches to the observed 12+ minutes.
--
-- Fix: add `id` plus every column the dedup/filter/sort stage in
-- `keyword-store.ts` actually touches (`countFilteredOpportunities`,
-- `getTopOpportunities`, `getWinnerKeywords` — see that file's
-- `LATEST_SCAN_THIN_COLUMNS_SQL`) as INCLUDE columns on the existing
-- ordering index, so the DISTINCT ON dedup step can run as an Index Only
-- Scan (zero heap/TOAST touches) instead of randomly heap-fetching every
-- fat row. The three call sites are updated in the same change to actually
-- project this thin column list (instead of `*`) so the planner can use the
-- covering index; `getTopOpportunities` additionally join-back-by-`id` to
-- fetch `top_apps`/`hint_*` (never needed for filtering/sorting) only for
-- the final ~`limit` rows it returns, not the full ~128k-row dedup set.
--
-- Deliberately ADDITIVE: the pre-existing `idx_appstore_keyword_scans_history`
-- is left in place rather than dropped/rebuilt in place, so this migration
-- never needs a DROP on a table other code paths may still be querying
-- through that index, and re-running it (migrations run non-fatally on every
-- startup) is a cheap no-op via `IF NOT EXISTS` rather than a repeated index
-- rebuild. `CONCURRENTLY` avoids taking the blocking lock a plain
-- `CREATE INDEX` would hold for the whole (potentially multi-minute, on a
-- table this size) build — the exact class of lock this incident was about.
--
-- NOTE: `CREATE INDEX CONCURRENTLY` cannot run inside a transaction block.
-- `src/store/migrations/index.ts` splits each file into individual
-- statements executed one at a time via `db.unsafe(...)` outside any
-- explicit BEGIN, so this is safe here.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_appstore_keyword_scans_history_covering
  ON appstore_keyword_scans (keyword, store, scanned_at DESC)
  INCLUDE (
    id, competitiveness, demand, incumbent_weakness, opportunity, trend,
    top_app_reviews, avg_rating, avg_age_days, low_confidence, brand_navigational
  );
