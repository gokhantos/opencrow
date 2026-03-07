import React, { useState, useEffect, useCallback } from "react";
import { apiFetch } from "../api";
import {
  PageHeader,
  LoadingState,
  EmptyState,
  FilterTabs,
  Button,
} from "../components";
import { cn } from "../lib/cn";

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

type MainTab = "rankings" | "reviews";
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

function listTypeLabel(listType: string): string {
  if (listType === "top-free") return "Top Free";
  if (listType === "top-paid") return "Top Paid";
  if (listType.startsWith("top-free-")) return "Top Free";
  if (listType.startsWith("top-paid-")) return "Top Paid";
  return listType;
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
  const groups = rankings.reduce<Record<string, PlayRankingRow[]>>((acc, app) => {
    const key = app.list_type;
    return { ...acc, [key]: [...(acc[key] ?? []), app] };
  }, {});

  const sortedKeys = Object.keys(groups).sort();

  if (sortedKeys.length === 0) {
    return <EmptyState title="No rankings" description="No rankings data yet." />;
  }

  return (
    <div className="flex flex-col gap-8">
      {sortedKeys.map((listType) => {
        const apps = groups[listType] ?? [];
        const firstApp = apps[0];
        const groupLabel =
          firstApp?.category
            ? `${listTypeLabel(listType)} — ${firstApp.category}`
            : listTypeLabel(listType);
        return (
          <section key={listType}>
            <h3 className="text-sm font-semibold text-muted uppercase tracking-wider mb-3 m-0">
              {groupLabel}
              <span className="ml-2 font-mono text-xs text-faint bg-bg-2 px-2 py-0.5 rounded">
                {apps.length}
              </span>
            </h3>
            <div className="grid gap-2 grid-cols-1 lg:grid-cols-2">
              {apps.map((app) => (
                <PlayCard key={`${app.id}-${app.list_type}`} app={app} />
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
  { id: "rankings", label: "Rankings" },
  { id: "reviews", label: "Reviews" },
] as const;

export default function PlayStore() {
  const [mainTab, setMainTab] = useState<MainTab>("rankings");
  const [overallFilter, setOverallFilter] = useState<OverallFilter>("all");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [rankings, setRankings] = useState<PlayRankingRow[]>([]);
  const [reviews, setReviews] = useState<PlayReviewRow[]>([]);
  const [stats, setStats] = useState<StatsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [scraping, setScraping] = useState(false);

  const fetchAll = useCallback(async () => {
    try {
      const params = new URLSearchParams({ limit: "100" });
      if (overallFilter !== "all") params.set("list_type", overallFilter);
      if (categoryFilter !== "all") params.set("category", categoryFilter);

      const [rankingsRes, reviewsRes, statsRes] = await Promise.all([
        apiFetch<{ success: boolean; data: PlayRankingRow[] }>(
          `/api/playstore/rankings?${params.toString()}`,
        ),
        apiFetch<{ success: boolean; data: PlayReviewRow[] }>(
          "/api/playstore/reviews?limit=100",
        ),
        apiFetch<{ success: boolean; data: StatsData }>(
          "/api/playstore/stats",
        ),
      ]);
      if (rankingsRes.success) setRankings(rankingsRes.data);
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
    { id: "all", label: "All Categories" },
    ...availableCategories.map((c) => ({ id: c, label: c })),
  ];

  const tabsWithCounts = MAIN_TABS.map((t) => ({
    ...t,
    count: t.id === "rankings" ? rankings.length : reviews.length,
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
            variant="secondary"
            size="sm"
            onClick={handleScrapeNow}
            disabled={scraping}
          >
            {scraping ? "Scraping…" : "Scrape Now"}
          </Button>
        }
      />

      <FilterTabs
        tabs={tabsWithCounts}
        active={mainTab}
        onChange={(id) => setMainTab(id as MainTab)}
      />

      {mainTab === "rankings" && (
        <>
          {/* Overall filter chips */}
          <div className="flex gap-1.5 flex-wrap mb-3">
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

          {/* Category chips — only when a specific list type is selected and data is available */}
          {overallFilter !== "all" && availableCategories.length > 0 && (
            <div className="flex gap-1.5 flex-wrap mb-5">
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

          {overallFilter === "all" ? (
            <GroupedRankings rankings={rankings} />
          ) : (
            <FlatRankings rankings={rankings} />
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
