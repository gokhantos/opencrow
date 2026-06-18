import { useState, useEffect } from "react";
import { apiFetch } from "../api";
import {
  PageHeader,
  LoadingState,
  EmptyState,
  FeedRow,
  Button,
  IntervalConfigPanel,
} from "../components";
import type { IntervalConfigField } from "../components";
import { MessageSquare } from "lucide-react";

interface HNStory {
  id: string;
  rank: number;
  title: string;
  url: string;
  site_label: string;
  points: number;
  author: string;
  age: string;
  comment_count: number;
  hn_url: string;
  feed_type: string;
  first_seen_at: number;
  updated_at: number;
  description: string;
  top_comments_json: string;
}

function parseComments(json: string): readonly string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

interface StatsData {
  total_stories: number;
  last_updated_at: number | null;
  feed_types: number;
}

const HN_CONFIG_FIELDS: readonly IntervalConfigField[] = [
  {
    key: "intervalMinutes",
    label: "Scrape interval (min)",
    desc: "How often to scrape",
    min: 1,
    max: 1440,
    defaultValue: 10,
  },
  {
    key: "maxStories",
    label: "Max stories",
    desc: "Number of top stories to fetch",
    min: 10,
    max: 200,
    defaultValue: 60,
  },
  {
    key: "commentLimit",
    label: "Comments per story",
    desc: "Top comments to fetch per story",
    min: 0,
    max: 10,
    defaultValue: 3,
  },
];

export default function HackerNews() {
  const [stories, setStories] = useState<HNStory[]>([]);
  const [stats, setStats] = useState<StatsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [scraping, setScraping] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [backfilling, setBackfilling] = useState(false);
  const [backfillResult, setBackfillResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void fetchAll();
    const interval = setInterval(() => void fetchAll(), 30_000);
    return () => clearInterval(interval);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function fetchAll() {
    try {
      const [storiesRes, statsRes] = await Promise.all([
        apiFetch<{ success: boolean; data: HNStory[] }>(
          "/api/hn/stories?limit=100",
        ),
        apiFetch<{ success: boolean; data: StatsData }>("/api/hn/stats"),
      ]);
      if (storiesRes.success) setStories(storiesRes.data);
      if (statsRes.success) setStats(statsRes.data);
      setError(null);
    } catch {
      setError("Failed to load data — the API may be unreachable.");
    } finally {
      setLoading(false);
    }
  }

  async function handleScrapeNow() {
    setScraping(true);
    try {
      await apiFetch("/api/hn/scrape-now", { method: "POST" });
      await fetchAll();
    } catch {
      // ignore scrape trigger errors — data will poll in
    } finally {
      setScraping(false);
    }
  }

  async function handleBackfillRag() {
    setBackfilling(true);
    setBackfillResult(null);
    try {
      const res = await apiFetch<{ success: boolean; data: { indexed: number } }>(
        "/api/hn/backfill-rag",
        { method: "POST" },
      );
      if (res.success) {
        setBackfillResult(`Indexed ${res.data.indexed} stories`);
      }
    } catch (err) {
      let message = "Unknown error";
      if (err && typeof err === "object" && "message" in err) {
        const raw = String((err as { message: string }).message);
        try {
          const parsed = JSON.parse(raw) as { error?: string };
          message = parsed.error ?? raw;
        } catch {
          message = raw;
        }
      }
      setBackfillResult(`Backfill failed: ${message}`);
    } finally {
      setBackfilling(false);
    }
  }

  function formatTime(epoch: number | null): string {
    if (!epoch) return "Never";
    return new Date(epoch * 1000).toLocaleString();
  }

  if (loading) {
    return <LoadingState message="Loading..." />;
  }

  return (
    <div>
      <PageHeader
        title="Hacker News"
        subtitle={
          stats &&
          `${stats.total_stories} stories | Last updated: ${formatTime(stats.last_updated_at)}`
        }
        actions={
          <div className="flex items-center gap-2">
            {backfillResult && (
              <span className="text-xs text-muted">{backfillResult}</span>
            )}
            <Button
              size="sm"
              variant="secondary"
              onClick={handleBackfillRag}
              loading={backfilling}
            >
              Backfill RAG
            </Button>
            <Button
              size="sm"
              onClick={handleScrapeNow}
              loading={scraping}
            >
              Scrape Now
            </Button>
          </div>
        }
      />

      <IntervalConfigPanel scraperId="hackernews" fields={HN_CONFIG_FIELDS} />

      {error && stories.length === 0 ? (
        <EmptyState
          title="Failed to load stories"
          description={error}
        />
      ) : stories.length === 0 ? (
        <EmptyState description='No stories yet. Click "Scrape Now" to fetch.' />
      ) : (
        <div className="flex flex-col gap-0.5">
          {stories.map((story) => {
            const comments = parseComments(story.top_comments_json);
            const isExpanded = expandedId === story.id;
            return (
              <div key={story.id} className="rounded-lg hover:bg-bg-1 transition-colors">
                <FeedRow
                  rank={story.rank}
                  title={story.title}
                  url={story.url || story.hn_url}
                  domain={story.site_label || undefined}
                  description={story.description || undefined}
                  meta={
                    <>
                      {story.author && <span>by {story.author}</span>}
                      {story.age && <span> | {story.age}</span>}
                      {story.hn_url && (
                        <>
                          {" | "}
                          <a
                            href={story.hn_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-faint no-underline hover:underline"
                          >
                            {story.comment_count} comments
                          </a>
                        </>
                      )}
                      {comments.length > 0 && (
                        <>
                          {" | "}
                          <button
                            type="button"
                            onClick={() => setExpandedId(isExpanded ? null : story.id)}
                            className={`inline-flex items-center gap-1 bg-transparent border-none cursor-pointer p-0 text-sm transition-colors ${
                              isExpanded ? "text-accent" : "text-muted hover:text-foreground"
                            }`}
                          >
                            <MessageSquare className="w-3 h-3" />
                            {comments.length} scraped
                          </button>
                        </>
                      )}
                    </>
                  }
                  stats={
                    <>
                      <span className="text-accent font-semibold font-mono">
                        {story.points}
                      </span>
                      <span className="text-faint">pts</span>
                    </>
                  }
                />
                {isExpanded && comments.length > 0 && (
                  <div className="ml-16 mr-4 mb-3 flex flex-col gap-2">
                    {comments.map((comment, ci) => (
                      <div
                        key={ci}
                        className="text-sm text-muted leading-relaxed bg-bg-2 rounded-md px-3 py-2 border-l-2 border-accent/30"
                      >
                        {comment.length > 500 ? `${comment.slice(0, 500)}...` : comment}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
