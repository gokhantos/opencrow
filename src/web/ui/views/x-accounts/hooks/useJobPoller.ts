import { useState, useEffect, useRef } from "react";
import { formatCountdown } from "../../../lib/format";

interface JobLike {
  readonly status: "running" | "stopped";
  readonly next_run_at: number | null;
}

/**
 * Tracks a countdown to the next job run, ticking every second.
 * Returns an empty string when the job is not running or has no scheduled run.
 */
export function useJobPoller(job: JobLike | null): { readonly countdown: string } {
  const [countdown, setCountdown] = useState("");
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (tickRef.current) clearInterval(tickRef.current);

    if (job?.status === "running" && job.next_run_at) {
      const next = job.next_run_at;
      const update = () => setCountdown(formatCountdown(next));
      update();
      tickRef.current = setInterval(update, 1000);
    } else {
      setCountdown("");
    }

    return () => {
      if (tickRef.current) clearInterval(tickRef.current);
    };
  }, [job?.status, job?.next_run_at]);

  return { countdown };
}

/**
 * Calls loadFn on a fixed interval while isRunning is true.
 * Creates a fresh AbortController for each poll tick so that in-flight requests
 * are cancelled when the interval is torn down (isRunning toggles or unmount).
 * loadFn must accept and respect the passed AbortSignal to avoid stale setState.
 */
export function useAutoRefresh(
  isRunning: boolean,
  loadFn: (signal: AbortSignal) => void,
  intervalMs = 30_000,
): void {
  useEffect(() => {
    if (!isRunning) return;
    const controller = new AbortController();
    const timer = setInterval(() => loadFn(controller.signal), intervalMs);
    return () => {
      clearInterval(timer);
      controller.abort();
    };
  }, [isRunning, loadFn, intervalMs]);
}
