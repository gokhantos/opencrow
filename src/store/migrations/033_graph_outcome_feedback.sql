-- Graph outcome feedback (Phase 3 of the idea-funnel learning loop).
--
-- Closes the graph feedback loop so SIGE opportunity-path traversal favors seed
-- entities that historically produced GOOD ideas, instead of the degree-DESC
-- monoculture. This Postgres side is the durable, auditable bookkeeping; the
-- materialized weights are PROJECTED onto the live Neo4j :Entity seeds by the
-- write client. Everything defaults OFF → these tables stay empty and the read
-- path's coalesce(...) keeps un-projected seeds at neutral (≈ degree behavior).
--
--   graph_seed_exposure  : which seeds fed each run (provenance for the credit
--                          assignment — a run's aggregate verdict is attributed
--                          back to exactly the seeds that fed it).
--   graph_outcome_events : immutable, append-only per-seed verdict log. ONLY
--                          gold/reprobe-tier verdicts are ever appended (proxy
--                          self-grades are excluded upstream), so early on this
--                          log is near-empty and traversal stays neutral/degree.
--   graph_seed_weights   : materialized, temporally-decayed projection of the
--                          event log — the rows the write client SETs onto Neo4j.
--
-- Additive + idempotent: CREATE TABLE / INDEX IF NOT EXISTS, no FK dependency.
-- Indexes are added ONLY to these new (empty) tables, so creation is instant with
-- no lock contention on hot tables. Applies cleanly on every startup.

-- Which seeds fed each run. (run_id, seed_name) is the natural key — one row per
-- (run, seed) pair, so re-recording the same exposure is a no-op via the PK.
CREATE TABLE IF NOT EXISTS graph_seed_exposure (
  run_id TEXT NOT NULL,
  seed_name TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (run_id, seed_name)
);

-- Immutable, append-only per-seed verdict log. weight is the signed credit (+ for
-- validated, - for killed) attributed to the seed by the run's aggregate verdict.
-- The UNIQUE (run_id, seed_name, verdict) constraint makes appends idempotent
-- (ON CONFLICT DO NOTHING) so a re-run never double-counts the same outcome.
CREATE TABLE IF NOT EXISTS graph_outcome_events (
  id BIGSERIAL PRIMARY KEY,
  run_id TEXT NOT NULL,
  seed_name TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('validated', 'killed')),
  weight DOUBLE PRECISION NOT NULL,
  created_at_sec BIGINT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (run_id, seed_name, verdict)
);

-- Materialized, temporally-decayed projection of the event log: one row per seed
-- with its current decayed success_weight, total exposure_count (novelty signal),
-- and sample_count (how many distinct events backed the weight).
CREATE TABLE IF NOT EXISTS graph_seed_weights (
  seed_name TEXT PRIMARY KEY,
  success_weight DOUBLE PRECISION NOT NULL,
  exposure_count INTEGER NOT NULL,
  sample_count INTEGER NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Recompute scan reads the whole event log grouped by seed_name.
CREATE INDEX IF NOT EXISTS idx_graph_outcome_events_seed_name
  ON graph_outcome_events (seed_name);

-- Exposure lookup by run (loading a run's seeds for credit assignment).
CREATE INDEX IF NOT EXISTS idx_graph_seed_exposure_run_id
  ON graph_seed_exposure (run_id);
