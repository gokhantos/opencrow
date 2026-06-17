/**
 * Stale-run reaper: safety net for runs whose owning process died and was never
 * re-dispatched (boot-resume didn't run, or the run's resume budget is spent).
 *
 * A run is considered stale when:
 *   - status = 'running', AND
 *   - it is NOT active in this process (in-process registry), AND
 *   - it has NO step with a fresh heartbeat within `staleSec` seconds.
 *
 * For each stale run: fail its non-terminal steps (removing the ghost), then
 * mark the run itself 'failed'. This makes the run eligible for a manual resume.
 *
 * Never throws — mirrors resume.ts style so a single bad run does not abort the
 * whole sweep.
 */

import { createLogger } from "../logger";
import { isRunActive } from "./active-runs";
import {
  findResumableRuns,
  hasFreshHeartbeat,
  failIncompleteStepsForRun,
  markRunFailed,
} from "./store";

const log = createLogger("pipeline:reaper");

/**
 * Default staleness threshold. Well above the 10s heartbeat interval and the
 * LIVE_HEARTBEAT_WINDOW_SEC=60 liveness window — a run is not reaped unless its
 * heartbeat has been dead for at least this long.
 */
export const DEFAULT_REAPER_STALE_SEC = 300; // 5 minutes

export interface ReaperResult {
  readonly reaped: number;
}

/**
 * Reap runs that are stuck in 'running' with no active executor and a stale
 * heartbeat. Safe to call periodically (every ~60s). Never throws.
 */
export async function reapStuckRuns(
  staleSec: number = DEFAULT_REAPER_STALE_SEC,
): Promise<ReaperResult> {
  let reaped = 0;

  let runs: Awaited<ReturnType<typeof findResumableRuns>>;
  try {
    runs = await findResumableRuns();
  } catch (err) {
    log.error("Reaper: failed to query resumable runs", { err });
    return { reaped: 0 };
  }

  for (const run of runs) {
    try {
      // Skip if executing in this process.
      if (isRunActive(run.id)) continue;

      // Skip if another process is keeping the heartbeat alive. NOTE: the reaper
      // deliberately uses the larger `staleSec` (default 300s) window here, not
      // resume.ts's LIVE_HEARTBEAT_WINDOW_SEC (60s) — it is the last-resort
      // backstop and must wait much longer before declaring a run dead.
      const fresh = await hasFreshHeartbeat(run.id, staleSec);
      if (fresh) continue;

      // The run is truly stuck — no executor, no heartbeat. Fail it.
      const failedSteps = await failIncompleteStepsForRun(
        run.id,
        `Reaped: no progress / heartbeat stale > ${staleSec}s`,
      );
      await markRunFailed(
        run.id,
        `Reaped: no progress / heartbeat stale > ${staleSec}s`,
      );
      reaped += 1;
      log.warn("Reaped stuck pipeline run", {
        runId: run.id,
        pipelineId: run.pipelineId,
        staleSec,
        failedSteps,
      });
    } catch (err) {
      log.error("Reaper: failed to reap run", { runId: run.id, err });
    }
  }

  return { reaped };
}
