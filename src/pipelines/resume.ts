/**
 * Auto-resume of pipeline runs interrupted by a process restart (a deploy).
 *
 * A run that dies because the process restarted stays `status = 'running'` (a
 * genuine in-code failure sets `'failed'` instead — see runIdeasPipeline's
 * catch). On the next boot we re-dispatch each such run through the SAME
 * pipeline with its ORIGINAL runId: the checkpoint-aware runStep replays every
 * already-completed step from its persisted output and execution falls through
 * to the first incomplete step.
 *
 * Lives outside store.ts so the data layer never imports the pipeline.
 */

import { createLogger } from "../logger";
import type { MemoryManager } from "../memory/types";
import {
  findResumableRuns,
  incrementResumeAttempts,
  markRunFailed,
} from "./store";
import { runIdeasPipeline } from "./ideas/pipeline";

const log = createLogger("pipeline:resume");

/**
 * How many times a single run may be auto-resumed before we give up and fail
 * it. Bounds the blast radius if one step deterministically crashes the process
 * (otherwise it would loop forever across deploys).
 */
export const MAX_RESUME_ATTEMPTS = 3;

export interface ResumeResult {
  readonly resumed: number;
  readonly failed: number;
}

/**
 * Decide what to do with one interrupted run given its prior attempt count.
 * PURE — no IO; the side effects are performed by the caller. Exposed for
 * direct unit testing of the cap boundary.
 */
export function classifyResume(resumeAttempts: number): "resume" | "fail" {
  return resumeAttempts >= MAX_RESUME_ATTEMPTS ? "fail" : "resume";
}

/**
 * Find runs interrupted by a restart and re-dispatch them (or fail the ones
 * that have exhausted their resume budget). Fire-and-forget per run — matches
 * the /run route, where concurrent runs are allowed. Never throws: a failure to
 * resume one run is logged and the rest proceed.
 */
export async function resumeInterruptedRuns(
  memoryManager?: MemoryManager | null,
): Promise<ResumeResult> {
  let resumed = 0;
  let failed = 0;

  let runs: Awaited<ReturnType<typeof findResumableRuns>>;
  try {
    runs = await findResumableRuns();
  } catch (err) {
    log.error("Failed to query resumable runs", { err });
    return { resumed: 0, failed: 0 };
  }

  for (const run of runs) {
    try {
      if (classifyResume(run.resumeAttempts) === "fail") {
        await markRunFailed(
          run.id,
          `Exceeded max resume attempts (${MAX_RESUME_ATTEMPTS})`,
        );
        failed += 1;
        log.warn("Run exceeded max resume attempts — marking failed", {
          runId: run.id,
          attempts: run.resumeAttempts,
        });
        continue;
      }

      const attempt = await incrementResumeAttempts(run.id);
      log.info("Resuming interrupted pipeline run", {
        runId: run.id,
        pipelineId: run.pipelineId,
        attempt,
      });

      // Fire-and-forget: the run continues in the background from its last
      // completed step. Errors are caught so an immediate re-failure does not
      // crash startup.
      runIdeasPipeline(run.pipelineId, run.config, run.id, memoryManager).catch(
        (err) => {
          log.error("Resumed pipeline run failed", { runId: run.id, err });
        },
      );
      resumed += 1;
    } catch (err) {
      log.error("Failed to resume run", { runId: run.id, err });
    }
  }

  return { resumed, failed };
}
