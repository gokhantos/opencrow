# Resumable Pipeline Runs — Design

**Date:** 2026-06-17
**Status:** Approved
**Author:** brainstorming session

## Problem

A pipeline run (`runIdeasPipeline`, `src/pipelines/ideas/pipeline.ts`) executes entirely
in one process's memory. Step outputs (`trends`, `pains`, `capabilities`,
`deepSearchContext`, synthesis candidates) live only as local variables; the DB persists
only a text `output_summary` per step. When the process restarts — in practice, a deploy
(this is a containerized service) — the in-flight run dies. On next boot
`recoverOrphanedRuns()` finds it still `running` and marks it `failed`
("Run was interrupted by process restart"). All collector work (often several minutes of
scraping + LLM insight) is lost.

## Goal

When a deploy interrupts a run, the next process boot resumes it automatically from the
last completed step — no manual clicks, no re-scraping completed stages.

## Decisions (from brainstorming)

- **Trigger:** automatic on next boot (deploys are the cause; you can't prevent them).
- **Granularity:** existing `runStep` boundaries only. The four collector steps
  (`landscape`, `reviews`, `capabilities`, `deep_search`) are the expensive wasted work
  and are all already wrapped in `runStep`. The heavy post-synthesis processing is plain
  code between `runStep` calls and will NOT be individually checkpointed (rejected as
  invasive).
- **Mechanism:** Approach A — checkpoint-aware `runStep` + a `JSONB` column on the
  existing `pipeline_steps` rows. No new checkpoint table.

## Key insight: running vs failed is a clean discriminator

`runIdeasPipeline`'s outer `catch` sets `status = 'failed'` and re-throws
(`pipeline.ts:2677`). A process death never reaches that catch, so an interrupted run
stays `status = 'running'`. Therefore at boot: `running` = interrupted (resume it);
`failed` = genuine error (leave it). No extra flag needed to tell them apart.

## Data model — migration `017_resumable_runs.sql`

Additive + idempotent (migrations run every boot; failures are non-fatal):

```sql
ALTER TABLE pipeline_steps ADD COLUMN IF NOT EXISTS output_json JSONB;
ALTER TABLE pipeline_runs  ADD COLUMN IF NOT EXISTS resume_attempts INT NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_pipeline_steps_completed
  ON pipeline_steps (run_id, step_name) WHERE status = 'completed';
```

- `output_json` — full structured payload of a completed step, for replay-on-resume.
- `resume_attempts` — bounds auto-resume so a step that reliably crashes the process
  cannot loop forever across deploys.

**Serialization contract:** only JSON round-trippable step outputs are cached. Today's
step returns are plain data/strings — no `Map`/`Set`/`Date` crosses a `runStep` boundary.
A test asserts the round-trip for each step's return shape so a future non-serializable
return fails loudly.

## `runStep` change (the only pipeline-adjacent change)

```
runStep(runId, stepName, work, formatOutput):
  cached = findCompletedStep(runId, stepName)
  if cached has output_json:
      return cached.output_json        # no work(), no re-consume, no LLM spend
  step = createPipelineStep(...)
  result = await work()
  updatePipelineStep(step.id, { status: completed, outputSummary, outputJson: result, durationMs })
  return result
  # catch: unchanged (mark failed, rethrow)
```

The `runIdeasPipeline` body is untouched. Fresh run → all misses → normal execution.
Resumed run (same `runId`) → completed steps are hits → execution falls through to the
first incomplete step. Cheap inter-step glue (`saturatedThemes`, exemplar selection)
recomputes — negligible.

## Boot resume flow

`recoverOrphanedRuns` changes from "fail" to "resume". Orchestration moves to a new
`src/pipelines/resume.ts` module (so `store.ts` stays free of pipeline imports / keeps
layering clean). `web-index.ts` calls it at startup.

```
for each run with status='running':
  if resume_attempts >= MAX_RESUME_ATTEMPTS (3):
      markRunFailed(run, "Exceeded max resume attempts (3)")
  else:
      incrementResumeAttempts(run)
      runIdeasPipeline(pipelineId, run.config, run.id, memoryManager)   # fire-and-forget
```

The run's `config` is already persisted on `pipeline_runs` at run start, so resume needs
no extra state. Multiple interrupted runs each re-dispatch independently (concurrent runs
are already allowed).

`store.ts` keeps only dumb queries: `findCompletedStep`, `findResumableRuns`,
`incrementResumeAttempts`, `markRunFailed`. `output_json` is added to the
`updatePipelineStep` write.

## Edge cases

1. **`store` step double-insert** — the only unsafe replay (it calls `insertIdea` in a
   loop). Fix: at the start of the `store` step's `work()`,
   `DELETE FROM generated_ideas WHERE pipeline_run_id = $1` before inserting. The
   `finalSelected` set is deterministic from cached upstream steps, so a clean re-store
   reproduces exactly the intended rows. Idempotent without idempotency keys.
2. **Partially-run collector + consumed signals** — a collector only skips if it
   `completed` (and already committed `markConsumed`). A collector killed mid-run may have
   marked some rows consumed; on resume it re-runs and finds fewer signals. Identical to
   today's re-run behavior, never wrong (just thinner), self-heals next scrape. Documented
   limitation, not fixed (per-row checkpointing is the rejected Approach-B rabbit hole).
3. **Deploy-loop / poison step** — `MAX_RESUME_ATTEMPTS = 3`; 4th encounter → `failed`.
4. **Multiple interrupted runs** — each re-dispatched independently.
5. **Serialization read failure** — corrupt/legacy `output_json` → treated as a cache miss
   → step re-runs. Resume degrades to "redo that step," never crashes.
6. **Pre-migration in-flight runs** — no `output_json` on any step → full clean re-run on
   first post-deploy boot. Strictly better than today's hard `failed`. Cannot retroactively
   recover runs already marked `failed`.

## Testing

- **Unit:** `findCompletedStep` hit/miss; serialization round-trip per step return shape;
  attempt-cap boundary (3 → resume, 4 → fail).
- **Integration (DB):** seed a `running` run with 4 completed steps carrying `output_json`
  + 1 incomplete → resume returns cached outputs for the 4, runs only the 5th, never
  invokes `work()` for completed steps (spy); `store` deletes prior run ideas before
  re-insert (no duplicates).
- **Boot path:** `findResumableRuns` selects `running` only; over-cap run → `failed`.

Targets the repo's 80% coverage bar; the `runStep` cache path and boot resolver are the
critical-path units.

## Out of scope

- Per-row / sub-step checkpointing of the post-synthesis processing block.
- Preventing deploys / draining in-flight runs before shutdown.
- Retroactively recovering already-`failed` runs.
