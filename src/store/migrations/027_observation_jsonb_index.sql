CREATE INDEX IF NOT EXISTS idx_memory_sources_observation_ids
  ON memory_sources USING GIN ((metadata_json::JSONB -> 'observationIds'))
  WHERE kind = 'observation';
