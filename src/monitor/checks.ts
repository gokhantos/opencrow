import { getDb } from "../store/db";
import { createLogger } from "../logger";
import { CRASH_LOOP_KEY, listProcesses } from "../process/registry";
import type { CheckResult, MonitorThresholds } from "./types";

const log = createLogger("monitor:checks");

/** One-time "probe unsupported on this platform" warnings (keyed by probe). */
const warnedUnsupported = new Set<string>();

function warnUnsupportedOnce(probe: string): void {
  if (warnedUnsupported.has(probe)) return;
  warnedUnsupported.add(probe);
  log.warn("Resource probe unsupported on this platform", {
    probe,
    platform: process.platform,
  });
}

async function spawnText(cmd: readonly string[]): Promise<string | null> {
  try {
    const proc = Bun.spawn(cmd as string[], { stdout: "pipe", stderr: "pipe" });
    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0) return null;
    return output;
  } catch {
    return null;
  }
}

/**
 * Parse the used-percent of the filesystem backing `/` from POSIX `df -P`
 * output. `-P` (portable) is supported on both GNU/Linux and macOS/BSD and
 * always emits a fixed-column "Capacity" field ending in `%`.
 *
 * Exported for unit testing only — not part of the public API.
 */
export function parseDfCapacityPercent(output: string): number | null {
  const lines = output.trim().split("\n");
  const dataLine = lines[lines.length - 1];
  if (!dataLine) return null;
  // Columns: Filesystem Blocks Used Available Capacity MountedOn
  const pctField = dataLine.trim().split(/\s+/).find((f) => f.endsWith("%"));
  if (!pctField) return null;
  const pct = parseInt(pctField.replace("%", ""), 10);
  return Number.isFinite(pct) ? pct : null;
}

/**
 * Check if any registered process has a stale heartbeat.
 */
export async function checkProcessHealth(
  thresholds: MonitorThresholds,
): Promise<readonly CheckResult[]> {
  const db = getDb();
  const rows = await db`SELECT name, last_heartbeat FROM process_registry ORDER BY name`;
  const now = Math.floor(Date.now() / 1000);
  const results: CheckResult[] = [];

  for (const row of rows) {
    const age = now - Number(row.last_heartbeat);
    if (age > thresholds.processHeartbeatStaleSec) {
      const isDead = age > thresholds.processHeartbeatStaleSec * 2;
      results.push({
        category: "process",
        level: isDead ? "critical" : "warning",
        title: `Process ${row.name} is ${isDead ? "dead" : "stale"}`,
        detail: `No heartbeat for ${age}s (threshold: ${thresholds.processHeartbeatStaleSec}s)`,
        metric: age,
        threshold: thresholds.processHeartbeatStaleSec,
      });
    }
  }

  return results;
}

/**
 * Check for processes the orchestrator has flagged as crash-looping.
 *
 * The orchestrator (a different process) persists a crash-loop marker onto the
 * child's `process_registry` row when it exceeds maxRestarts within the restart
 * window — a terminal state where the process will NOT self-recover. We surface
 * it as a critical alert (separate from the heartbeat-staleness warning) so an
 * operator gets a precise, actionable signal instead of only an "is stale" note.
 */
export async function checkCrashLoops(): Promise<readonly CheckResult[]> {
  const processes = await listProcesses();
  const results: CheckResult[] = [];

  for (const rec of processes) {
    const crashLoopAt = rec.metadata[CRASH_LOOP_KEY];
    if (typeof crashLoopAt !== "number") continue;

    const now = Math.floor(Date.now() / 1000);
    const ageSec = Math.max(0, now - crashLoopAt);
    results.push({
      category: "process",
      level: "critical",
      title: `Process ${rec.name} is in crash-loop`,
      detail: `${rec.name} exceeded its restart budget and was halted ${ageSec}s ago; it will not restart until manually intervened.`,
    });
  }

  return results;
}

/**
 * Check error count and rate in recent logs.
 */
