-- OpenCrow baseline schema
-- Auto-generated from production database
-- All statements are idempotent


CREATE TABLE IF NOT EXISTS agent_memory (
    agent_id text NOT NULL,
    key text NOT NULL,
    value text NOT NULL,
    updated_at integer DEFAULT (EXTRACT(epoch FROM now()))::integer NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_messages (
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    from_agent_id text NOT NULL,
    to_agent_id text NOT NULL,
    topic text DEFAULT 'general'::text NOT NULL,
    payload text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    consumed_at timestamp with time zone
);

CREATE TABLE IF NOT EXISTS appstore_rankings (
    id text NOT NULL,
    name text NOT NULL,
    artist text DEFAULT ''::text NOT NULL,
    category text DEFAULT ''::text NOT NULL,
    rank integer DEFAULT 0 NOT NULL,
    list_type text DEFAULT 'top-free'::text NOT NULL,
    icon_url text DEFAULT ''::text NOT NULL,
    store_url text DEFAULT ''::text NOT NULL,
    updated_at integer NOT NULL,
    indexed_at integer,
    description text DEFAULT ''::text NOT NULL,
    price text DEFAULT 'Free'::text NOT NULL,
    bundle_id text DEFAULT ''::text NOT NULL,
    release_date text DEFAULT ''::text NOT NULL
);

CREATE TABLE IF NOT EXISTS appstore_reviews (
    id text NOT NULL,
    app_id text NOT NULL,
    app_name text DEFAULT ''::text NOT NULL,
    author text DEFAULT ''::text NOT NULL,
    rating integer DEFAULT 0 NOT NULL,
    title text DEFAULT ''::text NOT NULL,
    content text DEFAULT ''::text NOT NULL,
    version text DEFAULT ''::text NOT NULL,
    first_seen_at integer NOT NULL,
    indexed_at integer
);

CREATE TABLE IF NOT EXISTS config_overrides (
    namespace text NOT NULL,
    key text NOT NULL,
    value_json text NOT NULL,
    updated_at integer DEFAULT (EXTRACT(epoch FROM now()))::integer NOT NULL
);

CREATE TABLE IF NOT EXISTS conversation_observations (
    id text NOT NULL,
    agent_id text NOT NULL,
    channel text NOT NULL,
    chat_id text NOT NULL,
    observation_type text NOT NULL,
    title text NOT NULL,
    summary text NOT NULL,
    facts_json text DEFAULT '[]'::text NOT NULL,
    concepts_json text DEFAULT '[]'::text NOT NULL,
    tools_used_json text DEFAULT '[]'::text NOT NULL,
    source_message_count integer DEFAULT 0 NOT NULL,
    created_at integer NOT NULL
);

CREATE TABLE IF NOT EXISTS conversation_summaries (
    id text NOT NULL,
    channel text NOT NULL,
    chat_id text NOT NULL,
    summary text NOT NULL,
    message_count integer NOT NULL,
    token_estimate integer NOT NULL,
    created_at integer NOT NULL
);

CREATE TABLE IF NOT EXISTS cost_tracking (
    id bigint NOT NULL,
    agent_id text NOT NULL,
    task_hash text,
    input_tokens integer,
    output_tokens integer,
    cost_usd real NOT NULL,
    model_used text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

DO $$ BEGIN
ALTER TABLE cost_tracking ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME cost_tracking_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);
EXCEPTION WHEN others THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS cron_deliveries (
    id text NOT NULL,
    channel text NOT NULL,
    chat_id text NOT NULL,
    job_name text NOT NULL,
    text text NOT NULL,
    preformatted boolean DEFAULT false NOT NULL,
    created_at integer DEFAULT (EXTRACT(epoch FROM now()))::integer NOT NULL,
    delivered_at integer
);

CREATE TABLE IF NOT EXISTS cron_jobs (
    id text NOT NULL,
    name text NOT NULL,
    enabled boolean DEFAULT true,
    delete_after_run boolean DEFAULT false,
    schedule_json text NOT NULL,
    payload_json text NOT NULL,
    delivery_json text DEFAULT '{"mode":"none"}'::text NOT NULL,
    next_run_at integer,
    last_run_at integer,
    last_status text,
    last_error text,
    created_at integer DEFAULT (EXTRACT(epoch FROM now()))::integer,
    updated_at integer DEFAULT (EXTRACT(epoch FROM now()))::integer,
    priority integer DEFAULT 10 NOT NULL
);

CREATE TABLE IF NOT EXISTS cron_runs (
    id text NOT NULL,
    job_id text NOT NULL,
    status text NOT NULL,
    result_summary text,
    error text,
    duration_ms integer,
    started_at integer NOT NULL,
    ended_at integer,
    created_at integer DEFAULT (EXTRACT(epoch FROM now()))::integer,
    progress_json text,
    CONSTRAINT cron_runs_status_check CHECK ((status = ANY (ARRAY['running'::text, 'ok'::text, 'error'::text, 'timeout'::text])))
);

CREATE TABLE IF NOT EXISTS economic_calendar_events (
    id text NOT NULL,
    event_name text NOT NULL,
    country text DEFAULT ''::text,
    currency text DEFAULT ''::text,
    importance text DEFAULT 'medium'::text,
    event_datetime text DEFAULT ''::text,
    actual text DEFAULT ''::text,
    forecast text DEFAULT ''::text,
    previous text DEFAULT ''::text,
    source_url text DEFAULT ''::text,
    event_hash text DEFAULT ''::text NOT NULL,
    scraped_at integer NOT NULL,
    created_at integer DEFAULT (EXTRACT(epoch FROM now()))::integer
);

CREATE TABLE IF NOT EXISTS generated_ideas (
    id text NOT NULL,
    agent_id text NOT NULL,
    title text NOT NULL,
    summary text NOT NULL,
    reasoning text NOT NULL,
    sources_used text DEFAULT ''::text NOT NULL,
    category text DEFAULT 'general'::text NOT NULL,
    created_at integer DEFAULT (EXTRACT(epoch FROM now()))::integer NOT NULL,
    rating integer,
    pipeline_stage text DEFAULT 'idea'::text,
    model_references text DEFAULT ''::text,
    quality_score real DEFAULT 1,
    CONSTRAINT generated_ideas_rating_check CHECK (((rating >= 0) AND (rating <= 5)))
);

CREATE TABLE IF NOT EXISTS github_repos (
    id text NOT NULL,
    owner text DEFAULT ''::text NOT NULL,
    name text DEFAULT ''::text NOT NULL,
    full_name text DEFAULT ''::text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    language text DEFAULT ''::text NOT NULL,
    stars integer DEFAULT 0 NOT NULL,
    forks integer DEFAULT 0 NOT NULL,
    stars_today integer DEFAULT 0 NOT NULL,
    built_by_json text DEFAULT '[]'::text NOT NULL,
    url text DEFAULT ''::text NOT NULL,
    period text DEFAULT 'daily'::text NOT NULL,
    first_seen_at integer NOT NULL,
    updated_at integer NOT NULL,
    indexed_at integer,
    prev_stars integer,
    prev_forks integer,
    stars_velocity real
);

CREATE TABLE IF NOT EXISTS hn_stories (
    id text NOT NULL,
    rank integer DEFAULT 0 NOT NULL,
    title text NOT NULL,
    url text DEFAULT ''::text NOT NULL,
    site_label text DEFAULT ''::text NOT NULL,
    points integer DEFAULT 0 NOT NULL,
    author text DEFAULT ''::text NOT NULL,
    age text DEFAULT ''::text NOT NULL,
    comment_count integer DEFAULT 0 NOT NULL,
    hn_url text DEFAULT ''::text NOT NULL,
    feed_type text DEFAULT 'front'::text NOT NULL,
    first_seen_at integer NOT NULL,
    updated_at integer NOT NULL,
    indexed_at integer,
    description text DEFAULT ''::text NOT NULL,
    top_comments_json text DEFAULT '[]'::text NOT NULL,
    prev_points integer,
    prev_comment_count integer,
    points_velocity real,
    comments_velocity real
);

CREATE TABLE IF NOT EXISTS memory_chunks (
    id text NOT NULL,
    source_id text NOT NULL,
    content text NOT NULL,
    chunk_index integer NOT NULL,
    token_count integer NOT NULL,
    created_at integer DEFAULT (EXTRACT(epoch FROM now()))::integer NOT NULL,
    tsv_content tsvector,
    content_hash text
);

CREATE TABLE IF NOT EXISTS memory_sources (
    id text NOT NULL,
    kind text NOT NULL,
    agent_id text NOT NULL,
    channel text,
    chat_id text,
    metadata_json text DEFAULT '{}'::text NOT NULL,
    created_at integer DEFAULT (EXTRACT(epoch FROM now()))::integer NOT NULL,
    CONSTRAINT memory_sources_kind_check CHECK ((kind = ANY (ARRAY['conversation'::text, 'note'::text, 'document'::text, 'x_post'::text, 'reuters_news'::text, 'cointelegraph_news'::text, 'cryptopanic_news'::text, 'investingnews_news'::text, 'producthunt_product'::text, 'hackernews_story'::text, 'reddit_post'::text, 'github_repo'::text, 'observation'::text, 'idea'::text, 'appstore_review'::text, 'appstore_ranking'::text, 'playstore_review'::text, 'playstore_ranking'::text])))
);

CREATE TABLE IF NOT EXISTS messages (
    id text NOT NULL,
    channel text NOT NULL,
    chat_id text NOT NULL,
    sender_id text NOT NULL,
    sender_name text,
    role text NOT NULL,
    content text NOT NULL,
    media_type text,
    "timestamp" integer NOT NULL,
    created_at integer DEFAULT (EXTRACT(epoch FROM now()))::integer NOT NULL,
    CONSTRAINT messages_role_check CHECK ((role = ANY (ARRAY['user'::text, 'assistant'::text])))
);

CREATE TABLE IF NOT EXISTS monitor_alerts (
    id text NOT NULL,
    category text NOT NULL,
    level text NOT NULL,
    title text NOT NULL,
    detail text NOT NULL,
    metric real,
    threshold real,
    fired_at integer NOT NULL,
    resolved_at integer,
    created_at integer DEFAULT (EXTRACT(epoch FROM now()))::integer NOT NULL,
    CONSTRAINT monitor_alerts_level_check CHECK ((level = ANY (ARRAY['critical'::text, 'warning'::text, 'info'::text])))
);

CREATE TABLE IF NOT EXISTS news_articles (
    id text NOT NULL,
    source_name text NOT NULL,
    title text NOT NULL,
    url text NOT NULL,
    url_hash text NOT NULL,
    published_at text DEFAULT ''::text,
    category text DEFAULT ''::text,
    summary text DEFAULT ''::text,
    sentiment text DEFAULT ''::text,
    image_url text DEFAULT ''::text,
    currencies_json text DEFAULT '[]'::text,
    source_id text DEFAULT ''::text,
    source_domain text DEFAULT ''::text,
    section text DEFAULT ''::text,
    extra_json text DEFAULT '{}'::text,
    scraped_at integer NOT NULL,
    created_at integer DEFAULT (EXTRACT(epoch FROM now()))::integer,
    indexed_at integer,
    body text
);

CREATE TABLE IF NOT EXISTS news_scraper_runs (
    id text NOT NULL,
    source_name text NOT NULL,
    status text,
    articles_found integer DEFAULT 0,
    articles_new integer DEFAULT 0,
    duration_ms integer NOT NULL,
    error text,
    started_at integer NOT NULL,
    created_at integer DEFAULT (EXTRACT(epoch FROM now()))::integer,
    CONSTRAINT news_scraper_runs_status_check CHECK ((status = ANY (ARRAY['ok'::text, 'error'::text, 'timeout'::text])))
);

CREATE TABLE IF NOT EXISTS ph_accounts (
    id text NOT NULL,
    label text NOT NULL,
    username text,
    display_name text,
    avatar_url text,
    session_cookie text DEFAULT ''::text NOT NULL,
    token_cookie text DEFAULT ''::text NOT NULL,
    status text DEFAULT 'unverified'::text NOT NULL,
    verified_at integer,
    error_message text,
    capabilities_json text DEFAULT '{}'::text NOT NULL,
    created_at integer DEFAULT (EXTRACT(epoch FROM now()))::integer NOT NULL,
    updated_at integer DEFAULT (EXTRACT(epoch FROM now()))::integer NOT NULL,
    cookies_json text DEFAULT '[]'::text NOT NULL,
    last_scraped_at integer,
    last_scrape_count integer,
    CONSTRAINT ph_accounts_status_check CHECK ((status = ANY (ARRAY['unverified'::text, 'active'::text, 'expired'::text, 'error'::text])))
);

CREATE TABLE IF NOT EXISTS ph_products (
    id text NOT NULL,
    slug text NOT NULL,
    name text NOT NULL,
    tagline text DEFAULT ''::text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    url text DEFAULT ''::text NOT NULL,
    website_url text DEFAULT ''::text NOT NULL,
    thumbnail_url text DEFAULT ''::text NOT NULL,
    votes_count integer DEFAULT 0 NOT NULL,
    comments_count integer DEFAULT 0 NOT NULL,
    is_featured boolean DEFAULT false NOT NULL,
    rank integer,
    makers_json text DEFAULT '[]'::text NOT NULL,
    topics_json text DEFAULT '[]'::text NOT NULL,
    featured_at integer,
    product_created_at integer,
    account_id text,
    first_seen_at integer NOT NULL,
    updated_at integer NOT NULL,
    indexed_at integer,
    reviews_count integer DEFAULT 0 NOT NULL,
    reviews_rating real DEFAULT 0 NOT NULL
);

CREATE TABLE IF NOT EXISTS playstore_rankings (
    id text NOT NULL,
    name text NOT NULL,
    developer text DEFAULT ''::text NOT NULL,
    category text DEFAULT ''::text NOT NULL,
    rank integer NOT NULL,
    list_type text NOT NULL,
    icon_url text DEFAULT ''::text NOT NULL,
    store_url text DEFAULT ''::text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    price text DEFAULT 'Free'::text NOT NULL,
    rating real,
    installs text DEFAULT ''::text NOT NULL,
    updated_at integer NOT NULL,
    indexed_at integer
);

CREATE TABLE IF NOT EXISTS playstore_reviews (
    id text NOT NULL,
    app_id text NOT NULL,
    app_name text DEFAULT ''::text NOT NULL,
    author text DEFAULT ''::text NOT NULL,
    rating integer DEFAULT 0 NOT NULL,
    title text DEFAULT ''::text NOT NULL,
    content text DEFAULT ''::text NOT NULL,
    thumbs_up integer DEFAULT 0 NOT NULL,
    version text DEFAULT ''::text NOT NULL,
    first_seen_at integer NOT NULL,
    indexed_at integer
);

CREATE TABLE IF NOT EXISTS prewarm_cache (
    id bigint NOT NULL,
    domain text NOT NULL,
    context_data jsonb NOT NULL,
    hit_rate real DEFAULT 0,
    last_used timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

DO $$ BEGIN
ALTER TABLE prewarm_cache ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME prewarm_cache_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);
EXCEPTION WHEN others THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS process_commands (
    id text NOT NULL,
    target text NOT NULL,
    action text NOT NULL,
    payload_json text DEFAULT '{}'::text NOT NULL,
    created_at integer DEFAULT (EXTRACT(epoch FROM now()))::integer NOT NULL,
    acknowledged_at integer,
    CONSTRAINT process_commands_action_check CHECK ((action = ANY (ARRAY['restart'::text, 'stop'::text, 'cron:run_job'::text])))
);

CREATE TABLE IF NOT EXISTS process_logs (
    id bigint NOT NULL,
    process_name text NOT NULL,
    level text NOT NULL,
    context text NOT NULL,
    message text NOT NULL,
    data_json text,
    created_at integer NOT NULL
);

DO $$ BEGIN
ALTER TABLE process_logs ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME process_logs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);
EXCEPTION WHEN others THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS process_registry (
    name text NOT NULL,
    pid integer NOT NULL,
    started_at integer NOT NULL,
    last_heartbeat integer NOT NULL,
    metadata_json text DEFAULT '{}'::text NOT NULL
);

