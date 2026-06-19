-- Composite indexes to support the SIGE ingestion composite-cursor fetch pattern:
--   WHERE (indexed_at > $ts) OR (indexed_at = $ts AND id > $id)
--   ORDER BY indexed_at DESC, id DESC
--
-- The (indexed_at, id) index lets Postgres satisfy both the predicate and the
-- ORDER BY in a single index scan without a sort step, which is important for
-- tables with hundreds of thousands of rows (playstore_reviews, news_articles).
--
-- All indexes are idempotent (IF NOT EXISTS).

CREATE INDEX IF NOT EXISTS idx_appstore_reviews_ingest_cursor
  ON appstore_reviews (indexed_at DESC, id DESC)
  WHERE indexed_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_playstore_reviews_ingest_cursor
  ON playstore_reviews (indexed_at DESC, id DESC)
  WHERE indexed_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_reddit_posts_ingest_cursor
  ON reddit_posts (indexed_at DESC, id DESC)
  WHERE indexed_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ph_products_ingest_cursor
  ON ph_products (indexed_at DESC, id DESC)
  WHERE indexed_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_hn_stories_ingest_cursor
  ON hn_stories (indexed_at DESC, id DESC)
  WHERE indexed_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_news_articles_ingest_cursor
  ON news_articles (indexed_at DESC, id DESC)
  WHERE indexed_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_appstore_apps_ingest_cursor
  ON appstore_apps (indexed_at DESC, id DESC)
  WHERE indexed_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_playstore_apps_ingest_cursor
  ON playstore_apps (indexed_at DESC, id DESC)
  WHERE indexed_at IS NOT NULL;
