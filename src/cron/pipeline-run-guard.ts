/**
 * pipeline-run-guard.ts — pure "is a pipeline run already in flight?" decision
 * for the SCHEDULED ideas-pipeline cron job (`CronPayload.kind === "pipelineRun"`).
 *
 * Why this exists: `acquirePipelineLock` (`src/pipelines/store.ts`) is a lock in
 * name only — it unconditionally INSERTs a fresh `pipeline_runs` row and returns
 * `acquired: true`, because the dashboard's manual "Run" button deliberately
 * allows concurrent runs. That is fine for a human clicking a button; it is NOT
 * fine for an unattended daily schedule, where a run that overruns its cadence
 * would silently stack a second ~14-minute LLM-spending run on top of the first.
 *
 * The liveness test is deliberately two-sided, because "status = 'running'" on
 * its own is NOT proof of life — the corpus contains rows from processes that
 * died without ever reaching a terminal status (that is exactly what
 * `reaper.ts` exists to clean up, and it only runs in the `web` process). If we
 * blocked on any `running` row, one zombie would wedge the schedule forever.
 * So a run counts as LIVE when either:
 *
 *   1. it has a fresh step heartbeat (`hasFreshHeartbeat` — the cross-process
 *      liveness signal `resume.ts` already trusts for exactly this purpose), or
 *   2. it started within {@link DEFAULT_START_GRACE_SECONDS} — a just-dispatched
 *      run has not written its first step heartbeat yet, so the heartbeat check
 *      alone would let a second run start seconds after the first.
 *
 * Anything older than the grace window with no heartbeat is presumed dead and
 * is NOT allowed to block the schedule; the reaper will mark it failed.
 *
 * Pure and DB-free by design (the caller supplies the already-queried rows), so
 * the whole decision is unit-testable without a database.
 *
 * ## Assumption: exactly ONE cron process at a time
 *
 * The inputs are read from Postgres, so this guard works across processes — but
 * it is a check-then-act, not an atomic one. `acquirePipelineLock` genuinely
 * does not lock, so if TWO cron processes ever ran concurrently (e.g. a rolling
 * deploy leaving the old container alive, or `replicas: 2`) both could pass the
 * guard in the same tick and each start a run: a TOCTOU race between this read
 * and each process's own INSERT.
 *
 * That cannot happen under the current single-supervised-`cron`-child
 * architecture (see CLAUDE.md), which is why no advisory lock is taken here.
 * If cron is ever scaled to more than one process, this guard MUST be upgraded
 * to hold a Postgres advisory lock (e.g. `pg_try_advisory_lock(hashtext(
 * pipelineId))`) spanning the check and the `acquirePipelineLock` call —
 * otherwise it will silently start double-dispatching ~14-minute LLM runs.
 */

/**
 * Grace period after a run's `started_at` during which it is treated as live
 * even with no step heartbeat yet. Comfortably larger than the pipeline's
 * first-step latency but far smaller than a normal ~14-minute run, so it never
 * masks a genuinely dead run for long.
 */
export const DEFAULT_START_GRACE_SECONDS = 300;

/** One `status = 'running'` pipeline run, plus the two liveness inputs. */
export interface InFlightRun {
  readonly runId: string;
  /** Epoch seconds, or null when the row never recorded one. */
  readonly startedAt: number | null;
  /** Result of `hasFreshHeartbeat(runId, …)` for this run. */
  readonly hasFreshHeartbeat: boolean;
}

export interface PipelineRunStartDecision {
  readonly shouldRun: boolean;
  /** Human-readable skip reason, or null when starting. */
  readonly reason: string | null;
  /** The run that blocked the start, or null when starting. */
  readonly blockingRunId: string | null;
}

export interface PipelineRunStartOptions {
  readonly nowEpochSeconds: number;
  /** Override for {@link DEFAULT_START_GRACE_SECONDS}. */
  readonly startGraceSeconds?: number;
}

const START: PipelineRunStartDecision = Object.freeze({
  shouldRun: true,
  reason: null,
  blockingRunId: null,
});

/**
 * Decide whether a scheduled pipeline run may start, given every currently
 * `running` run for that pipeline. Returns the FIRST live blocker found so the
 * log/skip reason names a concrete run id.
 */
export function decidePipelineRunStart(
  inFlight: readonly InFlightRun[],
  opts: PipelineRunStartOptions,
): PipelineRunStartDecision {
  const grace = opts.startGraceSeconds ?? DEFAULT_START_GRACE_SECONDS;

  for (const candidate of inFlight) {
    if (candidate.hasFreshHeartbeat) {
      return {
        shouldRun: false,
        reason: `run ${candidate.runId} is still executing (fresh step heartbeat)`,
        blockingRunId: candidate.runId,
      };
    }
    // A null startedAt is an unknown age, never proof of death — treat it as
    // inside the grace window so we skip rather than double-dispatch.
    const ageSeconds =
      candidate.startedAt === null ? 0 : opts.nowEpochSeconds - candidate.startedAt;
    if (ageSeconds <= grace) {
      return {
        shouldRun: false,
        reason: `run ${candidate.runId} started ${ageSeconds}s ago (within ${grace}s start grace)`,
        blockingRunId: candidate.runId,
      };
    }
  }

  return START;
}
