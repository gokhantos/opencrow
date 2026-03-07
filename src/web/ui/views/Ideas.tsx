import React, { useState, useEffect, useCallback, useMemo } from "react";
import { ChevronRight, Archive, RotateCcw } from "lucide-react";
import { apiFetch } from "../api";
import { relativeTime } from "../lib/format";
import { cn } from "../lib/cn";
import { Button, PageHeader, LoadingState, EmptyState } from "../components";
import { useToast } from "../components/Toast";

interface GeneratedIdea {
  readonly id: string;
  readonly agent_id: string;
  readonly title: string;
  readonly summary: string;
  readonly reasoning: string;
  readonly sources_used: string;
  readonly category: string;
  readonly rating: number | null;
  readonly pipeline_stage: string;
  readonly model_references: string;
  readonly created_at: number;
}

interface StageCounts {
  readonly stage: string;
  readonly count: number;
}

interface IdeaStat {
  readonly agent_id: string;
  readonly category: string;
  readonly count: number;
}

type CategoryFilter =
  | "all"
  | "mobile_app"
  | "crypto_project"
  | "ai_app"
  | "open_source"
  | "general";
type SortMode = "newest" | "top_rated" | "lowest_rated";
type RatingFilter = "all" | "high" | "mid" | "low" | "unrated";
type ViewMode = "list" | "grid";

const CATEGORY_TABS: readonly {
  readonly id: CategoryFilter;
  readonly label: string;
}[] = [
  { id: "all", label: "All" },
  { id: "mobile_app", label: "Mobile App" },
  { id: "crypto_project", label: "Crypto" },
  { id: "ai_app", label: "AI App" },
  { id: "open_source", label: "Open Source" },
  { id: "general", label: "General" },
];

const AGENT_COLORS: Record<string, string> = {
  "mobile-idea-gen": "#0070f3",
  "crypto-idea-gen": "#f5a623",
  "ai-idea-gen": "#7928ca",
  "oss-idea-gen": "#22c55e",
  "idea-validator": "#ef4444",
};

const CATEGORY_STYLES: Record<string, string> = {
  mobile_app: "bg-accent-subtle text-accent border border-accent/20",
  crypto_project: "bg-warning-subtle text-warning border border-warning/20",
  ai_app: "bg-[#7928ca18] text-[#7928ca] border border-[#7928ca33]",
  open_source: "bg-success-subtle text-success border border-success/20",
  general: "bg-bg-3 text-muted border border-border",
};

const STAGE_ORDER = ["signal", "synthesis", "idea", "validated", "archived"] as const;
type PipelineStage = (typeof STAGE_ORDER)[number];

const STAGE_STYLES: Record<PipelineStage, string> = {
  signal: "bg-warning-subtle text-warning border border-warning/20",
  synthesis: "bg-accent-subtle text-accent border border-accent/20",
  idea: "bg-bg-3 text-muted border border-border",
  validated: "bg-success-subtle text-success border border-success/20",
  archived: "bg-danger-subtle text-danger border border-danger/20",
};

function nextStage(current: string): PipelineStage | null {
  const idx = STAGE_ORDER.indexOf(current as PipelineStage);
  if (idx < 0 || idx >= STAGE_ORDER.indexOf("archived")) return null;
  return STAGE_ORDER[idx + 1];
}

export function computeRatingCounts(ideas: readonly GeneratedIdea[]) {
  let rated = 0;
  let unrated = 0;
  let sum = 0;
  for (const idea of ideas) {
    if (idea.rating != null) {
      rated++;
      sum += idea.rating;
    } else {
      unrated++;
    }
  }
  return {
    total: ideas.length,
    rated,
    unrated,
    average: rated > 0 ? sum / rated : null,
  };
}

