import React, { useState, useEffect, useCallback } from "react";
import { apiFetch } from "../api";
import { relativeTime } from "../lib/format";
import { cn } from "../lib/cn";
import { PageHeader, LoadingState, Button } from "../components";

interface NewsArticle {
  readonly id: string;
  readonly source_name: string;
  readonly title: string;
  readonly url: string;
  readonly published_at: string;
  readonly summary: string;
  readonly sentiment: string;
  readonly currencies_json: string;
  readonly source_domain: string;
  readonly scraped_at: number;
}

interface HNStory {
  readonly id: string;
  readonly rank: number;
  readonly title: string;
  readonly url: string;
  readonly site_label: string;
  readonly points: number;
  readonly author: string;
  readonly age: string;
  readonly comment_count: number;
  readonly hn_url: string;
  readonly updated_at: number;
}

interface CalendarEvent {
  readonly id: string;
  readonly event_name: string;
  readonly country: string;
  readonly importance: string;
  readonly event_datetime: string;
  readonly actual: string;
  readonly forecast: string;
  readonly previous: string;
}

interface ScraperRun {
  readonly id: string;
  readonly source_name: string;
  readonly status: "ok" | "error" | "timeout";
  readonly articles_found: number;
  readonly articles_new: number;
  readonly duration_ms: number;
  readonly error: string | null;
  readonly started_at: number;
}

interface StatRow {
  readonly source_name: string;
  readonly count: number;
  readonly latest_at: number;
}

type SourceFilter =
  | "all"
  | "hackernews"
  | "cryptopanic"
  | "cointelegraph"
  | "reuters"
  | "investing_news"
  | "investing_calendar";

const SOURCE_TABS: { id: SourceFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "hackernews", label: "Hacker News" },
  { id: "cryptopanic", label: "CryptoPanic" },
  { id: "cointelegraph", label: "CoinTelegraph" },
  { id: "reuters", label: "Reuters" },
  { id: "investing_news", label: "Investing" },
  { id: "investing_calendar", label: "Calendar" },
];

const SOURCE_COLORS: Record<string, string> = {
  hackernews: "#ff6600",
  cryptopanic: "#f59e0b",
  cointelegraph: "#0070f3",
  reuters: "#f97316",
  investing_news: "#2dd4bf",
  investing_calendar: "#7928ca",
};

const sentimentClasses: Record<string, string> = {
  positive: "bg-success-subtle text-success",
  negative: "bg-danger-subtle text-danger",
  neutral: "bg-bg-2 text-faint",
};

const importanceClasses: Record<string, string> = {
  high: "bg-danger-subtle text-danger",
  medium: "bg-warning-subtle text-warning",
  low: "bg-success-subtle text-success",
};

const runStatusClasses: Record<string, string> = {
  ok: "bg-success-subtle text-success",
  error: "bg-danger-subtle text-danger",
  timeout: "bg-warning-subtle text-warning",
};