CREATE TABLE IF NOT EXISTS reddit_accounts (
    id text NOT NULL,
    label text NOT NULL,
    username text,
    display_name text,
    avatar_url text,
    cookies_json text DEFAULT '[]'::text NOT NULL,
    status text DEFAULT 'unverified'::text NOT NULL,
    verified_at integer,
    error_message text,
    last_scraped_at integer,
    last_scrape_count integer,
    created_at integer DEFAULT (EXTRACT(epoch FROM now()))::integer NOT NULL,
    updated_at integer DEFAULT (EXTRACT(epoch FROM now()))::integer NOT NULL,
    CONSTRAINT reddit_accounts_status_check CHECK ((status = ANY (ARRAY['unverified'::text, 'active'::text, 'expired'::text, 'error'::text])))
);

CREATE TABLE IF NOT EXISTS reddit_posts (
    id text NOT NULL,
    subreddit text NOT NULL,
    title text NOT NULL,
    url text DEFAULT ''::text NOT NULL,
    selftext text DEFAULT ''::text NOT NULL,
    author text DEFAULT ''::text NOT NULL,
    score integer DEFAULT 0 NOT NULL,
    num_comments integer DEFAULT 0 NOT NULL,
    permalink text DEFAULT ''::text NOT NULL,
    post_type text DEFAULT 'link'::text NOT NULL,
    feed_source text DEFAULT 'home'::text NOT NULL,
    domain text DEFAULT ''::text NOT NULL,
    upvote_ratio real DEFAULT 0 NOT NULL,
    created_utc integer,
    first_seen_at integer NOT NULL,
    updated_at integer NOT NULL,
    indexed_at integer,
    top_comments_json text,
    flair text,
    thumbnail_url text,
    prev_score integer,
    prev_num_comments integer,
    score_velocity real,
    comments_velocity real
);

