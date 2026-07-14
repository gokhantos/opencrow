-- Semantic keyword concepts: precomputed cluster assignments that group the
-- noisy App Store keyword corpus into "app concepts" (Music, Budgeting, Sleep,
-- Flights ...). Populated by a MANUAL batch job (scripts/cluster-appstore-
-- keywords.ts) — NOT on every scraper tick — via local embeddings + greedy
-- cosine clustering, then served read-only by getOpportunityClusters. Additive
-- + idempotent.
--
-- One row per keyword (PRIMARY KEY), so a re-run replaces the whole assignment
-- set (delete-all-then-insert in one transaction). `cluster_label` is the
-- highest-demand member keyword of the cluster (denormalized so the serving
-- query never has to re-derive it). `similarity` is the keyword's cosine
-- similarity to its cluster centroid (0..1, nullable for a seed/singleton).

CREATE TABLE IF NOT EXISTS appstore_keyword_clusters (
  keyword       TEXT PRIMARY KEY,
  cluster_id    INTEGER NOT NULL,
  cluster_label TEXT NOT NULL,
  similarity    REAL,
  updated_at    BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_appstore_keyword_clusters_cluster
  ON appstore_keyword_clusters (cluster_id);
