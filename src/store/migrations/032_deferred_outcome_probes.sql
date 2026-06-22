-- Deferred outcome re-probe queue (Phase 2 of the idea-funnel learning loop).
--
-- The same-run "proxy" verdict an idea gets at synthesis is a SELF-GRADE, not
-- ground truth. This table lets the cron side re-run the demand probes for a
-- proxy-VALIDATED idea after a delay (default 21 days) and SUPERSEDE the original
-- proxy verdict with a REAL "reprobe:*" outcome memory (demand grew → validated,
-- decayed → archived, flat → stored-pending). It is the only externally-grounded
-- signal besides a human dashboard verdict.
--
--   idea_id              : generated_ideas id the verdict is about.
--   title / summary*     : carried so the re-probe can rebuild a demand candidate
--                          WITHOUT a join (the idea row may be archived/edited).
--   segment / archetype  : carried for the superseding outcome memory's metadata.
--   validation_source    : 'proxy:<reason>' | 'human' — provenance of the enqueue.
--   validated_at         : epoch SECONDS the original verdict landed.
--   baseline_demand_json : the validation-time DemandArtifact snapshot, diffed
--                          against the re-probe to compute the score delta.
--   due_at               : epoch SECONDS the row becomes eligible (validated_at +
--                          delayDays). Claimed only when due_at <= now.
--   claimed_at           : epoch SECONDS a scheduler tick claimed the row (so two
--                          ticks never double-process); NULL until claimed.
--   reprobe_label        : 'grew' | 'flat' | 'decayed' | 'inconclusive'.
--   reprobe_demand_json  : the re-probe DemandArtifact snapshot.
--   reprobe_score_delta  : current demand score - baseline demand score.
--   outcome_recorded_at  : epoch SECONDS the outcome was recorded; NULL while open.
--
-- Additive + idempotent: CREATE TABLE / INDEX IF NOT EXISTS, no FK dependency, and
-- a PARTIAL UNIQUE on (idea_id) WHERE outcome_recorded_at IS NULL makes enqueue
-- idempotent (one OPEN re-probe per idea). A new empty table → index creation is
-- instant (no lock contention). Applies cleanly on every startup.
CREATE TABLE IF NOT EXISTS deferred_outcome_probes (
  id BIGSERIAL PRIMARY KEY,
  idea_id TEXT NOT NULL,
  title TEXT NOT NULL,
  segment TEXT,
  archetype TEXT,
  validation_source TEXT NOT NULL,
  validated_at BIGINT NOT NULL,
  baseline_demand_json JSONB,
  due_at BIGINT NOT NULL,
  claimed_at BIGINT,
  reprobe_label TEXT,
  reprobe_demand_json JSONB,
  reprobe_score_delta REAL,
  outcome_recorded_at BIGINT
);

-- Due-claim scan path: claimDueReprobes filters due_at <= now AND open rows.
CREATE INDEX IF NOT EXISTS idx_deferred_outcome_probes_due_at
  ON deferred_outcome_probes (due_at);

-- Idempotent enqueue: at most ONE open (un-recorded) re-probe per idea_id. A
-- second enqueue for the same idea while one is still open is a no-op
-- (ON CONFLICT DO NOTHING). Once recorded, the partial predicate frees the slot so
-- a future re-validation can enqueue again.
CREATE UNIQUE INDEX IF NOT EXISTS uq_deferred_outcome_probes_open_idea
  ON deferred_outcome_probes (idea_id)
  WHERE outcome_recorded_at IS NULL;
