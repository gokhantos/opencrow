import { useState, useEffect, useCallback } from "react";
import { apiFetch } from "../api";
import {
  PageHeader,
  LoadingState,
  EmptyState,
  FilterTabs,
  Button,
} from "../components";
import { useToast } from "../components/Toast";
import { cn } from "../lib/cn";
import { Settings2, ChevronDown } from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

interface PlayRankingRow {
  readonly id: string;
  readonly name: string;
  readonly developer: string;
  readonly category: string;
  readonly rank: number;
  readonly list_type: string;
  readonly icon_url: string;
  readonly store_url: string;
  readonly description: string;
  readonly price: string;
  readonly rating: number | null;
  readonly installs: string;
  readonly updated_at: number;
  readonly indexed_at: number | null;
}

interface PlayReviewRow {
  readonly id: string;
  readonly app_id: string;
  readonly app_name: string;
  readonly author: string;
  readonly rating: number;
  readonly title: string;
  readonly content: string;
  readonly thumbs_up: number;
  readonly version: string;
  readonly first_seen_at: number;
  readonly indexed_at: number | null;
}

interface StatsData {
  readonly total_apps: number;
  readonly total_reviews: number;
  readonly total_categories: number;
  readonly last_updated_at: number | null;
}

type MainTab = "rankings" | "discovered" | "reviews";
type OverallFilter = "all" | "top-free" | "top-paid";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatTime(epoch: number | null): string {
  if (!epoch) return "Never";
  return new Date(epoch * 1000).toLocaleString();
}

function isFree(price: string | null | undefined): boolean {
  if (!price) return true;
  const lower = price.toLowerCase().trim();
  return lower === "0" || lower === "0.00" || lower === "free";
}

function formatInstalls(installs: string): string {
  if (!installs) return "";
  // Normalize "10,000,000+" → "10M+"
  const cleaned = installs.replace(/,/g, "");
  const match = cleaned.match(/^(\d+)(\+?)$/);
  if (!match) return installs;
  const num = parseInt(match[1] ?? "0", 10);
  const plus = match[2] ?? "";
  if (num >= 1_000_000_000) return `${(num / 1_000_000_000).toFixed(1).replace(/\.0$/, "")}B${plus}`;
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1).replace(/\.0$/, "")}M${plus}`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(1).replace(/\.0$/, "")}K${plus}`;
  return `${num}${plus}`;
}

// ─── PlayCard ─────────────────────────────────────────────────────────────────

interface PlayCardProps {
  readonly app: PlayRankingRow;
}