CREATE TABLE IF NOT EXISTS research_signals (
    id text NOT NULL,
    agent_id text NOT NULL,
    signal_type text DEFAULT 'trend'::text NOT NULL,
    title text NOT NULL,
    detail text NOT NULL,
    source text NOT NULL,
    source_url text DEFAULT ''::text NOT NULL,
    strength integer DEFAULT 3 NOT NULL,
    themes text DEFAULT ''::text NOT NULL,
    consumed boolean DEFAULT false NOT NULL,
    created_at integer DEFAULT (EXTRACT(epoch FROM now()))::integer NOT NULL
);

CREATE TABLE IF NOT EXISTS routing_decisions (
    id bigint NOT NULL,
    session_id text,
    task_hash text,
    selected_agent_id text NOT NULL,
    alternative_agents_json text DEFAULT '[]'::text NOT NULL,
    decision_reason text,
    outcome_status text,
    outcome_score real,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

DO $$ BEGIN
ALTER TABLE routing_decisions ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME routing_decisions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);
EXCEPTION WHEN others THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS routing_rules (
    id text NOT NULL,
    channel text NOT NULL,
    match_type text NOT NULL,
    match_value text NOT NULL,
    agent_id text NOT NULL,
    priority integer DEFAULT 0 NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    notes text,
    created_at integer DEFAULT (EXTRACT(epoch FROM now()))::integer NOT NULL,
    updated_at integer DEFAULT (EXTRACT(epoch FROM now()))::integer NOT NULL,
    CONSTRAINT routing_rules_match_type_check CHECK ((match_type = ANY (ARRAY['chat'::text, 'user'::text, 'group'::text, 'pattern'::text])))
);

CREATE TABLE IF NOT EXISTS sdk_sessions (
    channel text NOT NULL,
    chat_id text NOT NULL,
    agent_id text NOT NULL,
    sdk_session_id text NOT NULL,
    created_at integer DEFAULT (EXTRACT(epoch FROM now()))::integer NOT NULL,
    updated_at integer DEFAULT (EXTRACT(epoch FROM now()))::integer NOT NULL
);

CREATE TABLE IF NOT EXISTS session_history (
    id bigint NOT NULL,
    agent_id text NOT NULL,
    session_id text NOT NULL,
    prompt text,
    result text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

DO $$ BEGIN
ALTER TABLE session_history ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME session_history_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);
EXCEPTION WHEN others THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS sessions (
    id text NOT NULL,
    channel text NOT NULL,
    chat_id text NOT NULL,
    created_at integer DEFAULT (EXTRACT(epoch FROM now()))::integer NOT NULL,
    updated_at integer DEFAULT (EXTRACT(epoch FROM now()))::integer NOT NULL
);

CREATE TABLE IF NOT EXISTS subagent_audit_log (
    id bigint NOT NULL,
    parent_agent_id text NOT NULL,
    session_id text,
    subagent_id text NOT NULL,
    task text,
    status text DEFAULT 'started'::text,
    result text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone
);

DO $$ BEGIN
ALTER TABLE subagent_audit_log ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME subagent_audit_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);
EXCEPTION WHEN others THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS subagent_runs (
    id text NOT NULL,
    parent_agent_id text NOT NULL,
    parent_session_key text NOT NULL,
    child_agent_id text NOT NULL,
    child_session_key text NOT NULL,
    task text NOT NULL,
    status text DEFAULT 'running'::text NOT NULL,
    result_text text,
    error_message text,
    started_at integer NOT NULL,
    ended_at integer,
    created_at integer DEFAULT (EXTRACT(epoch FROM now()))::integer NOT NULL,
    CONSTRAINT subagent_runs_status_check CHECK ((status = ANY (ARRAY['running'::text, 'completed'::text, 'error'::text, 'timeout'::text])))
);

