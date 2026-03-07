import React, { useState, useEffect } from "react";
import { apiFetch } from "../api";
import {
  PageHeader,
  LoadingState,
  EmptyState,
  FilterTabs,
  Button,
} from "../components";
import { cn } from "../lib/cn";

interface NewsItem {
  readonly title: string;
  readonly url: string;
  readonly source: string;
  readonly picture: string;
}

interface TrendItem {
  readonly id: string;
  readonly title: string;
  readonly traffic_volume: string;
  readonly description: string;
  readonly source: string;
  readonly source_url: string;
  readonly related_queries: string;
  readonly picture_url: string | null;
  readonly news_items_json: string | null;
  readonly geo: string;
  readonly category: string;
  readonly first_seen_at: number;
  readonly updated_at: number;
}

interface StatsData {
  readonly total_trends: number;
  readonly last_updated_at: number | null;
  readonly categories: number;
}

const CATEGORY_TABS = [
  { id: "all", label: "All" },
  { id: "tech", label: "Tech" },
  { id: "business", label: "Business" },
  { id: "entertainment", label: "Entertainment" },
  { id: "health", label: "Health" },
] as const;

const CATEGORY_COLORS: Record<string, string> = {
  all: "bg-accent/10 text-accent",
  tech: "bg-blue-500/10 text-blue-400",
  business: "bg-green-500/10 text-green-400",
  entertainment: "bg-purple-500/10 text-purple-400",
  health: "bg-rose-500/10 text-rose-400",
};

function parseNewsItems(json: string | null): NewsItem[] {
  if (!json) return [];
  try {
    return JSON.parse(json) as NewsItem[];
  } catch {
    return [];
  }
}

function formatRelativeTime(epoch: number): string {
  const diff = Math.floor(Date.now() / 1000) - epoch;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

interface TrendCardProps {
  readonly trend: TrendItem;
}

function TrendCard({ trend }: TrendCardProps) {
  const newsItems = parseNewsItems(trend.news_items_json);
  const relatedQueries = trend.related_queries
    ? trend.related_queries.split(",").map((q) => q.trim()).filter(Boolean)
    : [];
  const categoryColor = CATEGORY_COLORS[trend.category] ?? CATEGORY_COLORS["all"];

  return (
    <div className="bg-bg-2 border border-border rounded-lg p-4 flex flex-col gap-3">
      {/* Header row */}
      <div className="flex gap-3 items-start">
        {trend.picture_url && (
          <img
            src={trend.picture_url}
            alt=""
            className="w-16 h-16 rounded-md object-cover flex-shrink-0 bg-bg-1"
          />
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-2 flex-wrap">
            <h3 className="text-strong font-semibold text-base leading-snug">
              {trend.title}
            </h3>
            <div className="flex items-center gap-2 flex-shrink-0">
              {trend.traffic_volume && (
                <span className="inline-flex items-center gap-1 bg-accent/10 text-accent text-xs font-semibold px-2 py-0.5 rounded-full font-mono">
                  {trend.traffic_volume}
                  <span className="text-accent/60 font-normal">searches</span>
                </span>
              )}
              <span
                className={cn(
                  "text-xs font-medium px-2 py-0.5 rounded-full capitalize",
                  categoryColor,
                )}
              >
                {trend.category}
              </span>
            </div>
          </div>
          <p className="text-muted text-xs mt-1">
            {formatRelativeTime(trend.updated_at)} · {trend.geo}
          </p>
        </div>
      </div>

      {/* News articles */}
      {newsItems.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <p className="text-faint text-xs uppercase tracking-wide font-medium">
            News
          </p>
          <div className="flex flex-col gap-1">
            {newsItems.map((item, i) => (
              <a
                key={i}
                href={item.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 group"
              >
                {item.picture && (
                  <img
                    src={item.picture}
                    alt=""
                    className="w-8 h-8 rounded object-cover flex-shrink-0 bg-bg-1"
                  />
                )}
                <div className="flex-1 min-w-0">
                  <span className="text-sm text-foreground group-hover:text-accent transition-colors line-clamp-1">
                    {item.title}
                  </span>
                  {item.source && (
                    <span className="text-xs text-faint ml-1">· {item.source}</span>
                  )}
                </div>
              </a>
            ))}
          </div>
        </div>
      )}

      {/* Related queries */}
      {relatedQueries.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {relatedQueries.map((q) => (
            <span
              key={q}
              className="text-xs bg-bg-1 border border-border text-muted px-2 py-0.5 rounded-full"
            >
              {q}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export default function GoogleTrends() {
  const [trends, setTrends] = useState<TrendItem[]>([]);
  const [stats, setStats] = useState<StatsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [category, setCategory] = useState("all");
  const [scraping, setScraping] = useState(false);
  const [backfilling, setBackfilling] = useState(false);

  useEffect(() => {
    fetchAll();
    const interval = setInterval(fetchAll, 30_000);
    return () => clearInterval(interval);
  }, [category]);

  async function fetchAll() {
    try {
      const categoryParam = category === "all" ? "" : `&category=${category}`;
      const [trendsRes, statsRes] = await Promise.all([
        apiFetch<{ success: boolean; data: TrendItem[] }>(
          `/api/trends/list?limit=100${categoryParam}`,
        ),
        apiFetch<{ success: boolean; data: StatsData }>("/api/trends/stats"),
      ]);
      if (trendsRes.success) setTrends(trendsRes.data);
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
      await apiFetch("/api/trends/scrape-now", { method: "POST" });
      await fetchAll();
    } catch {
      // ignore
    } finally {
      setScraping(false);
    }
  }

  async function handleBackfillRag() {
    setBackfilling(true);
    try {
      await apiFetch("/api/trends/backfill-rag", { method: "POST" });
    } catch {
      // ignore
    } finally {
      setBackfilling(false);
    }
  }

  function formatTime(epoch: number | null): string {
    if (!epoch) return "Never";
    return new Date(epoch * 1000).toLocaleString();
  }

  if (loading) {
    return <LoadingState message="Loading trends..." />;
  }

  return (
    <div>
      <PageHeader
        title="Google Trends"
        subtitle={
          stats
            ? `${stats.total_trends} trends · ${stats.categories} categories · Updated ${formatTime(stats.last_updated_at)}`
            : undefined
        }
        actions={
          <div className="flex gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={handleBackfillRag}
              disabled={backfilling}
            >
              {backfilling ? "Backfilling…" : "Backfill RAG"}
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={handleScrapeNow}
              disabled={scraping}
            >
              {scraping ? "Scraping…" : "Scrape Now"}
            </Button>
          </div>
        }
      />

      <FilterTabs
        tabs={[...CATEGORY_TABS]}
        active={category}
        onChange={setCategory}
      />

      {trends.length === 0 ? (
        <EmptyState description="No trends yet. The scraper will populate data automatically." />
      ) : (
        <div className="flex flex-col gap-3 mt-4">
          {trends.map((trend) => (
            <TrendCard key={trend.id} trend={trend} />
          ))}
        </div>
      )}
    </div>
  );
}
