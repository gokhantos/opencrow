import { useState, useEffect } from "react";
import { apiFetch } from "../api";
import { PageHeader, LoadingState, EmptyState, FeedRow, Button } from "../components";
import { useToast } from "../components/Toast";
import { Settings2, ChevronDown, MessageSquare } from "lucide-react";

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

interface HNConfig {
  readonly intervalMinutes: number;
  readonly maxStories: number;
  readonly commentLimit: number;
}

const HN_CONFIG_DEFAULTS: HNConfig = {
  intervalMinutes: 10,
  maxStories: 60,
  commentLimit: 3,
};

function HNConfigPanel() {
  const { success, error: toastError } = useToast();
  const [open, setOpen] = useState(false);
  const [config, setConfig] = useState<HNConfig>(HN_CONFIG_DEFAULTS);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open || loaded) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch<{ data: HNConfig }>(
          "/api/features/scraper-config/hackernews",
        );
        if (!cancelled) {
          setConfig(res.data);
          setLoaded(true);
        }
      } catch {
        if (!cancelled) {
          setLoaded(true);
          toastError("Failed to load config.");
        }
      }
    })();
    return () => { cancelled = true; };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleSave() {
    setSaving(true);
    try {
      await apiFetch("/api/features/scraper-config/hackernews", {
        method: "PUT",
        body: JSON.stringify(config),
      });
      success("Config saved.");
    } catch {
      toastError("Failed to save config.");
    } finally {
      setSaving(false);
    }
  }

  function field(
    label: string,
    key: keyof HNConfig,
    min: number,
    max: number,
    desc: string,
  ) {
    return (
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="text-xs font-medium text-foreground">{label}</div>
          <div className="text-xs text-muted mt-0.5">{desc}</div>
        </div>
        <input
          type="number"
          min={min}
          max={max}
          value={config[key]}
          onChange={(e) => {
            const n = parseInt(e.target.value, 10);
            if (!isNaN(n)) setConfig((prev) => ({ ...prev, [key]: n }));
          }}
          className="w-20 shrink-0 bg-bg-2 border border-border rounded-md px-2 py-1 text-xs text-foreground text-right focus:outline-none focus:border-accent"
        />
      </div>
    );
  }

  return (
    <div className="bg-bg-1 border border-border rounded-lg mb-5">
      <button
        type="button"
        onClick={() => setOpen((p) => !p)}
        className="w-full flex items-center justify-between px-4 py-2.5 bg-transparent border-none cursor-pointer text-left"
      >
        <div className="flex items-center gap-2 text-xs text-muted">
          <Settings2 className="w-3.5 h-3.5" />
          <span className="font-medium">Scraper Config</span>
        </div>
        <ChevronDown
          className={`w-3.5 h-3.5 text-muted transition-transform duration-200 ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open && (
        <div className="border-t border-border px-4 py-3 flex flex-col gap-3">
          {!loaded ? (
            <p className="text-xs text-muted">Loading...</p>
          ) : (
            <>
              {field("Scrape interval (min)", "intervalMinutes", 1, 1440, "How often to scrape")}
              {field("Max stories", "maxStories", 10, 200, "Number of top stories to fetch")}
              {field("Comments per story", "commentLimit", 0, 10, "Top comments to fetch per story")}
              <div className="flex justify-end">
                <Button
                  variant="primary"
                  size="sm"
                  onClick={handleSave}
                  disabled={saving}
                  loading={saving}
                >
                  Save
                </Button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default function HackerNews() {
  const [stories, setStories] = useState<HNStory[]>([]);
  const [stats, setStats] = useState<StatsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [scraping, setScraping] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
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

      <HNConfigPanel />

      {stories.length === 0 ? (
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