CREATE TABLE IF NOT EXISTS task_classification (
    id bigint NOT NULL,
    task_hash text NOT NULL,
    session_id text,
    domain text NOT NULL,
    complexity_score integer DEFAULT 1,
    urgency text DEFAULT 'medium'::text,
    keywords_json text DEFAULT '[]'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    semantic_domain text,
    confidence_score real,
    corrected_domain text
);

DO $$ BEGIN
ALTER TABLE task_classification ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME task_classification_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);
EXCEPTION WHEN others THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS task_embeddings (
    id bigint NOT NULL,
    task_hash text NOT NULL,
    embedding real[] NOT NULL,
    embedding_dim integer DEFAULT 512 NOT NULL,
    domain text NOT NULL,
    outcome_score real,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    complexity_score integer DEFAULT 1,
    requires_decomposition boolean DEFAULT false
);

DO $$ BEGIN
ALTER TABLE task_embeddings ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME task_embeddings_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);
EXCEPTION WHEN others THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS token_usage (
    id text NOT NULL,
    agent_id text NOT NULL,
    model text NOT NULL,
    provider text NOT NULL,
    channel text DEFAULT ''::text NOT NULL,
    chat_id text DEFAULT ''::text NOT NULL,
    source text DEFAULT 'message'::text NOT NULL,
    input_tokens integer DEFAULT 0 NOT NULL,
    output_tokens integer DEFAULT 0 NOT NULL,
    cache_read_tokens integer DEFAULT 0 NOT NULL,
    cache_creation_tokens integer DEFAULT 0 NOT NULL,
    cost_usd real DEFAULT 0 NOT NULL,
    duration_ms integer DEFAULT 0 NOT NULL,
    tool_use_count integer DEFAULT 0 NOT NULL,
    created_at integer DEFAULT (EXTRACT(epoch FROM now()))::integer NOT NULL
);

CREATE TABLE IF NOT EXISTS tool_audit_log (
    id bigint NOT NULL,
    agent_id text NOT NULL,
    session_id text,
    tool_name text NOT NULL,
    tool_input text,
    tool_response text,
    is_error boolean DEFAULT false NOT NULL,
    created_at integer DEFAULT (EXTRACT(epoch FROM now()))::integer NOT NULL
);

DO $$ BEGIN
ALTER TABLE tool_audit_log ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME tool_audit_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);
EXCEPTION WHEN others THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS tool_stats (
    agent_id text NOT NULL,
    tool_name text NOT NULL,
    success_count integer DEFAULT 0 NOT NULL,
    failure_count integer DEFAULT 0 NOT NULL,
    last_failure_at integer,
    last_failure_error text,
    updated_at integer DEFAULT (EXTRACT(epoch FROM now()))::integer NOT NULL
);

CREATE TABLE IF NOT EXISTS user_preferences (
    id text NOT NULL,
    preference_type text NOT NULL,
    preference_key text NOT NULL,
    preference_value text NOT NULL,
    confidence real DEFAULT 0.5 NOT NULL,
    source_session_id text,
    expires_at timestamp with time zone,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT user_preferences_preference_type_check CHECK ((preference_type = ANY (ARRAY['communication'::text, 'coding'::text, 'workflow'::text, 'tool'::text, 'model'::text])))
);

CREATE TABLE IF NOT EXISTS user_prompt_log (
    id bigint NOT NULL,
    agent_id text NOT NULL,
    session_id text,
    prompt text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

DO $$ BEGIN
ALTER TABLE user_prompt_log ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME user_prompt_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);
EXCEPTION WHEN others THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS workload_history (
    id bigint NOT NULL,
    sampled_at timestamp with time zone DEFAULT now() NOT NULL,
    total_tasks integer DEFAULT 0 NOT NULL,
    avg_queue_depth real DEFAULT 0 NOT NULL,
    agent_utilization_json text DEFAULT '[]'::text NOT NULL
);

DO $$ BEGIN
ALTER TABLE workload_history ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME workload_history_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);
EXCEPTION WHEN others THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS x_accounts (
    id text NOT NULL,
    label text NOT NULL,
    username text,
    display_name text,
    profile_image_url text,
    auth_token text NOT NULL,
    ct0 text NOT NULL,
    status text DEFAULT 'unverified'::text NOT NULL,
    verified_at integer,
    error_message text,
    created_at integer DEFAULT (EXTRACT(epoch FROM now()))::integer NOT NULL,
    updated_at integer DEFAULT (EXTRACT(epoch FROM now()))::integer NOT NULL,
    capabilities_json text DEFAULT '{}'::text NOT NULL,
    CONSTRAINT x_accounts_status_check CHECK ((status = ANY (ARRAY['unverified'::text, 'active'::text, 'expired'::text, 'error'::text])))
);

CREATE TABLE IF NOT EXISTS x_autofollow_jobs (
    id text NOT NULL,
    account_id text NOT NULL,
    max_follows_per_run integer DEFAULT 3 NOT NULL,
    interval_minutes integer DEFAULT 60 NOT NULL,
    languages text,
    status text DEFAULT 'stopped'::text NOT NULL,
    next_run_at integer,
    total_followed integer DEFAULT 0 NOT NULL,
    total_errors integer DEFAULT 0 NOT NULL,
    last_run_at integer,
    last_error text,
    created_at integer DEFAULT (EXTRACT(epoch FROM now()))::integer NOT NULL,
    updated_at integer DEFAULT (EXTRACT(epoch FROM now()))::integer NOT NULL,
    CONSTRAINT x_autofollow_jobs_status_check CHECK ((status = ANY (ARRAY['running'::text, 'stopped'::text])))
);

CREATE TABLE IF NOT EXISTS x_autolike_jobs (
    id text NOT NULL,
    account_id text NOT NULL,
    interval_minutes integer DEFAULT 15 NOT NULL,
    max_likes_per_run integer DEFAULT 5 NOT NULL,
    status text DEFAULT 'stopped'::text NOT NULL,
    next_run_at integer,
    total_scraped integer DEFAULT 0 NOT NULL,
    total_liked integer DEFAULT 0 NOT NULL,
    total_errors integer DEFAULT 0 NOT NULL,
    last_run_at integer,
    last_error text,
    created_at integer DEFAULT (EXTRACT(epoch FROM now()))::integer NOT NULL,
    updated_at integer DEFAULT (EXTRACT(epoch FROM now()))::integer NOT NULL,
    languages text,
    CONSTRAINT x_autolike_jobs_status_check CHECK ((status = ANY (ARRAY['running'::text, 'stopped'::text])))
);

CREATE TABLE IF NOT EXISTS x_bookmark_jobs (
    id text NOT NULL,
    account_id text NOT NULL,
    interval_minutes integer DEFAULT 15 NOT NULL,
    status text DEFAULT 'stopped'::text NOT NULL,
    next_run_at integer,
    total_shared integer DEFAULT 0 NOT NULL,
    total_errors integer DEFAULT 0 NOT NULL,
    last_run_at integer,
    last_error text,
    created_at integer DEFAULT (EXTRACT(epoch FROM now()))::integer NOT NULL,
    updated_at integer DEFAULT (EXTRACT(epoch FROM now()))::integer NOT NULL,
    CONSTRAINT x_bookmark_jobs_status_check CHECK ((status = ANY (ARRAY['running'::text, 'stopped'::text])))
);

