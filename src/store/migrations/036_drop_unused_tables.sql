-- Cleanup: drop unused tables and sync migrations with DB reality
-- 1) 8 tables in DB with zero code references
-- 2) 28 tables from old migrations that were manually dropped
-- 3) Create routing_rules (exists in DB but had no migration)

-- === 1. Unused tables still in DB ===
DROP TABLE IF EXISTS agent_capacity CASCADE;
DROP TABLE IF EXISTS conversation_state CASCADE;
DROP TABLE IF EXISTS conversation_topics CASCADE;
DROP TABLE IF EXISTS pending_restarts CASCADE;
DROP TABLE IF EXISTS scholar_papers CASCADE;
DROP TABLE IF EXISTS task_outcomes CASCADE;
DROP TABLE IF EXISTS task_revisions CASCADE;
DROP TABLE IF EXISTS tool_scores CASCADE;

-- === 2. Tables from old migrations, already manually dropped (idempotent) ===
-- DeFi/Llama (019)
DROP TABLE IF EXISTS defi_protocols CASCADE;
DROP TABLE IF EXISTS defi_chain_tvls CASCADE;
DROP TABLE IF EXISTS defi_chain_tvl_history CASCADE;
DROP TABLE IF EXISTS defi_chain_metrics CASCADE;
DROP TABLE IF EXISTS defi_protocol_detail CASCADE;
DROP TABLE IF EXISTS defi_categories CASCADE;
DROP TABLE IF EXISTS defi_global_metrics CASCADE;
DROP TABLE IF EXISTS defi_protocol_metrics CASCADE;
DROP TABLE IF EXISTS defi_yield_pools CASCADE;
DROP TABLE IF EXISTS defi_bridges CASCADE;
DROP TABLE IF EXISTS defi_hacks CASCADE;
DROP TABLE IF EXISTS defi_emissions CASCADE;
DROP TABLE IF EXISTS defi_stablecoins CASCADE;
DROP TABLE IF EXISTS defi_treasury CASCADE;

-- Predictions/intelligence (016)
DROP TABLE IF EXISTS prediction_records CASCADE;
DROP TABLE IF EXISTS prediction_models CASCADE;
DROP TABLE IF EXISTS prediction_performance CASCADE;
DROP TABLE IF EXISTS preference_extractions CASCADE;

-- Routing/scoring (013, 014)
DROP TABLE IF EXISTS agent_scores CASCADE;
DROP TABLE IF EXISTS agent_score_adjustments CASCADE;
DROP TABLE IF EXISTS mcp_performance CASCADE;
DROP TABLE IF EXISTS mcp_scores CASCADE;

-- Failure tracking (014)
DROP TABLE IF EXISTS failure_records CASCADE;
DROP TABLE IF EXISTS failure_patterns CASCADE;

-- Other dead features
DROP TABLE IF EXISTS arxiv_papers CASCADE;
DROP TABLE IF EXISTS hf_models CASCADE;
DROP TABLE IF EXISTS google_trends CASCADE;
DROP TABLE IF EXISTS anti_recommendations CASCADE;
