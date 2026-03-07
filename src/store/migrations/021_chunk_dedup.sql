ALTER TABLE memory_chunks ADD COLUMN IF NOT EXISTS content_hash TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_chunks_content_hash
  ON memory_chunks(content_hash)
  WHERE content_hash IS NOT NULL;
