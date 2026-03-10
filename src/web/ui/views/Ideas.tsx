import React, { useState, useEffect, useCallback, useMemo } from "react";
import { useLocalStorage } from "../lib/useLocalStorage";
import { ChevronRight, Archive, RotateCcw, Check } from "lucide-react";
import { apiFetch } from "../api";
import { relativeTime } from "../lib/format";
import { cn } from "../lib/cn";
import { PageHeader, LoadingState, EmptyState } from "../components";
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
  readonly quality_score: number | null;
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
type SortMode = "newest" | "oldest" | "score";
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

const AGENT_COLORS: Record<string, string> = {};

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
  return STAGE_ORDER[idx + 1] ?? null;
}

export function sortIdeas(
  ideas: readonly GeneratedIdea[],
  mode: SortMode,
): readonly GeneratedIdea[] {
  const sorted = [...ideas];
  switch (mode) {
    case "newest":
      return sorted.sort((a, b) => b.created_at - a.created_at);
    case "oldest":
      return sorted.sort((a, b) => a.created_at - b.created_at);
    case "score":
      return sorted.sort((a, b) => {
        if (b.quality_score === null && a.quality_score === null) return 0;
        if (b.quality_score === null) return -1;
        if (a.quality_score === null) return 1;
        return b.quality_score - a.quality_score;
      });
    default:
      return sorted;
  }
}

function qualityScoreStyle(score: number): string {
  if (score >= 4.0) return "bg-success-subtle text-success border border-success/20";
  if (score >= 3.0) return "bg-warning-subtle text-warning border border-warning/20";
  return "bg-danger-subtle text-danger border border-danger/20";
}

function IdeaCard({
  idea,
  onStageChange,
}: {
  readonly idea: GeneratedIdea;
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
      className="relative p-[1.25rem_1.5rem] bg-bg-1 rounded-lg border border-border transition-colors hover:bg-bg-2 hover:border-border-2"
    >

      <div className="flex items-start justify-between gap-3 max-md:flex-col max-md:gap-1">
        <h3 className="font-heading text-[1.05rem] font-semibold text-strong leading-[1.4] m-0">
          {idea.title}
        </h3>
        <span className="text-sm text-faint whitespace-nowrap shrink-0 font-mono">
          {relativeTime(idea.created_at)}
        </span>
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
            title="AI models referenced"
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

        {/* Quality score badge */}
        {idea.quality_score !== null && (
          <span
            className={cn(
              "inline-flex items-center px-3 py-1 rounded-full text-xs font-semibold font-mono shrink-0",
              qualityScoreStyle(idea.quality_score),
            )}
            title="Quality score"
          >
            {idea.quality_score.toFixed(1)}/5
          </span>
        )}

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
                className={cn(
                  "inline-flex items-center gap-1 px-2.5 py-1 rounded-full border text-xs font-medium cursor-pointer font-sans transition-colors disabled:opacity-40 disabled:cursor-not-allowed",
                  next === "validated"
                    ? "border-success/30 bg-success-subtle text-success hover:border-success hover:bg-success-subtle"
                    : "border-border bg-transparent text-faint hover:bg-bg-2 hover:text-strong",
                )}
                title={`Move to ${next}`}
              >
                {next === "validated" ? <Check size={11} /> : <ChevronRight size={12} />}
                {next === "validated" ? "Validate" : next}
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
  const [categoryFilter, setCategoryFilter] = useLocalStorage<CategoryFilter>("ideas:categoryFilter", "all");
  const [sortMode, setSortMode] = useLocalStorage<SortMode>("ideas:sortMode", "newest");
  const [viewMode, setViewMode] = useLocalStorage<ViewMode>("ideas:viewMode", "list");
  const [searchQuery, setSearchQuery] = useState("");
  const [stageFilter, setStageFilter] = useLocalStorage<string>("ideas:stageFilter", "all");
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

  const filteredIdeas = useMemo(() => {
    let result = [...ideas];

    if (stageFilter !== "all") {
      result = result.filter(
        (idea) => (idea.pipeline_stage || "idea") === stageFilter,
      );
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
  }, [ideas, stageFilter, searchQuery]);

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
                aria-label="List view"
                aria-pressed={viewMode === "list"}
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
                aria-label="Grid view"
                aria-pressed={viewMode === "grid"}
              >
                &#9638;
              </button>
            </div>
            <select
              aria-label="Sort ideas"
              className="py-2 px-4 rounded-lg border border-border bg-bg-1 text-muted font-sans text-sm cursor-pointer outline-none transition-colors h-[36px] focus:border-accent"
              value={sortMode}
              onChange={(e) => setSortMode(e.target.value as SortMode)}
            >
              <option value="newest">Newest</option>
              <option value="oldest">Oldest</option>
              <option value="score">Top Score</option>
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

      {/* Pipeline Summary Bar */}
      {stageCounts.length > 0 && (() => {
        const ideaCount = stageCounts.find((s) => s.stage === "idea")?.count ?? 0;
        const validatedCount = stageCounts.find((s) => s.stage === "validated")?.count ?? 0;
        const archivedCount = stageCounts.find((s) => s.stage === "archived")?.count ?? 0;
        return (
          <div className="flex items-center gap-2 mb-3 text-sm text-faint font-mono">
            <span className="text-strong font-semibold">{ideaCount}</span>
            <span>ideas</span>
            <ChevronRight size={13} className="text-border-2" />
            <span className="text-success font-semibold">{validatedCount}</span>
            <span>validated</span>
            <ChevronRight size={13} className="text-border-2" />
            <span className="text-danger font-semibold">{archivedCount}</span>
            <span>archived</span>
          </div>
        );
      })()}

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
              const alwaysShow = ["idea", "validated", "archived"].includes(stage);
              if (count === 0 && !alwaysShow) return null;
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
      {searchQuery && (
        <div className="flex items-center justify-between mb-3 px-0.5">
          <span className="text-sm text-faint">
            Showing{" "}
            <strong className="text-muted font-semibold">
              {sortedIdeas.length}
            </strong>{" "}
            of {totalCount} ideas
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
              : "Ideas are generated 3× daily via cron, or you can chat directly with the idea generator bots on Telegram."
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
            <IdeaCard key={idea.id} idea={idea} onStageChange={handleStageChange} />
          ))}
        </div>
      )}
    </div>
  );
}