CREATE TABLE IF NOT EXISTS x_followed_users (
    id text NOT NULL,
    account_id text NOT NULL,
    user_id text DEFAULT ''::text NOT NULL,
    username text NOT NULL,
    display_name text DEFAULT ''::text NOT NULL,
    followers_count integer DEFAULT 0 NOT NULL,
    following_count integer DEFAULT 0 NOT NULL,
    verified boolean DEFAULT false NOT NULL,
    source_tweet_id text,
    followed_at integer NOT NULL,
    follow_back boolean DEFAULT false NOT NULL,
    follow_back_checked_at integer,
    unfollowed_at integer,
    created_at integer DEFAULT (EXTRACT(epoch FROM now()))::integer NOT NULL
);

CREATE TABLE IF NOT EXISTS x_liked_tweets (
    id text NOT NULL,
    account_id text NOT NULL,
    tweet_id text NOT NULL,
    author_username text DEFAULT ''::text NOT NULL,
    text text DEFAULT ''::text NOT NULL,
    likes integer DEFAULT 0 NOT NULL,
    retweets integer DEFAULT 0 NOT NULL,
    views integer DEFAULT 0 NOT NULL,
    liked_at integer DEFAULT (EXTRACT(epoch FROM now()))::integer NOT NULL
);

CREATE TABLE IF NOT EXISTS x_scraped_tweets (
    id text NOT NULL,
    account_id text NOT NULL,
    tweet_id text NOT NULL,
    author_username text DEFAULT ''::text NOT NULL,
    author_display_name text DEFAULT ''::text NOT NULL,
    author_verified boolean DEFAULT false NOT NULL,
    author_followers integer DEFAULT 0 NOT NULL,
    text text DEFAULT ''::text NOT NULL,
    likes integer DEFAULT 0 NOT NULL,
    retweets integer DEFAULT 0 NOT NULL,
    replies integer DEFAULT 0 NOT NULL,
    views integer DEFAULT 0 NOT NULL,
    bookmarks integer DEFAULT 0 NOT NULL,
    quotes integer DEFAULT 0 NOT NULL,
    has_media boolean DEFAULT false NOT NULL,
    tweet_created_at integer,
    scraped_at integer DEFAULT (EXTRACT(epoch FROM now()))::integer NOT NULL,
    source text DEFAULT 'timeline'::text NOT NULL,
    indexed_at integer,
    prev_likes integer,
    prev_retweets integer,
    prev_views bigint,
    likes_velocity real,
    views_velocity real
);

CREATE TABLE IF NOT EXISTS x_shared_videos (
    id text NOT NULL,
    account_id text NOT NULL,
    source_tweet_id text NOT NULL,
    source_author text DEFAULT ''::text NOT NULL,
    source_url text DEFAULT ''::text NOT NULL,
    shared_at integer NOT NULL,
    created_at integer DEFAULT (EXTRACT(epoch FROM now()))::integer NOT NULL
);

CREATE TABLE IF NOT EXISTS x_timeline_scrape_jobs (
    id text NOT NULL,
    account_id text NOT NULL,
    max_pages integer DEFAULT 3 NOT NULL,
    sources text DEFAULT 'home,top_posts'::text NOT NULL,
    interval_minutes integer DEFAULT 120 NOT NULL,
    status text DEFAULT 'stopped'::text NOT NULL,
    next_run_at integer,
    total_scraped integer DEFAULT 0 NOT NULL,
    total_errors integer DEFAULT 0 NOT NULL,
    last_run_at integer,
    last_error text,
    created_at integer DEFAULT (EXTRACT(epoch FROM now()))::integer NOT NULL,
    updated_at integer DEFAULT (EXTRACT(epoch FROM now()))::integer NOT NULL,
    languages text,
    CONSTRAINT x_timeline_scrape_jobs_status_check CHECK ((status = ANY (ARRAY['running'::text, 'stopped'::text])))
);

DO $$ BEGIN
ALTER TABLE ONLY agent_memory
    ADD CONSTRAINT agent_memory_pkey PRIMARY KEY (agent_id, key);
EXCEPTION WHEN others THEN NULL;
END $$;

DO $$ BEGIN
ALTER TABLE ONLY agent_messages
    ADD CONSTRAINT agent_messages_pkey PRIMARY KEY (id);
EXCEPTION WHEN others THEN NULL;
END $$;

DO $$ BEGIN
ALTER TABLE ONLY appstore_rankings
    ADD CONSTRAINT appstore_rankings_pkey PRIMARY KEY (id, list_type);
EXCEPTION WHEN others THEN NULL;
END $$;

DO $$ BEGIN
ALTER TABLE ONLY appstore_reviews
    ADD CONSTRAINT appstore_reviews_pkey PRIMARY KEY (id);
EXCEPTION WHEN others THEN NULL;
END $$;

DO $$ BEGIN
ALTER TABLE ONLY config_overrides
    ADD CONSTRAINT config_overrides_pkey PRIMARY KEY (namespace, key);
EXCEPTION WHEN others THEN NULL;
END $$;

DO $$ BEGIN
ALTER TABLE ONLY conversation_observations
    ADD CONSTRAINT conversation_observations_pkey PRIMARY KEY (id);
EXCEPTION WHEN others THEN NULL;
END $$;

DO $$ BEGIN
ALTER TABLE ONLY conversation_summaries
    ADD CONSTRAINT conversation_summaries_pkey PRIMARY KEY (id);
EXCEPTION WHEN others THEN NULL;
END $$;

DO $$ BEGIN
ALTER TABLE ONLY cost_tracking
    ADD CONSTRAINT cost_tracking_pkey PRIMARY KEY (id);
EXCEPTION WHEN others THEN NULL;
END $$;

DO $$ BEGIN
ALTER TABLE ONLY cron_deliveries
    ADD CONSTRAINT cron_deliveries_pkey PRIMARY KEY (id);
EXCEPTION WHEN others THEN NULL;
END $$;

DO $$ BEGIN
ALTER TABLE ONLY cron_jobs
    ADD CONSTRAINT cron_jobs_pkey PRIMARY KEY (id);
EXCEPTION WHEN others THEN NULL;
END $$;

DO $$ BEGIN
ALTER TABLE ONLY cron_runs
    ADD CONSTRAINT cron_runs_pkey PRIMARY KEY (id);
EXCEPTION WHEN others THEN NULL;
END $$;

DO $$ BEGIN
ALTER TABLE ONLY economic_calendar_events
    ADD CONSTRAINT economic_calendar_events_pkey PRIMARY KEY (id);
EXCEPTION WHEN others THEN NULL;
END $$;

DO $$ BEGIN
ALTER TABLE ONLY generated_ideas
    ADD CONSTRAINT generated_ideas_pkey PRIMARY KEY (id);
EXCEPTION WHEN others THEN NULL;
END $$;

DO $$ BEGIN
ALTER TABLE ONLY github_repos
    ADD CONSTRAINT github_repos_pkey PRIMARY KEY (id);
EXCEPTION WHEN others THEN NULL;
END $$;

