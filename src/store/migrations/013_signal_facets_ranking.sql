-- Signal ranking columns layered onto signal_facets (migration 009).
-- Adds the LLM-derived importance/relevance ranking that is calibrated against
-- the idea_feedback loop and used as a filterable retrieval signal in deepSearch.
-- Gated behind pipelines.ideas.smart.signalRanking (default false), which is
-- layered on top of signalFacets.
--
-- Additive + idempotent only: never drops/renames existing facet columns, and
-- safe to re-run. importance is a categorical bucket (noise|low|medium|high) so
-- it stays calibratable via Beta-Bernoulli; relevance_to_ideas is in [0,1]
-- anchored to usefulness for product/startup idea generation.
ALTER TABLE signal_facets
  ADD COLUMN IF NOT EXISTS importance TEXT;

ALTER TABLE signal_facets
  ADD COLUMN IF NOT EXISTS relevance_to_ideas REAL;

ALTER TABLE signal_facets
  ADD COLUMN IF NOT EXISTS category TEXT;

ALTER TABLE signal_facets
  ADD COLUMN IF NOT EXISTS signal_type TEXT;

ALTER TABLE signal_facets
  ADD COLUMN IF NOT EXISTS rank_model TEXT;

-- Retrieval filtering by importance floor, scoped per source table.
CREATE INDEX IF NOT EXISTS idx_signal_facets_source_importance
  ON signal_facets (source_table, importance);

-- Global importance-bucket lookups for calibration aggregation.
CREATE INDEX IF NOT EXISTS idx_signal_facets_importance
  ON signal_facets (importance);
