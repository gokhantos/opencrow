/**
 * Single-instance takeover decision logic.
 *
 * When a process boots WITHOUT an orchestrator parent (i.e. it is the top-level
 * `core`, or a host-installed `web` service), it must reconcile against a
 * possibly-stale `process_registry` row left by a previous boot. The original
 * implementation killed whatever process held the recorded PID — which is
 * catastrophic in a container where the PID namespace is tiny and PIDs are
 * recycled: the stale row's PID (e.g. 11) maps to the container's own
 * bun/start-script ancestor on the next boot, so we SIGTERM our own parent and
 * crash-loop forever.
 *
 * This module isolates the *decision* (a pure function, no syscalls / no DB) so
 * the dangerous `process.kill` path is provably gated and unit-testable. The
 * supervisor gathers the facts (liveness, ancestry, container-ness, identity)
 * and feeds them in; the function never touches `process.*`.
 */

/** Per-process-start identity persisted into the registry row's metadata. */
export const INSTANCE_ID_KEY = "instanceId";

export type StaleAction = "skip" | "takeover" | "kill";

export interface StaleDecisionInput {
  /** Does a previous-boot registry row exist for this logical process name? */
  readonly hasExisting: boolean;
  /** PID recorded in the stale row (only meaningful when hasExisting). */
  readonly existingPid: number;
  /** instanceId recorded in the stale row's metadata, if any. */
  readonly existingInstanceId: string | undefined;
  /** This process's own PID. */
  readonly selfPid: number;
  /** This process's own freshly-generated instanceId. */
  readonly selfInstanceId: string;
  /** Is the recorded PID currently a live process? (process.kill(pid, 0)) */
  readonly existingPidAlive: boolean;
  /**
   * Is the recorded PID an ancestor of self (parent, grandparent, ...)? Killing
   * an ancestor tears down our own process tree — never do it.
   */
  readonly existingPidIsAncestor: boolean;
  /**
   * Are we running inside a container (docker/podman/k8s)? There the runtime +
   * restart policy already guarantee one instance per container, and PIDs are
   * reused, so killing by recorded PID is never correct.
   */
  readonly inContainer: boolean;
}

export interface StaleDecision {
  readonly action: StaleAction;
  /** Human-readable reason, surfaced in logs for operability. */
  readonly reason: string;
}

/**
 * Decide what to do about a stale single-instance registry row.
 *
 * Outcomes:
 *  - "skip":     leave everything as-is (no existing row, or it's us, or the row
 *                belongs to a process we must NOT touch — an ancestor).
 *  - "takeover": overwrite the registry row with ourselves WITHOUT killing the
 *                old PID (the old instance is gone, or the runtime owns
 *                singleton-ness, or the recorded PID can't be positively
 *                attributed to the old instance).
 *  - "kill":     the recorded PID is positively a *different, still-live*
 *                instance of the same logical process on this host — terminate
 *                it, then take over.
 */
export function decideStaleAction(input: StaleDecisionInput): StaleDecision {
  if (!input.hasExisting) {
    return { action: "skip", reason: "no existing registry row" };
  }

  // The row is already ours (same instanceId, or — for legacy rows without an
  // instanceId — same PID). Nothing to reconcile.
  const isSelfById =
    input.existingInstanceId !== undefined && input.existingInstanceId === input.selfInstanceId;
  const isSelfByPid = input.existingPid === input.selfPid;
  if (isSelfById || isSelfByPid) {
    return { action: "skip", reason: "registry row already belongs to self" };
  }

  // Stale row points at a dead PID: the old instance is gone. Just take over.
  if (!input.existingPidAlive) {
    return {
      action: "takeover",
      reason: "previous instance PID is not alive",
    };
  }

  // From here the recorded PID is alive but is NOT us.

  // Belt-and-suspenders: never kill an ancestor of ourselves. In a container the
  // recycled PID is typically our own start-script/bun parent.
  if (input.existingPidIsAncestor) {
    return {
      action: "takeover",
      reason: "recorded PID is an ancestor of self — refusing to kill",
    };
  }

  // In a container the runtime + restart policy guarantee a single instance per
  // container, and PIDs are reused, so a live PID match does NOT prove it's the
  // old instance. Take over the row without killing anything.
  if (input.inContainer) {
    return {
      action: "takeover",
      reason: "running in a container — runtime owns singleton-ness",
    };
  }

  // Host deploy. To positively attribute the live PID to the old instance we
  // require the stale row to carry a different instanceId. A legacy row with no
  // instanceId (pre-upgrade) is ambiguous: the live PID could be a recycled,
  // unrelated process, so we do NOT kill — we take over and let our own
  // instanceId disambiguate going forward.
  if (input.existingInstanceId === undefined) {
    return {
      action: "takeover",
      reason: "legacy row without instanceId — cannot positively attribute PID",
    };
  }

  // Host + live PID + a recorded instanceId that differs from ours: a genuine
  // previous instance survived an unclean restart. Take over by killing it.
  return {
    action: "kill",
    reason: "different live instance of same process on host",
  };
}
