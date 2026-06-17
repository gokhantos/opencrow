/**
 * Side-effecting runtime probes used by the single-instance guard.
 *
 * Kept apart from `instance-guard.ts` (the pure decision) so the syscall / fs /
 * env access lives in one place and the decision logic stays unit-testable.
 */
import { readFileSync } from "node:fs";

/**
 * Detect whether we are running inside a container. Cheap, best-effort, and
 * conservative: any positive signal counts. Order: explicit opt-in env, then
 * the docker marker file, then a cgroup heuristic (docker/k8s/containerd/podman).
 */
export function detectInContainer(): boolean {
  if (process.env.OPENCROW_IN_CONTAINER === "1") return true;

  try {
    readFileSync("/.dockerenv");
    return true;
  } catch {
    // not docker — keep probing
  }

  try {
    const cgroup = readFileSync("/proc/1/cgroup", "utf8");
    if (/docker|kubepods|containerd|podman|libpod/.test(cgroup)) return true;
  } catch {
    // /proc unavailable (e.g. macOS host) — not a container
  }

  return false;
}

/** Is `pid` currently a live process? Mirrors `process.kill(pid, 0)`. */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Parse the parent PID (ppid) out of a `/proc/<pid>/stat` line. Pure and
 * exported so the parenthesis-in-comm edge case is unit-testable without /proc.
 *
 * Format: "<pid> (<comm>) <state> <ppid> ...". `comm` may itself contain spaces
 * and parens (e.g. "(my (weird) proc)"), so the field boundary is found via the
 * LAST ')'. Returns null when the line can't be parsed.
 */
export function parsePpidFromStat(statLine: string): number | null {
  const close = statLine.lastIndexOf(")");
  if (close === -1) return null;
  const fields = statLine
    .slice(close + 2)
    .trim()
    .split(/\s+/);
  // After the post-comm "<state>" field, the next field is ppid. A truncated
  // read (e.g. a /proc race during teardown) can leave fewer fields — bail
  // rather than coerce undefined to NaN implicitly.
  if (fields.length < 2) return null;
  const ppid = Number(fields[1]);
  return Number.isInteger(ppid) ? ppid : null;
}

/**
 * Read a PID's parent PID from `/proc/<pid>/stat`. Returns null when /proc is
 * unavailable (macOS host) or the entry can't be parsed. The ancestry guard
 * treats null as "can't prove ancestry" (safe: it only ever ADDS a refusal to
 * kill, never authorises one).
 */
function readParentPid(pid: number): number | null {
  try {
    return parsePpidFromStat(readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Is `candidatePid` an ancestor (parent, grandparent, …) of `selfPid`? Walks the
 * /proc parent chain up to PID 1, with a hard hop cap to avoid pathological
 * loops. On hosts without /proc this returns false — there the explicit
 * instanceId check is the primary guard, and the container path doesn't apply.
 */
export function isAncestorOf(candidatePid: number, selfPid: number, maxHops = 64): boolean {
  if (candidatePid === selfPid) return false;
  let current = selfPid;
  for (let i = 0; i < maxHops; i++) {
    const parent = readParentPid(current);
    if (parent === null || parent === 0) return false;
    if (parent === candidatePid) return true;
    if (parent === current) return false; // self-parent guard
    current = parent;
  }
  return false;
}
