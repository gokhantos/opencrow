-- Structured signal facets extracted from ingested signals.
-- Scaffolding for the smart ideas pipeline (gated behind pipelines.ideas.smart.signalFacets).
-- Each row captures a typed, LLM-extracted facet profile for a single source item.
CREATE TABLE IF NOT EXISTS signal_facets (
  id              TEXT PRIMARY KEY,
  source_table    TEXT NOT NULL,
  source_id       TEXT NOT NULL,
  problem_type    TEXT,
  target_audience TEXT,
  jtbd            TEXT,
  sentiment       TEXT,
  entities_json   TEXT NOT NULL DEFAULT '[]',
  created_at      BIGINT NOT NULL
);

-- Lookup facets by their originating source item.
CREATE INDEX IF NOT EXISTS idx_signal_facets_source
  ON signal_facets (source_table, source_id);
