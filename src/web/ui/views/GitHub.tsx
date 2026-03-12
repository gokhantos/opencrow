import React, { useState, useEffect } from "react";
import { apiFetch } from "../api";
import { formatTime, formatNumber } from "../lib/format";
import { cn } from "../lib/cn";
import { PageHeader, LoadingState, EmptyState, Button } from "../components";
import { useToast } from "../components/Toast";
import { Settings2 } from "lucide-react";

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

interface FieldDef {
  readonly key: string;
  readonly label: string;
  readonly description: string;
  readonly min: number;
  readonly max: number;
  readonly defaultValue: number;
}

const SCRAPER_FIELDS: Readonly<Record<string, readonly FieldDef[]>> = {
  github: [
    { key: "intervalMinutes", label: "Scrape interval (min)", description: "How often to scrape", min: 10, max: 1440, defaultValue: 720 },
  ],
  "github-search": [
    { key: "intervalMinutes", label: "Scrape interval (min)", description: "How often to scrape", min: 1, max: 1440, defaultValue: 360 },
    { key: "minStars", label: "Minimum stars", description: "Only include repos with at least this many stars", min: 1, max: 100000, defaultValue: 500 },
    { key: "pushedWithinDays", label: "Pushed within days", description: "Only include repos pushed within this many days", min: 1, max: 90, defaultValue: 7 },
    { key: "maxPages", label: "Max pages", description: "Max pages to fetch (30 repos per page)", min: 1, max: 10, defaultValue: 4 },
  ],
};

function getDefaults(scraperId: string): Record<string, number> {
  const fields = SCRAPER_FIELDS[scraperId] ?? [];
  return Object.fromEntries(fields.map((f) => [f.key, f.defaultValue]));
}

type Tab = "trending" | "search";
type SortKey = "stars_today" | "stars" | "forks" | "newest";
type TrendingPeriod = "" | "daily" | "weekly";

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

/* ── Scraper config form (inline, expandable) ── */
function ScraperConfigForm({
  scraperId,
  onClose,
}: {
  readonly scraperId: string;
  readonly onClose: () => void;
}) {
  const { success, error: toastError } = useToast();
  const fields = SCRAPER_FIELDS[scraperId] ?? [];
  const [config, setConfig] = useState<Record<string, number>>(getDefaults(scraperId));
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch<{ data: Record<string, number> }>(
          `/api/features/scraper-config/${scraperId}`,
        );
        if (!cancelled) setConfig(res.data);
      } catch {
        if (!cancelled) toastError("Failed to load scraper config.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [scraperId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleSave() {
    setSaving(true);
    try {
      await apiFetch(`/api/features/scraper-config/${scraperId}`, {
        method: "PUT",
        body: JSON.stringify(config),
      });
      success("Config saved.");
      onClose();
    } catch {
      toastError("Failed to save config.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="bg-bg-2 border border-border rounded-lg p-3 mb-4">
      {loading ? (
        <p className="text-xs text-muted py-1">Loading config…</p>
      ) : (
        <div className="flex flex-col gap-3">
          {fields.map((f) => (
            <div key={f.key} className="flex items-center justify-between gap-4">
              <div className="min-w-0">
                <div className="text-xs font-medium text-foreground">{f.label}</div>
                <div className="text-xs text-muted mt-0.5">{f.description}</div>
              </div>
              <input
                type="number"
                min={f.min}
                max={f.max}
                value={config[f.key] ?? f.defaultValue}
                onChange={(e) => {
                  const n = parseInt(e.target.value, 10);
                  if (!isNaN(n)) setConfig((prev) => ({ ...prev, [f.key]: n }));
                }}
                className="w-20 shrink-0 bg-bg-1 border border-border rounded-md px-2 py-1 text-xs text-foreground text-right focus:outline-none focus:border-accent"
              />
            </div>
          ))}
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="ghost" size="sm" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
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
        </div>
      )}
    </div>
  );
}

/* ── Shared repo list component ── */
function RepoList({ repos }: { readonly repos: readonly GithubRepo[] }) {
  if (repos.length === 0) {
    return <EmptyState description='No repos yet. Click "Scrape Now" to fetch.' />;
  }

  return (
    <div className="flex flex-col gap-0.5">
      {repos.map((repo, i) => (
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
                    color: langColors[repo.language] ?? "var(--color-accent)",
                  }}
                >
                  {repo.language}
                </span>
              )}
              {repo.period !== "search" && (
                <span className="text-xs text-faint bg-bg-2 px-2 py-0.5 rounded-sm shrink-0">
                  {repo.period === "weekly" ? "week" : "day"}
                </span>
              )}
            </div>
            {repo.description && (
              <div className="text-sm text-faint mt-0.5 overflow-hidden text-ellipsis whitespace-nowrap max-w-[650px]">
                {repo.description.slice(0, 150)}
              </div>
            )}
          </div>

          <div className="flex items-center gap-4 text-sm text-faint shrink-0 font-mono">
            {repo.stars_today > 0 && (
              <span
                title={`+${repo.stars_today} stars ${repo.period === "weekly" ? "this week" : "today"}`}
              >
                <span className="text-[#f0b429] font-semibold">
                  +{formatNumber(repo.stars_today)}
                </span>
              </span>
            )}
            <span title="Total stars">
              {formatNumber(repo.stars)} stars
            </span>
            <span title="Forks">{formatNumber(repo.forks)} forks</span>
          </div>
        </div>
      ))}
    </div>
  );
}

