-- Theme-Stratified Intake (Component 1) — mirror the LLM-extracted
-- `signalCategory` (the coarse theme, e.g. "fintech", "devtools") onto the
-- scraped source rows so the collectors can bucket the seed pool by THEME at
-- selection time with ZERO added reads.
--
-- Background: `signalCategory` is computed post-collection at BATCH granularity,
-- keyed by a `memory_sources` UUID — there is no key to read it back per
-- scraped row (only an unqueried CSV in metadata_json). We add a nullable
-- `signal_category TEXT` to each of the 6 collector-read source tables; the
-- enrichment write-back (indexer.ts) fans the batch category onto every row in
-- the batch. NULL means "not yet enriched" — the collector's hybrid bucket key
-- falls back to the existing source/sub-source stratification for those rows.
--
-- Additive + idempotent: guarded ADD COLUMN / CREATE INDEX IF NOT EXISTS, no
-- dependency on any other relation, applies cleanly on every startup. The
-- partial index keeps any future filtered bucket read cheap without bloating
-- the (mostly-NULL early on) column.

ALTER TABLE reddit_posts ADD COLUMN IF NOT EXISTS signal_category TEXT;
ALTER TABLE hn_stories ADD COLUMN IF NOT EXISTS signal_category TEXT;
ALTER TABLE github_repos ADD COLUMN IF NOT EXISTS signal_category TEXT;
ALTER TABLE ph_products ADD COLUMN IF NOT EXISTS signal_category TEXT;
ALTER TABLE news_articles ADD COLUMN IF NOT EXISTS signal_category TEXT;
ALTER TABLE x_scraped_tweets ADD COLUMN IF NOT EXISTS signal_category TEXT;

CREATE INDEX IF NOT EXISTS idx_reddit_posts_signal_category
  ON reddit_posts (signal_category) WHERE signal_category IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_hn_stories_signal_category
  ON hn_stories (signal_category) WHERE signal_category IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_github_repos_signal_category
  ON github_repos (signal_category) WHERE signal_category IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ph_products_signal_category
  ON ph_products (signal_category) WHERE signal_category IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_news_articles_signal_category
  ON news_articles (signal_category) WHERE signal_category IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_x_scraped_tweets_signal_category
  ON x_scraped_tweets (signal_category) WHERE signal_category IS NOT NULL;
