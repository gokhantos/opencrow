import React, { useState, useEffect, useCallback, useMemo } from "react";
import { apiFetch } from "../api";
import { relativeTime } from "../lib/format";
import { cn } from "../lib/cn";
import { Button, Input } from "../components";

interface GeneratedIdea {
  readonly id: string;
  readonly agent_id: string;
  readonly title: string;
  readonly summary: string;
  readonly reasoning: string;
  readonly sources_used: string;
  readonly category: string;
  readonly rating: string | null;
  readonly feedback: string;
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
type RatingFilter = "all" | "good" | "bad" | "unrated";
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
};

const CATEGORY_STYLES: Record<string, string> = {
  mobile_app: "bg-accent-subtle text-accent border border-accent/20",
  crypto_project: "bg-warning-subtle text-warning border border-warning/20",
  ai_app: "bg-[#7928ca18] text-[#7928ca] border border-[#7928ca33]",
  open_source: "bg-success-subtle text-success border border-success/20",
  general: "bg-bg-3 text-muted border border-border",
};

function computeRatingCounts(ideas: readonly GeneratedIdea[]) {
  let good = 0;
  let bad = 0;
  let unrated = 0;
  for (const idea of ideas) {
    if (idea.rating === "good") good++;
    else if (idea.rating === "bad") bad++;
    else unrated++;
  }
  return { total: ideas.length, good, bad, unrated };
}

function sortIdeas(
  ideas: readonly GeneratedIdea[],
  mode: SortMode,
): readonly GeneratedIdea[] {
  const sorted = [...ideas];
  switch (mode) {
    case "newest":
      return sorted.sort((a, b) => b.created_at - a.created_at);
    case "top_rated":
      return sorted.sort((a, b) => {
        const scoreA = a.rating === "good" ? 2 : a.rating === "bad" ? 0 : 1;
        const scoreB = b.rating === "good" ? 2 : b.rating === "bad" ? 0 : 1;
        return scoreB - scoreA || b.created_at - a.created_at;
      });
    case "lowest_rated":
      return sorted.sort((a, b) => {
        const scoreA = a.rating === "good" ? 2 : a.rating === "bad" ? 0 : 1;
        const scoreB = b.rating === "good" ? 2 : b.rating === "bad" ? 0 : 1;
        return scoreA - scoreB || b.created_at - a.created_at;
      });
    default:
      return sorted;
  }
}

