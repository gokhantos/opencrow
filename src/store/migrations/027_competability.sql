-- Layer B "competability / moat gate" persistence — make the per-idea
-- competability scorecard queryable on generated_ideas (PR #208 follow-up #2).
--
-- Both idea paths (the trend-intersection pipeline's Pass-3 critique AND the
-- SIGE strategic-agent cross-write) compute a competability scorecard in-memory
-- but currently DROP it on the floor — only per-kill log lines survived. These
-- two columns let the gate be observed and analysed after the fact:
--   competability_overall : the single 0..5 "a small builder can win v1" score.
--   competability_json     : the full scorecard — the 4 moat dimensions
--                            (capital/networkEffect/logistics/regulated), the
--                            rationale, the gate decision reason, and the gated
--                            flag (whether the gate would/did reject the idea).
--
-- Additive + idempotent: guarded ADD COLUMN IF NOT EXISTS, no dependency on any
-- other relation, applies cleanly on every startup.
ALTER TABLE generated_ideas ADD COLUMN IF NOT EXISTS competability_overall REAL;
ALTER TABLE generated_ideas ADD COLUMN IF NOT EXISTS competability_json JSONB;
