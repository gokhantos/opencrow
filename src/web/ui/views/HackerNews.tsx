import React, { useState, useEffect } from "react";
import { apiFetch } from "../api";
import { PageHeader, LoadingState, EmptyState, FeedRow, Button } from "../components";

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
}

interface StatsData {
  total_stories: number;
  last_updated_at: number | null;
  feed_types: number;
}

export default function HackerNews() {
  const [stories, setStories] = useState<HNStory[]>([]);
  const [stats, setStats] = useState<StatsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [scraping, setScraping] = useState(false);
  const [backfilling, setBackfilling] = useState(false);
  const [backfillResult, setBackfillResult] = useState<string | null>(null);

  useEffect(() => {
    fetchAll();
    const interval = setInterval(fetchAll, 30_000);
    return () => clearInterval(interval);
  }, []);

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
    } catch {
      // ignore
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
      // ignore
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
    } catch {
      setBackfillResult("Backfill failed");
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

      {stories.length === 0 ? (
        <EmptyState description='No stories yet. Click "Scrape Now" to fetch.' />
      ) : (
        <div className="flex flex-col gap-0.5">
          {stories.map((story) => (
            <FeedRow
              key={story.id}
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
          ))}
        </div>
      )}
    </div>
  );
}
