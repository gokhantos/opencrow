import { useState, useEffect, useCallback } from "react";
import { apiFetch } from "../../api";
import { cn } from "../../lib/cn";
import { JobStatusHero } from "./JobStatusHero";
import { JobControls } from "./JobControls";
import { TweetRow } from "./TweetRow";
import { useJobPoller, useAutoRefresh } from "./hooks/useJobPoller";
import { useJobActions } from "./hooks/useJobActions";

// ─── Data shapes ────────────────────────────────────────────────────────────

interface AutolikeJob {
  readonly id: string;
  readonly account_id: string;
  readonly interval_minutes: number;
  readonly max_likes_per_run: number;
  readonly languages: string | null;
  readonly status: "running" | "stopped";
  readonly next_run_at: number | null;
  readonly total_scraped: number;
  readonly total_liked: number;
  readonly total_errors: number;
  readonly last_run_at: number | null;
  readonly last_error: string | null;
  readonly created_at: number;
  readonly updated_at: number;
}

interface ScrapedTweet {
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
}

interface LikedTweet {
  readonly id: string;
  readonly tweet_id: string;
  readonly author_username: string;
  readonly text: string;
  readonly likes: number;
  readonly retweets: number;
  readonly views: number;
  readonly liked_at: number;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const INTERVAL_PRESETS = [
  { label: "5m", value: 5 },
  { label: "10m", value: 10 },
  { label: "15m", value: 15 },
  { label: "30m", value: 30 },
  { label: "1h", value: 60 },
] as const;

const MAX_LIKES_PRESETS = [
  { label: "3", value: 3 },
  { label: "5", value: 5 },
  { label: "10", value: 10 },
  { label: "15", value: 15 },
] as const;

const SUPPORTED_LANGUAGES = [
  { label: "TR", code: "tr" },
  { label: "EN", code: "en" },
  { label: "DE", code: "de" },
  { label: "FR", code: "fr" },
  { label: "ES", code: "es" },
  { label: "PT", code: "pt" },
  { label: "IT", code: "it" },
  { label: "NL", code: "nl" },
  { label: "RU", code: "ru" },
  { label: "AR", code: "ar" },
  { label: "JA", code: "ja" },
  { label: "KO", code: "ko" },
  { label: "ZH", code: "zh" },
] as const;

type SubTab = "scraped" | "liked";

// ─── Component ───────────────────────────────────────────────────────────────

interface AutoLikesTabProps {
  readonly accountId: string;
}

/**
 * Full auto-likes feature view. Fetches job status and tweet lists,
 * and wires up shared hooks for polling, auto-refresh, and job actions.
 */
export function AutoLikesTab({ accountId }: AutoLikesTabProps) {
  const [job, setJob] = useState<AutolikeJob | null>(null);
  const [scraped, setScraped] = useState<ScrapedTweet[]>([]);
  const [liked, setLiked] = useState<LikedTweet[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeSubTab, setActiveSubTab] = useState<SubTab>("scraped");
  const [intervalMinutes, setIntervalMinutes] = useState(15);
  const [maxLikesPerRun, setMaxLikesPerRun] = useState(5);
  const [languages, setLanguages] = useState<string[]>([]);

  // ─── Data fetching ───────────────────────────────────────────────────────

  const loadStatus = useCallback(async () => {
    try {
      const [statusRes, scrapedRes, likedRes] = await Promise.all([
        apiFetch<{ success: boolean; data: AutolikeJob | null }>(
          `/api/x/interactions/status?account_id=${accountId}`,
        ),
        apiFetch<{ success: boolean; data: ScrapedTweet[] }>(
          `/api/x/interactions/scraped?account_id=${accountId}&limit=100`,
        ),
        apiFetch<{ success: boolean; data: LikedTweet[] }>(
          `/api/x/interactions/liked?account_id=${accountId}&limit=100`,
        ),
      ]);

      if (statusRes.success && statusRes.data) {
        const j = statusRes.data;
        setJob(j);
        setIntervalMinutes(j.interval_minutes);
        setMaxLikesPerRun(j.max_likes_per_run);
        setLanguages(j.languages ? j.languages.split(",") : []);
      }
      if (scrapedRes.success) setScraped(scrapedRes.data);
      if (likedRes.success) setLiked(likedRes.data);
    } finally {
      setLoading(false);
    }
  }, [accountId]);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  // ─── Hooks ───────────────────────────────────────────────────────────────

  const isRunning = job !== null && job.status === "running";
  const { countdown } = useJobPoller(job);
  useAutoRefresh(isRunning, loadStatus, 30_000);

  const { handleStart, handleStop, handleRunNow, actionLoading, error, clearError } =
    useJobActions({
      startUrl: "/api/x/interactions/start",
      stopUrl: "/api/x/interactions/stop",
      runNowUrl: "/api/x/interactions/run-now",
      accountId,
      onSuccess: loadStatus,
    });

  // ─── Start with runtime config ────────────────────────────────────────────

  function onStart() {
    clearError();
    handleStart({
      interval_minutes: intervalMinutes,
      max_likes_per_run: maxLikesPerRun,
      languages: languages.length > 0 ? languages : null,
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
          { label: "scraped", value: job?.total_scraped ?? 0 },
          { label: "liked", value: job?.total_liked ?? 0, color: "text-danger" },
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
        maxPerRun={maxLikesPerRun}
        onMaxPerRunChange={setMaxLikesPerRun}
        maxPerRunPresets={MAX_LIKES_PRESETS.map((p) => ({ label: p.label, value: p.value }))}
        maxPerRunLabel="Likes per run"
        languages={languages}
        onLanguagesChange={setLanguages}
        availableLanguages={SUPPORTED_LANGUAGES}
      />

      {/* Sub-tab bar */}
      <div className="flex gap-1 border-b border-border mb-5">
        {(["scraped", "liked"] as const).map((tab) => {
          const count = tab === "scraped" ? scraped.length : liked.length;
          const label = tab === "scraped" ? "Scraped" : "Liked";
          return (
            <button
              key={tab}
              type="button"
              className={cn(
                "px-5 py-3 bg-transparent border-none border-b-2 border-b-transparent text-faint font-sans text-xs font-semibold uppercase tracking-wide cursor-pointer transition-colors flex items-center gap-2.5",
                "hover:text-muted",
                activeSubTab === tab && "text-accent border-b-accent",
              )}
              onClick={() => setActiveSubTab(tab)}
            >
              {label}
              {count > 0 && (
                <span className="inline-flex items-center justify-center px-2 py-0.5 rounded-full bg-accent-subtle font-mono text-xs font-semibold text-accent">
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Tweet list */}
      {activeSubTab === "scraped" && (
        <div className="flex flex-col gap-1">
          {scraped.length === 0 ? (
            <div className="text-center text-faint py-8 text-sm font-sans">
              No tweets scraped yet
            </div>
          ) : (
            scraped.map((t) => (
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
                variant="default"
              />
            ))
          )}
        </div>
      )}

      {activeSubTab === "liked" && (
        <div className="flex flex-col gap-1">
          {liked.length === 0 ? (
            <div className="text-center text-faint py-8 text-sm font-sans">
              No tweets liked yet
            </div>
          ) : (
            liked.map((t) => (
              <TweetRow
                key={t.id}
                tweetId={t.tweet_id}
                authorUsername={t.author_username}
                text={t.text}
                likes={t.likes}
                retweets={t.retweets}
                views={t.views}
                scrapedAt={t.liked_at}
                variant="liked"
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}
