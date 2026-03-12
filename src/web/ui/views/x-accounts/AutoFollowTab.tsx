import { useState, useEffect, useCallback } from "react";
import { apiFetch } from "../../api";
import { JobStatusHero } from "./JobStatusHero";
import { JobControls } from "./JobControls";
import { FollowedUserRow } from "./FollowedUserRow";
import { useJobPoller, useAutoRefresh } from "./hooks/useJobPoller";
import { useJobActions } from "./hooks/useJobActions";

// ─── Data shapes ─────────────────────────────────────────────────────────────

interface AutofollowJob {
  readonly id: string;
  readonly account_id: string;
  readonly max_follows_per_run: number;
  readonly interval_minutes: number;
  readonly languages: string | null;
  readonly status: "running" | "stopped";
  readonly next_run_at: number | null;
  readonly total_followed: number;
  readonly total_errors: number;
  readonly last_run_at: number | null;
  readonly last_error: string | null;
  readonly created_at: number;
  readonly updated_at: number;
}

interface FollowedUser {
  readonly id: string;
  readonly username: string;
  readonly display_name: string;
  readonly followers_count: number;
  readonly following_count: number;
  readonly verified: boolean;
  readonly followed_at: number;
  readonly follow_back: boolean;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const INTERVAL_PRESETS = [
  { label: "5m", value: 5 },
  { label: "10m", value: 10 },
  { label: "15m", value: 15 },
  { label: "30m", value: 30 },
  { label: "1h", value: 60 },
] as const;

const MAX_FOLLOWS_PRESETS = [
  { label: "1", value: 1 },
  { label: "3", value: 3 },
  { label: "5", value: 5 },
  { label: "10", value: 10 },
] as const;

// ─── Component ───────────────────────────────────────────────────────────────

interface AutoFollowTabProps {
  readonly accountId: string;
}

/**
 * Full auto-follow feature view. Fetches job status and follow history,
 * and wires up shared hooks for polling, auto-refresh, and job actions.
 */
export function AutoFollowTab({ accountId }: AutoFollowTabProps) {
  const [job, setJob] = useState<AutofollowJob | null>(null);
  const [history, setHistory] = useState<FollowedUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [intervalMinutes, setIntervalMinutes] = useState(60);
  const [maxFollows, setMaxFollows] = useState(3);

  // ─── Data fetching ────────────────────────────────────────────────────────

  const loadStatus = useCallback(async () => {
    try {
      const [statusRes, historyRes] = await Promise.all([
        apiFetch<{ success: boolean; data: AutofollowJob | null }>(
          `/api/x/follow/status?account_id=${accountId}`,
        ),
        apiFetch<{ success: boolean; data: FollowedUser[] }>(
          `/api/x/follow/history?account_id=${accountId}&limit=100`,
        ),
      ]);

      if (statusRes.success && statusRes.data) {
        const j = statusRes.data;
        setJob(j);
        setIntervalMinutes(j.interval_minutes);
        setMaxFollows(j.max_follows_per_run);
      }
      if (historyRes.success) setHistory(historyRes.data);
    } finally {
      setLoading(false);
    }
  }, [accountId]);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  // ─── Hooks ────────────────────────────────────────────────────────────────

  const isRunning = job !== null && job.status === "running";
  const { countdown } = useJobPoller(job);
  useAutoRefresh(isRunning, loadStatus, 30_000);

  const { handleStart, handleStop, handleRunNow, actionLoading, error, clearError } =
    useJobActions({
      startUrl: "/api/x/follow/start",
      stopUrl: "/api/x/follow/stop",
      runNowUrl: "/api/x/follow/run-now",
      accountId,
      onSuccess: loadStatus,
    });

  // ─── Start with runtime config ────────────────────────────────────────────

  function onStart() {
    clearError();
    handleStart({
      interval_minutes: intervalMinutes,
      max_follows_per_run: maxFollows,
    });
  }

  // ─── Render ───────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <span className="w-4 h-4 border-2 border-border-2 border-t-accent rounded-full animate-spin inline-block" />
      </div>
    );
  }

  return (
    <div>
      {/* Error banner from actions */}
      {error && (
        <div className="text-danger text-sm font-mono px-4 py-3 bg-danger-subtle border border-border rounded-md mb-4 break-words leading-relaxed">
          {error}
        </div>
      )}

      {/* Status hero */}
      <JobStatusHero
        isRunning={isRunning}
        countdown={countdown}
        intervalMinutes={job?.interval_minutes ?? intervalMinutes}
        lastRunAt={job?.last_run_at ?? null}
        lastError={!error ? (job?.last_error ?? null) : null}
        stats={[
          { label: "followed", value: job?.total_followed ?? 0, color: "text-accent" },
          { label: "errors", value: job?.total_errors ?? 0, color: "text-faint" },
        ]}
      />

      {/* Controls */}
      <JobControls
        isRunning={isRunning}
        onStart={onStart}
        onStop={handleStop}
        onRunNow={handleRunNow}
        actionLoading={actionLoading}
        intervalMinutes={intervalMinutes}
        onIntervalChange={setIntervalMinutes}
        intervalPresets={INTERVAL_PRESETS.map((p) => ({ label: p.label, value: p.value }))}
        maxPerRun={maxFollows}
        onMaxPerRunChange={setMaxFollows}
        maxPerRunPresets={MAX_FOLLOWS_PRESETS.map((p) => ({ label: p.label, value: p.value }))}
        maxPerRunLabel="Follows per run"
      />

      {/* History header */}
      <div className="flex items-center gap-2.5 mb-4 pb-2.5 border-b border-border">
        <span className="font-sans text-xs font-semibold uppercase tracking-wide text-muted">
          Followed Users
        </span>
        {history.length > 0 && (
          <span className="inline-flex items-center justify-center px-2 py-0.5 rounded-full bg-accent-subtle font-mono text-xs font-semibold text-accent">
            {history.length}
          </span>
        )}
      </div>

      {/* History list */}
      <div className="flex flex-col gap-1">
        {history.length === 0 ? (
          <div className="text-center text-faint py-8 text-sm font-sans">
            No users followed yet
          </div>
        ) : (
          history.map((u) => (
            <FollowedUserRow
              key={u.id}
              id={u.id}
              username={u.username}
              displayName={u.display_name}
              followersCount={u.followers_count}
              followingCount={u.following_count}
              verified={u.verified}
              followedAt={u.followed_at}
              followBack={u.follow_back}
            />
          ))
        )}
      </div>
    </div>
  );
}
