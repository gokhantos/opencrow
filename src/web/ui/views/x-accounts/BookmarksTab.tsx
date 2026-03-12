import { useState, useEffect, useCallback } from "react";
import { apiFetch } from "../../api";
import { useJobPoller, useAutoRefresh } from "./hooks/useJobPoller";
import { useJobActions } from "./hooks/useJobActions";
import { JobStatusHero } from "./JobStatusHero";
import { JobControls } from "./JobControls";
import { SharedVideoRow } from "./SharedVideoRow";

interface BookmarkJob {
  readonly id: string;
  readonly account_id: string;
  readonly interval_minutes: number;
  readonly status: "running" | "stopped";
  readonly next_run_at: number | null;
  readonly total_shared: number;
  readonly total_errors: number;
  readonly last_run_at: number | null;
  readonly last_error: string | null;
  readonly created_at: number;
  readonly updated_at: number;
}

interface SharedVideo {
  readonly id: string;
  readonly source_tweet_id: string;
  readonly source_author: string;
  readonly source_url: string;
  readonly shared_at: number;
}

const INTERVAL_PRESETS = [
  { label: "5m", value: 5 },
  { label: "10m", value: 10 },
  { label: "15m", value: 15 },
  { label: "30m", value: 30 },
  { label: "1h", value: 60 },
] as const;

interface BookmarksTabProps {
  readonly accountId: string;
}

export function BookmarksTab({ accountId }: BookmarksTabProps) {
  const [job, setJob] = useState<BookmarkJob | null>(null);
  const [sharedVideos, setSharedVideos] = useState<SharedVideo[]>([]);
  const [intervalMinutes, setIntervalMinutes] = useState(15);
  const [loading, setLoading] = useState(true);

  const isRunning = job?.status === "running";

  const loadData = useCallback(async () => {
    try {
      const [statusRes, historyRes] = await Promise.all([
        apiFetch<{ success: boolean; data: BookmarkJob | null }>(
          `/api/x/bookmarks/status?account_id=${accountId}`,
        ),
        apiFetch<{ success: boolean; data: SharedVideo[] }>(
          `/api/x/bookmarks/history?account_id=${accountId}`,
        ),
      ]);
      if (statusRes.success && statusRes.data) {
        setJob(statusRes.data);
        setIntervalMinutes(statusRes.data.interval_minutes);
      }
      if (historyRes.success) {
        setSharedVideos(historyRes.data);
      }
    } finally {
      setLoading(false);
    }
  }, [accountId]);

  useEffect(() => {
    setLoading(true);
    loadData();
  }, [loadData]);

  const { countdown } = useJobPoller(job);
  useAutoRefresh(isRunning, loadData);

  const { handleStart, handleStop, handleRunNow, actionLoading, error, clearError } =
    useJobActions({
      startUrl: "/api/x/bookmarks/start",
      stopUrl: "/api/x/bookmarks/stop",
      runNowUrl: "/api/x/bookmarks/share-now",
      accountId,
      startBody: { interval_minutes: intervalMinutes },
      onSuccess: loadData,
    });

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <span className="w-5 h-5 border-2 border-border-2 border-t-accent rounded-full animate-spin inline-block" />
      </div>
    );
  }

  const displayError = error ?? job?.last_error ?? null;

  return (
    <div className="flex flex-col gap-0">
      <JobStatusHero
        isRunning={isRunning}
        countdown={countdown}
        intervalMinutes={job?.interval_minutes ?? intervalMinutes}
        lastRunAt={job?.last_run_at ?? null}
        lastError={displayError}
        stats={[
          {
            label: "shared",
            value: job?.total_shared ?? 0,
            color: "text-accent",
          },
          {
            label: "errors",
            value: job?.total_errors ?? 0,
            color: "text-faint",
          },
        ]}
      />

      <JobControls
        isRunning={isRunning}
        onStart={() => {
          clearError();
          handleStart({ interval_minutes: intervalMinutes });
        }}
        onStop={() => {
          clearError();
          handleStop();
        }}
        onRunNow={() => {
          clearError();
          handleRunNow();
        }}
        actionLoading={actionLoading}
        intervalMinutes={intervalMinutes}
        onIntervalChange={setIntervalMinutes}
        intervalPresets={INTERVAL_PRESETS}
        startLabel="Start Sharing"
        runNowLabel="Share Now"
      />

      {/* Shared History */}
      <div className="border-t border-border pt-5">
        <div className="font-sans text-xs font-semibold uppercase tracking-widest text-faint mb-3 flex items-center gap-2.5">
          Shared History
          {sharedVideos.length > 0 && (
            <span className="inline-flex items-center justify-center px-2 py-0.5 rounded-full bg-accent-subtle font-mono text-xs font-semibold text-accent">
              {sharedVideos.length}
            </span>
          )}
        </div>
        {sharedVideos.length === 0 ? (
          <div className="text-center text-faint py-8 text-sm font-sans">
            No videos shared yet
          </div>
        ) : (
          <div className="flex flex-col gap-0.5">
            {sharedVideos.map((v) => (
              <SharedVideoRow
                key={v.id}
                id={v.id}
                sourceTweetId={v.source_tweet_id}
                sourceAuthor={v.source_author}
                sourceUrl={v.source_url}
                sharedAt={v.shared_at}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