export async function checkErrorRate(
  thresholds: MonitorThresholds,
): Promise<readonly CheckResult[]> {
  const db = getDb();
  const since = Math.floor(Date.now() / 1000) - thresholds.errorWindowMinutes * 60;

  const [stats] = await db`
    SELECT
      COUNT(*) FILTER (WHERE level = 'error') AS error_count,
      COUNT(*) AS total_count
    FROM process_logs
    WHERE created_at >= ${since}
  `;

  const errorCount = Number(stats?.error_count ?? 0);
  const totalCount = Number(stats?.total_count ?? 0);
  const errorRate = totalCount > 0 ? (errorCount / totalCount) * 100 : 0;
  const results: CheckResult[] = [];

  if (errorCount >= thresholds.errorCountWindow) {
    results.push({
      category: "error_rate",
      level: errorCount >= thresholds.errorCountWindow * 2 ? "critical" : "warning",
      title: `High error count: ${errorCount} errors in ${thresholds.errorWindowMinutes}m`,
      detail: `${errorCount} errors / ${totalCount} total (${errorRate.toFixed(1)}%)`,
      metric: errorCount,
      threshold: thresholds.errorCountWindow,
    });
  } else if (errorRate >= thresholds.errorRatePercent && totalCount > 10) {
    results.push({
      category: "error_rate",
      level: "warning",
      title: `Elevated error rate: ${errorRate.toFixed(1)}%`,
      detail: `${errorCount} errors / ${totalCount} total in ${thresholds.errorWindowMinutes}m`,
      metric: errorRate,
      threshold: thresholds.errorRatePercent,
    });
  }

  return results;
}

/**
 * Check for cron jobs with consecutive failures.
 */
export async function checkCronFailures(
  thresholds: MonitorThresholds,
): Promise<readonly CheckResult[]> {
  const db = getDb();
  const since = Math.floor(Date.now() / 1000) - 1800;

  const rows = await db`
    SELECT cr.job_id, cr.status, cr.error, cj.name AS job_name
    FROM cron_runs cr
    JOIN cron_jobs cj ON cj.id = cr.job_id
    WHERE cr.started_at >= ${since}
    ORDER BY cr.job_id, cr.started_at DESC
  `;

  const jobRuns = new Map<string, { name: string; runs: Array<{ status: string; error: string | null }> }>();
  for (const row of rows) {
    const jobId = row.job_id as string;
    if (!jobRuns.has(jobId)) {
      jobRuns.set(jobId, { name: row.job_name as string, runs: [] });
    }
    jobRuns.get(jobId)!.runs.push({
      status: row.status as string,
      error: row.error as string | null,
    });
  }

  const results: CheckResult[] = [];
  for (const [, job] of jobRuns) {
    let consecutive = 0;
    for (const run of job.runs) {
      if (run.status === "error" || run.status === "timeout") {
        consecutive++;
      } else {
        break;
      }
    }

    if (consecutive >= thresholds.cronConsecutiveFailures) {
      const lastError = job.runs[0]?.error ?? "unknown";
      results.push({
        category: "cron",
        level: consecutive >= thresholds.cronConsecutiveFailures * 2 ? "critical" : "warning",
        title: `Cron job "${job.name}" failing`,
        detail: `${consecutive} consecutive failures. Last error: ${lastError.slice(0, 200)}`,
        metric: consecutive,
        threshold: thresholds.cronConsecutiveFailures,
      });
    }
  }

  return results;
}

/**
 * Check disk usage on root partition.
 */
export async function checkDiskUsage(
  thresholds: MonitorThresholds,
): Promise<readonly CheckResult[]> {
  // `df -P` is POSIX-portable (GNU/Linux and macOS/BSD), unlike the GNU-only
  // `df --output=pcent` which silently failed on macOS.
  const output = await spawnText(["df", "-P", "/"]);
  if (output === null) {
    warnUnsupportedOnce("disk");
    return [];
  }

  const pct = parseDfCapacityPercent(output);
  if (pct === null) {
    warnUnsupportedOnce("disk");
    return [];
  }

  if (pct >= thresholds.diskUsagePercent) {
    return [{
      category: "disk",
      level: pct >= 95 ? "critical" : "warning",
      title: `Disk usage at ${pct}%`,
      detail: `Root partition is ${pct}% full (threshold: ${thresholds.diskUsagePercent}%)`,
      metric: pct,
      threshold: thresholds.diskUsagePercent,
    }];
  }

  return [];
}

