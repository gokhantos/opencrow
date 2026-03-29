-- Enable pg_trgm for fuzzy text matching (idea deduplication)
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- GIN trigram indexes for fast fuzzy title/summary matching
CREATE INDEX IF NOT EXISTS idx_ideas_title_trgm ON generated_ideas USING gin (title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_ideas_summary_trgm ON generated_ideas USING gin (summary gin_trgm_ops);

-- Track which source items were used to generate each idea
ALTER TABLE generated_ideas ADD COLUMN IF NOT EXISTS source_ids_json TEXT DEFAULT '[]';
