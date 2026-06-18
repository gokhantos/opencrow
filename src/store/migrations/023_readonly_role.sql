-- Migration 022: least-privilege read-only role for the db_query agent tool
--
-- PURPOSE
-- =======
-- Creates the `opencrow_readonly` PostgreSQL role and grants it SELECT access
-- to analytics/content tables only.  Credential and secret tables are
-- explicitly withheld.
--
-- GRANT STRATEGY — FAIL-CLOSED (read this before adding tables)
-- =============================================================
-- This migration uses an EXPLICIT per-table GRANT allowlist instead of
-- `GRANT SELECT ON ALL TABLES` or `ALTER DEFAULT PRIVILEGES ... GRANT SELECT`.
--
-- WHY: the migration runner (src/store/db.ts) has NO tracking table and
-- RE-RUNS EVERY MIGRATION ON EVERY STARTUP.  A blanket GRANT would
-- automatically re-grant SELECT to `opencrow_readonly` on any credential
-- table that a later migration creates, the moment the service reboots.
-- `ALTER DEFAULT PRIVILEGES` would do the same for every new table going
-- forward.  Both are removed here for that reason.
--
-- CONSEQUENCE: new tables are NOT readable by `opencrow_readonly` by default.
-- This is intentional — fail-closed is the only safe default.
--
-- OPERATORS MUST follow these rules when adding new migrations:
--
--   - If the new table is an analytics/content table that the db_query tool
--     SHOULD be able to read, add to the same migration:
--
--       GRANT SELECT ON TABLE <new_table> TO opencrow_readonly;
--
--   - If the new table holds credentials, secrets, tokens, auth state, or any
--     sensitive user data, add to the same migration (belt-and-suspenders):
--
--       REVOKE ALL ON TABLE <new_table> FROM opencrow_readonly;
--
--     AND add the table name to SENSITIVE_TABLES in src/tools/db-query.ts.
--
--   Failing to do either means the new table is simply not accessible to the
--   read-only role, which is safe but means queries against it will fail.
--
-- OPERATOR SETUP (one-time, before setting OPENCROW_READONLY_DATABASE_URL)
-- =========================================================================
-- This migration creates the role with NOLOGIN as a safe placeholder so it
-- exists in the DB catalog.  A NOLOGIN role cannot be used as a connection
-- credential.  Before pointing OPENCROW_READONLY_DATABASE_URL at this role
-- you MUST enable login and set a password.  Run as a superuser:
--
--   ALTER ROLE opencrow_readonly LOGIN PASSWORD 'choose-a-strong-password';
--
-- Alternatively, pre-create the role yourself (WITH LOGIN) before the service
-- first starts; the DO block below will skip creation if the role already
-- exists (EXCEPTION WHEN duplicate_object).
--
-- Then set the environment variable:
--
--   OPENCROW_READONLY_DATABASE_URL=postgres://opencrow_readonly:<password>@host/db
--
-- The db_query tool will use that connection when the env var is set.
--
-- IDEMPOTENCY
-- ===========
-- All blocks are wrapped in DO $$ ... EXCEPTION ... END $$ so re-running on
-- an already-configured DB is safe and non-fatal (matches the runner's
-- non-fatal migration semantics in src/store/db.ts).

-- 1. Create the role if it does not already exist.
--    NOLOGIN is safe here; the operator enables login via ALTER ROLE (see above).
DO $$
BEGIN
  CREATE ROLE opencrow_readonly WITH NOLOGIN;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 2. Allow the role to inspect objects in the public schema.
DO $$
BEGIN
  GRANT USAGE ON SCHEMA public TO opencrow_readonly;
EXCEPTION WHEN insufficient_privilege THEN NULL;
END $$;

-- 3. Explicit SELECT allowlist: analytics and content tables only.
--    New tables are NOT included automatically — see the GRANT STRATEGY above.
--    Tables listed here were created by migrations 000-021 and are confirmed
--    non-credential.  Update this list (in the same migration) when adding
--    new readable tables.

DO $$
BEGIN
  GRANT SELECT ON TABLE
    agent_memory,
    agent_messages,
    appstore_apps,
    appstore_ranking_history,
    appstore_rankings,
    appstore_reviews,
    conversation_observations,
    conversation_summaries,
    cost_tracking,
    cron_deliveries,
    cron_jobs,
    cron_runs,
    economic_calendar_events,
    generated_ideas,
    github_repos,
    hn_stories,
    idea_eval_runs,
    idea_feedback,
    memory_chunks,
    memory_sources,
    messages,
    monitor_alerts,
    news_articles,
    news_scraper_runs,
    ph_products,
    pipeline_consumed_signals,
    pipeline_runs,
    pipeline_steps,
    playstore_apps,
    playstore_ranking_history,
    playstore_rankings,
    playstore_reviews,
    prewarm_cache,
    process_commands,
    process_logs,
    process_registry,
    reddit_posts,
    research_signals,
    routing_decisions,
    routing_rules,
    session_history,
    sessions,
    sige_agent_actions,
    sige_game_formulations,
    sige_idea_scores,
    sige_population_dynamics,
    sige_sessions,
    sige_simulation_results,
    signal_facets,
    subagent_audit_log,
    subagent_runs,
    task_classification,
    task_embeddings,
    token_usage,
    tool_audit_log,
    tool_stats,
    user_preferences,
    user_prompt_log,
    workflow_execution_steps,
    workflow_executions,
    workflows,
    workload_history,
    x_autofollow_jobs,
    x_autolike_jobs,
    x_bookmark_jobs,
    x_followed_users,
    x_liked_tweets,
    x_scraped_tweets,
    x_shared_videos,
    x_timeline_scrape_jobs
  TO opencrow_readonly;
EXCEPTION WHEN undefined_table THEN NULL;
END $$;

-- 4. Belt-and-suspenders: explicitly revoke all access to credential/secret
--    tables.  These are also blocked at the code level in src/tools/db-query.ts
--    (SENSITIVE_TABLES), but the DB-layer REVOKE is the authoritative boundary.
--
--    NOTE TO REVIEWERS: if you add a new credential table and see it missing
--    here, that is a bug — add the REVOKE in the same migration that creates
--    the table (see GRANT STRATEGY in the header above).

DO $$
BEGIN
  REVOKE ALL ON TABLE x_accounts FROM opencrow_readonly;
EXCEPTION WHEN undefined_table THEN NULL;
END $$;

DO $$
BEGIN
  REVOKE ALL ON TABLE ph_accounts FROM opencrow_readonly;
EXCEPTION WHEN undefined_table THEN NULL;
END $$;

DO $$
BEGIN
  REVOKE ALL ON TABLE reddit_accounts FROM opencrow_readonly;
EXCEPTION WHEN undefined_table THEN NULL;
END $$;

DO $$
BEGIN
  REVOKE ALL ON TABLE sdk_sessions FROM opencrow_readonly;
EXCEPTION WHEN undefined_table THEN NULL;
END $$;

DO $$
BEGIN
  REVOKE ALL ON TABLE config_overrides FROM opencrow_readonly;
EXCEPTION WHEN undefined_table THEN NULL;
END $$;

-- 5. Deny reads of PostgreSQL system catalog views that expose credentials.
DO $$
BEGIN
  REVOKE ALL ON TABLE pg_shadow FROM opencrow_readonly;
EXCEPTION WHEN undefined_table THEN NULL;
END $$;

DO $$
BEGIN
  REVOKE ALL ON TABLE pg_authid FROM opencrow_readonly;
EXCEPTION WHEN undefined_table THEN NULL;
END $$;