function PlayCard({ app }: PlayCardProps) {
  const free = isFree(app.price);
  const installsLabel = formatInstalls(app.installs);

  return (
    <a
      href={app.store_url}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-start gap-3 p-3 rounded-lg border border-border-2 bg-bg-1 hover:bg-bg-2 hover:border-border-hover transition-colors duration-150 cursor-pointer no-underline group"
    >
      {/* Rank */}
      <span className="font-mono text-sm font-bold text-muted w-6 shrink-0 pt-1 text-right leading-none">
        {app.rank}
      </span>

      {/* Icon */}
      <div className="w-10 h-10 shrink-0 rounded-lg border border-border-2 bg-bg-2 overflow-hidden">
        {app.icon_url ? (
          <img
            src={app.icon_url}
            alt={app.name}
            className="w-full h-full object-cover"
            loading="lazy"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-faint text-xs">
            ?
          </div>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-start gap-2 flex-wrap">
          <span className="font-semibold text-sm text-foreground group-hover:text-accent transition-colors truncate leading-snug">
            {app.name}
          </span>
          <span
            className={cn(
              "shrink-0 text-xs font-medium px-1.5 py-0.5 rounded font-mono leading-none",
              free
                ? "bg-green-500/15 text-green-400"
                : "bg-accent/15 text-accent",
            )}
          >
            {free ? "Free" : app.price}
          </span>
        </div>
        <div className="text-xs text-muted mt-0.5 truncate">{app.developer}</div>

        {/* Rating + Installs row */}
        <div className="flex items-center gap-2 mt-0.5 flex-wrap">
          {app.rating !== null && (
            <span className="text-xs text-yellow-400 font-medium leading-none">
              ★ {app.rating.toFixed(1)}
            </span>
          )}
          {installsLabel && (
            <span className="text-xs text-faint leading-none">{installsLabel}</span>
          )}
        </div>

        {app.category && (
          <span className="inline-block mt-1 text-xs text-faint bg-bg-3 px-2 py-0.5 rounded-full leading-none">
            {app.category}
          </span>
        )}
        {app.description && (
          <p className="text-xs text-muted mt-1 leading-snug line-clamp-2 m-0">
            {app.description}
          </p>
        )}
      </div>
    </a>
  );
}

// ─── GroupedRankings ──────────────────────────────────────────────────────────

interface GroupedRankingsProps {
  readonly rankings: PlayRankingRow[];
}

function GroupedRankings({ rankings }: GroupedRankingsProps) {
  const seen = new Set<string>();
  const groups: Record<string, PlayRankingRow[]> = {};

  for (const app of rankings) {
    if (seen.has(app.id)) continue;
    seen.add(app.id);
    const key = app.category || "Other";
    groups[key] = [...(groups[key] ?? []), app];
  }

  const sortedKeys = Object.keys(groups).sort();

  if (sortedKeys.length === 0) {
    return <EmptyState title="No rankings" description="No rankings data yet." />;
  }

  return (
    <div className="flex flex-col gap-8">
      {sortedKeys.map((category) => {
        const apps = groups[category] ?? [];
        return (
          <section key={category}>
            <h3 className="text-sm font-semibold text-muted uppercase tracking-wider mb-3 m-0">
              {category}
              <span className="ml-2 font-mono text-xs text-faint bg-bg-2 px-2 py-0.5 rounded">
                {apps.length}
              </span>
            </h3>
            <div className="grid gap-2 grid-cols-1 lg:grid-cols-2">
              {apps.map((app) => (
                <PlayCard key={app.id} app={app} />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

// ─── FlatRankings ─────────────────────────────────────────────────────────────

interface FlatRankingsProps {
  readonly rankings: PlayRankingRow[];
}

function FlatRankings({ rankings }: FlatRankingsProps) {
  if (rankings.length === 0) {
    return <EmptyState title="No rankings" description="No apps for this filter." />;
  }
  return (
    <div className="grid gap-2 grid-cols-1 lg:grid-cols-2">
      {rankings.map((app) => (
        <PlayCard key={`${app.id}-${app.list_type}`} app={app} />
      ))}
    </div>
  );
}

// ─── ReviewCard ───────────────────────────────────────────────────────────────

interface ReviewCardProps {
  readonly review: PlayReviewRow;
}

function ReviewCard({ review }: ReviewCardProps) {
  const stars = Array.from({ length: 5 }, (_, i) => i < review.rating);
  return (
    <div className="p-3 rounded-lg border border-border-2 bg-bg-1 flex flex-col gap-1.5">
      <div className="flex items-start justify-between gap-2">
        <span className="font-semibold text-sm text-foreground leading-snug">
          {review.title || "(No title)"}
        </span>
        <span className="flex shrink-0 gap-0.5 mt-0.5">
          {stars.map((filled, i) => (
            <span
              key={i}
              className={cn(
                "text-sm leading-none",
                filled ? "text-yellow-400" : "text-faint",
              )}
            >
              ★
            </span>
          ))}
        </span>
      </div>
      {review.content && (
        <p className="text-xs text-muted leading-snug line-clamp-3 m-0">
          {review.content}
        </p>
      )}
      <div className="flex items-center gap-2 text-xs text-faint flex-wrap">
        <span className="font-medium text-muted">{review.app_name}</span>
        {review.author && <span>· {review.author}</span>}
        {review.version && <span>· v{review.version}</span>}
        {review.thumbs_up > 0 && (
          <span>· 👍 {review.thumbs_up.toLocaleString()}</span>
        )}
        {review.first_seen_at > 0 && (
          <span>· {formatTime(review.first_seen_at)}</span>
        )}
      </div>
    </div>
  );
}

// ─── PlayStore (main) ─────────────────────────────────────────────────────────

const OVERALL_CHIPS = [
  { id: "all", label: "All" },
  { id: "top-free", label: "Top Free" },
  { id: "top-paid", label: "Top Paid" },
] as const;

const MAIN_TABS = [
  { id: "rankings", label: "Top Apps" },
  { id: "discovered", label: "Discovered" },
  { id: "reviews", label: "Reviews" },
] as const;

function IntervalConfigPanel({ scraperId, defaultMinutes }: { readonly scraperId: string; readonly defaultMinutes: number }) {
  const { success, error: toastError } = useToast();
  const [open, setOpen] = useState(false);
  const [interval, setInterval_] = useState(defaultMinutes);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open || loaded) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch<{ data: { intervalMinutes: number } }>(
          `/api/features/scraper-config/${scraperId}`,
        );
        if (!cancelled) { setInterval_(res.data.intervalMinutes); setLoaded(true); }
      } catch {
        if (!cancelled) { setLoaded(true); toastError("Failed to load config."); }
      }
    })();
    return () => { cancelled = true; };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleSave() {
    setSaving(true);
    try {
      await apiFetch(`/api/features/scraper-config/${scraperId}`, {
        method: "PUT",
        body: JSON.stringify({ intervalMinutes: interval }),
      });
      success("Config saved.");
    } catch {
      toastError("Failed to save config.");
    } finally {
      setSaving(false);
    }
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
        <ChevronDown className={`w-3.5 h-3.5 text-muted transition-transform duration-200 ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div className="border-t border-border px-4 py-3 flex flex-col gap-3">
          {!loaded ? (
            <p className="text-xs text-muted">Loading...</p>
          ) : (
            <>
              <div className="flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <div className="text-xs font-medium text-foreground">Scrape interval (min)</div>
                  <div className="text-xs text-muted mt-0.5">How often to scrape</div>
                </div>
                <input
                  type="number"
                  min={10}
                  max={1440}
                  value={interval}
                  onChange={(e) => { const n = parseInt(e.target.value, 10); if (!isNaN(n)) setInterval_(n); }}
                  className="w-20 shrink-0 bg-bg-2 border border-border rounded-md px-2 py-1 text-xs text-foreground text-right focus:outline-none focus:border-accent"
                />
              </div>
              <div className="flex justify-end">
                <Button variant="primary" size="sm" onClick={handleSave} disabled={saving} loading={saving}>Save</Button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default function PlayStore() {
  const [mainTab, setMainTab] = useState<MainTab>("rankings");
  const [overallFilter, setOverallFilter] = useState<OverallFilter>("all");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [rankings, setRankings] = useState<PlayRankingRow[]>([]);
  const [discoveredApps, setDiscoveredApps] = useState<PlayRankingRow[]>([]);
  const [reviews, setReviews] = useState<PlayReviewRow[]>([]);
  const [stats, setStats] = useState<StatsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [scraping, setScraping] = useState(false);

  const fetchAll = useCallback(async () => {
    try {
      const params = new URLSearchParams({ limit: "500" });
      if (overallFilter !== "all") params.set("list_type", overallFilter);
      if (categoryFilter !== "all") params.set("category", categoryFilter);

      const [rankingsRes, discoveredRes, reviewsRes, statsRes] = await Promise.all([
        apiFetch<{ success: boolean; data: PlayRankingRow[] }>(
          `/api/playstore/rankings?${params.toString()}`,
        ),
        apiFetch<{ success: boolean; data: PlayRankingRow[] }>(
          "/api/playstore/discovered?limit=100",
        ),
        apiFetch<{ success: boolean; data: PlayReviewRow[] }>(
          "/api/playstore/reviews?limit=100",
        ),
        apiFetch<{ success: boolean; data: StatsData }>(
          "/api/playstore/stats",
        ),
      ]);
      if (rankingsRes.success) setRankings(rankingsRes.data);
      if (discoveredRes.success) setDiscoveredApps(discoveredRes.data);
      if (reviewsRes.success) setReviews(reviewsRes.data);
      if (statsRes.success) setStats(statsRes.data);
    } catch {
      // silently ignore
    } finally {
      setLoading(false);
    }
  }, [overallFilter, categoryFilter]);

  useEffect(() => {
    setLoading(true);
    fetchAll();
    const interval = setInterval(fetchAll, 30_000);
    return () => clearInterval(interval);
  }, [fetchAll]);

  async function handleScrapeNow() {
    setScraping(true);
    try {
      await apiFetch("/api/playstore/scrape-now", { method: "POST" });
      await fetchAll();
    } catch {
      // ignore
    } finally {
      setScraping(false);
    }
  }

  const availableCategories: string[] = Array.from(
    new Set(rankings.map((r) => r.category).filter(Boolean)),
  ).sort();

  const categoryChips = [
    { id: "all", label: "All" },
    ...availableCategories.map((c) => ({ id: c, label: c })),
  ];

  const tabsWithCounts = MAIN_TABS.map((t) => ({
    ...t,
    count: t.id === "rankings" ? rankings.length : t.id === "discovered" ? discoveredApps.length : reviews.length,
  }));

  if (loading) return <LoadingState message="Loading Play Store data…" />;

  const subtitle = stats
    ? `${stats.total_apps.toLocaleString()} apps · ${stats.total_reviews.toLocaleString()} reviews · ${stats.total_categories ?? 0} categories · Updated ${formatTime(stats.last_updated_at)}`
    : undefined;

  return (
    <div>
      <PageHeader
        title="Play Store"
        subtitle={subtitle}
        actions={
          <Button
            size="sm"
            onClick={handleScrapeNow}
            disabled={scraping}
          >
            {scraping ? "Scraping…" : "Scrape Now"}
          </Button>
        }
      />

      <IntervalConfigPanel scraperId="playstore" defaultMinutes={60} />

      <FilterTabs
        tabs={tabsWithCounts}
        active={mainTab}
        onChange={(id) => setMainTab(id as MainTab)}
      />

      {mainTab === "rankings" && (
        <>
          {/* Type + Category filters */}
          <div className="flex flex-wrap items-center gap-4 mb-4">
            <div className="flex gap-1.5">
              {OVERALL_CHIPS.map((chip) => (
                <button
                  key={chip.id}
                  type="button"
                  onClick={() => {
                    setOverallFilter(chip.id as OverallFilter);
                    setCategoryFilter("all");
                  }}
                  className={cn(
                    "px-3 py-1.5 rounded-lg text-sm font-medium cursor-pointer transition-colors duration-150 border",
                    overallFilter === chip.id
                      ? "bg-accent text-white border-accent font-semibold"
                      : "bg-transparent border-border-2 text-muted hover:bg-bg-2 hover:border-border-hover hover:text-foreground",
                  )}
                >
                  {chip.label}
                </button>
              ))}
            </div>

            {availableCategories.length > 0 && (
              <div className="w-px h-5 bg-border-2 hidden sm:block" />
            )}

            {availableCategories.length > 0 && (
              <div className="flex gap-1.5 flex-wrap">
                {categoryChips.map((chip) => (
                  <button
                    key={chip.id}
                    type="button"
                    onClick={() => setCategoryFilter(chip.id)}
                    className={cn(
                      "px-2.5 py-1 rounded-full text-xs font-medium cursor-pointer transition-colors duration-150 border",
                      categoryFilter === chip.id
                        ? "bg-accent/20 text-accent border-accent/40 font-semibold"
                        : "bg-transparent border-border-2 text-faint hover:bg-bg-2 hover:border-border-hover hover:text-muted",
                    )}
                  >
                    {chip.label}
                  </button>
                ))}
              </div>
            )}
          </div>

          {categoryFilter !== "all" ? (
            <FlatRankings rankings={rankings} />
          ) : (
            <GroupedRankings rankings={rankings} />
          )}
        </>
      )}

      {mainTab === "discovered" && (
        <>
          {discoveredApps.length === 0 ? (
            <EmptyState
              title="No discovered apps"
              description="Discovered apps will appear here after the next scrape cycle."
            />
          ) : (
            <div className="grid gap-2 grid-cols-1 lg:grid-cols-2">
              {discoveredApps.map((app) => (
                <PlayCard key={`${app.id}-${app.list_type}`} app={app} />
              ))}
            </div>
          )}
        </>
      )}

      {mainTab === "reviews" && (
        <>
          {reviews.length === 0 ? (
            <EmptyState
              title="No reviews"
              description="No low-rated reviews collected yet."
            />
          ) : (
            <div className="grid gap-2 grid-cols-1 lg:grid-cols-2">
              {reviews.map((review) => (
                <ReviewCard key={review.id} review={review} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
