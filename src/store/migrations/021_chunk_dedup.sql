ALTER TABLE memory_chunks ADD COLUMN IF NOT EXISTS content_hash TEXT;

-- Drop partial index if it exists (was WHERE content_hash IS NOT NULL),
-- then recreate as full unique index so ON CONFLICT (content_hash) works.
DROP INDEX IF EXISTS idx_memory_chunks_content_hash;

CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_chunks_content_hash
  ON memory_chunks(content_hash);