function IdeaCard({
  idea,
  onRate,
}: {
  readonly idea: GeneratedIdea;
  readonly onRate: (
    id: string,
    rating: "good" | "bad",
    feedback?: string,
  ) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [showFeedback, setShowFeedback] = useState(false);
  const [feedbackText, setFeedbackText] = useState(idea.feedback ?? "");
  const agentColor = AGENT_COLORS[idea.agent_id] ?? "var(--text-3)";

  const handleThumbsUp = () => {
    if (idea.rating === "good") return;
    onRate(idea.id, "good");
  };

  const handleThumbsDown = () => {
    setFeedbackText(idea.feedback ?? "");
    setShowFeedback(true);
  };

  const submitFeedback = () => {
    onRate(idea.id, "bad", feedbackText.trim());
    setShowFeedback(false);
    setFeedbackText("");
  };

  const cancelFeedback = () => {
    setShowFeedback(false);
    setFeedbackText("");
  };

  const handleFeedbackKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submitFeedback();
    } else if (e.key === "Escape") {
      cancelFeedback();
    }
  };

  return (
    <div
      className={cn(
        "relative p-[1.25rem_1.5rem] bg-bg-1 rounded-lg border transition-colors hover:bg-bg-2",
        idea.rating === "good" && "border-success hover:border-success",
        idea.rating === "bad" && "border-danger hover:border-danger",
        idea.rating !== "good" &&
          idea.rating !== "bad" &&
          "border-border hover:border-border-2",
      )}
    >
      {idea.rating === "good" && (
        <div className="absolute top-0 left-3 right-3 h-0.5 rounded-b-sm bg-success" />
      )}
      {idea.rating === "bad" && (
        <div className="absolute top-0 left-3 right-3 h-0.5 rounded-b-sm bg-danger" />
      )}

      <div className="flex items-start justify-between gap-3 max-md:flex-col max-md:gap-1">
        <h3 className="font-heading text-[1.05rem] font-semibold text-strong leading-[1.4] m-0">
          {idea.title}
        </h3>
        <div className="flex items-center gap-2 shrink-0 max-md:order-[-1] max-md:self-end">
          <div className="flex gap-1">
            <button
              className={cn(
                "w-8 h-8 rounded-md border bg-bg border-border text-faint text-[0.85rem] cursor-pointer flex items-center justify-center transition-colors p-0 leading-none hover:bg-bg-2",
                idea.rating === "good" &&
                  "bg-success-subtle border-success text-success",
              )}
              onClick={handleThumbsUp}
              title="Good idea"
            >
              &#x1F44D;
            </button>
            <button
              className={cn(
                "w-8 h-8 rounded-md border bg-bg border-border text-faint text-[0.85rem] cursor-pointer flex items-center justify-center transition-colors p-0 leading-none hover:bg-bg-2",
                idea.rating === "bad" &&
                  "bg-danger-subtle border-danger text-danger",
              )}
              onClick={handleThumbsDown}
              title="Bad idea"
            >
              &#x1F44E;
            </button>
          </div>
          <span className="text-sm text-faint whitespace-nowrap shrink-0 font-mono">
            {relativeTime(idea.created_at)}
          </span>
        </div>
      </div>

      <div className="text-base text-muted leading-[1.7] mt-2.5 whitespace-pre-wrap">
        {idea.summary}
      </div>

      {showFeedback && (
        <div className="mt-3 flex flex-col gap-3 p-4 bg-danger-subtle rounded-md border border-danger">
          <Input
            type="text"
            placeholder="Why is this idea bad? (optional)"
            value={feedbackText}
            onChange={(e) => setFeedbackText(e.target.value)}
            onKeyDown={handleFeedbackKeyDown}
            autoFocus
          />
          <div className="flex gap-2">
            <Button variant="danger" size="sm" onClick={submitFeedback}>
              Submit
            </Button>
            <Button variant="secondary" size="sm" onClick={cancelFeedback}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {idea.rating === "bad" && idea.feedback && (
        <div className="mt-3 px-4 py-2.5 border-l-2 border-l-danger bg-danger-subtle rounded-r-md text-sm text-muted italic leading-[1.5]">
          {idea.feedback}
        </div>
      )}

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

function LoadingSkeleton() {
  return (
    <div className="flex flex-col gap-2.5">
      {[1, 2, 3, 4].map((i) => (
        <div
          key={i}
          className="h-[120px] rounded-lg bg-bg-1 animate-pulse border border-border"
        />
      ))}
    </div>
  );
}

export default function Ideas() {
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
      const categoryParam =
        categoryFilter !== "all" ? `&category=${categoryFilter}` : "";

      const [ideasRes, statsRes, stageRes] = await Promise.all([
        apiFetch<{ success: boolean; data: readonly GeneratedIdea[] }>(
          `/api/ideas?limit=100${categoryParam}`,
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
      // ignore fetch errors
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
    async (id: string, rating: "good" | "bad", feedback?: string) => {
      try {
        const res = await apiFetch<{ success: boolean; data: GeneratedIdea }>(
          `/api/ideas/${id}`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ rating, feedback: feedback ?? "" }),
          },
        );
        if (res.success) {
          setIdeas((prev) =>
            prev.map((idea) => (idea.id === id ? res.data : idea)),
          );
        }
      } catch {
        // ignore rating errors
      }
    },
    [],
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
        if (ratingFilter === "good") return idea.rating === "good";
        if (ratingFilter === "bad") return idea.rating === "bad";
        return idea.rating !== "good" && idea.rating !== "bad";
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
    return (
      <div className="max-w-[960px] mx-auto">
        <div className="mb-7">
          <div className="flex items-end justify-between gap-4 mb-5">
            <div>
              <h1 className="m-0 font-heading text-[1.75rem] font-extrabold tracking-tight text-strong leading-[1.2]">
                Ideas
              </h1>
              <p className="mt-1 text-base text-faint">Loading ideas...</p>
            </div>
          </div>
        </div>
        <LoadingSkeleton />
      </div>
    );
  }

  return (
    <div className="max-w-[960px] mx-auto">
      {/* Header */}
      <div className="mb-7">
        <div className="flex items-end justify-between gap-4 mb-5 max-md:flex-col max-md:items-start max-md:gap-3">
          <div>
            <h1 className="m-0 font-heading text-[1.75rem] font-extrabold tracking-tight text-strong leading-[1.2] max-sm:text-[1.4rem]">
              Ideas
            </h1>
            <p className="mt-1 text-base text-faint">
              {totalCount} ideas generated by your agents
            </p>
          </div>
          <div className="flex items-center gap-3 shrink-0 max-md:w-full max-md:justify-between">
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
          </div>
        </div>
      </div>

      {/* Stat Cards */}
      <div className="grid grid-cols-4 gap-3 mb-6 max-md:grid-cols-2 max-sm:grid-cols-2 max-sm:gap-2.5">
        {(
          [
            {
              key: "all" as const,
              label: "Total",
              icon: "\u2731",
              color: "accent",
              value: ratingCounts.total,
            },
            {
              key: "good" as const,
              label: "Good",
              icon: "\u2714",
              color: "green",
              value: ratingCounts.good,
            },
            {
              key: "bad" as const,
              label: "Bad",
              icon: "\u2718",
              color: "red",
              value: ratingCounts.bad,
            },
            {
              key: "unrated" as const,
              label: "Unrated",
              icon: "?",
              color: "gray",
              value: ratingCounts.unrated,
            },
          ] as const
        ).map((stat) => (
          <button
            key={stat.key}
            className={cn(
              "relative bg-bg-1 border border-border rounded-lg p-5 cursor-pointer text-left font-inherit transition-colors overflow-hidden hover:bg-bg-2 hover:border-border-2",
              ratingFilter === stat.key && "bg-bg-2",
              ratingFilter === stat.key &&
                stat.color === "accent" &&
                "border-accent",
              ratingFilter === stat.key &&
                stat.color === "green" &&
                "border-success",
              ratingFilter === stat.key &&
                stat.color === "red" &&
                "border-danger",
              "max-sm:p-4",
            )}
            onClick={() =>
              setRatingFilter(
                ratingFilter === stat.key
                  ? "all"
                  : stat.key === "all"
                    ? "all"
                    : stat.key,
              )
            }
          >
            <div
              className={cn(
                "absolute top-0 left-0 right-0 h-0.5 rounded-t-lg transition-opacity",
                ratingFilter === stat.key ? "opacity-100" : "opacity-0",
                stat.color === "accent" && "bg-accent",
                stat.color === "green" && "bg-success",
                stat.color === "red" && "bg-danger",
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
                  stat.color === "red" && "bg-danger-subtle",
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
                stat.color === "red" && "text-danger",
                stat.color === "gray" && "text-faint",
              )}
            >
              {stat.value}
            </div>
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
        <div className="flex flex-col items-center justify-center py-20 px-6 text-center">
          <div className="w-16 h-16 rounded-xl bg-accent-subtle flex items-center justify-center text-[1.75rem] mb-5">
            {"\u{1F4A1}"}
          </div>
          <div className="font-heading text-[1.1rem] font-semibold text-strong mb-2">
            {searchQuery ? "No matching ideas" : "No ideas yet"}
          </div>
          <div className="text-base text-faint max-w-[360px] leading-[1.6]">
            {searchQuery
              ? `No ideas match "${searchQuery}". Try a different search term.`
              : "Ideas are generated every 6 hours via cron, or you can chat directly with the idea generator bots on Telegram."}
          </div>
        </div>
      ) : (
        <div
          className={cn(
            "flex flex-col gap-3",
            viewMode === "grid" &&
              "grid grid-cols-[repeat(auto-fill,minmax(min(400px,100%),1fr))] gap-3.5 max-md:grid-cols-1",
          )}
        >
          {sortedIdeas.map((idea) => (
            <IdeaCard key={idea.id} idea={idea} onRate={handleRate} />
          ))}
        </div>
      )}
    </div>
  );
}