export function sortIdeas(
  ideas: readonly GeneratedIdea[],
  mode: SortMode,
): readonly GeneratedIdea[] {
  const sorted = [...ideas];
  switch (mode) {
    case "newest":
      return sorted.sort((a, b) => b.created_at - a.created_at);
    case "top_rated":
      return sorted.sort((a, b) => {
        const scoreA = a.rating ?? -1;
        const scoreB = b.rating ?? -1;
        return scoreB - scoreA || b.created_at - a.created_at;
      });
    case "lowest_rated":
      return sorted.sort((a, b) => {
        const scoreA = a.rating ?? 6;
        const scoreB = b.rating ?? 6;
        return scoreA - scoreB || b.created_at - a.created_at;
      });
    default:
      return sorted;
  }
}

function StarRating({
  value,
  onChange,
}: {
  readonly value: number | null;
  readonly onChange: (rating: number | null) => void;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const display = hover ?? value ?? 0;

  return (
    <div
      className="flex gap-0.5"
      onMouseLeave={() => setHover(null)}
    >
      {[1, 2, 3, 4, 5].map((star) => (
        <button
          key={star}
          className={cn(
            "w-7 h-7 rounded-md border-none bg-transparent text-[1.1rem] cursor-pointer flex items-center justify-center transition-colors p-0 leading-none",
            star <= display ? "text-warning" : "text-faint opacity-40",
            hover != null && star <= hover && "text-warning opacity-100",
          )}
          onClick={() => onChange(value === star ? null : star)}
          onMouseEnter={() => setHover(star)}
          title={value === star ? "Clear rating" : `Rate ${star}/5`}
        >
          &#9733;
        </button>
      ))}
    </div>
  );
}

function ratingBorderClass(rating: number | null): string {
  if (rating == null) return "border-border hover:border-border-2";
  if (rating >= 4) return "border-success hover:border-success";
  if (rating >= 2) return "border-warning hover:border-warning";
  return "border-danger hover:border-danger";
}

function ratingBarColor(rating: number | null): string {
  if (rating == null) return "";
  if (rating >= 4) return "bg-success";
  if (rating >= 2) return "bg-warning";
  return "bg-danger";
}

function IdeaCard({
  idea,
  onRate,
  onStageChange,
}: {
  readonly idea: GeneratedIdea;
  readonly onRate: (id: string, rating: number | null) => void;
  readonly onStageChange: (id: string, stage: string) => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [stagePending, setStagePending] = useState(false);
  const agentColor = AGENT_COLORS[idea.agent_id] ?? "var(--text-3)";

  const currentStage = (idea.pipeline_stage || "idea") as PipelineStage;
  const next = nextStage(currentStage);
  const isArchived = currentStage === "archived";

  async function handleAdvance() {
    if (!next || stagePending) return;
    setStagePending(true);
    await onStageChange(idea.id, next);
    setStagePending(false);
  }

  async function handleArchive() {
    if (stagePending) return;
    setStagePending(true);
    await onStageChange(idea.id, "archived");
    setStagePending(false);
  }

  async function handleRestore() {
    if (stagePending) return;
    setStagePending(true);
    await onStageChange(idea.id, "idea");
    setStagePending(false);
  }

  return (
    <div
      className={cn(
        "relative p-[1.25rem_1.5rem] bg-bg-1 rounded-lg border transition-colors hover:bg-bg-2",
        ratingBorderClass(idea.rating),
      )}
    >
      {idea.rating != null && (
        <div className={cn("absolute top-0 left-3 right-3 h-0.5 rounded-b-sm", ratingBarColor(idea.rating))} />
      )}

      <div className="flex items-start justify-between gap-3 max-md:flex-col max-md:gap-1">
        <h3 className="font-heading text-[1.05rem] font-semibold text-strong leading-[1.4] m-0">
          {idea.title}
        </h3>
        <div className="flex items-center gap-2 shrink-0 max-md:order-[-1] max-md:self-end">
          <StarRating
            value={idea.rating}
            onChange={(r) => onRate(idea.id, r)}
          />
          <span className="text-sm text-faint whitespace-nowrap shrink-0 font-mono">
            {relativeTime(idea.created_at)}
          </span>
        </div>
      </div>

      <div className="text-base text-muted leading-[1.7] mt-2.5 whitespace-pre-wrap">
        {idea.summary}
      </div>

      <div className="flex items-center gap-3 mt-4 flex-wrap">
        <span
          className={cn(
            "inline-flex items-center gap-[5px] px-3 py-1 rounded-full text-sm font-semibold capitalize shrink-0",
            CATEGORY_STYLES[idea.category] ?? "bg-bg-3 text-muted",
          )}
        >
          {idea.category.replace("_", " ")}
        </span>
        <span
          className="inline-flex items-center px-3 py-1 rounded-full font-mono text-xs font-medium tracking-wide shrink-0"
          style={{
            background: `${agentColor}18`,
            color: agentColor,
            border: `1px solid ${agentColor}30`,
          }}
        >
          {idea.agent_id}
        </span>
        {idea.sources_used && (
          <span className="inline-flex items-center gap-1 text-sm text-faint italic">
            {idea.sources_used}
          </span>
        )}
        {idea.model_references && (
          <span
            className="inline-flex items-center gap-1 text-sm italic bg-accent-subtle text-accent px-2 py-0.5 rounded"
            title="HuggingFace models referenced"
          >
            {idea.model_references}
          </span>
        )}
        <button
          className="inline-flex items-center gap-[5px] px-3 py-1 border border-border rounded-full bg-accent-subtle text-accent text-sm font-medium cursor-pointer font-sans transition-colors hover:border-accent"
          onClick={() => setExpanded((prev) => !prev)}
        >
          <span
            className={cn(
              "text-[0.55rem] transition-transform duration-300 inline-block",
              expanded && "rotate-90",
            )}
          >
            &#9654;
          </span>
          {expanded ? "Hide reasoning" : "Reasoning"}
        </button>

        {/* Stage badge */}
        <span
          className={cn(
            "inline-flex items-center px-3 py-1 rounded-full text-xs font-semibold capitalize ml-auto shrink-0",
            STAGE_STYLES[currentStage] ?? "bg-bg-3 text-muted border border-border",
          )}
        >
          {currentStage}
        </span>

        {/* Stage action buttons */}
        {isArchived ? (
          <button
            disabled={stagePending}
            onClick={handleRestore}
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full border border-border bg-transparent text-faint text-xs font-medium cursor-pointer font-sans transition-colors hover:bg-bg-2 hover:text-strong disabled:opacity-40 disabled:cursor-not-allowed"
            title="Restore to idea stage"
          >
            <RotateCcw size={11} />
            Restore
          </button>
        ) : (
          <>
            {next && next !== "archived" && (
              <button
                disabled={stagePending}
                onClick={handleAdvance}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full border border-border bg-transparent text-faint text-xs font-medium cursor-pointer font-sans transition-colors hover:bg-bg-2 hover:text-strong disabled:opacity-40 disabled:cursor-not-allowed"
                title={`Move to ${next}`}
              >
                <ChevronRight size={12} />
                {next}
              </button>
            )}
            <button
              disabled={stagePending}
              onClick={handleArchive}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full border border-border bg-transparent text-faint text-xs font-medium cursor-pointer font-sans transition-colors hover:bg-danger-subtle hover:text-danger hover:border-danger/30 disabled:opacity-40 disabled:cursor-not-allowed"
              title="Archive this idea"
            >
              <Archive size={11} />
            </button>
          </>
        )}
      </div>

      <div
        className={cn(
          "overflow-hidden transition-all duration-500",
          expanded ? "max-h-[800px] opacity-100" : "max-h-0 opacity-0",
        )}
      >
        <div className="mt-4 px-5 py-4 bg-accent-subtle border-l-2 border-l-accent rounded-r-md text-sm text-muted leading-[1.7] whitespace-pre-wrap">
          {idea.reasoning}
        </div>
      </div>
    </div>
  );
}


export default function Ideas() {
  const toast = useToast();
  const [ideas, setIdeas] = useState<readonly GeneratedIdea[]>([]);
  const [stats, setStats] = useState<readonly IdeaStat[]>([]);
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>("all");
  const [sortMode, setSortMode] = useState<SortMode>("newest");
  const [ratingFilter, setRatingFilter] = useState<RatingFilter>("all");
  const [viewMode, setViewMode] = useState<ViewMode>("list");
  const [searchQuery, setSearchQuery] = useState("");
  const [stageFilter, setStageFilter] = useState<string>("all");
  const [stageCounts, setStageCounts] = useState<readonly StageCounts[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    try {
      const query =
        categoryFilter !== "all" ? `?category=${categoryFilter}` : "";

      const [ideasRes, statsRes, stageRes] = await Promise.all([
        apiFetch<{ success: boolean; data: readonly GeneratedIdea[] }>(
          `/api/ideas${query}`,
        ),
        apiFetch<{ success: boolean; data: readonly IdeaStat[] }>(
          "/api/ideas/stats",
        ),
        apiFetch<{ success: boolean; data: readonly StageCounts[] }>(
          "/api/ideas/stage-counts",
        ),
      ]);

      if (ideasRes.success) setIdeas(ideasRes.data);
      if (statsRes.success) setStats(statsRes.data);
      if (stageRes.success) setStageCounts(stageRes.data);
    } catch {
      toast.error("Failed to load ideas");
    } finally {
      setLoading(false);
    }
  }, [categoryFilter]);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 30_000);
    return () => clearInterval(interval);
  }, [fetchData]);

  const handleRate = useCallback(
    async (id: string, rating: number | null) => {
      try {
        const res = await apiFetch<{ success: boolean; data: GeneratedIdea }>(
          `/api/ideas/${id}`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ rating }),
          },
        );
        if (res.success) {
          setIdeas((prev) =>
            prev.map((idea) => (idea.id === id ? res.data : idea)),
          );
        }
      } catch {
        toast.error("Failed to save rating");
      }
    },
    [],
  );

  const handleStageChange = useCallback(
    async (id: string, stage: string) => {
      try {
        const res = await apiFetch<{ success: boolean; data: GeneratedIdea }>(
          `/api/ideas/${id}/stage`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ stage }),
          },
        );
        if (res.success) {
          setIdeas((prev) =>
            prev.map((idea) => (idea.id === id ? res.data : idea)),
          );
          setStageCounts((prev) => {
            const oldStage = ideas.find((i) => i.id === id)?.pipeline_stage ?? "idea";
            return prev.map((s) => {
              if (s.stage === oldStage) return { ...s, count: Math.max(0, s.count - 1) };
              if (s.stage === stage) return { ...s, count: s.count + 1 };
              return s;
            });
          });
        }
      } catch {
        toast.error("Failed to update stage");
      }
    },
    [ideas],
  );

  const ratingCounts = useMemo(() => computeRatingCounts(ideas), [ideas]);

  const filteredIdeas = useMemo(() => {
    let result = [...ideas];

    if (stageFilter !== "all") {
      result = result.filter(
        (idea) => (idea.pipeline_stage || "idea") === stageFilter,
      );
    }

    if (ratingFilter !== "all") {
      result = result.filter((idea) => {
        if (ratingFilter === "high") return idea.rating != null && idea.rating >= 4;
        if (ratingFilter === "mid") return idea.rating != null && idea.rating >= 2 && idea.rating <= 3;
        if (ratingFilter === "low") return idea.rating != null && idea.rating <= 1;
        return idea.rating == null;
      });
    }

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter(
        (idea) =>
          idea.title.toLowerCase().includes(q) ||
          idea.summary.toLowerCase().includes(q),
      );
    }

    return result;
  }, [ideas, stageFilter, ratingFilter, searchQuery]);

  const sortedIdeas = useMemo(
    () => sortIdeas(filteredIdeas, sortMode),
    [filteredIdeas, sortMode],
  );

  const totalCount = stats.reduce((sum, s) => sum + s.count, 0);

  const categoryCounts = useMemo(() => {
    const counts: Record<string, number> = { all: totalCount };
    for (const s of stats) {
      counts[s.category] = (counts[s.category] ?? 0) + s.count;
    }
    return counts;
  }, [stats, totalCount]);

  if (loading) {
    return <LoadingState message="Loading ideas..." />;
  }

  return (
    <div>
      <PageHeader
        title="Ideas"
        count={totalCount}
        subtitle={`${totalCount} ideas generated by your agents`}
        actions={
          <div className="flex items-center gap-3">
            <div className="flex bg-bg-1 border border-border rounded-md overflow-hidden">
              <button
                className={cn(
                  "w-[34px] h-8 flex items-center justify-center border-none bg-transparent text-faint cursor-pointer text-[0.85rem] transition-colors p-0",
                  viewMode === "list" && "bg-accent-subtle text-accent",
                )}
                onClick={() => setViewMode("list")}
                title="List view"
              >
                &#9776;
              </button>
              <button
                className={cn(
                  "w-[34px] h-8 flex items-center justify-center border-none bg-transparent text-faint cursor-pointer text-[0.85rem] transition-colors p-0",
                  viewMode === "grid" && "bg-accent-subtle text-accent",
                )}
                onClick={() => setViewMode("grid")}
                title="Grid view"
              >
                &#9638;
              </button>
            </div>
            <select
              className="py-2 px-4 rounded-lg border border-border bg-bg-1 text-muted font-sans text-sm cursor-pointer outline-none transition-colors h-[36px] focus:border-accent"
              value={sortMode}
              onChange={(e) => setSortMode(e.target.value as SortMode)}
            >
              <option value="newest">Newest</option>
              <option value="top_rated">Top Rated</option>
              <option value="lowest_rated">Lowest Rated</option>
            </select>
            <div className="flex bg-bg-1 border border-border rounded-md overflow-hidden">
              <button
                className="h-8 px-3 flex items-center justify-center border-none bg-transparent text-faint cursor-pointer text-xs font-medium transition-colors hover:text-accent hover:bg-accent-subtle"
                onClick={() => {
                  const query = categoryFilter !== "all" ? `&category=${categoryFilter}` : "";
                  window.open(`/api/ideas/export?format=csv${query}`, "_blank");
                }}
                title="Export as CSV"
              >
                CSV
              </button>
              <button
                className="h-8 px-3 flex items-center justify-center border-l border-border bg-transparent text-faint cursor-pointer text-xs font-medium transition-colors hover:text-accent hover:bg-accent-subtle"
                onClick={() => {
                  const query = categoryFilter !== "all" ? `&category=${categoryFilter}` : "";
                  window.open(`/api/ideas/export?format=json${query}`, "_blank");
                }}
                title="Export as JSON"
              >
                JSON
              </button>
            </div>
          </div>
        }
      />

      {/* Stat Cards */}
      <div className="grid grid-cols-4 gap-3 mb-6 max-md:grid-cols-2 max-sm:grid-cols-2 max-sm:gap-2.5">
        {(
          [
            {
              key: "all" as const,
              label: "Total",
              icon: "\u2731",
              color: "accent",
              value: String(ratingCounts.total),
            },
            {
              key: "avg" as const,
              label: "Average",
              icon: "\u2605",
              color: "yellow",
              value: ratingCounts.average != null ? ratingCounts.average.toFixed(1) : "\u2014",
            },
            {
              key: "rated" as const,
              label: "Rated",
              icon: "\u2714",
              color: "green",
              value: String(ratingCounts.rated),
            },
            {
              key: "unrated" as const,
              label: "Unrated",
              icon: "?",
              color: "gray",
              value: String(ratingCounts.unrated),
            },
          ] as const
        ).map((stat) => (
          <button
            key={stat.key}
            className={cn(
              "relative bg-bg-1 border border-border rounded-lg p-5 cursor-pointer text-left font-inherit transition-colors overflow-hidden hover:bg-bg-2 hover:border-border-2",
              stat.key === "unrated" && ratingFilter === "unrated" && "bg-bg-2 border-faint",
              stat.key === "all" && ratingFilter === "all" && "bg-bg-2 border-accent",
              "max-sm:p-4",
            )}
            onClick={() => {
              if (stat.key === "all") setRatingFilter("all");
              else if (stat.key === "unrated") setRatingFilter(ratingFilter === "unrated" ? "all" : "unrated");
            }}
          >
            <div
              className={cn(
                "absolute top-0 left-0 right-0 h-0.5 rounded-t-lg transition-opacity",
                (stat.key === "all" && ratingFilter === "all") || (stat.key === "unrated" && ratingFilter === "unrated")
                  ? "opacity-100"
                  : "opacity-0",
                stat.color === "accent" && "bg-accent",
                stat.color === "green" && "bg-success",
                stat.color === "yellow" && "bg-warning",
                stat.color === "gray" && "bg-faint",
              )}
            />
            <div className="flex items-center justify-between">
              <div className="text-xs font-medium uppercase tracking-wide text-faint">
                {stat.label}
              </div>
              <div
                className={cn(
                  "w-8 h-8 rounded-md flex items-center justify-center text-sm shrink-0",
                  stat.color === "accent" && "bg-accent-subtle",
                  stat.color === "green" && "bg-success-subtle",
                  stat.color === "yellow" && "bg-warning-subtle",
                  stat.color === "gray" && "bg-bg-3",
                )}
              >
                {stat.icon}
              </div>
            </div>
            <div
              className={cn(
                "font-heading text-[1.75rem] font-bold leading-none tracking-tight mt-2 max-sm:text-[1.35rem]",
                stat.color === "accent" && "text-accent",
                stat.color === "green" && "text-success",
                stat.color === "yellow" && "text-warning",
                stat.color === "gray" && "text-faint",
              )}
            >
              {stat.value}
            </div>
          </button>
        ))}
      </div>

      {/* Rating Filter Pills */}
      <div className="flex gap-1.5 flex-wrap mb-3">
        {(
          [
            { key: "all" as const, label: "All Ratings" },
            { key: "high" as const, label: "4-5 Stars" },
            { key: "mid" as const, label: "2-3 Stars" },
            { key: "low" as const, label: "0-1 Stars" },
            { key: "unrated" as const, label: "Unrated" },
          ] as const
        ).map((f) => (
          <button
            key={f.key}
            className={cn(
              "px-3 py-1.5 rounded-full bg-bg-1 border border-border text-faint font-sans text-xs font-medium cursor-pointer transition-colors hover:bg-bg-2 hover:text-strong",
              ratingFilter === f.key &&
                "bg-accent-subtle border-accent text-accent font-semibold",
            )}
            onClick={() => setRatingFilter(f.key)}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* Pipeline Funnel */}
      {stageCounts.length > 0 && (
        <div className="flex gap-1.5 flex-wrap mb-5 p-2 bg-bg border border-border rounded-md">
          <button
            className={cn(
              "px-4 py-[7px] rounded-md bg-transparent border border-transparent text-faint font-sans text-sm font-medium cursor-pointer capitalize transition-colors hover:bg-bg-2 hover:text-strong",
              stageFilter === "all" &&
                "bg-accent-subtle border-accent text-accent font-semibold",
            )}
            onClick={() => setStageFilter("all")}
          >
            All
          </button>
          {["signal", "synthesis", "idea", "validated", "archived"].map(
            (stage) => {
              const count =
                stageCounts.find((s) => s.stage === stage)?.count ?? 0;
              if (count === 0 && stage !== "idea") return null;
              return (
                <button
                  key={stage}
                  className={cn(
                    "px-4 py-[7px] rounded-md bg-transparent border border-transparent text-faint font-sans text-sm font-medium cursor-pointer capitalize transition-colors hover:bg-bg-2 hover:text-strong",
                    stageFilter === stage &&
                      "bg-accent-subtle border-accent text-accent font-semibold",
                  )}
                  onClick={() =>
                    setStageFilter(stageFilter === stage ? "all" : stage)
                  }
                >
                  {stage}{" "}
                  <span
                    className={cn(
                      "inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 ml-1 rounded-full bg-bg-3 font-mono text-xs font-semibold",
                      stageFilter === stage && "bg-accent-subtle text-accent",
                    )}
                  >
                    {count}
                  </span>
                </button>
              );
            },
          )}
        </div>
      )}

      {/* Search Bar */}
      <div className="relative mb-5">
        <input
          type="text"
          className="w-full py-3 px-4 pl-[40px] rounded-lg border border-border bg-bg-1 text-strong font-sans text-sm outline-none transition-colors focus:border-accent focus:bg-bg-2 placeholder:text-faint"
          placeholder="Search ideas by title or summary..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
        <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-[0.85rem] text-faint pointer-events-none">
          {"\u{1F50D}"}
        </span>
        {searchQuery && (
          <button
            className="absolute right-2.5 top-1/2 -translate-y-1/2 w-[22px] h-[22px] rounded-full border-none bg-bg-3 text-faint text-xs cursor-pointer flex items-center justify-center transition-colors p-0 hover:bg-bg-2 hover:text-strong"
            onClick={() => setSearchQuery("")}
            title="Clear search"
          >
            &#x2715;
          </button>
        )}
      </div>

      {/* Category Filter Tabs */}
      <div className="flex gap-2 flex-wrap mb-6 max-sm:overflow-x-auto max-sm:flex-nowrap max-sm:scrollbar-none">
        {CATEGORY_TABS.map((t) => (
          <button
            key={t.id}
            className={cn(
              "px-5 py-2 rounded-full bg-bg-1 border border-border text-muted font-sans text-sm font-medium cursor-pointer transition-colors hover:bg-bg-2 hover:border-border-2 hover:text-strong max-sm:whitespace-nowrap max-sm:shrink-0",
              categoryFilter === t.id &&
                "bg-accent-subtle border-accent text-accent font-semibold",
            )}
            onClick={() => setCategoryFilter(t.id)}
          >
            {t.label}
            <span
              className={cn(
                "inline-flex items-center justify-center min-w-[22px] h-[20px] px-1.5 ml-1.5 rounded-full bg-bg-3 font-mono text-xs font-semibold text-faint",
                categoryFilter === t.id && "bg-accent-subtle text-accent",
              )}
            >
              {categoryCounts[t.id] ?? 0}
            </span>
          </button>
        ))}
      </div>

      {/* Results Bar */}
      {(searchQuery || ratingFilter !== "all") && (
        <div className="flex items-center justify-between mb-3 px-0.5">
          <span className="text-sm text-faint">
            Showing{" "}
            <strong className="text-muted font-semibold">
              {sortedIdeas.length}
            </strong>{" "}
            of {ratingCounts.total} ideas
            {searchQuery && <> matching &ldquo;{searchQuery}&rdquo;</>}
          </span>
        </div>
      )}

      {/* Idea Cards */}
      {sortedIdeas.length === 0 ? (
        <EmptyState
          icon={"\u{1F4A1}"}
          title={searchQuery ? "No matching ideas" : "No ideas yet"}
          description={
            searchQuery
              ? `No ideas match "${searchQuery}". Try a different search term.`
              : "Ideas are generated every 6 hours via cron, or you can chat directly with the idea generator bots on Telegram."
          }
        />
      ) : (
        <div
          className={cn(
            "flex flex-col gap-3",
            viewMode === "grid" &&
              "grid grid-cols-[repeat(auto-fill,minmax(min(400px,100%),1fr))] gap-3.5 max-md:grid-cols-1",
          )}
        >
          {sortedIdeas.map((idea) => (
            <IdeaCard key={idea.id} idea={idea} onRate={handleRate} onStageChange={handleStageChange} />
          ))}
        </div>
      )}
    </div>
  );
}
