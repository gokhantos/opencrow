export const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    channel TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    sender_id TEXT NOT NULL,
    sender_name TEXT,
    role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    media_type TEXT,
    timestamp INTEGER NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::INTEGER)
  )`,

  `CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(channel, chat_id, timestamp)`,

  `CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    channel TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::INTEGER),
    updated_at INTEGER NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::INTEGER),
    UNIQUE(channel, chat_id)
  )`,

  `CREATE INDEX IF NOT EXISTS idx_sessions_chat ON sessions(channel, chat_id)`,

  `CREATE TABLE IF NOT EXISTS agent_memory (
    agent_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::INTEGER),
    PRIMARY KEY (agent_id, key)
  )`,

  `CREATE TABLE IF NOT EXISTS memory_sources (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK(kind IN ('conversation','note','document','tweet','article','product','story')),
    agent_id TEXT NOT NULL,
    channel TEXT,
    chat_id TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::INTEGER)
  )`,

  `CREATE INDEX IF NOT EXISTS idx_memory_sources_agent ON memory_sources(agent_id)`,

  `CREATE TABLE IF NOT EXISTS memory_chunks (
    id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL REFERENCES memory_sources(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    chunk_index INTEGER NOT NULL,
    token_count INTEGER NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::INTEGER)
  )`,

  `CREATE INDEX IF NOT EXISTS idx_memory_chunks_source ON memory_chunks(source_id)`,

  `CREATE TABLE IF NOT EXISTS subagent_runs (
    id TEXT PRIMARY KEY,
    parent_agent_id TEXT NOT NULL,
    parent_session_key TEXT NOT NULL,
    child_agent_id TEXT NOT NULL,
    child_session_key TEXT NOT NULL,
    task TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running','completed','error','timeout')),
    result_text TEXT,
    error_message TEXT,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    created_at INTEGER NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::INTEGER)
  )`,

  `CREATE INDEX IF NOT EXISTS idx_subagent_runs_parent ON subagent_runs(parent_session_key, status)`,

  `CREATE TABLE IF NOT EXISTS cron_jobs (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    enabled BOOLEAN DEFAULT TRUE,
    delete_after_run BOOLEAN DEFAULT FALSE,
    schedule_json TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    delivery_json TEXT NOT NULL DEFAULT '{"mode":"none"}',
    next_run_at INTEGER,
    last_run_at INTEGER,
    last_status TEXT,
    last_error TEXT,
    created_at INTEGER DEFAULT (EXTRACT(EPOCH FROM NOW())::INTEGER),
    updated_at INTEGER DEFAULT (EXTRACT(EPOCH FROM NOW())::INTEGER)
  )`,

  `CREATE INDEX IF NOT EXISTS idx_cron_jobs_next_run ON cron_jobs(enabled, next_run_at)`,

  `CREATE TABLE IF NOT EXISTS cron_runs (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES cron_jobs(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK(status IN ('ok','error','timeout')),
    result_summary TEXT,
    error TEXT,
    duration_ms INTEGER NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at INTEGER NOT NULL,
    created_at INTEGER DEFAULT (EXTRACT(EPOCH FROM NOW())::INTEGER)
  )`,

  `CREATE INDEX IF NOT EXISTS idx_cron_runs_job ON cron_runs(job_id, started_at)`,

  `CREATE TABLE IF NOT EXISTS config_overrides (
    namespace TEXT NOT NULL,
    key TEXT NOT NULL,
    value_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::INTEGER),
    PRIMARY KEY (namespace, key)
  )`,

  `CREATE TABLE IF NOT EXISTS conversation_summaries (
    id TEXT PRIMARY KEY,
    channel TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    summary TEXT NOT NULL,
    message_count INTEGER NOT NULL,
    token_estimate INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  )`,

  `CREATE INDEX IF NOT EXISTS idx_conv_summaries_lookup ON conversation_summaries (channel, chat_id, created_at DESC)`,

  `ALTER TABLE memory_chunks ADD COLUMN IF NOT EXISTS tsv_content tsvector`,

  `CREATE INDEX IF NOT EXISTS idx_memory_chunks_fts ON memory_chunks USING gin(tsv_content)`,

  `DROP TABLE IF EXISTS browser_sessions CASCADE`,
  `DROP TABLE IF EXISTS browser_cookie_sets CASCADE`,
  `DROP TABLE IF EXISTS tweets CASCADE`,
  `CREATE TABLE IF NOT EXISTS news_articles (
    id TEXT PRIMARY KEY,
    source_name TEXT NOT NULL,
    title TEXT NOT NULL,
    url TEXT NOT NULL,
    url_hash TEXT NOT NULL,
    published_at TEXT DEFAULT '',
    category TEXT DEFAULT '',
    summary TEXT DEFAULT '',
    sentiment TEXT DEFAULT '',
    image_url TEXT DEFAULT '',
    currencies_json TEXT DEFAULT '[]',
    source_id TEXT DEFAULT '',
    source_domain TEXT DEFAULT '',
    section TEXT DEFAULT '',
    extra_json TEXT DEFAULT '{}',
    scraped_at INTEGER NOT NULL,
    created_at INTEGER DEFAULT (EXTRACT(EPOCH FROM NOW())::INTEGER)
  )`,

  `CREATE UNIQUE INDEX IF NOT EXISTS idx_news_url_hash ON news_articles(url_hash)`,
  `CREATE INDEX IF NOT EXISTS idx_news_source ON news_articles(source_name, scraped_at DESC)`,

  `CREATE TABLE IF NOT EXISTS economic_calendar_events (
    id TEXT PRIMARY KEY,
    event_name TEXT NOT NULL,
    country TEXT DEFAULT '',
    currency TEXT DEFAULT '',
    importance TEXT DEFAULT 'medium',
    event_datetime TEXT DEFAULT '',
    actual TEXT DEFAULT '',
    forecast TEXT DEFAULT '',
    previous TEXT DEFAULT '',
    source_url TEXT DEFAULT '',
    event_hash TEXT NOT NULL DEFAULT '',
    scraped_at INTEGER NOT NULL,
    created_at INTEGER DEFAULT (EXTRACT(EPOCH FROM NOW())::INTEGER)
  )`,

  `CREATE UNIQUE INDEX IF NOT EXISTS idx_calendar_event_hash ON economic_calendar_events(event_hash)`,

  `CREATE TABLE IF NOT EXISTS news_scraper_runs (
    id TEXT PRIMARY KEY,
    source_name TEXT NOT NULL,
    status TEXT CHECK(status IN ('ok','error','timeout')),
    articles_found INTEGER DEFAULT 0,
    articles_new INTEGER DEFAULT 0,
    duration_ms INTEGER NOT NULL,
    error TEXT,
    started_at INTEGER NOT NULL,
    created_at INTEGER DEFAULT (EXTRACT(EPOCH FROM NOW())::INTEGER)
  )`,

  `CREATE INDEX IF NOT EXISTS idx_news_runs_source ON news_scraper_runs(source_name, started_at DESC)`,

  // Drop deprecated tables
  `DROP TABLE IF EXISTS agent_configs CASCADE`,
  `DROP TABLE IF EXISTS auth_state CASCADE`,

  `CREATE TABLE IF NOT EXISTS x_accounts (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    username TEXT,
    display_name TEXT,
    profile_image_url TEXT,
    auth_token TEXT NOT NULL,
    ct0 TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'unverified'
      CHECK(status IN ('unverified','active','expired','error')),
    verified_at INTEGER,
    error_message TEXT,
    created_at INTEGER NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::INTEGER),
    updated_at INTEGER NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::INTEGER)
  )`,

  `ALTER TABLE x_accounts ADD COLUMN IF NOT EXISTS capabilities_json TEXT NOT NULL DEFAULT '{}'`,

  `CREATE TABLE IF NOT EXISTS x_bookmark_jobs (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES x_accounts(id) ON DELETE CASCADE,
    interval_minutes INTEGER NOT NULL DEFAULT 15,
    status TEXT NOT NULL DEFAULT 'stopped'
      CHECK(status IN ('running','stopped')),
    next_run_at INTEGER,
    total_shared INTEGER NOT NULL DEFAULT 0,
    total_errors INTEGER NOT NULL DEFAULT 0,
    last_run_at INTEGER,
    last_error TEXT,
    created_at INTEGER NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::INTEGER),
    updated_at INTEGER NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::INTEGER),
    UNIQUE(account_id)
  )`,

  `CREATE TABLE IF NOT EXISTS x_shared_videos (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES x_accounts(id) ON DELETE CASCADE,
    source_tweet_id TEXT NOT NULL,
    source_author TEXT NOT NULL DEFAULT '',
    source_url TEXT NOT NULL DEFAULT '',
    shared_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::INTEGER)
  )`,

  `CREATE INDEX IF NOT EXISTS idx_x_shared_videos_account
    ON x_shared_videos(account_id, shared_at DESC)`,

  `CREATE UNIQUE INDEX IF NOT EXISTS idx_x_shared_videos_dedup
    ON x_shared_videos(account_id, source_tweet_id)`,

  `CREATE TABLE IF NOT EXISTS ph_accounts (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    username TEXT,
    display_name TEXT,
    avatar_url TEXT,
    cookies_json TEXT NOT NULL DEFAULT '[]',
    session_cookie TEXT NOT NULL DEFAULT '',
    token_cookie TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'unverified'
      CHECK(status IN ('unverified','active','expired','error')),
    verified_at INTEGER,
    error_message TEXT,
    capabilities_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::INTEGER),
    updated_at INTEGER NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::INTEGER)
  )`,

  `ALTER TABLE ph_accounts ADD COLUMN IF NOT EXISTS cookies_json TEXT NOT NULL DEFAULT '[]'`,
  `ALTER TABLE ph_accounts ALTER COLUMN session_cookie SET DEFAULT ''`,

  `CREATE TABLE IF NOT EXISTS ph_products (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL,
    name TEXT NOT NULL,
    tagline TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    url TEXT NOT NULL DEFAULT '',
    website_url TEXT NOT NULL DEFAULT '',
    thumbnail_url TEXT NOT NULL DEFAULT '',
    votes_count INT NOT NULL DEFAULT 0,
    comments_count INT NOT NULL DEFAULT 0,
    is_featured BOOLEAN NOT NULL DEFAULT FALSE,
    rank INT,
    makers_json TEXT NOT NULL DEFAULT '[]',
    topics_json TEXT NOT NULL DEFAULT '[]',
    featured_at INT,
    product_created_at INT,
    account_id TEXT,
    first_seen_at INT NOT NULL,
    updated_at INT NOT NULL
  )`,

  `CREATE INDEX IF NOT EXISTS idx_ph_products_featured_at ON ph_products(featured_at DESC)`,

  `ALTER TABLE ph_accounts ADD COLUMN IF NOT EXISTS last_scraped_at INT`,
  `ALTER TABLE ph_accounts ADD COLUMN IF NOT EXISTS last_scrape_count INT`,

  `CREATE TABLE IF NOT EXISTS hn_stories (
    id TEXT PRIMARY KEY,
    rank INT NOT NULL DEFAULT 0,
    title TEXT NOT NULL,
    url TEXT NOT NULL DEFAULT '',
    site_label TEXT NOT NULL DEFAULT '',
    points INT NOT NULL DEFAULT 0,
    author TEXT NOT NULL DEFAULT '',
    age TEXT NOT NULL DEFAULT '',
    comment_count INT NOT NULL DEFAULT 0,
    hn_url TEXT NOT NULL DEFAULT '',
    feed_type TEXT NOT NULL DEFAULT 'front',
    first_seen_at INT NOT NULL,
    updated_at INT NOT NULL
  )`,

  `CREATE INDEX IF NOT EXISTS idx_hn_stories_updated ON hn_stories(updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_hn_stories_points ON hn_stories(points DESC)`,

  // --- Autolike: scraped tweets + liked tweets ---
  `CREATE TABLE IF NOT EXISTS x_scraped_tweets (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES x_accounts(id) ON DELETE CASCADE,
    tweet_id TEXT NOT NULL,
    author_username TEXT NOT NULL DEFAULT '',
    author_display_name TEXT NOT NULL DEFAULT '',
    author_verified BOOLEAN NOT NULL DEFAULT FALSE,
    author_followers INTEGER NOT NULL DEFAULT 0,
    text TEXT NOT NULL DEFAULT '',
    likes INTEGER NOT NULL DEFAULT 0,
    retweets INTEGER NOT NULL DEFAULT 0,
    replies INTEGER NOT NULL DEFAULT 0,
    views INTEGER NOT NULL DEFAULT 0,
    bookmarks INTEGER NOT NULL DEFAULT 0,
    quotes INTEGER NOT NULL DEFAULT 0,
    has_media BOOLEAN NOT NULL DEFAULT FALSE,
    tweet_created_at INTEGER,
    scraped_at INTEGER NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::INTEGER)
  )`,

  `CREATE UNIQUE INDEX IF NOT EXISTS idx_x_scraped_tweets_dedup
    ON x_scraped_tweets(account_id, tweet_id)`,

  `CREATE INDEX IF NOT EXISTS idx_x_scraped_tweets_account
    ON x_scraped_tweets(account_id, scraped_at DESC)`,

  `CREATE TABLE IF NOT EXISTS x_liked_tweets (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES x_accounts(id) ON DELETE CASCADE,
    tweet_id TEXT NOT NULL,
    author_username TEXT NOT NULL DEFAULT '',
    text TEXT NOT NULL DEFAULT '',
    likes INTEGER NOT NULL DEFAULT 0,
    retweets INTEGER NOT NULL DEFAULT 0,
    views INTEGER NOT NULL DEFAULT 0,
    liked_at INTEGER NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::INTEGER)
  )`,

  `CREATE UNIQUE INDEX IF NOT EXISTS idx_x_liked_tweets_dedup
    ON x_liked_tweets(account_id, tweet_id)`,

  `CREATE INDEX IF NOT EXISTS idx_x_liked_tweets_account
    ON x_liked_tweets(account_id, liked_at DESC)`,

  `CREATE TABLE IF NOT EXISTS x_autolike_jobs (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES x_accounts(id) ON DELETE CASCADE,
    interval_minutes INTEGER NOT NULL DEFAULT 15,
    max_likes_per_run INTEGER NOT NULL DEFAULT 5,
    status TEXT NOT NULL DEFAULT 'stopped'
      CHECK(status IN ('running','stopped')),
    next_run_at INTEGER,
    total_scraped INTEGER NOT NULL DEFAULT 0,
    total_liked INTEGER NOT NULL DEFAULT 0,
    total_errors INTEGER NOT NULL DEFAULT 0,
    last_run_at INTEGER,
    last_error TEXT,
    created_at INTEGER NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::INTEGER),
    updated_at INTEGER NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::INTEGER),
    UNIQUE(account_id)
  )`,

  `ALTER TABLE x_autolike_jobs ADD COLUMN IF NOT EXISTS languages TEXT DEFAULT NULL`,

  // --- Autofollow: jobs + followed users ---
  `CREATE TABLE IF NOT EXISTS x_autofollow_jobs (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES x_accounts(id) ON DELETE CASCADE,
    max_follows_per_run INTEGER NOT NULL DEFAULT 3,
    interval_minutes INTEGER NOT NULL DEFAULT 60,
    languages TEXT DEFAULT NULL,
    status TEXT NOT NULL DEFAULT 'stopped'
      CHECK(status IN ('running','stopped')),
    next_run_at INTEGER,
    total_followed INTEGER NOT NULL DEFAULT 0,
    total_errors INTEGER NOT NULL DEFAULT 0,
    last_run_at INTEGER,
    last_error TEXT,
    created_at INTEGER NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::INTEGER),
    updated_at INTEGER NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::INTEGER),
    UNIQUE(account_id)
  )`,

  `CREATE TABLE IF NOT EXISTS x_followed_users (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES x_accounts(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL DEFAULT '',
    username TEXT NOT NULL,
    display_name TEXT NOT NULL DEFAULT '',
    followers_count INTEGER NOT NULL DEFAULT 0,
    following_count INTEGER NOT NULL DEFAULT 0,
    verified BOOLEAN NOT NULL DEFAULT FALSE,
    source_tweet_id TEXT DEFAULT NULL,
    followed_at INTEGER NOT NULL,
    follow_back BOOLEAN NOT NULL DEFAULT FALSE,
    follow_back_checked_at INTEGER DEFAULT NULL,
    unfollowed_at INTEGER DEFAULT NULL,
    created_at INTEGER NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::INTEGER)
  )`,

  `CREATE UNIQUE INDEX IF NOT EXISTS idx_x_followed_users_dedup
    ON x_followed_users(account_id, username)`,

  `CREATE INDEX IF NOT EXISTS idx_x_followed_users_account
    ON x_followed_users(account_id, followed_at DESC)`,

  // Expand memory_sources kind check to include 'article' and 'product'
  `DO $$ BEGIN
    ALTER TABLE memory_sources DROP CONSTRAINT IF EXISTS memory_sources_kind_check;
    ALTER TABLE memory_sources ADD CONSTRAINT memory_sources_kind_check
      CHECK(kind IN ('conversation','note','document','tweet','article','product','story','reddit_post'));
  END $$`,

  // --- Timeline scraping: add source column + jobs table ---
  `ALTER TABLE x_scraped_tweets ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'timeline'`,

  `CREATE TABLE IF NOT EXISTS x_timeline_scrape_jobs (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES x_accounts(id) ON DELETE CASCADE,
    max_pages INTEGER NOT NULL DEFAULT 3,
    sources TEXT NOT NULL DEFAULT 'home,top_posts',
    interval_minutes INTEGER NOT NULL DEFAULT 10,
    status TEXT NOT NULL DEFAULT 'stopped' CHECK(status IN ('running','stopped')),
    next_run_at INTEGER,
    total_scraped INTEGER NOT NULL DEFAULT 0,
    total_errors INTEGER NOT NULL DEFAULT 0,
    last_run_at INTEGER,
    last_error TEXT,
    created_at INTEGER NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::INTEGER),
    updated_at INTEGER NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::INTEGER),
    UNIQUE(account_id)
  )`,

  // --- Generated Ideas ---
  `CREATE TABLE IF NOT EXISTS generated_ideas (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    reasoning TEXT NOT NULL,
    sources_used TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT 'general',
    created_at INTEGER NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::INTEGER)
  )`,

  `CREATE INDEX IF NOT EXISTS idx_generated_ideas_agent ON generated_ideas(agent_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_generated_ideas_created ON generated_ideas(created_at DESC)`,

  // Idea rating + feedback for dedup & agent learning
  `ALTER TABLE generated_ideas ADD COLUMN IF NOT EXISTS rating TEXT DEFAULT NULL CHECK(rating IN ('good','bad'))`,
  `ALTER TABLE generated_ideas ADD COLUMN IF NOT EXISTS feedback TEXT DEFAULT ''`,

  // --- Reddit accounts + posts ---
  `CREATE TABLE IF NOT EXISTS reddit_accounts (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    username TEXT,
    display_name TEXT,
    avatar_url TEXT,
    cookies_json TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'unverified'
      CHECK(status IN ('unverified','active','expired','error')),
    verified_at INTEGER,
    error_message TEXT,
    last_scraped_at INTEGER,
    last_scrape_count INTEGER,
    created_at INTEGER NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::INTEGER),
    updated_at INTEGER NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::INTEGER)
  )`,

  `CREATE TABLE IF NOT EXISTS reddit_posts (
    id TEXT PRIMARY KEY,
    subreddit TEXT NOT NULL,
    title TEXT NOT NULL,
    url TEXT NOT NULL DEFAULT '',
    selftext TEXT NOT NULL DEFAULT '',
    author TEXT NOT NULL DEFAULT '',
    score INT NOT NULL DEFAULT 0,
    num_comments INT NOT NULL DEFAULT 0,
    permalink TEXT NOT NULL DEFAULT '',
    post_type TEXT NOT NULL DEFAULT 'link',
    feed_source TEXT NOT NULL DEFAULT 'home',
    domain TEXT NOT NULL DEFAULT '',
    upvote_ratio REAL NOT NULL DEFAULT 0,
    created_utc INT,
    first_seen_at INT NOT NULL,
    updated_at INT NOT NULL
  )`,

  `CREATE INDEX IF NOT EXISTS idx_reddit_posts_updated ON reddit_posts(updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_reddit_posts_score ON reddit_posts(score DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_reddit_posts_subreddit ON reddit_posts(subreddit, updated_at DESC)`,

  // --- Add indexed_at column to all content tables for RAG deduplication ---
  `ALTER TABLE reddit_posts ADD COLUMN IF NOT EXISTS indexed_at INT`,
  `ALTER TABLE hn_stories ADD COLUMN IF NOT EXISTS indexed_at INT`,
  `ALTER TABLE news_articles ADD COLUMN IF NOT EXISTS indexed_at INT`,
  `ALTER TABLE ph_products ADD COLUMN IF NOT EXISTS indexed_at INT`,
  `ALTER TABLE x_scraped_tweets ADD COLUMN IF NOT EXISTS indexed_at INT`,

  `CREATE TABLE IF NOT EXISTS sdk_sessions (
    channel TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    sdk_session_id TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::INTEGER),
    updated_at INTEGER NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::INTEGER),
    PRIMARY KEY (channel, chat_id, agent_id)
  )`,

  // --- HuggingFace models ---
  `CREATE TABLE IF NOT EXISTS hf_models (
    id TEXT PRIMARY KEY,
    author TEXT NOT NULL DEFAULT '',
    pipeline_tag TEXT NOT NULL DEFAULT '',
    tags_json TEXT NOT NULL DEFAULT '[]',
    downloads INT NOT NULL DEFAULT 0,
    likes INT NOT NULL DEFAULT 0,
    trending_score REAL NOT NULL DEFAULT 0,
    library_name TEXT NOT NULL DEFAULT '',
    model_created_at TEXT DEFAULT '',
    last_modified TEXT DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    feed_source TEXT NOT NULL DEFAULT 'trending',
    first_seen_at INT NOT NULL,
    updated_at INT NOT NULL,
    indexed_at INT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_hf_models_updated ON hf_models(updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_hf_models_likes ON hf_models(likes DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_hf_models_downloads ON hf_models(downloads DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_hf_models_pipeline_tag ON hf_models(pipeline_tag, updated_at DESC)`,

  // Expand memory_sources kind check to include 'hf_model'
  `DO $$ BEGIN
    ALTER TABLE memory_sources DROP CONSTRAINT IF EXISTS memory_sources_kind_check;
    ALTER TABLE memory_sources ADD CONSTRAINT memory_sources_kind_check
      CHECK(kind IN ('conversation','note','document','tweet','article','product','story','reddit_post','hf_model'));
  END $$`,

  // --- Idea funnel: pipeline stages + model references ---
  `ALTER TABLE generated_ideas ADD COLUMN IF NOT EXISTS pipeline_stage TEXT DEFAULT 'idea'`,
  `ALTER TABLE generated_ideas ADD COLUMN IF NOT EXISTS model_references TEXT DEFAULT ''`,

  // --- GitHub trending repos ---
  `CREATE TABLE IF NOT EXISTS github_repos (
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL DEFAULT '',
    full_name TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    language TEXT NOT NULL DEFAULT '',
    stars INT NOT NULL DEFAULT 0,
    forks INT NOT NULL DEFAULT 0,
    stars_today INT NOT NULL DEFAULT 0,
    built_by_json TEXT NOT NULL DEFAULT '[]',
    url TEXT NOT NULL DEFAULT '',
    period TEXT NOT NULL DEFAULT 'daily',
    first_seen_at INT NOT NULL,
    updated_at INT NOT NULL,
    indexed_at INT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_github_repos_updated ON github_repos(updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_github_repos_stars ON github_repos(stars DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_github_repos_stars_today ON github_repos(stars_today DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_github_repos_language ON github_repos(language, updated_at DESC)`,

  // Expand memory_sources kind check to include 'github_repo'
  `DO $$ BEGIN
    ALTER TABLE memory_sources DROP CONSTRAINT IF EXISTS memory_sources_kind_check;
    ALTER TABLE memory_sources ADD CONSTRAINT memory_sources_kind_check
      CHECK(kind IN ('conversation','note','document','tweet','article','product','story','reddit_post','hf_model','github_repo'));
  END $$`,

  // --- arXiv papers ---
  `CREATE TABLE IF NOT EXISTS arxiv_papers (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT '',
    authors_json TEXT NOT NULL DEFAULT '[]',
    abstract TEXT NOT NULL DEFAULT '',
    categories_json TEXT NOT NULL DEFAULT '[]',
    primary_category TEXT NOT NULL DEFAULT '',
    published_at TEXT NOT NULL DEFAULT '',
    pdf_url TEXT NOT NULL DEFAULT '',
    abs_url TEXT NOT NULL DEFAULT '',
    feed_category TEXT NOT NULL DEFAULT '',
    first_seen_at INT NOT NULL,
    updated_at INT NOT NULL,
    indexed_at INT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_arxiv_papers_updated ON arxiv_papers(updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_arxiv_papers_category ON arxiv_papers(primary_category, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_arxiv_papers_published ON arxiv_papers(published_at DESC)`,

  // --- Semantic Scholar papers ---
  `CREATE TABLE IF NOT EXISTS scholar_papers (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT '',
    authors_json TEXT NOT NULL DEFAULT '[]',
    abstract TEXT NOT NULL DEFAULT '',
    year INT NOT NULL DEFAULT 0,
    venue TEXT NOT NULL DEFAULT '',
    citation_count INT NOT NULL DEFAULT 0,
    reference_count INT NOT NULL DEFAULT 0,
    publication_date TEXT NOT NULL DEFAULT '',
    url TEXT NOT NULL DEFAULT '',
    external_ids_json TEXT NOT NULL DEFAULT '{}',
    tldr TEXT NOT NULL DEFAULT '',
    feed_source TEXT NOT NULL DEFAULT '',
    first_seen_at INT NOT NULL,
    updated_at INT NOT NULL,
    indexed_at INT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_scholar_papers_updated ON scholar_papers(updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_scholar_papers_citations ON scholar_papers(citation_count DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_scholar_papers_year ON scholar_papers(year DESC, citation_count DESC)`,

  // Expand memory_sources kind check to include 'arxiv_paper' + 'scholar_paper' + 'observation'
  `DO $$ BEGIN
    ALTER TABLE memory_sources DROP CONSTRAINT IF EXISTS memory_sources_kind_check;
    ALTER TABLE memory_sources ADD CONSTRAINT memory_sources_kind_check
      CHECK(kind IN ('conversation','note','document','tweet','article','product','story','reddit_post','hf_model','github_repo','arxiv_paper','scholar_paper','observation'));
  END $$`,

  // --- Conversation observations (claude-mem style) ---
  `CREATE TABLE IF NOT EXISTS conversation_observations (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    channel TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    observation_type TEXT NOT NULL,
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    facts_json TEXT NOT NULL DEFAULT '[]',
    concepts_json TEXT NOT NULL DEFAULT '[]',
    tools_used_json TEXT NOT NULL DEFAULT '[]',
    source_message_count INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  )`,

  `CREATE INDEX IF NOT EXISTS idx_observations_agent ON conversation_observations(agent_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_observations_chat ON conversation_observations(channel, chat_id, created_at DESC)`,

  // --- Cron runs observability: allow 'running' status, progress tracking, nullable end fields ---
  `DO $$ BEGIN
    ALTER TABLE cron_runs DROP CONSTRAINT IF EXISTS cron_runs_status_check;
    ALTER TABLE cron_runs ADD CONSTRAINT cron_runs_status_check
      CHECK(status IN ('running','ok','error','timeout'));
  END $$`,
  `ALTER TABLE cron_runs ADD COLUMN IF NOT EXISTS progress_json TEXT`,
  `ALTER TABLE cron_runs ALTER COLUMN ended_at DROP NOT NULL`,
  `ALTER TABLE cron_runs ALTER COLUMN duration_ms DROP NOT NULL`,

  // --- Process isolation infrastructure ---
  `CREATE TABLE IF NOT EXISTS process_registry (
    name TEXT PRIMARY KEY,
    pid INTEGER NOT NULL,
    started_at INTEGER NOT NULL,
    last_heartbeat INTEGER NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}'
  )`,

  `CREATE TABLE IF NOT EXISTS process_commands (
    id TEXT PRIMARY KEY,
    target TEXT NOT NULL,
    action TEXT NOT NULL CHECK(action IN ('restart','stop','cron:run_job')),
    payload_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::INTEGER),
    acknowledged_at INTEGER DEFAULT NULL
  )`,

  `CREATE INDEX IF NOT EXISTS idx_process_commands_target
    ON process_commands(target, acknowledged_at)`,

  `CREATE TABLE IF NOT EXISTS cron_deliveries (
    id TEXT PRIMARY KEY,
    channel TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    job_name TEXT NOT NULL,
    text TEXT NOT NULL,
    preformatted BOOLEAN NOT NULL DEFAULT FALSE,
    created_at INTEGER NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::INTEGER),
    delivered_at INTEGER DEFAULT NULL
  )`,

  `CREATE INDEX IF NOT EXISTS idx_cron_deliveries_pending
    ON cron_deliveries(channel, delivered_at)`,

  // --- Centralized process logs ---
  `CREATE TABLE IF NOT EXISTS process_logs (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    process_name TEXT NOT NULL,
    level TEXT NOT NULL,
    context TEXT NOT NULL,
    message TEXT NOT NULL,
    data_json TEXT,
    created_at INTEGER NOT NULL
  )`,

  `CREATE INDEX IF NOT EXISTS idx_process_logs_lookup
    ON process_logs(created_at DESC, process_name, level)`,

  `CREATE INDEX IF NOT EXISTS idx_process_logs_context
    ON process_logs(context, created_at DESC)`,

  // --- Token usage tracking ---
  `CREATE TABLE IF NOT EXISTS token_usage (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    model TEXT NOT NULL,
    provider TEXT NOT NULL,
    channel TEXT NOT NULL DEFAULT '',
    chat_id TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT 'message',
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    tool_use_count INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::INTEGER)
  )`,

  `CREATE INDEX IF NOT EXISTS idx_token_usage_agent ON token_usage(agent_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_token_usage_created ON token_usage(created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_token_usage_source ON token_usage(source, created_at DESC)`,

  // Expand process_commands action check to include cron:run_job
  `ALTER TABLE process_commands DROP CONSTRAINT IF EXISTS process_commands_action_check`,
  `ALTER TABLE process_commands ADD CONSTRAINT process_commands_action_check CHECK(action IN ('restart','stop','cron:run_job'))`,

  // --- Idea quality score ---
  `ALTER TABLE generated_ideas ADD COLUMN IF NOT EXISTS quality_score REAL DEFAULT NULL`,

  // --- Tool audit log (hooks system) ---
  `CREATE TABLE IF NOT EXISTS tool_audit_log (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    agent_id TEXT NOT NULL,
    session_id TEXT,
    tool_name TEXT NOT NULL,
    tool_input TEXT,
    tool_response TEXT,
    is_error BOOLEAN NOT NULL DEFAULT FALSE,
    created_at INTEGER NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::INTEGER)
  )`,

  `CREATE INDEX IF NOT EXISTS idx_tool_audit_agent_time ON tool_audit_log(agent_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_tool_audit_tool ON tool_audit_log(tool_name, created_at DESC)`,

  // Expand memory_sources kind check to include 'idea'
  `DO $$ BEGIN
    ALTER TABLE memory_sources DROP CONSTRAINT IF EXISTS memory_sources_kind_check;
    ALTER TABLE memory_sources ADD CONSTRAINT memory_sources_kind_check
      CHECK(kind IN ('conversation','note','document','tweet','article','product','story','reddit_post','hf_model','github_repo','arxiv_paper','scholar_paper','observation','idea'));
  END $$`,

  // --- Proactive Monitor: alert history ---
  `CREATE TABLE IF NOT EXISTS monitor_alerts (
    id TEXT PRIMARY KEY,
    category TEXT NOT NULL,
    level TEXT NOT NULL CHECK(level IN ('critical','warning','info')),
    title TEXT NOT NULL,
    detail TEXT NOT NULL,
    metric REAL,
    threshold REAL,
    fired_at INTEGER NOT NULL,
    resolved_at INTEGER,
    created_at INTEGER NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::INTEGER)
  )`,

  `CREATE INDEX IF NOT EXISTS idx_monitor_alerts_fired
    ON monitor_alerts(fired_at DESC)`,

  `CREATE INDEX IF NOT EXISTS idx_monitor_alerts_active
    ON monitor_alerts(resolved_at, fired_at DESC)`,

  // --- Hooks: session history tracking ---
  `CREATE TABLE IF NOT EXISTS session_history (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    agent_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    prompt TEXT,
    result TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(agent_id, session_id)
  )`,

  `CREATE INDEX IF NOT EXISTS idx_session_history_agent ON session_history(agent_id, created_at DESC)`,

  // --- Hooks: user prompt logging ---
  `CREATE TABLE IF NOT EXISTS user_prompt_log (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    agent_id TEXT NOT NULL,
    session_id TEXT,
    prompt TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,

  `CREATE INDEX IF NOT EXISTS idx_user_prompt_log_agent ON user_prompt_log(agent_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_user_prompt_log_session ON user_prompt_log(session_id)`,

  // --- Hooks: subagent audit log ---
  `CREATE TABLE IF NOT EXISTS subagent_audit_log (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    parent_agent_id TEXT NOT NULL,
    session_id TEXT,
    subagent_id TEXT NOT NULL,
    task TEXT,
    status TEXT DEFAULT 'started',
    result TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ
  )`,

  `CREATE INDEX IF NOT EXISTS idx_subagent_audit_parent ON subagent_audit_log(parent_agent_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_subagent_audit_session ON subagent_audit_log(session_id)`,

  // --- Phase 1: Intelligent Routing - Task classification ---
  `CREATE TABLE IF NOT EXISTS task_classification (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    task_hash TEXT NOT NULL,
    session_id TEXT,
    domain TEXT NOT NULL,
    complexity_score INTEGER DEFAULT 1,
    urgency TEXT DEFAULT 'medium',
    keywords_json TEXT NOT NULL DEFAULT '[]',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,

  `CREATE INDEX IF NOT EXISTS idx_task_classification_domain ON task_classification(domain, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_task_classification_hash ON task_classification(task_hash)`,

  // --- Routing decisions for learning ---
  `CREATE TABLE IF NOT EXISTS routing_decisions (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    session_id TEXT,
    task_hash TEXT,
    selected_agent_id TEXT NOT NULL,
    alternative_agents_json TEXT NOT NULL DEFAULT '[]',
    decision_reason TEXT,
    outcome_status TEXT,
    outcome_score REAL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,

  `CREATE INDEX IF NOT EXISTS idx_routing_decisions_session ON routing_decisions(session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_routing_decisions_agent ON routing_decisions(selected_agent_id, created_at DESC)`,

  // --- Performance scores (computed by cron) ---
  `CREATE TABLE IF NOT EXISTS agent_scores (
    agent_id TEXT NOT NULL,
    domain TEXT,
    time_window TEXT NOT NULL,
    success_rate REAL,
    avg_duration_sec REAL,
    avg_cost_usd REAL,
    total_tasks INTEGER,
    score REAL,
    computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (agent_id, domain, time_window)
  )`,

  `CREATE INDEX IF NOT EXISTS idx_agent_scores_domain ON agent_scores(domain, score DESC NULLS LAST)`,

  // --- Tool performance scores ---
  `CREATE TABLE IF NOT EXISTS tool_scores (
    tool_name TEXT NOT NULL,
    time_window TEXT NOT NULL,
    total_calls INTEGER,
    error_rate REAL,
    avg_latency_ms REAL,
    score REAL,
    computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (tool_name, time_window)
  )`,

  // --- Phase 1: MCP Server Performance Tracking ---
  `CREATE TABLE IF NOT EXISTS mcp_performance (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    mcp_server TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    duration_ms INTEGER NOT NULL,
    is_error BOOLEAN DEFAULT FALSE,
    error_message TEXT,
    cost_usd REAL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_mcp_perf_server ON mcp_performance(mcp_server, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_mcp_perf_tool ON mcp_performance(tool_name, created_at DESC)`,

  // --- MCP performance scores (computed by cron) ---
  `CREATE TABLE IF NOT EXISTS mcp_scores (
    mcp_server TEXT NOT NULL,
    time_window TEXT NOT NULL,
    total_calls INTEGER,
    p95_latency_ms REAL,
    reliability REAL,
    avg_cost_usd REAL,
    score REAL,
    computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (mcp_server, time_window)
  )`,

  // --- Phase 5: Cost Tracking ---
  `CREATE TABLE IF NOT EXISTS cost_tracking (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    agent_id TEXT NOT NULL,
    task_hash TEXT,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cost_usd REAL NOT NULL,
    model_used TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_cost_agent ON cost_tracking(agent_id, created_at DESC)`,

  // --- Phase 7: Enhanced Task Classification ---
  `ALTER TABLE task_classification ADD COLUMN IF NOT EXISTS semantic_domain TEXT`,
  `ALTER TABLE task_classification ADD COLUMN IF NOT EXISTS confidence_score REAL`,
  `ALTER TABLE task_classification ADD COLUMN IF NOT EXISTS corrected_domain TEXT`,

  // --- Phase 8: Pre-warming Cache ---
  `CREATE TABLE IF NOT EXISTS prewarm_cache (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    domain TEXT NOT NULL,
    context_data JSONB NOT NULL,
    hit_rate REAL DEFAULT 0,
    last_used TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_prewarm_domain ON prewarm_cache(domain)`,

  // --- Phase 1 (Intelligence): Task Embeddings for Semantic Similarity ---
  `CREATE TABLE IF NOT EXISTS task_embeddings (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    task_hash TEXT NOT NULL UNIQUE,
    embedding REAL[] NOT NULL,
    embedding_dim INTEGER NOT NULL DEFAULT 512,
    domain TEXT NOT NULL,
    outcome_score REAL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_task_embeddings_hash ON task_embeddings(task_hash)`,
  `CREATE INDEX IF NOT EXISTS idx_task_embeddings_domain ON task_embeddings(domain, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_task_embeddings_created ON task_embeddings(created_at DESC)`,

  // --- Phase 2: Conversation State Tracking ---
  `CREATE TABLE IF NOT EXISTS conversation_state (
    session_id TEXT PRIMARY KEY,
    current_topic TEXT,
    topic_history JSONB NOT NULL DEFAULT '[]',
    current_turn INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL DEFAULT 'exploration' CHECK(state IN ('exploration', 'implementation', 'review', 'deploy')),
    last_activity TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_conversation_state_topic ON conversation_state(current_topic)`,

  `CREATE TABLE IF NOT EXISTS conversation_topics (
    topic_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    topic TEXT NOT NULL,
    keywords TEXT[] NOT NULL DEFAULT '{}',
    agent_used TEXT,
    outcome_score REAL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_conversation_topics_session ON conversation_topics(session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_conversation_topics_topic ON conversation_topics(topic)`,

  // --- Phase 2: Task Outcomes & Learning Loop ---
  `CREATE TABLE IF NOT EXISTS task_outcomes (
    task_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    task_hash TEXT NOT NULL,
    domain TEXT NOT NULL,
    agents_spawned TEXT[] NOT NULL DEFAULT '{}',
    revision_count INTEGER NOT NULL DEFAULT 0,
    user_feedback TEXT CHECK(user_feedback IN ('good', 'neutral', 'bad')),
    time_to_complete INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_task_outcomes_session ON task_outcomes(session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_task_outcomes_hash ON task_outcomes(task_hash)`,
  `CREATE INDEX IF NOT EXISTS idx_task_outcomes_domain ON task_outcomes(domain)`,

  `CREATE TABLE IF NOT EXISTS survey_responses (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    session_id TEXT NOT NULL,
    task_hash TEXT NOT NULL,
    feedback_type TEXT NOT NULL CHECK(feedback_type IN ('good', 'neutral', 'bad')),
    feedback_text TEXT,
    revision_requested BOOLEAN DEFAULT FALSE,
    response_time_sec INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_survey_responses_session ON survey_responses(session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_survey_responses_feedback ON survey_responses(feedback_type)`,

  `CREATE TABLE IF NOT EXISTS task_revisions (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    session_id TEXT NOT NULL,
    task_hash TEXT NOT NULL,
    attempt_number INTEGER NOT NULL,
    agent_id TEXT NOT NULL,
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_task_revisions_session ON task_revisions(session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_task_revisions_hash ON task_revisions(task_hash)`,

  `CREATE TABLE IF NOT EXISTS agent_score_adjustments (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    agent_id TEXT NOT NULL,
    domain TEXT,
    adjustment_type TEXT NOT NULL CHECK(adjustment_type IN ('outcome_bonus', 'revision_penalty', 'survey_bonus', 'survey_penalty', 'timeout_penalty')),
    adjustment_value REAL NOT NULL,
    reason TEXT NOT NULL,
    session_id TEXT,
    task_hash TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_agent_score_adjustments_agent ON agent_score_adjustments(agent_id, created_at DESC)`,

  // --- Phase 3: Load Balancing - Agent Capacity Tracking ---
  `CREATE TABLE IF NOT EXISTS agent_capacity (
    agent_id TEXT PRIMARY KEY,
    current_load INTEGER NOT NULL DEFAULT 0,
    max_capacity INTEGER NOT NULL DEFAULT 3,
    queue_depth INTEGER NOT NULL DEFAULT 0,
    avg_task_duration_sec REAL NOT NULL DEFAULT 60,
    last_updated TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_agent_capacity_load ON agent_capacity(current_load)`,

  // --- Phase 3: Task Queue for Load Balancing ---
  `CREATE TABLE IF NOT EXISTS task_queue (
    queue_id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    domain TEXT NOT NULL,
    task TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 5,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'running', 'completed', 'cancelled', 'failed')),
    preferred_agent TEXT,
    assigned_agent TEXT,
    result TEXT,
    error_message TEXT,
    enqueued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ
  )`,
  `CREATE INDEX IF NOT EXISTS idx_task_queue_status ON task_queue(status, priority DESC, enqueued_at ASC)`,
  `CREATE INDEX IF NOT EXISTS idx_task_queue_session ON task_queue(session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_task_queue_agent ON task_queue(assigned_agent)`,

  // --- Phase 3: Workload History for Trend Analysis ---
  `CREATE TABLE IF NOT EXISTS workload_history (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    sampled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    total_tasks INTEGER NOT NULL DEFAULT 0,
    avg_queue_depth REAL NOT NULL DEFAULT 0,
    agent_utilization_json TEXT NOT NULL DEFAULT '[]'
  )`,
  `CREATE INDEX IF NOT EXISTS idx_workload_history_sampled ON workload_history(sampled_at DESC)`,

  // --- Phase 3: Failure Pattern Recognition ---
  `CREATE TABLE IF NOT EXISTS failure_records (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    session_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    domain TEXT NOT NULL,
    error_message TEXT NOT NULL,
    error_signature TEXT NOT NULL,
    error_type TEXT NOT NULL DEFAULT 'unknown',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_failure_records_agent ON failure_records(agent_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_failure_records_domain ON failure_records(domain, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_failure_records_signature ON failure_records(error_signature)`,

  // --- Phase 3: Failure Patterns (Clustered) ---
  `CREATE TABLE IF NOT EXISTS failure_patterns (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    domain TEXT NOT NULL,
    agent_id TEXT,
    error_signature TEXT NOT NULL,
    occurrence_count INTEGER NOT NULL DEFAULT 1,
    first_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    affected_sessions TEXT[] NOT NULL DEFAULT '{}',
    recommended_action TEXT,
    is_resolved BOOLEAN NOT NULL DEFAULT FALSE,
    UNIQUE(domain, agent_id, error_signature)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_failure_patterns_domain ON failure_patterns(domain, is_resolved, occurrence_count DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_failure_patterns_agent ON failure_patterns(agent_id, is_resolved, occurrence_count DESC)`,

  // --- Phase 3: Anti-Recommendations (Routing Avoidance) ---
  `CREATE TABLE IF NOT EXISTS anti_recommendations (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    domain TEXT,
    reason TEXT NOT NULL,
    failure_count INTEGER NOT NULL DEFAULT 0,
    confidence REAL NOT NULL DEFAULT 0.5,
    valid_until TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(agent_id, domain)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_anti_recommendations_agent ON anti_recommendations(agent_id, valid_until)`,
  `CREATE INDEX IF NOT EXISTS idx_anti_recommendations_valid ON anti_recommendations(valid_until)`,

  // ============================================
  // Phase 4: Deep Outcome Learning
  // ============================================

  // Phase 4: Post-Task Survey Configuration
  `CREATE TABLE IF NOT EXISTS survey_configs (
    id TEXT PRIMARY KEY,
    survey_type TEXT NOT NULL DEFAULT 'post_task' CHECK(survey_type IN ('post_task', 'post_failure', 'periodic')),
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    trigger_delay_sec INTEGER NOT NULL DEFAULT 30,
    questions_json TEXT NOT NULL DEFAULT '[]',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,

  // Phase 4: Enhanced Survey Responses with structured data
  `CREATE TABLE IF NOT EXISTS survey_responses_enhanced (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    session_id TEXT NOT NULL,
    task_hash TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    survey_type TEXT NOT NULL DEFAULT 'post_task',
    overall_rating INTEGER CHECK(overall_rating >= 1 AND overall_rating <= 5),
    speed_rating INTEGER CHECK(speed_rating >= 1 AND speed_rating <= 5),
    quality_rating INTEGER CHECK(quality_rating >= 1 AND quality_rating <= 5),
    feedback_text TEXT,
    tags_json TEXT NOT NULL DEFAULT '[]',
    would_use_again BOOLEAN,
    response_time_sec INTEGER,
    delivered_via TEXT DEFAULT 'telegram',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_survey_enhanced_session ON survey_responses_enhanced(session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_survey_enhanced_agent ON survey_responses_enhanced(agent_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_survey_enhanced_rating ON survey_responses_enhanced(overall_rating)`,

  // Phase 4: Agent Reflection/Post-Mortem Records
  `CREATE TABLE IF NOT EXISTS agent_reflections (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    task_hash TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    reflection_type TEXT NOT NULL CHECK(reflection_type IN ('post_failure', 'post_success', 'periodic')),
    outcome_status TEXT NOT NULL CHECK(outcome_status IN ('success', 'partial', 'failure')),
    what_went_well TEXT,
    what_went_wrong TEXT,
    root_cause_analysis TEXT,
    lessons_learned_json TEXT NOT NULL DEFAULT '[]',
    improvement_actions_json TEXT NOT NULL DEFAULT '[]',
    similar_past_failures TEXT[] DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_reflections_session ON agent_reflections(session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_reflections_agent ON agent_reflections(agent_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_reflections_outcome ON agent_reflections(outcome_status)`,

  // Phase 4: Outcome-Enhanced Routing Cache
  `CREATE TABLE IF NOT EXISTS outcome_routing_cache (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    domain TEXT NOT NULL,
    task_embedding REAL[] DEFAULT '{}',
    successful_agents_json TEXT NOT NULL DEFAULT '[]',
    failed_agents_json TEXT NOT NULL DEFAULT '[]',
    total_tasks INTEGER NOT NULL DEFAULT 0,
    success_rate REAL NOT NULL DEFAULT 0,
    last_updated TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ
  )`,
  `CREATE INDEX IF NOT EXISTS idx_outcome_cache_domain ON outcome_routing_cache(domain, expires_at)`,

  // Phase 4: Failure Cluster Signatures
  `CREATE TABLE IF NOT EXISTS failure_clusters (
    id TEXT PRIMARY KEY,
    cluster_name TEXT NOT NULL,
    cluster_signature TEXT NOT NULL,
    domain TEXT NOT NULL,
    affected_agents TEXT[] NOT NULL DEFAULT '{}',
    affected_sessions TEXT[] NOT NULL DEFAULT '{}',
    occurrence_count INTEGER NOT NULL DEFAULT 1,
    first_occurrence TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_occurrence TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    severity TEXT NOT NULL DEFAULT 'medium' CHECK(severity IN ('low', 'medium', 'high', 'critical')),
    resolution_steps_json TEXT NOT NULL DEFAULT '[]',
    is_resolved BOOLEAN NOT NULL DEFAULT FALSE,
    resolved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_failure_clusters_domain ON failure_clusters(domain, is_resolved, occurrence_count DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_failure_clusters_severity ON failure_clusters(severity, is_resolved)`,

  // Phase 4: Learning Events (audit trail for all learning)
  `CREATE TABLE IF NOT EXISTS learning_events (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_type TEXT NOT NULL CHECK(event_type IN ('survey_submitted', 'reflection_created', 'pattern_discovered', 'routing_updated', 'score_adjusted')),
    session_id TEXT,
    task_hash TEXT,
    agent_id TEXT,
    domain TEXT,
    event_data_json TEXT NOT NULL DEFAULT '{}',
    learning_impact TEXT NOT NULL DEFAULT 'pending' CHECK(learning_impact IN ('pending', 'applied', 'expired', 'overridden')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_learning_events_type ON learning_events(event_type, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_learning_events_agent ON learning_events(agent_id, created_at DESC)`,

  // Phase 4: Pending Surveys (for delayed delivery)
  `CREATE TABLE IF NOT EXISTS pending_surveys (
    session_id TEXT PRIMARY KEY,
    task_hash TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    message_text TEXT,
    questions_json TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'delivered', 'answered', 'expired', 'cancelled')),
    expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_pending_surveys_status ON pending_surveys(status, created_at)`,

  // Phase 4: Schema modifications to existing tables
  `ALTER TABLE survey_responses ADD COLUMN IF NOT EXISTS message_id INTEGER`,
  `ALTER TABLE survey_responses ADD COLUMN IF NOT EXISTS chat_id TEXT`,
  `ALTER TABLE survey_responses ADD COLUMN IF NOT EXISTS is_anonymous BOOLEAN DEFAULT FALSE`,
  `ALTER TABLE survey_responses ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ`,
  `ALTER TABLE survey_responses ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'pending'`,
  `ALTER TABLE survey_responses ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ`,
  `ALTER TABLE survey_responses ADD COLUMN IF NOT EXISTS answered_at TIMESTAMPTZ`,
  `ALTER TABLE task_outcomes ADD COLUMN IF NOT EXISTS quality_score REAL`,
  `ALTER TABLE task_outcomes ADD COLUMN IF NOT EXISTS auto_generated_reflection BOOLEAN DEFAULT FALSE`,
  `ALTER TABLE failure_patterns ADD COLUMN IF NOT EXISTS severity TEXT DEFAULT 'medium'`,
  `ALTER TABLE failure_patterns ADD COLUMN IF NOT EXISTS last_occurrence TIMESTAMPTZ`,

  // ============================================================================
  // Phase 5: Advanced Intelligence
  // ============================================================================

  // Phase 5: Task Decompositions
  `CREATE TABLE IF NOT EXISTS task_decompositions (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    task_hash TEXT NOT NULL,
    original_task TEXT NOT NULL,
    complexity_score INTEGER NOT NULL DEFAULT 1,
    decomposition_json TEXT NOT NULL DEFAULT '{}',
    spawn_chain_json TEXT NOT NULL DEFAULT '[]',
    execution_order TEXT[] NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'in_progress', 'completed', 'failed', 'partial')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ
  )`,
  `CREATE INDEX IF NOT EXISTS idx_task_decompositions_session ON task_decompositions(session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_task_decompositions_status ON task_decompositions(status, created_at DESC)`,

  // Phase 5: Prediction Records (historical data for ML)
  `CREATE TABLE IF NOT EXISTS prediction_records (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    session_id TEXT NOT NULL,
    task_hash TEXT NOT NULL,
    task_text TEXT NOT NULL,
    predicted_domain TEXT NOT NULL,
    predicted_agent TEXT NOT NULL,
    confidence_score REAL NOT NULL,
    actual_domain TEXT,
    actual_agent TEXT,
    was_correct BOOLEAN,
    features_json TEXT NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_prediction_records_domain ON prediction_records(predicted_domain, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_prediction_records_correct ON prediction_records(was_correct, created_at DESC)`,

  // Phase 5: User Preferences
  `CREATE TABLE IF NOT EXISTS user_preferences (
    id TEXT PRIMARY KEY,
    preference_type TEXT NOT NULL CHECK(preference_type IN ('communication', 'coding', 'workflow', 'tool', 'model')),
    preference_key TEXT NOT NULL,
    preference_value TEXT NOT NULL,
    confidence REAL NOT NULL DEFAULT 0.5,
    source_session_id TEXT,
    expires_at TIMESTAMPTZ,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_user_preferences_type ON user_preferences(preference_type, is_active)`,
  `CREATE INDEX IF NOT EXISTS idx_user_preferences_active ON user_preferences(is_active, updated_at DESC)`,

  // Phase 5: Cross-Session Context
  `CREATE TABLE IF NOT EXISTS cross_session_context (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    topics_json TEXT NOT NULL DEFAULT '[]',
    task_embedding REAL[] DEFAULT '{}',
    summary TEXT NOT NULL,
    key_decisions_json TEXT NOT NULL DEFAULT '[]',
    files_touched TEXT[] DEFAULT '{}',
    agents_spawned TEXT[] DEFAULT '{}',
    outcomes_json TEXT NOT NULL DEFAULT '[]',
    relevance_decay REAL NOT NULL DEFAULT 1.0,
    expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_cross_session_session ON cross_session_context(session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_cross_session_expiry ON cross_session_context(expires_at)`,

  // Phase 5: Self-Reflection Logs
  `CREATE TABLE IF NOT EXISTS self_reflection_logs (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    session_id TEXT NOT NULL,
    task_hash TEXT,
    agent_id TEXT NOT NULL,
    trigger_type TEXT NOT NULL CHECK(trigger_type IN ('timeout', 'loop_detected', 'repeated_failures', 'complexity_overflow', 'manual')),
    trigger_details_json TEXT NOT NULL DEFAULT '{}',
    reflection_text TEXT NOT NULL,
    action_taken TEXT NOT NULL CHECK(action_taken IN ('continue', 'retry', 'escalate', 'switch_agent', 'request_clarification')),
    escalation_target TEXT,
    is_resolved BOOLEAN NOT NULL DEFAULT FALSE,
    resolved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_self_reflection_session ON self_reflection_logs(session_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_self_reflection_agent ON self_reflection_logs(agent_id, trigger_type)`,

  // Phase 5: Prediction Models (trained weights)
  `CREATE TABLE IF NOT EXISTS prediction_models (
    id TEXT PRIMARY KEY,
    model_version TEXT NOT NULL,
    training_data_count INTEGER NOT NULL,
    weights_json TEXT NOT NULL DEFAULT '{}',
    accuracy_metrics_json TEXT NOT NULL DEFAULT '{}',
    is_active BOOLEAN NOT NULL DEFAULT FALSE,
    trained_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ
  )`,
  `CREATE INDEX IF NOT EXISTS idx_prediction_models_active ON prediction_models(is_active, trained_at DESC)`,

  // Phase 5: Preference Extractions (audit trail)
  `CREATE TABLE IF NOT EXISTS preference_extractions (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    session_id TEXT NOT NULL,
    message_id TEXT,
    extracted_preferences_json TEXT NOT NULL DEFAULT '[]',
    extraction_confidence REAL NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_preference_extractions_session ON preference_extractions(session_id, created_at DESC)`,

  // Phase 5: Prediction Performance Tracking
  `CREATE TABLE IF NOT EXISTS prediction_performance (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    domain TEXT NOT NULL,
    total_predictions INTEGER NOT NULL DEFAULT 0,
    correct_predictions INTEGER NOT NULL DEFAULT 0,
    accuracy_rate REAL NOT NULL DEFAULT 0,
    last_predicted_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_prediction_performance_domain ON prediction_performance(domain)`,

  // Phase 5: Schema modifications
  `ALTER TABLE task_embeddings ADD COLUMN IF NOT EXISTS complexity_score INTEGER DEFAULT 1`,
  `ALTER TABLE task_embeddings ADD COLUMN IF NOT EXISTS requires_decomposition BOOLEAN DEFAULT FALSE`,

  // --- Research Signals (for idea generation pipeline) ---
  `CREATE TABLE IF NOT EXISTS research_signals (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    signal_type TEXT NOT NULL DEFAULT 'trend',
    title TEXT NOT NULL,
    detail TEXT NOT NULL,
    source TEXT NOT NULL,
    source_url TEXT NOT NULL DEFAULT '',
    strength INTEGER NOT NULL DEFAULT 3,
    themes TEXT NOT NULL DEFAULT '',
    consumed BOOLEAN NOT NULL DEFAULT false,
    created_at INTEGER NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::INTEGER)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_signals_agent ON research_signals (agent_id, consumed, created_at DESC)`,

  // Convert idea rating from binary good/bad text to 0-5 integer stars
  `ALTER TABLE generated_ideas ALTER COLUMN rating DROP DEFAULT`,
  `ALTER TABLE generated_ideas DROP CONSTRAINT IF EXISTS generated_ideas_rating_check`,
  `ALTER TABLE generated_ideas ALTER COLUMN rating TYPE INTEGER USING CASE WHEN rating = 'good' THEN 5 WHEN rating = 'bad' THEN 1 ELSE NULL END`,
  `ALTER TABLE generated_ideas ALTER COLUMN rating SET DEFAULT NULL`,
  `ALTER TABLE generated_ideas ADD CONSTRAINT generated_ideas_rating_check CHECK(rating >= 0 AND rating <= 5)`,
  `ALTER TABLE generated_ideas DROP COLUMN IF EXISTS feedback`,

  // Phase 6: DexScreener token tracking
  `CREATE TABLE IF NOT EXISTS dexscreener_tokens (
    id TEXT PRIMARY KEY,
    symbol TEXT NOT NULL,
    name TEXT NOT NULL,
    address TEXT NOT NULL,
    chain_id TEXT NOT NULL,
    price_usd TEXT NOT NULL,
    price_change_24h REAL NOT NULL DEFAULT 0,
    volume_24h REAL NOT NULL DEFAULT 0,
    liquidity_usd REAL,
    market_cap REAL,
    pair_url TEXT NOT NULL,
    is_trending BOOLEAN NOT NULL DEFAULT false,
    is_new BOOLEAN NOT NULL DEFAULT false,
    token_hash TEXT NOT NULL,
    scraped_at INTEGER NOT NULL,
    created_at INTEGER DEFAULT (EXTRACT(EPOCH FROM NOW())::INTEGER)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_dexscreener_token_hash ON dexscreener_tokens(token_hash)`,
  `CREATE INDEX IF NOT EXISTS idx_dexscreener_trending ON dexscreener_tokens(is_trending, scraped_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_dexscreener_new ON dexscreener_tokens(is_new, scraped_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_dexscreener_symbol ON dexscreener_tokens(symbol)`,
  `ALTER TABLE dexscreener_tokens ADD COLUMN IF NOT EXISTS image_url TEXT`,
  `ALTER TABLE dexscreener_tokens ADD COLUMN IF NOT EXISTS boost_amount INTEGER DEFAULT 0`,

  // --- DeFi Llama: protocols ---
  `CREATE TABLE IF NOT EXISTS defi_protocols (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT 'Unknown',
    chain TEXT NOT NULL DEFAULT 'unknown',
    chains_json TEXT NOT NULL DEFAULT '[]',
    tvl NUMERIC NOT NULL DEFAULT 0,
    tvl_prev NUMERIC,
    change_1d REAL,
    change_7d REAL,
    url TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    first_seen_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    indexed_at INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS idx_defi_protocols_tvl ON defi_protocols(tvl DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_defi_protocols_chain ON defi_protocols(chain, tvl DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_defi_protocols_category ON defi_protocols(category, tvl DESC)`,

  // --- DeFi Llama: chain TVL snapshots ---
  `CREATE TABLE IF NOT EXISTS defi_chain_tvls (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL DEFAULT '',
    tvl NUMERIC NOT NULL DEFAULT 0,
    tvl_prev NUMERIC,
    protocols_count INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_defi_chain_tvls_tvl ON defi_chain_tvls(tvl DESC)`,

  // --- DeFi Llama: historical daily TVL per chain ---
  `CREATE TABLE IF NOT EXISTS defi_chain_tvl_history (
    chain_id TEXT NOT NULL,
    date INTEGER NOT NULL,
    tvl NUMERIC NOT NULL DEFAULT 0,
    PRIMARY KEY (chain_id, date)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_defi_chain_tvl_history_date ON defi_chain_tvl_history(chain_id, date DESC)`,

  // --- DeFi Llama: chain metrics (fees, revenue, DEX volume, stablecoins) ---
  `CREATE TABLE IF NOT EXISTS defi_chain_metrics (
    chain_id TEXT NOT NULL,
    metric_date INTEGER NOT NULL,
    fees_24h NUMERIC,
    fees_7d NUMERIC,
    fees_30d NUMERIC,
    fees_change_1d REAL,
    revenue_24h NUMERIC,
    revenue_7d NUMERIC,
    revenue_30d NUMERIC,
    revenue_change_1d REAL,
    dex_volume_24h NUMERIC,
    dex_volume_7d NUMERIC,
    dex_volume_30d NUMERIC,
    dex_volume_change_1d REAL,
    stablecoin_mcap NUMERIC,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (chain_id, metric_date)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_defi_chain_metrics_date ON defi_chain_metrics(chain_id, metric_date DESC)`,

  // --- DeFi Llama: protocol detail enrichment ---
  `CREATE TABLE IF NOT EXISTS defi_protocol_detail (
    id TEXT PRIMARY KEY,
    symbol TEXT DEFAULT '',
    logo TEXT DEFAULT '',
    twitter TEXT DEFAULT '',
    description_full TEXT DEFAULT '',
    mcap NUMERIC,
    chains_json TEXT DEFAULT '[]',
    current_chain_tvls_json TEXT DEFAULT '{}',
    raises_json TEXT DEFAULT '[]',
    fees_24h NUMERIC,
    fees_7d NUMERIC,
    revenue_24h NUMERIC,
    revenue_7d NUMERIC,
    updated_at INTEGER NOT NULL
  )`,

  // --- DeFi Llama: categories ---
  `CREATE TABLE IF NOT EXISTS defi_categories (
    name TEXT PRIMARY KEY,
    tvl NUMERIC DEFAULT 0,
    percentage REAL DEFAULT 0,
    protocol_count INTEGER DEFAULT 0,
    updated_at INTEGER NOT NULL
  )`,

  // --- DeFi Llama: global metrics (fees, dex volumes, options, derivatives) ---
  `CREATE TABLE IF NOT EXISTS defi_global_metrics (
    metric_type TEXT NOT NULL,
    metric_date INTEGER NOT NULL,
    total_24h NUMERIC,
    total_7d NUMERIC,
    change_1d REAL,
    extra_json TEXT DEFAULT '{}',
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (metric_type, metric_date)
  )`,

  // --- DeFi Llama: per-protocol metrics ---
  `CREATE TABLE IF NOT EXISTS defi_protocol_metrics (
    protocol_id TEXT NOT NULL,
    metric_type TEXT NOT NULL,
    value_24h NUMERIC,
    value_7d NUMERIC,
    change_1d REAL,
    chains_json TEXT DEFAULT '[]',
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (protocol_id, metric_type)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_defi_protocol_metrics_type ON defi_protocol_metrics (metric_type, value_24h DESC)`,

  // --- DeFiLlama Phase 3: yields, bridges, hacks, stablecoins, emissions, treasury ---
  `CREATE TABLE IF NOT EXISTS defi_yield_pools (
    pool_id TEXT PRIMARY KEY,
    chain TEXT NOT NULL DEFAULT '',
    project TEXT NOT NULL DEFAULT '',
    symbol TEXT NOT NULL DEFAULT '',
    tvl_usd NUMERIC DEFAULT 0,
    apy REAL,
    apy_base REAL,
    apy_reward REAL,
    apy_base_7d REAL,
    volume_usd_1d NUMERIC,
    volume_usd_7d NUMERIC,
    pool_meta TEXT DEFAULT '',
    exposure TEXT DEFAULT '',
    reward_tokens_json TEXT DEFAULT '[]',
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_defi_yield_pools_chain ON defi_yield_pools (chain, tvl_usd DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_defi_yield_pools_apy ON defi_yield_pools (apy DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_defi_yield_pools_project ON defi_yield_pools (project)`,

  `CREATE TABLE IF NOT EXISTS defi_bridges (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL DEFAULT '',
    display_name TEXT DEFAULT '',
    volume_prev_day NUMERIC,
    volume_prev_2day NUMERIC,
    last_24h_volume NUMERIC,
    chain_breakdown_json TEXT DEFAULT '{}',
    updated_at INTEGER NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS defi_hacks (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL DEFAULT '',
    protocol TEXT DEFAULT '',
    amount NUMERIC DEFAULT 0,
    chain TEXT DEFAULT '',
    classification TEXT DEFAULT '',
    technique TEXT DEFAULT '',
    date INTEGER NOT NULL,
    description TEXT DEFAULT '',
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_defi_hacks_date ON defi_hacks (date DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_defi_hacks_amount ON defi_hacks (amount DESC)`,

  `CREATE TABLE IF NOT EXISTS defi_emissions (
    protocol_id TEXT PRIMARY KEY,
    name TEXT NOT NULL DEFAULT '',
    token TEXT DEFAULT '',
    circ_supply NUMERIC,
    total_locked NUMERIC,
    max_supply NUMERIC,
    unlocks_per_day NUMERIC,
    mcap NUMERIC,
    next_event_date INTEGER,
    next_event_unlock NUMERIC,
    events_json TEXT DEFAULT '[]',
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_defi_emissions_next ON defi_emissions (next_event_date ASC)`,

  `CREATE TABLE IF NOT EXISTS defi_stablecoins (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL DEFAULT '',
    symbol TEXT DEFAULT '',
    peg_type TEXT DEFAULT '',
    circulating NUMERIC DEFAULT 0,
    chains_json TEXT DEFAULT '[]',
    price REAL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_defi_stablecoins_circ ON defi_stablecoins (circulating DESC)`,

  `CREATE TABLE IF NOT EXISTS defi_treasury (
    protocol_id TEXT PRIMARY KEY,
    name TEXT NOT NULL DEFAULT '',
    total_usd NUMERIC DEFAULT 0,
    own_tokens_usd NUMERIC DEFAULT 0,
    stablecoins_usd NUMERIC DEFAULT 0,
    majors_usd NUMERIC DEFAULT 0,
    others_usd NUMERIC DEFAULT 0,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_defi_treasury_total ON defi_treasury (total_usd DESC)`,

  // --- ProductHunt: add review metrics ---
  `ALTER TABLE ph_products ADD COLUMN IF NOT EXISTS reviews_count INT NOT NULL DEFAULT 0`,
  `ALTER TABLE ph_products ADD COLUMN IF NOT EXISTS reviews_rating REAL NOT NULL DEFAULT 0`,

  // --- HackerNews: add description and top comments ---
  `ALTER TABLE hn_stories ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE hn_stories ADD COLUMN IF NOT EXISTS top_comments_json TEXT NOT NULL DEFAULT '[]'`,

  // --- Reddit: enrich posts with flair, thumbnail, and top comments ---
  `ALTER TABLE reddit_posts ADD COLUMN IF NOT EXISTS top_comments_json TEXT DEFAULT NULL`,
  `ALTER TABLE reddit_posts ADD COLUMN IF NOT EXISTS flair TEXT DEFAULT NULL`,
  `ALTER TABLE reddit_posts ADD COLUMN IF NOT EXISTS thumbnail_url TEXT DEFAULT NULL`,

  // --- Google Trends ---
  `CREATE TABLE IF NOT EXISTS google_trends (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    traffic_volume TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT '',
    source_url TEXT NOT NULL DEFAULT '',
    related_queries TEXT NOT NULL DEFAULT '',
    picture_url TEXT DEFAULT NULL,
    news_items_json TEXT DEFAULT NULL,
    geo TEXT NOT NULL DEFAULT 'US',
    category TEXT NOT NULL DEFAULT 'all',
    first_seen_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    indexed_at INTEGER DEFAULT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_google_trends_updated ON google_trends(updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_google_trends_category ON google_trends(category, updated_at DESC)`,

  // --- Google Trends: add picture_url and news_items_json to existing tables ---
  `ALTER TABLE google_trends ADD COLUMN IF NOT EXISTS picture_url TEXT DEFAULT NULL`,
  `ALTER TABLE google_trends ADD COLUMN IF NOT EXISTS news_items_json TEXT DEFAULT NULL`,

  // --- App Store ---
  `CREATE TABLE IF NOT EXISTS appstore_rankings (
    id TEXT NOT NULL,
    name TEXT NOT NULL,
    artist TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT '',
    rank INTEGER NOT NULL,
    list_type TEXT NOT NULL,
    icon_url TEXT NOT NULL DEFAULT '',
    store_url TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    price TEXT NOT NULL DEFAULT 'Free',
    bundle_id TEXT NOT NULL DEFAULT '',
    release_date TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL,
    indexed_at INTEGER,
    PRIMARY KEY (id, list_type)
  )`,
  `CREATE TABLE IF NOT EXISTS appstore_reviews (
    id TEXT PRIMARY KEY,
    app_id TEXT NOT NULL,
    app_name TEXT NOT NULL,
    author TEXT NOT NULL DEFAULT '',
    rating INTEGER NOT NULL DEFAULT 0,
    title TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL DEFAULT '',
    version TEXT NOT NULL DEFAULT '',
    first_seen_at INTEGER NOT NULL,
    indexed_at INTEGER
  )`,

  // --- App Store: add richer fields to existing tables ---
  `ALTER TABLE appstore_rankings ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE appstore_rankings ADD COLUMN IF NOT EXISTS price TEXT NOT NULL DEFAULT 'Free'`,
  `ALTER TABLE appstore_rankings ADD COLUMN IF NOT EXISTS bundle_id TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE appstore_rankings ADD COLUMN IF NOT EXISTS release_date TEXT NOT NULL DEFAULT ''`,

  // --- Google Play Store ---
  `CREATE TABLE IF NOT EXISTS playstore_rankings (
    id TEXT NOT NULL,
    name TEXT NOT NULL,
    developer TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT '',
    rank INTEGER NOT NULL,
    list_type TEXT NOT NULL,
    icon_url TEXT NOT NULL DEFAULT '',
    store_url TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    price TEXT NOT NULL DEFAULT 'Free',
    rating REAL,
    installs TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL,
    indexed_at INTEGER,
    PRIMARY KEY (id, list_type)
  )`,

  `CREATE TABLE IF NOT EXISTS playstore_reviews (
    id TEXT PRIMARY KEY,
    app_id TEXT NOT NULL,
    app_name TEXT NOT NULL DEFAULT '',
    author TEXT NOT NULL DEFAULT '',
    rating INTEGER NOT NULL DEFAULT 0,
    title TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL DEFAULT '',
    thumbs_up INTEGER NOT NULL DEFAULT 0,
    version TEXT NOT NULL DEFAULT '',
    first_seen_at INTEGER NOT NULL,
    indexed_at INTEGER
  )`,
];
