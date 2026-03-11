import React, { useState, useEffect } from "react";
import { apiFetch } from "../api";
import { formatTime, formatNumber } from "../lib/format";
import { PageHeader, LoadingState, EmptyState, Button } from "../components";

interface GithubRepo {
  readonly id: string;
  readonly owner: string;
  readonly name: string;
  readonly full_name: string;
  readonly description: string;
  readonly language: string;
  readonly stars: number;
  readonly forks: number;
  readonly stars_today: number;
  readonly built_by_json: string;
  readonly url: string;
  readonly period: string;
  readonly first_seen_at: number;
  readonly updated_at: number;
}

interface StatsData {
  readonly total_repos: number;
  readonly last_updated_at: number | null;
  readonly languages: number;
}

type SortKey = "stars_today" | "stars" | "forks" | "newest";
type PeriodFilter = "" | "daily" | "weekly";

const langColors: Record<string, string> = {
  Python: "#3572A5",
  TypeScript: "#3178c6",
  JavaScript: "#f1e05a",
  Rust: "#dea584",
  Go: "#00ADD8",
  "C++": "#f34b7d",
  C: "#555555",
  Java: "#b07219",
  Shell: "#89e051",
  Ruby: "#701516",
  Swift: "#F05138",
  Kotlin: "#A97BFF",
  Dart: "#00B4AB",
};

export default function GitHub() {
  const [repos, setRepos] = useState<GithubRepo[]>([]);
  const [stats, setStats] = useState<StatsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [scraping, setScraping] = useState(false);
  const [backfilling, setBackfilling] = useState(false);
  const [backfillResult, setBackfillResult] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<SortKey>("stars_today");
  const [filterLang, setFilterLang] = useState("");
  const [filterPeriod, setFilterPeriod] = useState<PeriodFilter>("");

  useEffect(() => {
    fetchAll();
    const interval = setInterval(fetchAll, 60_000);
    return () => clearInterval(interval);
  }, []);

  async function fetchAll() {
    try {
      const [reposRes, statsRes] = await Promise.all([
        apiFetch<{ success: boolean; data: GithubRepo[] }>(
          "/api/github/repos?limit=200",
        ),
        apiFetch<{ success: boolean; data: StatsData }>("/api/github/stats"),
      ]);
      if (reposRes.success) setRepos(reposRes.data);
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
      await apiFetch("/api/github/scrape-now", { method: "POST" });
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
        "/api/github/backfill-rag",
        { method: "POST" },
      );
      if (res.success) {
        setBackfillResult(`Indexed ${res.data.indexed} repos`);
      }
    } catch {
      setBackfillResult("Backfill failed");
    } finally {
      setBackfilling(false);
    }
  }

  const languages = Array.from(
    new Set(repos.map((r) => r.language).filter(Boolean)),
  ).sort();

  const filtered = repos
    .filter((r) => !filterLang || r.language === filterLang)
    .filter((r) => !filterPeriod || r.period === filterPeriod)
    .sort((a, b) => {
      if (sortBy === "stars_today") return b.stars_today - a.stars_today;
      if (sortBy === "stars") return b.stars - a.stars;
      if (sortBy === "forks") return b.forks - a.forks;
      return b.updated_at - a.updated_at;
    });

  // Dedupe by full_name, keeping the entry with higher stars_today
  const seen = new Set<string>();
  const deduped = filtered.filter((r) => {
    if (seen.has(r.full_name)) return false;
    seen.add(r.full_name);
    return true;
  });

  if (loading) {
    return <LoadingState message="Loading..." />;
  }

  return (
    <div>
      <PageHeader
        title="GitHub Trending"
        subtitle={
          stats &&
          `${stats.total_repos} repos | ${stats.languages} languages | Last updated: ${formatTime(stats.last_updated_at)}`
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

      <div className="flex gap-3 mb-5 flex-wrap">
        <select
          value={sortBy}
          onChange={(e) => setSortBy(e.target.value as SortKey)}
          className="px-3 py-2 text-sm bg-bg-1 text-strong border border-border rounded-md outline-none"
        >
          <option value="stars_today">Hottest</option>
          <option value="stars">Most Stars</option>
          <option value="forks">Most Forks</option>
          <option value="newest">Newest</option>
        </select>

        <select
          value={filterPeriod}
          onChange={(e) => setFilterPeriod(e.target.value as PeriodFilter)}
          className="px-3 py-2 text-sm bg-bg-1 text-strong border border-border rounded-md outline-none"
        >
          <option value="">All periods</option>
          <option value="daily">Today</option>
          <option value="weekly">This week</option>
        </select>

        <select
          value={filterLang}
          onChange={(e) => setFilterLang(e.target.value)}
          className="px-3 py-2 text-sm bg-bg-1 text-strong border border-border rounded-md outline-none"
        >
          <option value="">All languages ({repos.length})</option>
          {languages.map((lang) => (
            <option key={lang} value={lang}>
              {lang} ({repos.filter((r) => r.language === lang).length})
            </option>
          ))}
        </select>
      </div>

      {deduped.length === 0 ? (
        <EmptyState description='No repos yet. Click "Scrape Now" to fetch.' />
      ) : (
        <div className="flex flex-col gap-0.5">
          {deduped.map((repo, i) => (
            <div
              key={repo.id}
              className="grid grid-cols-[auto_1fr_auto] items-center gap-4 px-4 py-3 bg-bg-1 rounded-lg text-sm hover:bg-bg-2 transition-colors"
            >
              <span className="text-sm text-faint font-mono w-6 text-right">
                {i + 1}
              </span>

              <div className="min-w-0">
                <div className="flex items-baseline gap-2">
                  <a
                    href={repo.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-strong no-underline font-medium overflow-hidden text-ellipsis whitespace-nowrap"
                  >
                    {repo.full_name}
                  </a>
                  {repo.language && (
                    <span
                      className="text-xs bg-bg-2 px-2 py-0.5 rounded-sm shrink-0 font-medium"
                      style={{
                        color:
                          langColors[repo.language] ?? "var(--color-accent)",
                      }}
                    >
                      {repo.language}
                    </span>
                  )}
                  <span className="text-xs text-faint bg-bg-2 px-2 py-0.5 rounded-sm shrink-0">
                    {repo.period === "weekly" ? "week" : "day"}
                  </span>
                </div>
                {repo.description && (
                  <div className="text-sm text-faint mt-0.5 overflow-hidden text-ellipsis whitespace-nowrap max-w-[650px]">
                    {repo.description.slice(0, 150)}
                  </div>
                )}
              </div>

              <div className="flex items-center gap-4 text-sm text-faint shrink-0 font-mono">
                <span
                  title={`+${repo.stars_today} stars ${repo.period === "weekly" ? "this week" : "today"}`}
                >
                  <span className="text-[#f0b429] font-semibold">
                    +{formatNumber(repo.stars_today)}
                  </span>
                </span>
                <span title="Total stars">
                  {formatNumber(repo.stars)} stars
                </span>
                <span title="Forks">{formatNumber(repo.forks)} forks</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