/* ── Tab config + controls header ── */
function TabHeader({
  scraperId,
  children,
}: {
  readonly scraperId: string;
  readonly children?: React.ReactNode;
}) {
  const [configOpen, setConfigOpen] = useState(false);

  return (
    <div className="mb-5">
      <div className="flex items-center justify-between mb-3">
        <button
          type="button"
          title="Configure"
          onClick={() => setConfigOpen((p) => !p)}
          className={`p-1 rounded-md transition-colors ${
            configOpen
              ? "text-accent bg-accent-subtle"
              : "text-muted hover:text-foreground hover:bg-bg-2"
          }`}
        >
          <Settings2 className="w-3.5 h-3.5" />
        </button>
        {children && <div className="flex gap-3 flex-wrap">{children}</div>}
      </div>
      {configOpen && (
        <ScraperConfigForm
          scraperId={scraperId}
          onClose={() => setConfigOpen(false)}
        />
      )}
    </div>
  );
}

/* ── Helpers ── */
function dedupeByFullName(repos: readonly GithubRepo[]): GithubRepo[] {
  const seen = new Set<string>();
  return repos.filter((r) => {
    if (seen.has(r.full_name)) return false;
    seen.add(r.full_name);
    return true;
  });
}

function sortRepos(repos: readonly GithubRepo[], sortBy: SortKey): GithubRepo[] {
  return [...repos].sort((a, b) => {
    if (sortBy === "stars_today") return b.stars_today - a.stars_today;
    if (sortBy === "stars") return b.stars - a.stars;
    if (sortBy === "forks") return b.forks - a.forks;
    return b.updated_at - a.updated_at;
  });
}

function getLanguages(repos: readonly GithubRepo[]): string[] {
  return Array.from(
    new Set(repos.map((r) => r.language).filter(Boolean)),
  ).sort();
}

