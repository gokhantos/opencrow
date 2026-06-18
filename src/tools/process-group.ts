import { createLogger } from "../logger";

const log = createLogger("tool:process-group");

/**
 * Kill an entire process group by its leader pid.
 *
 * Child processes must be spawned `detached: true` (POSIX `setsid()`) so the
 * child leads its own process group and its pgid equals its pid. A
 * negative-pid signal then reaches the whole pipeline (e.g. `yes | head`) —
 * not just the shell PID. Without this, killing only the shell re-parents its
 * forked children to PID 1 (launchd/init) where they can spin a CPU core
 * forever. Works natively on macOS and Linux.
 *
 * Best-effort and side-effect-free: ESRCH means the group is already gone (the
 * common case on a normal-exit sweep) and is ignored; other errors are logged
 * at debug. Never throws.
 */
export function killProcessGroup(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) {
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ESRCH") {
      return;
    }
    log.debug("Failed to kill process group", { pid, error });
  }
}
