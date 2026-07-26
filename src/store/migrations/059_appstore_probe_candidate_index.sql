-- Direct hint-probe candidate selection was timing out at its 30s statement
-- timeout and silently degrading to zero targets, so the probe ledger stopped
-- growing (verified live 2026-07-26: 0 new probes in 15 minutes, repeated
-- "getDirectProbeCandidates failed, degrading to no probe targets" warnings).
--
-- The cost driver is the `scored` CTE in getDirectProbeCandidates
-- (hint-probe-store.ts): `SELECT DISTINCT keyword FROM appstore_keyword_scans
-- WHERE store = ? AND opportunity >= ? AND scanned_at >= ?` had no supporting
-- index, so it scanned all 274k store='app' rows under a concurrent ~1 insert/s
-- write load, and the result then fed a 25k-row 4-key sort.
--
-- This index serves the CTE's equality + range predicates and carries `keyword`
-- so the CTE can be satisfied index-only.
CREATE INDEX IF NOT EXISTS idx_appstore_keyword_scans_probe_candidates
  ON appstore_keyword_scans (store, opportunity, scanned_at, keyword);
