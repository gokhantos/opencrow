/**
 * In-process registry of pipeline runs currently executing in THIS process.
 *
 * The precise guard against duplicate dispatch: a run already executing here
 * must not be re-dispatched by an auto-resume (boot) or a manual resume. This is
 * exactly the bug that left a slow run with several concurrent executions and a
 * pile of orphaned 'running' step rows — a resume fired while the original was
 * still mid-synthesis.
 *
 * Process-lifetime scope is the correct scope: a process restart (the very thing
 * that orphans a 'running' run) clears the registry, so every run left 'running'
 * by the dead process is once again eligible for resume on the next boot. For
 * the cross-process case (multiple app instances), pair this with the persisted
 * heartbeat (see store.hasFreshHeartbeat) — a live run elsewhere keeps a fresh
 * heartbeat that this process can observe.
 *
 * Lives in its own module so both the executor (runIdeasPipeline) and the resume
 * layer can share it without the data layer importing the pipeline.
 */

const active = new Set<string>();

/**
 * Mark a run as executing in this process. Returns `false` if it was ALREADY
 * active — the caller lost the race and must NOT proceed (it would double-
 * execute). Atomic check-and-add: no await between the check and the add.
 */
export function beginRun(runId: string): boolean {
  if (active.has(runId)) return false;
  active.add(runId);
  return true;
}

/** Release a run once its execution settles. No-op if it was never active. */
export function endRun(runId: string): void {
  active.delete(runId);
}

/** Whether a run is currently executing in this process. */
export function isRunActive(runId: string): boolean {
  return active.has(runId);
}

/** Test-only: drop all entries so each test starts from a clean registry. */
export function __resetActiveRuns(): void {
  active.clear();
}
