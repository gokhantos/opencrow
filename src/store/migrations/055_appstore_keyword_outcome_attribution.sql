-- Batch F (App Store keyword pipeline consumption & actionability), F5 leg 4:
-- run-aggregate outcome attribution back to the App Store keyword-gap seeds
-- that fed a run's synthesis prompt.
--
-- Mirrors migration 033's graph_outcome_feedback shape (graph_seed_exposure /
-- graph_outcome_events / graph_seed_weights) for a DIFFERENT target:
-- appstore_keyword_verdicts (source='pipeline') instead of Neo4j :Entity
-- seeds. See `keyword-outcome-feedback.ts`'s module doc for why this is
-- RUN-AGGREGATE attribution across every exposed seed keyword, not a
-- per-idea mapping — a GapSeed keyword is prompt CONTEXT (see
-- collector-keyword-gaps.ts), so no durable link exists from one generated
-- idea back to the one keyword that inspired it.
--
--   appstore_keyword_seed_exposure  : which gap-seed keywords fed each run
--                                      (provenance for the credit
--                                      assignment) — mirrors
--                                      graph_seed_exposure.
--   appstore_keyword_outcome_events : immutable, append-only per-keyword
--                                      verdict log. Only gold/reprobe-tier
--                                      verdicts are ever appended (see
--                                      buildSeedOutcomeEvents in
--                                      graph-outcome-feedback.ts, reused
--                                      unchanged here) — mirrors
--                                      graph_outcome_events.
--   appstore_keyword_verdicts.validated_count / killed_count :
--       materialized, temporally-decayed projection of the event log —
--       the two counters collectKeywordGaps reads back (killed_count is a
--       SOFT downweight on sort rank, never a hard exclude — see that
--       module's and keyword-verdict-store.ts's doc comments on the
--       existing human/pipeline hard/soft exclude distinction this
--       deliberately extends). Added onto the EXISTING migration-054 table
--       rather than a new one so the counters live alongside the same
--       (keyword, source='pipeline') row a screener dismissal (F5 leg 2)
--       may already occupy — recomputeKeywordOutcomeCounts only ever
--       touches these two columns on conflict, never the row's existing
--       verdict/note/decided_at (see that function's doc comment).
--
-- Additive + idempotent: ALTER TABLE / CREATE TABLE / INDEX IF NOT EXISTS
-- throughout, no FK dependency. Applies cleanly on every startup.

ALTER TABLE appstore_keyword_verdicts
  ADD COLUMN IF NOT EXISTS validated_count DOUBLE PRECISION NOT NULL DEFAULT 0;

ALTER TABLE appstore_keyword_verdicts
  ADD COLUMN IF NOT EXISTS killed_count DOUBLE PRECISION NOT NULL DEFAULT 0;

-- Which gap-seed keywords fed each run. (run_id, keyword) is the natural key
-- — one row per (run, keyword) pair, so re-recording the same exposure is a
-- no-op via the PK.
CREATE TABLE IF NOT EXISTS appstore_keyword_seed_exposure (
  run_id TEXT NOT NULL,
  keyword TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (run_id, keyword)
);

-- Immutable, append-only per-keyword verdict log. weight is the signed
-- credit (+ for validated, - for killed) attributed to the keyword by the
-- run's aggregate verdict. The UNIQUE (run_id, keyword, verdict) constraint
-- makes appends idempotent (ON CONFLICT DO NOTHING) so a re-run never
-- double-counts the same outcome.
CREATE TABLE IF NOT EXISTS appstore_keyword_outcome_events (
  id BIGSERIAL PRIMARY KEY,
  run_id TEXT NOT NULL,
  keyword TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('validated', 'killed')),
  weight DOUBLE PRECISION NOT NULL,
  created_at_sec BIGINT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (run_id, keyword, verdict)
);

-- recomputeKeywordOutcomeCounts reads the whole event log grouped by keyword.
CREATE INDEX IF NOT EXISTS idx_appstore_keyword_outcome_events_keyword
  ON appstore_keyword_outcome_events (keyword);

-- Exposure lookup by run (loading a run's exposed keywords for credit
-- assignment at write-back time).
CREATE INDEX IF NOT EXISTS idx_appstore_keyword_seed_exposure_run_id
  ON appstore_keyword_seed_exposure (run_id);

-- collectKeywordGaps' getPipelineKilledWeights scans for pipeline-sourced
-- rows with an accumulated kill signal.
CREATE INDEX IF NOT EXISTS idx_appstore_keyword_verdicts_killed_count
  ON appstore_keyword_verdicts (source, killed_count)
  WHERE killed_count > 0;
