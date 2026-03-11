import React, { useState, useEffect, useCallback } from "react";
import { apiFetch } from "../../api";
import { cn } from "../../lib/cn";
import { useJobPoller, useAutoRefresh } from "./hooks/useJobPoller";
import { useJobActions } from "./hooks/useJobActions";
import { JobStatusHero } from "./JobStatusHero";
import { JobControls } from "./JobControls";
import { TweetRow } from "./TweetRow";

interface TimelineJob {
  readonly id: string;
  readonly account_id: string;
  readonly interval_minutes: number;
  readonly status: "running" | "stopped";
  readonly next_run_at: number | null;
  readonly total_scraped: number;
  readonly total_errors: number;
  readonly last_run_at: number | null;
  readonly last_error: string | null;
  readonly sources: string;
  readonly languages: string | null;
  readonly created_at: number;
  readonly updated_at: number;
}

interface TimelineTweet {
  readonly id: string;
  readonly tweet_id: string;
  readonly author_username: string;
  readonly author_display_name: string;
  readonly author_verified: boolean;
  readonly author_followers: number;
  readonly text: string;
  readonly likes: number;
  readonly retweets: number;
  readonly replies: number;
  readonly views: number;
  readonly has_media: boolean;
  readonly scraped_at: number;
  readonly source: string;
}

const INTERVAL_PRESETS = [
  { label: "10m", value: 10 },
  { label: "15m", value: 15 },
  { label: "30m", value: 30 },
  { label: "1h", value: 60 },
] as const;

type SourceFilter = "all" | "home" | "top_posts";

const PILL_BASE =
  "py-2 px-5 rounded-full border font-mono text-sm font-medium cursor-pointer transition-colors";
const PILL_ACTIVE = "bg-accent-subtle border-accent text-accent font-semibold";
const PILL_INACTIVE =
  "bg-bg-2 border-border text-muted hover:bg-accent-subtle hover:border-accent hover:text-accent";
const PILL_DISABLED = "opacity-40 cursor-not-allowed pointer-events-none";

interface TimelineTabProps {
  readonly accountId: string;
}