DO $$ BEGIN
ALTER TABLE ONLY hn_stories
    ADD CONSTRAINT hn_stories_pkey PRIMARY KEY (id);
EXCEPTION WHEN others THEN NULL;
END $$;

DO $$ BEGIN
ALTER TABLE ONLY memory_chunks
    ADD CONSTRAINT memory_chunks_pkey PRIMARY KEY (id);
EXCEPTION WHEN others THEN NULL;
END $$;

DO $$ BEGIN
ALTER TABLE ONLY memory_sources
    ADD CONSTRAINT memory_sources_pkey PRIMARY KEY (id);
EXCEPTION WHEN others THEN NULL;
END $$;

DO $$ BEGIN
ALTER TABLE ONLY messages
    ADD CONSTRAINT messages_pkey PRIMARY KEY (id);
EXCEPTION WHEN others THEN NULL;
END $$;

DO $$ BEGIN
ALTER TABLE ONLY monitor_alerts
    ADD CONSTRAINT monitor_alerts_pkey PRIMARY KEY (id);
EXCEPTION WHEN others THEN NULL;
END $$;

DO $$ BEGIN
ALTER TABLE ONLY news_articles
    ADD CONSTRAINT news_articles_pkey PRIMARY KEY (id);
EXCEPTION WHEN others THEN NULL;
END $$;

DO $$ BEGIN
ALTER TABLE ONLY news_scraper_runs
    ADD CONSTRAINT news_scraper_runs_pkey PRIMARY KEY (id);
EXCEPTION WHEN others THEN NULL;
END $$;

DO $$ BEGIN
ALTER TABLE ONLY ph_accounts
    ADD CONSTRAINT ph_accounts_pkey PRIMARY KEY (id);
EXCEPTION WHEN others THEN NULL;
END $$;

DO $$ BEGIN
ALTER TABLE ONLY ph_products
    ADD CONSTRAINT ph_products_pkey PRIMARY KEY (id);
EXCEPTION WHEN others THEN NULL;
END $$;

DO $$ BEGIN
ALTER TABLE ONLY playstore_rankings
    ADD CONSTRAINT playstore_rankings_pkey PRIMARY KEY (id, list_type);
EXCEPTION WHEN others THEN NULL;
END $$;

DO $$ BEGIN
ALTER TABLE ONLY playstore_reviews
    ADD CONSTRAINT playstore_reviews_pkey PRIMARY KEY (id);
EXCEPTION WHEN others THEN NULL;
END $$;

DO $$ BEGIN
ALTER TABLE ONLY prewarm_cache
    ADD CONSTRAINT prewarm_cache_pkey PRIMARY KEY (id);
EXCEPTION WHEN others THEN NULL;
END $$;

DO $$ BEGIN
ALTER TABLE ONLY process_commands
    ADD CONSTRAINT process_commands_pkey PRIMARY KEY (id);
EXCEPTION WHEN others THEN NULL;
END $$;

DO $$ BEGIN
ALTER TABLE ONLY process_logs
    ADD CONSTRAINT process_logs_pkey PRIMARY KEY (id);
EXCEPTION WHEN others THEN NULL;
END $$;

DO $$ BEGIN
ALTER TABLE ONLY process_registry
    ADD CONSTRAINT process_registry_pkey PRIMARY KEY (name);
EXCEPTION WHEN others THEN NULL;
END $$;

DO $$ BEGIN
ALTER TABLE ONLY reddit_accounts
    ADD CONSTRAINT reddit_accounts_pkey PRIMARY KEY (id);
EXCEPTION WHEN others THEN NULL;
END $$;

DO $$ BEGIN
ALTER TABLE ONLY reddit_posts
    ADD CONSTRAINT reddit_posts_pkey PRIMARY KEY (id);
EXCEPTION WHEN others THEN NULL;
END $$;

DO $$ BEGIN
ALTER TABLE ONLY research_signals
    ADD CONSTRAINT research_signals_pkey PRIMARY KEY (id);
EXCEPTION WHEN others THEN NULL;
END $$;

DO $$ BEGIN
ALTER TABLE ONLY routing_decisions
    ADD CONSTRAINT routing_decisions_pkey PRIMARY KEY (id);
EXCEPTION WHEN others THEN NULL;
END $$;

DO $$ BEGIN
ALTER TABLE ONLY routing_rules
    ADD CONSTRAINT routing_rules_channel_match_type_match_value_key UNIQUE (channel, match_type, match_value);
EXCEPTION WHEN others THEN NULL;
END $$;

DO $$ BEGIN
ALTER TABLE ONLY routing_rules
    ADD CONSTRAINT routing_rules_pkey PRIMARY KEY (id);
EXCEPTION WHEN others THEN NULL;
END $$;

DO $$ BEGIN
ALTER TABLE ONLY sdk_sessions
    ADD CONSTRAINT sdk_sessions_pkey PRIMARY KEY (channel, chat_id, agent_id);
EXCEPTION WHEN others THEN NULL;
END $$;

DO $$ BEGIN
ALTER TABLE ONLY session_history
    ADD CONSTRAINT session_history_agent_id_session_id_key UNIQUE (agent_id, session_id);
EXCEPTION WHEN others THEN NULL;
END $$;

DO $$ BEGIN
ALTER TABLE ONLY session_history
    ADD CONSTRAINT session_history_pkey PRIMARY KEY (id);
EXCEPTION WHEN others THEN NULL;
END $$;

DO $$ BEGIN
ALTER TABLE ONLY sessions
    ADD CONSTRAINT sessions_channel_chat_id_key UNIQUE (channel, chat_id);
EXCEPTION WHEN others THEN NULL;
END $$;

DO $$ BEGIN
ALTER TABLE ONLY sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (id);
EXCEPTION WHEN others THEN NULL;
END $$;

DO $$ BEGIN
ALTER TABLE ONLY subagent_audit_log
    ADD CONSTRAINT subagent_audit_log_pkey PRIMARY KEY (id);
EXCEPTION WHEN others THEN NULL;
END $$;

DO $$ BEGIN
ALTER TABLE ONLY subagent_runs
    ADD CONSTRAINT subagent_runs_pkey PRIMARY KEY (id);
EXCEPTION WHEN others THEN NULL;
END $$;

DO $$ BEGIN
ALTER TABLE ONLY task_classification
    ADD CONSTRAINT task_classification_pkey PRIMARY KEY (id);
EXCEPTION WHEN others THEN NULL;
END $$;

DO $$ BEGIN
ALTER TABLE ONLY task_embeddings
    ADD CONSTRAINT task_embeddings_pkey PRIMARY KEY (id);
EXCEPTION WHEN others THEN NULL;
END $$;

DO $$ BEGIN
ALTER TABLE ONLY task_embeddings
    ADD CONSTRAINT task_embeddings_task_hash_key UNIQUE (task_hash);
EXCEPTION WHEN others THEN NULL;
END $$;

DO $$ BEGIN
ALTER TABLE ONLY token_usage
    ADD CONSTRAINT token_usage_pkey PRIMARY KEY (id);
EXCEPTION WHEN others THEN NULL;
END $$;

DO $$ BEGIN
ALTER TABLE ONLY tool_audit_log
    ADD CONSTRAINT tool_audit_log_pkey PRIMARY KEY (id);
EXCEPTION WHEN others THEN NULL;
END $$;