/**
 * Check system memory usage.
 */
interface MemoryStat {
  readonly totalMb: number;
  readonly usedMb: number;
}

/** Linux: parse `free -m`. Uses the "available" column as effectively-free. */
async function readLinuxMemory(): Promise<MemoryStat | null> {
  const output = await spawnText(["free", "-m"]);
  if (output === null) return null;

  const memLine = output.split("\n").find((l) => l.startsWith("Mem:"));
  if (!memLine) return null;

  const parts = memLine.split(/\s+/);
  const total = parseInt(parts[1] ?? "0", 10);
  const available = parseInt(parts[6] ?? "0", 10);
  if (!Number.isFinite(total) || total <= 0) return null;
  return { totalMb: total, usedMb: total - available };
}

/**
 * macOS: total from `sysctl -n hw.memsize` (bytes); free/inactive pages from
 * `vm_stat`. Inactive pages are reclaimable, so they count as effectively free
 * (mirrors the Linux "available" semantics above).
 */
async function readDarwinMemory(): Promise<MemoryStat | null> {
  const sizeOut = await spawnText(["sysctl", "-n", "hw.memsize"]);
  const vmOut = await spawnText(["vm_stat"]);
  if (sizeOut === null || vmOut === null) return null;

  const totalBytes = parseInt(sizeOut.trim(), 10);
  if (!Number.isFinite(totalBytes) || totalBytes <= 0) return null;

  const pageSizeMatch = vmOut.match(/page size of (\d+) bytes/);
  const pageSize = pageSizeMatch ? parseInt(pageSizeMatch[1] ?? "4096", 10) : 4096;

  const readPages = (label: string): number => {
    const m = vmOut.match(new RegExp(`${label}:\\s+(\\d+)`));
    return m ? parseInt(m[1] ?? "0", 10) : 0;
  };

  const freePages = readPages("Pages free") + readPages("Pages inactive");
  const freeBytes = freePages * pageSize;
  const totalMb = Math.round(totalBytes / (1024 * 1024));
  const usedMb = Math.round((totalBytes - freeBytes) / (1024 * 1024));
  return { totalMb, usedMb };
}

export async function checkMemoryUsage(
  thresholds: MonitorThresholds,
): Promise<readonly CheckResult[]> {
  // `free` is Linux-only; macOS needs vm_stat/sysctl. Branch on platform so the
  // probe produces real results instead of silently no-op'ing on Darwin.
  const stat =
    process.platform === "darwin"
      ? await readDarwinMemory()
      : await readLinuxMemory();

  if (stat === null) {
    warnUnsupportedOnce("memory");
    return [];
  }

  const { totalMb, usedMb } = stat;
  const pct = totalMb > 0 ? Math.round((usedMb / totalMb) * 100) : 0;

  if (pct >= thresholds.memoryUsagePercent) {
    return [{
      category: "memory",
      level: pct >= 95 ? "critical" : "warning",
      title: `Memory usage at ${pct}%`,
      detail: `${usedMb}MB / ${totalMb}MB used (threshold: ${thresholds.memoryUsagePercent}%)`,
      metric: pct,
      threshold: thresholds.memoryUsagePercent,
    }];
  }

  return [];
}

/**
 * Run all checks in parallel and collect results.
 * Individual check failures don't prevent other checks from running.
 */
export async function runAllChecks(
  thresholds: MonitorThresholds,
): Promise<readonly CheckResult[]> {
  const settled = await Promise.allSettled([
    checkProcessHealth(thresholds),
    checkCrashLoops(),
    checkErrorRate(thresholds),
    checkCronFailures(thresholds),
    checkDiskUsage(thresholds),
    checkMemoryUsage(thresholds),
  ]);

  const results: CheckResult[] = [];
  for (const result of settled) {
    if (result.status === "fulfilled") {
      results.push(...result.value);
    }
  }

  return results;
}
