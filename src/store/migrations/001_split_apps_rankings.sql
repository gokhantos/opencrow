-- Split app metadata from ranking history
-- Creates dedicated app tables and ranking history tables
-- Old appstore_rankings / playstore_rankings tables are retained for safety

CREATE TABLE IF NOT EXISTS appstore_apps (
    id text PRIMARY KEY,
    name text,
    artist text,
    category text,
    icon_url text,
    store_url text,
    description text,
    price text,
    bundle_id text,
    release_date text,
    updated_at integer,
    indexed_at integer
);

CREATE TABLE IF NOT EXISTS playstore_apps (
    id text PRIMARY KEY,
    name text,
    developer text,
    category text,
    icon_url text,
    store_url text,
    description text,
    price text,
    rating real,
    installs text,
    updated_at integer,
    indexed_at integer
);

INSERT INTO appstore_apps
SELECT DISTINCT ON (id)
    id, name, artist, category, icon_url, store_url,
    description, price, bundle_id, release_date, updated_at, indexed_at
FROM appstore_rankings
ORDER BY id, updated_at DESC
ON CONFLICT DO NOTHING;

INSERT INTO playstore_apps
SELECT DISTINCT ON (id)
    id, name, developer, category, icon_url, store_url,
    description, price, rating, installs, updated_at, indexed_at
FROM playstore_rankings
ORDER BY id, updated_at DESC
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS appstore_ranking_history (
    id serial PRIMARY KEY,
    app_id text,
    list_type text,
    rank integer,
    scraped_at integer
);

CREATE TABLE IF NOT EXISTS playstore_ranking_history (
    id serial PRIMARY KEY,
    app_id text,
    list_type text,
    rank integer,
    scraped_at integer
);

INSERT INTO appstore_ranking_history (app_id, list_type, rank, scraped_at)
SELECT id, list_type, rank, updated_at
FROM appstore_rankings;

INSERT INTO playstore_ranking_history (app_id, list_type, rank, scraped_at)
SELECT id, list_type, rank, updated_at
FROM playstore_rankings;

CREATE INDEX IF NOT EXISTS idx_appstore_ranking_history_app ON appstore_ranking_history USING btree (app_id, list_type, scraped_at DESC);

CREATE INDEX IF NOT EXISTS idx_playstore_ranking_history_app ON playstore_ranking_history USING btree (app_id, list_type, scraped_at DESC);

CREATE INDEX IF NOT EXISTS idx_appstore_apps_category ON appstore_apps USING btree (category);

CREATE INDEX IF NOT EXISTS idx_appstore_apps_indexed_at ON appstore_apps USING btree (indexed_at);

CREATE INDEX IF NOT EXISTS idx_playstore_apps_category ON playstore_apps USING btree (category);

CREATE INDEX IF NOT EXISTS idx_playstore_apps_indexed_at ON playstore_apps USING btree (indexed_at);

-- Drop old tables (replaced by *_apps + *_ranking_history)
DROP TABLE IF EXISTS appstore_rankings;
DROP TABLE IF EXISTS playstore_rankings;