DO $$ BEGIN
ALTER TABLE ONLY tool_stats
    ADD CONSTRAINT tool_stats_pkey PRIMARY KEY (agent_id, tool_name);
EXCEPTION WHEN others THEN NULL;
END $$;

DO $$ BEGIN
ALTER TABLE ONLY user_preferences
    ADD CONSTRAINT user_preferences_pkey PRIMARY KEY (id);
EXCEPTION WHEN others THEN NULL;
END $$;

DO $$ BEGIN
ALTER TABLE ONLY user_prompt_log
    ADD CONSTRAINT user_prompt_log_pkey PRIMARY KEY (id);
EXCEPTION WHEN others THEN NULL;
END $$;

DO $$ BEGIN
ALTER TABLE ONLY workload_history
    ADD CONSTRAINT workload_history_pkey PRIMARY KEY (id);
EXCEPTION WHEN others THEN NULL;
END $$;

DO $$ BEGIN
ALTER TABLE ONLY x_accounts
    ADD CONSTRAINT x_accounts_pkey PRIMARY KEY (id);
EXCEPTION WHEN others THEN NULL;
END $$;

DO $$ BEGIN
ALTER TABLE ONLY x_autofollow_jobs
    ADD CONSTRAINT x_autofollow_jobs_account_id_key UNIQUE (account_id);
EXCEPTION WHEN others THEN NULL;
END $$;

DO $$ BEGIN
ALTER TABLE ONLY x_autofollow_jobs
    ADD CONSTRAINT x_autofollow_jobs_pkey PRIMARY KEY (id);
EXCEPTION WHEN others THEN NULL;
END $$;

DO $$ BEGIN
ALTER TABLE ONLY x_autolike_jobs
    ADD CONSTRAINT x_autolike_jobs_account_id_key UNIQUE (account_id);
EXCEPTION WHEN others THEN NULL;
END $$;

DO $$ BEGIN
ALTER TABLE ONLY x_autolike_jobs
    ADD CONSTRAINT x_autolike_jobs_pkey PRIMARY KEY (id);
EXCEPTION WHEN others THEN NULL;
END $$;

DO $$ BEGIN
ALTER TABLE ONLY x_bookmark_jobs
    ADD CONSTRAINT x_bookmark_jobs_account_id_key UNIQUE (account_id);
EXCEPTION WHEN others THEN NULL;
END $$;

DO $$ BEGIN
ALTER TABLE ONLY x_bookmark_jobs
    ADD CONSTRAINT x_bookmark_jobs_pkey PRIMARY KEY (id);
EXCEPTION WHEN others THEN NULL;
END $$;

DO $$ BEGIN
ALTER TABLE ONLY x_followed_users
    ADD CONSTRAINT x_followed_users_pkey PRIMARY KEY (id);
EXCEPTION WHEN others THEN NULL;
END $$;

DO $$ BEGIN
ALTER TABLE ONLY x_liked_tweets
    ADD CONSTRAINT x_liked_tweets_pkey PRIMARY KEY (id);
EXCEPTION WHEN others THEN NULL;
END $$;

DO $$ BEGIN
ALTER TABLE ONLY x_scraped_tweets
    ADD CONSTRAINT x_scraped_tweets_pkey PRIMARY KEY (id);
EXCEPTION WHEN others THEN NULL;
END $$;

DO $$ BEGIN
ALTER TABLE ONLY x_shared_videos
    ADD CONSTRAINT x_shared_videos_pkey PRIMARY KEY (id);
EXCEPTION WHEN others THEN NULL;
END $$;

DO $$ BEGIN
ALTER TABLE ONLY x_timeline_scrape_jobs
    ADD CONSTRAINT x_timeline_scrape_jobs_account_id_key UNIQUE (account_id);
EXCEPTION WHEN others THEN NULL;
END $$;

DO $$ BEGIN
ALTER TABLE ONLY x_timeline_scrape_jobs
    ADD CONSTRAINT x_timeline_scrape_jobs_pkey PRIMARY KEY (id);
EXCEPTION WHEN others THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_agent_messages_pending ON agent_messages USING btree (to_agent_id, status, created_at) WHERE (status = 'pending'::text);

CREATE INDEX IF NOT EXISTS idx_appstore_rankings_list ON appstore_rankings USING btree (list_type, rank);

