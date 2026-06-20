-- mem0 memory backend (phase 2): source_id → mem0_id chunk mapping.
--
-- When OPENCROW_MEMORY_BACKEND=mem0, the memory backend chunks each source's
-- text and writes one mem0 memory per chunk. mem0 owns the chunk ids, so we
-- record the (sourceId, mem0Id) pairs here to support delete-by-source: the
-- manager/eviction path deletes by sourceId, and the backend looks up the
-- corresponding mem0 ids to call DELETE /v1/memories/{id}/ for each.
--
-- The qdrant backend does NOT use this table; it stays empty unless the mem0
-- backend is selected. Additive + idempotent (IF NOT EXISTS), no dependency on
-- any other relation, applies cleanly on every startup.
CREATE TABLE IF NOT EXISTS mem0_chunk_map (
  source_id text NOT NULL,
  mem0_id   text NOT NULL,
  PRIMARY KEY (source_id, mem0_id)
);

CREATE INDEX IF NOT EXISTS idx_mem0_chunk_map_source ON mem0_chunk_map(source_id);
