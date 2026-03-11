import React, { useState, useEffect, useCallback } from "react";
import { apiFetch } from "../api";
import { relativeTime } from "../lib/format";
import { cn } from "../lib/cn";
import { PageHeader, LoadingState, Button } from "../components";
import { Settings2 } from "lucide-react";

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

interface StatRow {
  readonly source_name: string;
  readonly count: number;
  readonly latest_at: number;
}

type SourceFilter =
  | "all"
  | "cryptopanic"
  | "cointelegraph"
  | "reuters"
  | "investing_news"
  | "investing_calendar";

const ALL_SOURCE_TABS: { id: SourceFilter; label: string; scraperId: string }[] = [
  { id: "all", label: "All", scraperId: "" },
  { id: "cryptopanic", label: "CryptoPanic", scraperId: "cryptopanic" },
  { id: "cointelegraph", label: "CoinTelegraph", scraperId: "cointelegraph" },
  { id: "reuters", label: "Reuters", scraperId: "reuters" },
  { id: "investing_news", label: "Investing", scraperId: "investing_news" },
  { id: "investing_calendar", label: "Calendar", scraperId: "investing_calendar" },
];

const SOURCE_COLORS: Record<string, string> = {
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

interface FieldDef {
  readonly key: string;
  readonly label: string;
  readonly description: string;
  readonly min: number;
  readonly max: number;
  readonly defaultValue: number;
}

const SOURCE_CONFIG_FIELDS: Record<string, readonly FieldDef[]> = {
  cryptopanic: [
    { key: "intervalMinutes", label: "Scrape interval (min)", description: "How often to scrape", min: 5, max: 1440, defaultValue: 15 },
  ],
  cointelegraph: [
    { key: "intervalMinutes", label: "Scrape interval (min)", description: "How often to scrape", min: 10, max: 1440, defaultValue: 30 },
  ],
  reuters: [
    { key: "intervalMinutes", label: "Scrape interval (min)", description: "How often to scrape", min: 10, max: 1440, defaultValue: 60 },
  ],
  investing_news: [
    { key: "intervalMinutes", label: "Scrape interval (min)", description: "How often to scrape", min: 10, max: 1440, defaultValue: 60 },
  ],
  investing_calendar: [
    { key: "intervalMinutes", label: "Scrape interval (min)", description: "How often to scrape", min: 30, max: 1440, defaultValue: 120 },
  ],
};

function getDefaults(scraperId: string): Record<string, number> {
  const fields = SOURCE_CONFIG_FIELDS[scraperId] ?? [];
  return Object.fromEntries(fields.map((f) => [f.key, f.defaultValue]));
}

function parseCurrencies(json: string): readonly string[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/* ── Inline config panel for a source ── */
function SourceConfigPanel({ scraperId }: { readonly scraperId: string }) {
  const fields = SOURCE_CONFIG_FIELDS[scraperId];
  if (!fields) return null;

  const [config, setConfig] = useState<Record<string, number>>(getDefaults(scraperId));
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch<{ data: Record<string, number> }>(
          `/api/features/scraper-config/${scraperId}`,
        );
        if (!cancelled) setConfig(res.data);
      } catch {
        // use defaults
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [scraperId]);

  async function handleSave() {
    setSaving(true);
    try {
      await apiFetch(`/api/features/scraper-config/${scraperId}`, {
        method: "PUT",
        body: JSON.stringify(config),
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch {
      // ignore
    } finally {
      setSaving(false);
    }
  }

  if (loading) return null;

  return (
    <div className="flex items-center gap-4 px-4 py-2.5 bg-bg-1 rounded-lg border border-border mb-4">
      <Settings2 className="w-3.5 h-3.5 text-muted shrink-0" />
      {fields.map((f) => (
        <div key={f.key} className="flex items-center gap-2">
          <label className="text-xs text-muted whitespace-nowrap">{f.label}</label>
          <input
            type="number"
            min={f.min}
            max={f.max}
            value={config[f.key] ?? f.defaultValue}
            onChange={(e) => {
              const n = parseInt(e.target.value, 10);
              if (!isNaN(n)) setConfig((prev) => ({ ...prev, [f.key]: n }));
            }}
            className="w-16 bg-bg-2 border border-border rounded-md px-2 py-1 text-xs text-foreground text-right focus:outline-none focus:border-accent"
          />
        </div>
      ))}
      <Button
        variant="ghost"
        size="sm"
        onClick={handleSave}
        disabled={saving}
        loading={saving}
      >
        {saved ? "Saved" : "Save"}
      </Button>
    </div>
  );
}

export default function News() {
  const [articles, setArticles] = useState<readonly NewsArticle[]>([]);
  const [calendarEvents, setCalendarEvents] = useState<readonly CalendarEvent[]>([]);
  const [stats, setStats] = useState<readonly StatRow[]>([]);
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
  const [loading, setLoading] = useState(true);
  const [scrapingSource, setScrapingSource] = useState<string | null>(null);
  const [enabledScrapers, setEnabledScrapers] = useState<ReadonlySet<string>>(new Set());

  const isCalendar = sourceFilter === "investing_calendar";

  // News-related scraper IDs
  const NEWS_SCRAPER_IDS = new Set([
    "cryptopanic", "cointelegraph",
    "reuters", "investing_news", "investing_calendar",
  ]);

  // Filter tabs to only show enabled sources (+ "all" always shown)
  const visibleTabs = ALL_SOURCE_TABS.filter(
    (t) => t.id === "all" || enabledScrapers.has(t.scraperId),
  );

  // Fetch enabled scrapers from features API
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch<{
          data: { scrapers: { enabled: readonly string[] } };
        }>("/api/features");
        if (!cancelled) {
          setEnabledScrapers(new Set(res.data.scrapers.enabled));
        }
      } catch {
        // Show all tabs if features can't be loaded
        if (!cancelled) setEnabledScrapers(NEWS_SCRAPER_IDS);
      }
    })();
    const handleChange = () => {
      apiFetch<{ data: { scrapers: { enabled: readonly string[] } } }>("/api/features")
        .then((res) => { if (!cancelled) setEnabledScrapers(new Set(res.data.scrapers.enabled)); })
        .catch(() => {});
    };
    window.addEventListener("features-changed", handleChange);
    return () => {
      cancelled = true;
      window.removeEventListener("features-changed", handleChange);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const fetchData = useCallback(async () => {
    try {
      const sourceParam =
        sourceFilter !== "all" &&
        sourceFilter !== "investing_calendar"
          ? `?source=${sourceFilter}&limit=100`
          : "?limit=100";

      const [articlesRes, calendarRes, statsRes] = await Promise.all([
        apiFetch<{ success: boolean; data: readonly NewsArticle[] }>(
          `/api/news/articles${sourceParam}`,
        ),
        apiFetch<{ success: boolean; data: readonly CalendarEvent[] }>(
          "/api/news/calendar?limit=100",
        ),
        apiFetch<{ success: boolean; data: readonly StatRow[] }>(
          "/api/news/stats",
        ),
      ]);

      if (articlesRes.success) setArticles(articlesRes.data);
      if (calendarRes.success) setCalendarEvents(calendarRes.data);
      if (statsRes.success) setStats(statsRes.data);
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
      await apiFetch("/api/news/scrape-now", {
        method: "POST",
        body: JSON.stringify({ source }),
      });
      await fetchData();
    } catch {
      // ignore
    } finally {
      setScrapingSource(null);
    }
  }

  function totalArticles(): number {
    return stats.reduce((sum, s) => sum + s.count, 0);
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
              {ALL_SOURCE_TABS.find((t) => t.id === sourceFilter)?.label ?? ""}
            </Button>
          ) : undefined
        }
      />

      {/* Source Filter Tabs — only enabled sources */}
      <div className="flex gap-1.5 flex-wrap mb-5">
        {visibleTabs.map((t) => {
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

      {/* Inline config for selected source */}
      {sourceFilter !== "all" && (
        <SourceConfigPanel scraperId={sourceFilter} />
      )}

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

      {/* Calendar View */}
      {isCalendar ? (
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
    </div>
  );
}