CREATE INDEX IF NOT EXISTS idx_appstore_rankings_updated ON appstore_rankings USING btree (updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_appstore_reviews_app ON appstore_reviews USING btree (app_id, first_seen_at DESC);

CREATE INDEX IF NOT EXISTS idx_appstore_reviews_rating ON appstore_reviews USING btree (rating, first_seen_at DESC);

CREATE INDEX IF NOT EXISTS idx_appstore_reviews_unindexed ON appstore_reviews USING btree (indexed_at) WHERE (indexed_at IS NULL);

CREATE UNIQUE INDEX IF NOT EXISTS idx_calendar_event_hash ON economic_calendar_events USING btree (event_hash);

CREATE INDEX IF NOT EXISTS idx_conv_summaries_lookup ON conversation_summaries USING btree (channel, chat_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_cost_agent ON cost_tracking USING btree (agent_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_cron_deliveries_pending ON cron_deliveries USING btree (channel, delivered_at);

CREATE INDEX IF NOT EXISTS idx_cron_jobs_next_run ON cron_jobs USING btree (enabled, next_run_at);

CREATE INDEX IF NOT EXISTS idx_cron_jobs_priority ON cron_jobs USING btree (priority);

CREATE INDEX IF NOT EXISTS idx_cron_runs_job ON cron_runs USING btree (job_id, started_at);

CREATE INDEX IF NOT EXISTS idx_generated_ideas_agent ON generated_ideas USING btree (agent_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_generated_ideas_created ON generated_ideas USING btree (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_github_repos_language ON github_repos USING btree (language, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_github_repos_stars ON github_repos USING btree (stars DESC);

CREATE INDEX IF NOT EXISTS idx_github_repos_stars_today ON github_repos USING btree (stars_today DESC);

CREATE INDEX IF NOT EXISTS idx_github_repos_updated ON github_repos USING btree (updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_hn_stories_points ON hn_stories USING btree (points DESC);

CREATE INDEX IF NOT EXISTS idx_hn_stories_updated ON hn_stories USING btree (updated_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_chunks_content_hash ON memory_chunks USING btree (content_hash);

CREATE INDEX IF NOT EXISTS idx_memory_chunks_fts ON memory_chunks USING gin (tsv_content);

CREATE INDEX IF NOT EXISTS idx_memory_chunks_source ON memory_chunks USING btree (source_id);

CREATE INDEX IF NOT EXISTS idx_memory_sources_agent ON memory_sources USING btree (agent_id);

CREATE INDEX IF NOT EXISTS idx_memory_sources_observation_ids ON memory_sources USING gin ((((metadata_json)::jsonb -> 'observationIds'::text))) WHERE (kind = 'observation'::text);

CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages USING btree (channel, chat_id, "timestamp");

CREATE INDEX IF NOT EXISTS idx_monitor_alerts_active ON monitor_alerts USING btree (resolved_at, fired_at DESC);

CREATE INDEX IF NOT EXISTS idx_monitor_alerts_fired ON monitor_alerts USING btree (fired_at DESC);

CREATE INDEX IF NOT EXISTS idx_news_runs_source ON news_scraper_runs USING btree (source_name, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_news_source ON news_articles USING btree (source_name, scraped_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_news_url_hash ON news_articles USING btree (url_hash);

CREATE INDEX IF NOT EXISTS idx_observations_agent ON conversation_observations USING btree (agent_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_observations_chat ON conversation_observations USING btree (channel, chat_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ph_products_featured_at ON ph_products USING btree (featured_at DESC);

CREATE INDEX IF NOT EXISTS idx_prewarm_domain ON prewarm_cache USING btree (domain);

CREATE INDEX IF NOT EXISTS idx_process_commands_target ON process_commands USING btree (target, acknowledged_at);

CREATE INDEX IF NOT EXISTS idx_process_logs_context ON process_logs USING btree (context, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_process_logs_lookup ON process_logs USING btree (created_at DESC, process_name, level);

CREATE INDEX IF NOT EXISTS idx_reddit_posts_score ON reddit_posts USING btree (score DESC);

CREATE INDEX IF NOT EXISTS idx_reddit_posts_subreddit ON reddit_posts USING btree (subreddit, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_reddit_posts_updated ON reddit_posts USING btree (updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_routing_decisions_agent ON routing_decisions USING btree (selected_agent_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_routing_decisions_session ON routing_decisions USING btree (session_id);

CREATE INDEX IF NOT EXISTS idx_routing_rules_lookup ON routing_rules USING btree (channel, enabled, priority DESC);

CREATE INDEX IF NOT EXISTS idx_session_history_agent ON session_history USING btree (agent_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_sessions_chat ON sessions USING btree (channel, chat_id);

CREATE INDEX IF NOT EXISTS idx_signals_agent ON research_signals USING btree (agent_id, consumed, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_subagent_audit_parent ON subagent_audit_log USING btree (parent_agent_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_subagent_audit_session ON subagent_audit_log USING btree (session_id);

CREATE INDEX IF NOT EXISTS idx_subagent_runs_parent ON subagent_runs USING btree (parent_session_key, status);

CREATE INDEX IF NOT EXISTS idx_task_classification_domain ON task_classification USING btree (domain, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_task_classification_hash ON task_classification USING btree (task_hash);

CREATE INDEX IF NOT EXISTS idx_task_embeddings_created ON task_embeddings USING btree (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_task_embeddings_domain ON task_embeddings USING btree (domain, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_task_embeddings_hash ON task_embeddings USING btree (task_hash);

CREATE INDEX IF NOT EXISTS idx_token_usage_agent ON token_usage USING btree (agent_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_token_usage_created ON token_usage USING btree (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_token_usage_source ON token_usage USING btree (source, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_tool_audit_agent_time ON tool_audit_log USING btree (agent_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_tool_audit_tool ON tool_audit_log USING btree (tool_name, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_user_preferences_active ON user_preferences USING btree (is_active, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_user_preferences_type ON user_preferences USING btree (preference_type, is_active);

CREATE INDEX IF NOT EXISTS idx_user_prompt_log_agent ON user_prompt_log USING btree (agent_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_user_prompt_log_session ON user_prompt_log USING btree (session_id);

CREATE INDEX IF NOT EXISTS idx_workload_history_sampled ON workload_history USING btree (sampled_at DESC);

CREATE INDEX IF NOT EXISTS idx_x_followed_users_account ON x_followed_users USING btree (account_id, followed_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_x_followed_users_dedup ON x_followed_users USING btree (account_id, username);

CREATE INDEX IF NOT EXISTS idx_x_liked_tweets_account ON x_liked_tweets USING btree (account_id, liked_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_x_liked_tweets_dedup ON x_liked_tweets USING btree (account_id, tweet_id);

CREATE INDEX IF NOT EXISTS idx_x_scraped_tweets_account ON x_scraped_tweets USING btree (account_id, scraped_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_x_scraped_tweets_dedup ON x_scraped_tweets USING btree (account_id, tweet_id);

CREATE INDEX IF NOT EXISTS idx_x_shared_videos_account ON x_shared_videos USING btree (account_id, shared_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_x_shared_videos_dedup ON x_shared_videos USING btree (account_id, source_tweet_id);

DO $$ BEGIN
ALTER TABLE ONLY cron_runs
    ADD CONSTRAINT cron_runs_job_id_fkey FOREIGN KEY (job_id) REFERENCES cron_jobs(id) ON DELETE CASCADE;
EXCEPTION WHEN others THEN NULL;
END $$;

DO $$ BEGIN
ALTER TABLE ONLY memory_chunks
    ADD CONSTRAINT memory_chunks_source_id_fkey FOREIGN KEY (source_id) REFERENCES memory_sources(id) ON DELETE CASCADE;
EXCEPTION WHEN others THEN NULL;
END $$;

DO $$ BEGIN
ALTER TABLE ONLY x_autofollow_jobs
    ADD CONSTRAINT x_autofollow_jobs_account_id_fkey FOREIGN KEY (account_id) REFERENCES x_accounts(id) ON DELETE CASCADE;
EXCEPTION WHEN others THEN NULL;
END $$;

DO $$ BEGIN
ALTER TABLE ONLY x_autolike_jobs
    ADD CONSTRAINT x_autolike_jobs_account_id_fkey FOREIGN KEY (account_id) REFERENCES x_accounts(id) ON DELETE CASCADE;
EXCEPTION WHEN others THEN NULL;
END $$;

DO $$ BEGIN
ALTER TABLE ONLY x_bookmark_jobs
    ADD CONSTRAINT x_bookmark_jobs_account_id_fkey FOREIGN KEY (account_id) REFERENCES x_accounts(id) ON DELETE CASCADE;
EXCEPTION WHEN others THEN NULL;
END $$;

DO $$ BEGIN
ALTER TABLE ONLY x_followed_users
    ADD CONSTRAINT x_followed_users_account_id_fkey FOREIGN KEY (account_id) REFERENCES x_accounts(id) ON DELETE CASCADE;
EXCEPTION WHEN others THEN NULL;
END $$;

DO $$ BEGIN
ALTER TABLE ONLY x_liked_tweets
    ADD CONSTRAINT x_liked_tweets_account_id_fkey FOREIGN KEY (account_id) REFERENCES x_accounts(id) ON DELETE CASCADE;
EXCEPTION WHEN others THEN NULL;
END $$;

DO $$ BEGIN
ALTER TABLE ONLY x_scraped_tweets
    ADD CONSTRAINT x_scraped_tweets_account_id_fkey FOREIGN KEY (account_id) REFERENCES x_accounts(id) ON DELETE CASCADE;
EXCEPTION WHEN others THEN NULL;
END $$;

DO $$ BEGIN
ALTER TABLE ONLY x_shared_videos
    ADD CONSTRAINT x_shared_videos_account_id_fkey FOREIGN KEY (account_id) REFERENCES x_accounts(id) ON DELETE CASCADE;
EXCEPTION WHEN others THEN NULL;
END $$;

DO $$ BEGIN
ALTER TABLE ONLY x_timeline_scrape_jobs
    ADD CONSTRAINT x_timeline_scrape_jobs_account_id_fkey FOREIGN KEY (account_id) REFERENCES x_accounts(id) ON DELETE CASCADE;
EXCEPTION WHEN others THEN NULL;
END $$;