function parseCurrencies(json: string): readonly string[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export default function News() {
  const [articles, setArticles] = useState<readonly NewsArticle[]>([]);
  const [hnStories, setHnStories] = useState<readonly HNStory[]>([]);
  const [calendarEvents, setCalendarEvents] = useState<
    readonly CalendarEvent[]
  >([]);
  const [stats, setStats] = useState<readonly StatRow[]>([]);
  const [runs, setRuns] = useState<readonly ScraperRun[]>([]);
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
  const [loading, setLoading] = useState(true);
  const [scrapingSource, setScrapingSource] = useState<string | null>(null);
  const [showRuns, setShowRuns] = useState(false);

  const isCalendar = sourceFilter === "investing_calendar";
  const isHN = sourceFilter === "hackernews";

  const fetchData = useCallback(async () => {
    try {
      const sourceParam =
        sourceFilter !== "all" &&
        sourceFilter !== "investing_calendar" &&
        sourceFilter !== "hackernews"
          ? `?source=${sourceFilter}&limit=100`
          : "?limit=100";

      const requests: Promise<unknown>[] = [
        apiFetch<{ success: boolean; data: readonly NewsArticle[] }>(
          `/api/news/articles${sourceParam}`,
        ),
        apiFetch<{ success: boolean; data: readonly CalendarEvent[] }>(
          "/api/news/calendar?limit=100",
        ),
        apiFetch<{ success: boolean; data: readonly StatRow[] }>(
          "/api/news/stats",
        ),
        apiFetch<{ success: boolean; data: readonly ScraperRun[] }>(
          "/api/news/runs?limit=20",
        ),
        apiFetch<{ success: boolean; data: readonly HNStory[] }>(
          "/api/hn/stories?limit=100",
        ),
      ];

      const [articlesRes, calendarRes, statsRes, runsRes, hnRes] =
        (await Promise.all(requests)) as [
          { success: boolean; data: readonly NewsArticle[] },
          { success: boolean; data: readonly CalendarEvent[] },
          { success: boolean; data: readonly StatRow[] },
          { success: boolean; data: readonly ScraperRun[] },
          { success: boolean; data: readonly HNStory[] },
        ];

      if (articlesRes.success) setArticles(articlesRes.data);
      if (calendarRes.success) setCalendarEvents(calendarRes.data);
      if (statsRes.success) setStats(statsRes.data);
      if (runsRes.success) setRuns(runsRes.data);
      if (hnRes.success) setHnStories(hnRes.data);
    } catch {
      // ignore fetch errors
    } finally {
      setLoading(false);
    }
  }, [sourceFilter]);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 30_000);
    return () => clearInterval(interval);
  }, [fetchData]);

  async function handleScrapeNow(source: SourceFilter) {
    if (source === "all") return;
    setScrapingSource(source);
    try {
      if (source === "hackernews") {
        await apiFetch("/api/hn/scrape-now", { method: "POST" });
      } else {
        await apiFetch("/api/news/scrape-now", {
          method: "POST",
          body: JSON.stringify({ source }),
        });
      }
      await fetchData();
    } catch {
      // ignore
    } finally {
      setScrapingSource(null);
    }
  }

  function totalArticles(): number {
    return stats.reduce((sum, s) => sum + s.count, 0) + hnStories.length;
  }

  if (loading) {
    return <LoadingState message="Loading..." />;
  }

  return (
    <div>
      {/* Header */}
      <PageHeader
        title="News"
        count={totalArticles()}
        actions={
          sourceFilter !== "all" ? (
            <Button
              size="sm"
              onClick={() => handleScrapeNow(sourceFilter)}
              loading={scrapingSource === sourceFilter}
              disabled={scrapingSource !== null}
            >
              Scrape{" "}
              {SOURCE_TABS.find((t) => t.id === sourceFilter)?.label ?? ""}
            </Button>
          ) : undefined
        }
      />

      {/* Source Filter Tabs */}
      <div className="flex gap-1.5 flex-wrap mb-5">
        {SOURCE_TABS.map((t) => {
          const isActive = sourceFilter === t.id;
          return (
            <button
              key={t.id}
              className={cn(
                "px-4 py-2 rounded-full font-sans text-sm font-medium cursor-pointer transition-colors border",
                isActive
                  ? "font-semibold"
                  : "bg-bg-1 border-border text-muted hover:bg-bg-2 hover:text-strong",
              )}
              style={
                isActive && t.id !== "all"
                  ? {
                      borderColor: SOURCE_COLORS[t.id],
                      background: `${SOURCE_COLORS[t.id]}18`,
                      color: SOURCE_COLORS[t.id],
                    }
                  : isActive
                    ? {
                        borderColor: "var(--color-accent)",
                        background: "var(--color-accent-subtle)",
                        color: "var(--color-accent)",
                      }
                    : undefined
              }
              onClick={() => setSourceFilter(t.id)}
            >
              {t.label}
            </button>
          );
        })}
      </div>

      {/* Stats Bar */}
      {stats.length > 0 && (
        <div className="flex items-center justify-between mb-5 px-4 py-3 bg-bg-1 rounded-lg border border-border text-sm text-faint">
          <div className="flex gap-5 flex-wrap">
            {stats.map((s) => (
              <span
                key={s.source_name}
                className="inline-flex items-center gap-1.5"
              >
                <span
                  className="inline-block w-2 h-2 rounded-full shrink-0"
                  style={{
                    background:
                      SOURCE_COLORS[s.source_name] ?? "var(--color-faint)",
                  }}
                />
                <span className="font-mono font-semibold text-muted">
                  {s.count}
                </span>
                {s.source_name.replace("_", " ")}
                <span className="text-faint text-xs">
                  ({relativeTime(s.latest_at)})
                </span>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* HN Stories View */}
      {isHN ? (
        hnStories.length === 0 ? (
          <div className="text-center text-faint p-12 text-base">
            No stories yet. Click "Scrape Hacker News" to fetch.
          </div>
        ) : (
          <div className="flex flex-col gap-0.5">
            {hnStories.map((s) => {
              const color = SOURCE_COLORS.hackernews;
              return (
                <div
                  key={s.id}
                  className="grid grid-cols-[1fr_auto] items-start gap-4 px-4 py-3 bg-bg-1 rounded-lg text-sm transition-colors hover:bg-bg-2"
                >
                  <div className="min-w-0">
                    <div className="flex items-baseline gap-2 flex-wrap">
                      <span
                        className="font-mono font-semibold text-base"
                        style={{ color, minWidth: "1.5rem" }}
                      >
                        {s.rank}.
                      </span>
                      <a
                        href={s.url || s.hn_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-strong no-underline font-medium leading-snug hover:underline"
                      >
                        {s.title}
                      </a>
                      {s.site_label && (
                        <span className="text-xs text-faint shrink-0">
                          ({s.site_label})
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 mt-1 flex-wrap">
                      <span
                        className="inline-flex items-center px-2 py-0.5 rounded-full font-mono text-xs font-semibold uppercase tracking-wide shrink-0"
                        style={{
                          background: `${color}18`,
                          color,
                          border: `1px solid ${color}40`,
                        }}
                      >
                        {s.points} pts
                      </span>
                      {s.author && (
                        <span className="text-xs text-faint">
                          by {s.author}
                        </span>
                      )}
                      {s.hn_url && (
                        <a
                          href={s.hn_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs text-faint no-underline"
                        >
                          {s.comment_count} comments
                        </a>
                      )}
                    </div>
                  </div>
                  <span className="text-xs text-faint whitespace-nowrap shrink-0 self-center">
                    {s.age || relativeTime(s.updated_at)}
                  </span>
                </div>
              );
            })}
          </div>
        )
      ) : /* Calendar View */
      isCalendar ? (
        calendarEvents.length === 0 ? (
          <div className="text-center text-faint p-12 text-base">
            No calendar events yet. Click "Scrape" to fetch.
          </div>
        ) : (
          <table
            className="w-full border-separate"
            style={{ borderSpacing: "0 2px" }}
          >
            <thead>
              <tr>
                <th className="text-left px-4 py-2.5 text-xs font-semibold uppercase tracking-widest text-faint border-b border-border">
                  Event
                </th>
                <th className="text-left px-4 py-2.5 text-xs font-semibold uppercase tracking-widest text-faint border-b border-border">
                  Country
                </th>
                <th className="text-left px-4 py-2.5 text-xs font-semibold uppercase tracking-widest text-faint border-b border-border">
                  Importance
                </th>
                <th className="text-left px-4 py-2.5 text-xs font-semibold uppercase tracking-widest text-faint border-b border-border">
                  Date/Time
                </th>
                <th className="text-left px-4 py-2.5 text-xs font-semibold uppercase tracking-widest text-faint border-b border-border">
                  Actual
                </th>
                <th className="text-left px-4 py-2.5 text-xs font-semibold uppercase tracking-widest text-faint border-b border-border">
                  Forecast
                </th>
                <th className="text-left px-4 py-2.5 text-xs font-semibold uppercase tracking-widest text-faint border-b border-border">
                  Previous
                </th>
              </tr>
            </thead>
            <tbody>
              {calendarEvents.map((ev) => (
                <tr key={ev.id}>
                  <td className="px-4 py-2.5 bg-bg-1 text-sm first:rounded-l-md last:rounded-r-md">
                    <span className="font-medium text-strong">
                      {ev.event_name}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 bg-bg-1 text-sm">
                    <span className="text-sm text-faint">{ev.country}</span>
                  </td>
                  <td className="px-4 py-2.5 bg-bg-1 text-sm">
                    <span
                      className={cn(
                        "inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold capitalize",
                        importanceClasses[ev.importance || "medium"] ??
                          importanceClasses.medium,
                      )}
                    >
                      {ev.importance || "medium"}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 bg-bg-1 text-sm text-muted">
                    {ev.event_datetime || "-"}
                  </td>
                  <td className="px-4 py-2.5 bg-bg-1 font-mono text-sm text-foreground">
                    {ev.actual || "-"}
                  </td>
                  <td className="px-4 py-2.5 bg-bg-1 font-mono text-sm text-foreground">
                    {ev.forecast || "-"}
                  </td>
                  <td className="px-4 py-2.5 bg-bg-1 font-mono text-sm text-foreground last:rounded-r-md">
                    {ev.previous || "-"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      ) : (
        /* Article List */
        <>
          {articles.length === 0 ? (
            <div className="text-center text-faint p-12 text-base">
              No articles yet. Click a source tab and "Scrape" to fetch.
            </div>
          ) : (
            <div className="flex flex-col gap-0.5">
              {articles.map((a) => {
                const currencies = parseCurrencies(a.currencies_json);
                const color =
                  SOURCE_COLORS[a.source_name] ?? "var(--color-faint)";
                return (
                  <div
                    key={a.id}
                    className="grid grid-cols-[1fr_auto] items-start gap-4 px-4 py-3 bg-bg-1 rounded-lg text-sm transition-colors hover:bg-bg-2"
                  >
                    <div className="min-w-0">
                      <div className="flex items-baseline gap-2 flex-wrap">
                        <a
                          href={a.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-strong no-underline font-medium leading-snug hover:underline"
                        >
                          {a.title}
                        </a>
                        {a.source_domain && (
                          <span className="text-xs text-faint shrink-0">
                            ({a.source_domain})
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2 mt-1 flex-wrap">
                        <span
                          className="inline-flex items-center px-2 py-0.5 rounded-full font-mono text-xs font-semibold uppercase tracking-wide shrink-0"
                          style={{
                            background: `${color}18`,
                            color,
                            border: `1px solid ${color}40`,
                          }}
                        >
                          {a.source_name.replace("_", " ")}
                        </span>
                        {a.sentiment && (
                          <span
                            className={cn(
                              "inline-flex items-center px-1.5 py-0.5 rounded-full text-xs font-semibold capitalize",
                              sentimentClasses[a.sentiment.toLowerCase()] ??
                                sentimentClasses.neutral,
                            )}
                          >
                            {a.sentiment}
                          </span>
                        )}
                        {currencies.length > 0 && (
                          <span className="inline-flex gap-1 flex-wrap">
                            {currencies.slice(0, 5).map((c) => (
                              <span
                                key={c}
                                className="inline-flex px-1.5 py-0.5 rounded-md bg-accent-subtle text-accent font-mono text-xs font-semibold"
                              >
                                {c}
                              </span>
                            ))}
                          </span>
                        )}
                      </div>
                      {a.summary && (
                        <div className="text-sm text-muted mt-1 leading-relaxed line-clamp-2 overflow-hidden">
                          {a.summary}
                        </div>
                      )}
                    </div>
                    <span className="text-xs text-faint whitespace-nowrap shrink-0 self-center">
                      {relativeTime(a.scraped_at)}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      {/* Runs Panel */}
      <div className="mt-5 border border-border rounded-lg overflow-hidden">
        <div
          className="flex items-center justify-between px-4 py-3 bg-bg-1 cursor-pointer select-none transition-colors hover:bg-bg-2"
          onClick={() => setShowRuns((prev) => !prev)}
        >
          <span className="font-sans text-sm font-semibold text-muted tracking-wide">
            Scraper Runs ({runs.length})
          </span>
          <span
            className={cn(
              "text-xs text-faint transition-transform duration-150",
              showRuns && "rotate-90",
            )}
          >
            &#9654;
          </span>
        </div>
        {showRuns && (
          <div className="flex flex-col gap-0.5 p-1">
            {runs.length === 0 ? (
              <div className="p-5 text-center text-faint text-sm">
                No runs yet
              </div>
            ) : (
              runs.map((r) => (
                <div
                  key={r.id}
                  className="grid grid-cols-[6rem_5rem_4rem_4rem_5rem_1fr] max-md:grid-cols-[5rem_4rem_3rem_1fr] items-center gap-3 px-4 py-2.5 text-sm bg-bg-1 rounded-md"
                >
                  <span className="font-medium text-foreground">
                    {r.source_name.replace("_", " ")}
                  </span>
                  <span
                    className={cn(
                      "inline-flex items-center px-1.5 py-0.5 rounded-full text-xs font-semibold uppercase",
                      runStatusClasses[r.status] ?? "bg-bg-2 text-faint",
                    )}
                  >
                    {r.status}
                  </span>
                  <span className="font-mono text-muted text-right">
                    {r.articles_new}/{r.articles_found}
                  </span>
                  <span className="font-mono text-faint text-right max-md:hidden">
                    {(r.duration_ms / 1000).toFixed(1)}s
                  </span>
                  <span className="text-faint text-right">
                    {relativeTime(r.started_at)}
                  </span>
                  <span className="text-danger text-xs font-mono whitespace-nowrap overflow-hidden text-ellipsis max-md:hidden">
                    {r.error ?? ""}
                  </span>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}