/* ── Main page ── */
export default function GitHub() {
  const [repos, setRepos] = useState<GithubRepo[]>([]);
  const [stats, setStats] = useState<StatsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [scrapingTrending, setScrapingTrending] = useState(false);
  const [scrapingSearch, setScrapingSearch] = useState(false);
  const [tab, setTab] = useState<Tab>("trending");

  // Trending filters
  const [trendingSort, setTrendingSort] = useState<SortKey>("stars_today");
  const [trendingLang, setTrendingLang] = useState("");
  const [trendingPeriod, setTrendingPeriod] = useState<TrendingPeriod>("");

  // Search filters
  const [searchSort, setSearchSort] = useState<SortKey>("stars");
  const [searchLang, setSearchLang] = useState("");

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

  async function handleScrapeTrending() {
    setScrapingTrending(true);
    try {
      await apiFetch("/api/github/scrape-now", { method: "POST" });
      await fetchAll();
    } catch {
      // ignore
    } finally {
      setScrapingTrending(false);
    }
  }

  async function handleScrapeSearch() {
    setScrapingSearch(true);
    try {
      await apiFetch("/api/github/search-scrape-now", { method: "POST" });
      await fetchAll();
    } catch {
      // ignore
    } finally {
      setScrapingSearch(false);
    }
  }

  // Split repos by source
  const trendingRepos = repos.filter((r) => r.period === "daily" || r.period === "weekly");
  const searchRepos = repos.filter((r) => r.period === "search");

  // Trending: filter, sort, dedupe
  const trendingFiltered = dedupeByFullName(
    sortRepos(
      trendingRepos
        .filter((r) => !trendingLang || r.language === trendingLang)
        .filter((r) => !trendingPeriod || r.period === trendingPeriod),
      trendingSort,
    ),
  );

  // Search: filter, sort
  const searchFiltered = sortRepos(
    searchRepos.filter((r) => !searchLang || r.language === searchLang),
    searchSort,
  );

  const trendingLanguages = getLanguages(trendingRepos);
  const searchLanguages = getLanguages(searchRepos);

  if (loading) {
    return <LoadingState message="Loading..." />;
  }

  return (
    <div>
      <PageHeader
        title="GitHub"
        subtitle={
          stats &&
          `${stats.total_repos} repos | ${stats.languages} languages | Last updated: ${formatTime(stats.last_updated_at)}`
        }
        actions={
          tab === "trending" ? (
            <Button size="sm" onClick={handleScrapeTrending} loading={scrapingTrending}>
              Scrape Trending
            </Button>
          ) : (
            <Button size="sm" onClick={handleScrapeSearch} loading={scrapingSearch}>
              Scrape Search
            </Button>
          )
        }
      />

      {/* Tab switcher */}
      <div className="flex gap-1 mb-5 border-b border-border">
        {(["trending", "search"] as const).map((t) => (
          <button
            key={t}
            onClick={() => { setTab(t); }}
            className={cn(
              "px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors bg-transparent cursor-pointer",
              tab === t
                ? "border-accent text-accent"
                : "border-transparent text-muted hover:text-foreground",
            )}
          >
            {t === "trending"
              ? `Trending (${trendingRepos.length})`
              : `Search (${searchRepos.length})`}
          </button>
        ))}
      </div>

      {/* ── Trending Tab ── */}
      {tab === "trending" && (
        <>
          <TabHeader scraperId="github">
            <select
              value={trendingSort}
              onChange={(e) => setTrendingSort(e.target.value as SortKey)}
              className="px-3 py-1.5 text-xs bg-bg-1 text-strong border border-border rounded-md outline-none"
            >
              <option value="stars_today">Hottest</option>
              <option value="stars">Most Stars</option>
              <option value="forks">Most Forks</option>
              <option value="newest">Newest</option>
            </select>

            <select
              value={trendingPeriod}
              onChange={(e) => setTrendingPeriod(e.target.value as TrendingPeriod)}
              className="px-3 py-1.5 text-xs bg-bg-1 text-strong border border-border rounded-md outline-none"
            >
              <option value="">Daily + Weekly</option>
              <option value="daily">Today</option>
              <option value="weekly">This week</option>
            </select>

            <select
              value={trendingLang}
              onChange={(e) => setTrendingLang(e.target.value)}
              className="px-3 py-1.5 text-xs bg-bg-1 text-strong border border-border rounded-md outline-none"
            >
              <option value="">All languages</option>
              {trendingLanguages.map((lang) => (
                <option key={lang} value={lang}>{lang}</option>
              ))}
            </select>
          </TabHeader>

          <RepoList repos={trendingFiltered} />
        </>
      )}

      {/* ── Search Tab ── */}
      {tab === "search" && (
        <>
          <TabHeader scraperId="github-search">
            <select
              value={searchSort}
              onChange={(e) => setSearchSort(e.target.value as SortKey)}
              className="px-3 py-1.5 text-xs bg-bg-1 text-strong border border-border rounded-md outline-none"
            >
              <option value="stars">Most Stars</option>
              <option value="forks">Most Forks</option>
              <option value="newest">Newest</option>
            </select>

            <select
              value={searchLang}
              onChange={(e) => setSearchLang(e.target.value)}
              className="px-3 py-1.5 text-xs bg-bg-1 text-strong border border-border rounded-md outline-none"
            >
              <option value="">All languages</option>
              {searchLanguages.map((lang) => (
                <option key={lang} value={lang}>{lang}</option>
              ))}
            </select>
          </TabHeader>

          <RepoList repos={searchFiltered} />
        </>
      )}
    </div>
  );
}
