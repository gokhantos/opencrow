ALTER TABLE memory_chunks ADD COLUMN IF NOT EXISTS content_hash TEXT;

DO $$ BEGIN
  DROP INDEX IF EXISTS idx_memory_chunks_content_hash;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_chunks_content_hash
    ON memory_chunks(content_hash);
EXCEPTION WHEN duplicate_table THEN NULL;
END $$;