export function TimelineTab({ accountId }: TimelineTabProps) {
  const [job, setJob] = useState<TimelineJob | null>(null);
  const [tweets, setTweets] = useState<TimelineTweet[]>([]);
  const [intervalMinutes, setIntervalMinutes] = useState(10);
  const [homeEnabled, setHomeEnabled] = useState(true);
  const [topEnabled, setTopEnabled] = useState(true);
  const [languages, setLanguages] = useState("en");
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
  const [loading, setLoading] = useState(true);

  const isRunning = job?.status === "running";

  const loadData = useCallback(async () => {
    try {
      const [statusRes, tweetsRes] = await Promise.all([
        apiFetch<{ success: boolean; data: TimelineJob | null }>(
          `/api/x/timeline/status?account_id=${accountId}`,
        ),
        apiFetch<{ success: boolean; data: TimelineTweet[] }>(
          `/api/x/timeline/tweets?account_id=${accountId}&limit=200`,
        ),
      ]);
      if (statusRes.success && statusRes.data) {
        const j = statusRes.data;
        setJob(j);
        setIntervalMinutes(j.interval_minutes);
        const srcs = j.sources.split(",");
        setHomeEnabled(srcs.includes("home"));
        setTopEnabled(srcs.includes("top_posts"));
        setLanguages(j.languages ?? "en");
      }
      if (tweetsRes.success) {
        setTweets(tweetsRes.data);
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

  function buildSources(): Record<string, unknown> {
    const srcs = [
      ...(homeEnabled ? ["home"] : []),
      ...(topEnabled ? ["top_posts"] : []),
    ].join(",");
    return {
      sources: srcs || "home",
      languages: languages.trim() || null,
    };
  }

  const { handleStart, handleStop, handleRunNow, actionLoading, error, clearError } =
    useJobActions({
      startUrl: "/api/x/timeline/start",
      stopUrl: "/api/x/timeline/stop",
      runNowUrl: "/api/x/timeline/run-now",
      accountId,
      startBody: { interval_minutes: intervalMinutes, ...buildSources() },
      onSuccess: loadData,
    });

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <span className="w-5 h-5 border-2 border-border-2 border-t-accent rounded-full animate-spin inline-block" />
      </div>
    );
  }

  const homeTweets = tweets.filter((t) => t.source === "home");
  const topTweets = tweets.filter((t) => t.source === "top_posts");

  const visibleTweets =
    sourceFilter === "all"
      ? tweets
      : sourceFilter === "home"
        ? homeTweets
        : topTweets;

  const displayError = error ?? job?.last_error ?? null;

  const onlyOneSrcActive = homeEnabled !== topEnabled;

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
            label: "total",
            value: tweets.length,
            color: "text-accent",
          },
          {
            label: "home",
            value: homeTweets.length,
            color: "text-foreground",
          },
          {
            label: "top",
            value: topTweets.length,
            color: "text-foreground",
          },
        ]}
      />

      <JobControls
        isRunning={isRunning}
        onStart={() => {
          clearError();
          handleStart({ interval_minutes: intervalMinutes, ...buildSources() });
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
        startLabel="Start Scraping"
        runNowLabel="Scrape Now"
      />

      {/* Source toggles */}
      <div className="mb-5">
        <div className="font-sans text-xs font-semibold uppercase tracking-widest text-faint mb-3">
          Sources
        </div>
        <div className="flex gap-2 flex-wrap">
          <button
            type="button"
            className={cn(
              PILL_BASE,
              homeEnabled ? PILL_ACTIVE : PILL_INACTIVE,
              (isRunning || (onlyOneSrcActive && homeEnabled)) && PILL_DISABLED,
            )}
            onClick={() => setHomeEnabled((v) => !v)}
            disabled={isRunning || (onlyOneSrcActive && homeEnabled)}
          >
            Home Timeline
          </button>
          <button
            type="button"
            className={cn(
              PILL_BASE,
              topEnabled ? PILL_ACTIVE : PILL_INACTIVE,
              (isRunning || (onlyOneSrcActive && topEnabled)) && PILL_DISABLED,
            )}
            onClick={() => setTopEnabled((v) => !v)}
            disabled={isRunning || (onlyOneSrcActive && topEnabled)}
          >
            Top Posts
          </button>
        </div>
      </div>

      {/* Language filter */}
      <div className="mb-5">
        <div className="font-sans text-xs font-semibold uppercase tracking-widest text-faint mb-3">
          Languages
        </div>
        <input
          type="text"
          value={languages}
          onChange={(e) => setLanguages(e.target.value)}
          disabled={isRunning}
          placeholder="en,es,fr"
          className={cn(
            "w-48 px-4 py-2 rounded-lg border bg-bg-2 border-border font-mono text-sm text-foreground placeholder:text-faint focus:outline-none focus:border-accent transition-colors",
            isRunning && "opacity-40 cursor-not-allowed",
          )}
        />
        <p className="text-faint text-xs mt-1 font-sans">
          Comma-separated language codes. Leave empty to fetch all.
        </p>
      </div>

      {/* Source filter tabs */}
      <div className="flex gap-0 border-b border-border mb-4">
        {(
          [
            { id: "all" as const, label: "All", count: tweets.length },
            { id: "home" as const, label: "Home", count: homeTweets.length },
            {
              id: "top_posts" as const,
              label: "Top Posts",
              count: topTweets.length,
            },
          ] as const
        ).map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={cn(
              "px-5 py-3 bg-transparent border-b-2 text-faint font-sans text-xs font-semibold uppercase tracking-wide cursor-pointer transition-colors flex items-center gap-2",
              "hover:text-muted",
              sourceFilter === tab.id
                ? "border-accent text-accent"
                : "border-transparent",
            )}
            onClick={() => setSourceFilter(tab.id)}
          >
            {tab.label}
            {tab.count > 0 && (
              <span className="inline-flex items-center justify-center px-2 py-0.5 rounded-full bg-accent-subtle font-mono text-xs font-semibold text-accent">
                {tab.count}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Tweet list — full height, no max-height */}
      <div className="flex flex-col gap-1">
        {visibleTweets.length === 0 ? (
          <div className="text-center text-faint py-8 text-sm font-sans">
            No tweets scraped yet
          </div>
        ) : (
          visibleTweets.map((t) => (
            <TweetRow
              key={t.id}
              tweetId={t.tweet_id}
              authorUsername={t.author_username}
              authorVerified={t.author_verified}
              authorFollowers={t.author_followers}
              text={t.text}
              likes={t.likes}
              retweets={t.retweets}
              replies={t.replies}
              views={t.views}
              hasMedia={t.has_media}
              scrapedAt={t.scraped_at}
              source={t.source}
            />
          ))
        )}
      </div>
    </div>
  );
}
