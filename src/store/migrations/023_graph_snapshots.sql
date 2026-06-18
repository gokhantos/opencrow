-- Graph snapshot: persists the last non-empty GraphView per userId so the
-- knowledge graph endpoint can serve a stale-but-useful view when Mem0 is
-- unavailable or returns an empty result.
-- All statements are idempotent.

CREATE TABLE IF NOT EXISTS sige_graph_snapshots (
  user_id TEXT PRIMARY KEY,
  graph_json TEXT NOT NULL,
  saved_at BIGINT NOT NULL DEFAULT extract(epoch from now())::bigint
);
