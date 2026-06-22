-- Injected-lessons log (Phase 4 of the idea-funnel learning loop).
--
-- The structured lessons actually injected into a GUIDED run's synthesis prompt:
-- the REINFORCE / AVOID outcome memories and the graph OPPORTUNITY-PATH chains.
-- Recording them per run lets the lift attribution correlate "this lesson was
-- present" with "this run's ideas validated", i.e. per-lesson lift vs baseline.
--
-- SECURITY: lesson_text is derived from scraped/untrusted memory text. The store
-- layer SANITIZEs it (sanitizeScrapedField) before INSERT so the DB never holds
-- raw role-markers / control chars; lesson_key is a stable content hash used as
-- the join key for per-lesson aggregation (independent of the display text).
--
-- Append-only. Everything defaults OFF (guidance is only injected when the run is
-- in the guided arm), so this table stays empty until smart.abHoldout is enabled.
--
-- Additive + idempotent: CREATE TABLE / INDEX IF NOT EXISTS, no FK dependency.
-- Indexes are added ONLY to this new (empty) table, so creation is instant with no
-- lock contention. Applies cleanly on every startup.

CREATE TABLE IF NOT EXISTS injected_lessons (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  run_id TEXT NOT NULL,
  lesson_kind TEXT NOT NULL CHECK (lesson_kind IN ('reinforce', 'avoid', 'graph_path')),
  lesson_key TEXT NOT NULL,
  lesson_text TEXT,
  source_idea_id TEXT,
  schema_version INT NOT NULL DEFAULT 1,
  created_at BIGINT NOT NULL DEFAULT extract(epoch from now())::bigint
);

-- Load a run's injected lessons (per-run lift detail).
CREATE INDEX IF NOT EXISTS idx_injected_lessons_run_id
  ON injected_lessons (run_id);

-- Per-lesson aggregation across runs (lesson lift vs baseline).
CREATE INDEX IF NOT EXISTS idx_injected_lessons_key_kind
  ON injected_lessons (lesson_key, lesson_kind);
