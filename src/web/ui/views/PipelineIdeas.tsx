import { useState, useEffect, useCallback, useMemo } from "react";
import {
  ChevronRight,
  Archive,
  RotateCcw,
  Check,
  Search,
  X,
} from "lucide-react";
import { apiFetch } from "../api";
import { relativeTime } from "../lib/format";
import { cn } from "../lib/cn";
import { PageHeader, LoadingState, EmptyState } from "../components";
import { useToast } from "../components/Toast";
import { useLocalStorage } from "../lib/useLocalStorage";

// ── Types ──────────────────────────────────────────────────────────────

interface PipelineIdea {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly reasoning: string;
  readonly category: string;
  readonly quality_score: number | null;
  readonly sources_used: string;
  readonly pipeline_stage: string;
  readonly pipeline_run_id: string;
  readonly pipeline_name: string;
  readonly created_at: number;
}

interface PipelineRunOption {
  readonly id: string;
  readonly pipeline_id: string;
  readonly created_at: number;
  readonly idea_count: number;
}

type StageFilter = "all" | "idea" | "validated" | "archived";
type CategoryFilter = "all" | "mobile_app" | "crypto_project" | "ai_app" | "open_source" | "general";
type SortMode = "newest" | "oldest" | "score";

// ── Constants ───────────────────────────────────────────────────────────

const STAGE_STYLES: Record<string, string> = {
  idea: "bg-bg-3 text-muted border border-border",
  validated: "bg-success-subtle text-success border border-success/20",
  archived: "bg-danger-subtle text-danger border border-danger/20",
};

const CATEGORY_STYLES: Record<string, string> = {
  mobile_app: "bg-accent-subtle text-accent border border-accent/20",
  crypto_project: "bg-warning-subtle text-warning border border-warning/20",
  ai_app: "bg-[#7928ca18] text-[#7928ca] border border-[#7928ca33]",
  open_source: "bg-success-subtle text-success border border-success/20",
  general: "bg-bg-3 text-muted border border-border",
};

const CATEGORY_OPTIONS: readonly { readonly id: CategoryFilter; readonly label: string }[] = [
  { id: "all", label: "All Categories" },
  { id: "mobile_app", label: "Mobile App" },
  { id: "crypto_project", label: "Crypto" },
  { id: "ai_app", label: "AI App" },
  { id: "open_source", label: "Open Source" },
  { id: "general", label: "General" },
];

function qualityBadgeStyle(score: number): string {
  if (score >= 4.0) return "bg-success-subtle text-success border border-success/20";
  if (score >= 3.0) return "bg-warning-subtle text-warning border border-warning/20";
  return "bg-danger-subtle text-danger border border-danger/20";
}

// ── Reasoning renderer (markdown-lite: headers, links, bold) ───────────

function ReasoningContent({ text }: { readonly text: string }) {
  const lines = text.split("\n");

  return (
    <div className="space-y-2">
      {lines.map((line, i) => {
        const trimmed = line.trim();
        if (!trimmed) return <div key={i} className="h-2" />;

        // ## Headers
        if (trimmed.startsWith("## ")) {
          return (
            <h4
              key={i}
              className="text-xs font-bold text-strong uppercase tracking-wider mt-3 mb-1"
            >
              {trimmed.slice(3)}
            </h4>
          );
        }

        // Render inline markdown (links + bold)
        return (
          <p key={i} className="text-sm text-muted leading-relaxed">
            <InlineMarkdown text={trimmed} />
          </p>
        );
      })}
    </div>
  );
}

function InlineMarkdown({ text }: { readonly text: string }) {
  // Parse markdown links [title](url) and **bold**
  const parts: Array<{ type: "text" | "link" | "bold"; value: string; url?: string }> = [];
  let remaining = text;

  while (remaining.length > 0) {
    // Check for markdown link: [title](url)
    const linkMatch = remaining.match(/^(.*?)\[([^\]]+)\]\(([^)]+)\)/);
    // Check for bold: **text**
    const boldMatch = remaining.match(/^(.*?)\*\*([^*]+)\*\*/);

    const linkIdx = linkMatch ? (linkMatch[1]?.length ?? Infinity) : Infinity;
    const boldIdx = boldMatch ? (boldMatch[1]?.length ?? Infinity) : Infinity;

    if (linkIdx === Infinity && boldIdx === Infinity) {
      parts.push({ type: "text", value: remaining });
      break;
    }

    if (linkIdx <= boldIdx && linkMatch) {
      if (linkMatch[1]) parts.push({ type: "text", value: linkMatch[1] });
      parts.push({ type: "link", value: linkMatch[2]!, url: linkMatch[3]! });
      remaining = remaining.slice(linkMatch[0]!.length);
    } else if (boldMatch) {
      if (boldMatch[1]) parts.push({ type: "text", value: boldMatch[1] });
      parts.push({ type: "bold", value: boldMatch[2]! });
      remaining = remaining.slice(boldMatch[0]!.length);
    }
  }

  return (
    <>
      {parts.map((part, i) => {
        if (part.type === "link") {
          return (
            <a
              key={i}
              href={part.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent underline underline-offset-2 decoration-accent/40 hover:decoration-accent transition-colors"
            >
              {part.value}
            </a>
          );
        }
        if (part.type === "bold") {
          return (
            <strong key={i} className="text-strong font-semibold">
              {part.value}
            </strong>
          );
        }
        return <span key={i}>{part.value}</span>;
      })}
    </>
  );
}

// ── Idea Card ──────────────────────────────────────────────────────────

function IdeaCard({
  idea,
  onStageChange,
}: {
  readonly idea: PipelineIdea;
  readonly onStageChange: (id: string, stage: string) => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [pending, setPending] = useState(false);

  const stage = idea.pipeline_stage || "idea";
  const isArchived = stage === "archived";
  const isValidated = stage === "validated";

  async function handleAction(newStage: string) {
    if (pending) return;
    setPending(true);
    await onStageChange(idea.id, newStage);
    setPending(false);
  }

  return (
    <div
      className={cn(
        "p-5 bg-bg-1 rounded-lg border transition-colors",
        isArchived
          ? "border-border opacity-60"
          : "border-border hover:border-border-2",
      )}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="font-heading text-[1.05rem] font-semibold text-strong leading-tight">
              {idea.title}
            </h3>
            <span
              className={cn(
                "px-2.5 py-0.5 rounded-full text-xs font-semibold capitalize shrink-0",
                CATEGORY_STYLES[idea.category] ?? "bg-bg-3 text-muted",
              )}
            >
              {idea.category.replace(/_/g, " ")}
            </span>
            {idea.quality_score !== null && (
              <span
                className={cn(
                  "px-2.5 py-0.5 rounded-full text-xs font-semibold font-mono shrink-0",
                  qualityBadgeStyle(idea.quality_score),
                )}
              >
                {idea.quality_score.toFixed(1)}/5
              </span>
            )}
            <span
              className={cn(
                "px-2.5 py-0.5 rounded-full text-xs font-semibold capitalize shrink-0",
                STAGE_STYLES[stage] ?? "bg-bg-3 text-muted border border-border",
              )}
            >
              {stage}
            </span>
          </div>
        </div>
        <span className="text-xs text-faint whitespace-nowrap shrink-0 font-mono">
          {relativeTime(idea.created_at)}
        </span>
      </div>

      {/* Summary */}
      <p className="text-sm text-muted leading-relaxed mt-2">
        {idea.summary}
      </p>

      {/* Meta row */}
      <div className="flex items-center gap-3 mt-3 flex-wrap">
        {idea.sources_used && (
          <span className="text-xs text-faint italic">
            Sources: {idea.sources_used}
          </span>
        )}
        {idea.pipeline_name && (
          <span className="text-xs text-faint">
            Pipeline: {idea.pipeline_name.replace(/-/g, " ")}
          </span>
        )}

        {/* Reasoning toggle */}
        <button
          className="inline-flex items-center gap-1.5 px-3 py-1 border border-border rounded-full bg-transparent text-xs font-medium cursor-pointer font-sans transition-colors hover:border-accent hover:text-accent text-faint"
          onClick={() => setExpanded((prev) => !prev)}
        >
          <ChevronRight
            size={11}
            className={cn(
              "transition-transform",
              expanded && "rotate-90",
            )}
          />
          {expanded ? "Hide" : "Reasoning"}
        </button>

        {/* Action buttons — pushed right */}
        <div className="flex items-center gap-2 ml-auto">
          {isArchived ? (
            <button
              disabled={pending}
              onClick={() => handleAction("idea")}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full border border-border bg-transparent text-faint text-xs font-medium cursor-pointer transition-colors hover:bg-bg-2 hover:text-strong disabled:opacity-40 disabled:cursor-not-allowed"
              title="Restore"
            >
              <RotateCcw size={11} />
              Restore
            </button>
          ) : (
            <>
              {!isValidated && (
                <button
                  disabled={pending}
                  onClick={() => handleAction("validated")}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full border border-success/30 bg-success-subtle text-success text-xs font-medium cursor-pointer transition-colors hover:border-success disabled:opacity-40 disabled:cursor-not-allowed"
                  title="Validate this idea"
                >
                  <Check size={11} />
                  Validate
                </button>
              )}
              {isValidated && (
                <button
                  disabled={pending}
                  onClick={() => handleAction("idea")}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full border border-border bg-transparent text-faint text-xs font-medium cursor-pointer transition-colors hover:bg-bg-2 hover:text-strong disabled:opacity-40 disabled:cursor-not-allowed"
                  title="Move back to idea stage"
                >
                  <RotateCcw size={11} />
                  Unvalidate
                </button>
              )}
              <button
                disabled={pending}
                onClick={() => handleAction("archived")}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full border border-border bg-transparent text-faint text-xs font-medium cursor-pointer transition-colors hover:bg-danger-subtle hover:text-danger hover:border-danger/30 disabled:opacity-40 disabled:cursor-not-allowed"
                title="Archive"
              >
                <Archive size={11} />
              </button>
            </>
          )}
        </div>
      </div>

      {/* Expandable reasoning with rich rendering */}
      {expanded && idea.reasoning && (
        <div className="mt-4 px-5 py-4 bg-accent-subtle border-l-2 border-l-accent rounded-r-md text-sm text-muted leading-relaxed">
          <ReasoningContent text={idea.reasoning} />
        </div>
      )}
    </div>
  );
}

// ── Main Component ─────────────────────────────────────────────────────

export default function PipelineIdeas() {
  const toast = useToast();
  const [ideas, setIdeas] = useState<readonly PipelineIdea[]>([]);
  const [total, setTotal] = useState(0);
  const [runs, setRuns] = useState<readonly PipelineRunOption[]>([]);
  const [loading, setLoading] = useState(true);

  const [stageFilter, setStageFilter] = useLocalStorage<StageFilter>("pipeline-ideas:stage", "all");
  const [categoryFilter, setCategoryFilter] = useLocalStorage<CategoryFilter>("pipeline-ideas:category", "all");
  const [runFilter, setRunFilter] = useLocalStorage<string>("pipeline-ideas:run", "all");
  const [sortMode, setSortMode] = useLocalStorage<SortMode>("pipeline-ideas:sort", "newest");
  const [searchQuery, setSearchQuery] = useState("");

  const fetchIdeas = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (stageFilter !== "all") params.set("stage", stageFilter);
      if (categoryFilter !== "all") params.set("category", categoryFilter);
      if (runFilter !== "all") params.set("run_id", runFilter);
      if (sortMode) params.set("sort", sortMode);
      if (searchQuery.trim()) params.set("search", searchQuery.trim());
      params.set("limit", "100");

      const qs = params.toString();
      const res = await apiFetch<{
        success: boolean;
        data: readonly PipelineIdea[];
        meta: { total: number };
      }>(`/api/pipeline-ideas${qs ? `?${qs}` : ""}`);

      if (res.success) {
        setIdeas(res.data);
        setTotal(res.meta.total);
      }
    } catch {
      toast.error("Failed to load pipeline ideas");
    } finally {
      setLoading(false);
    }
  }, [stageFilter, categoryFilter, runFilter, sortMode, searchQuery, toast]);

  const fetchRuns = useCallback(async () => {
    try {
      const res = await apiFetch<{
        success: boolean;
        data: readonly PipelineRunOption[];
      }>("/api/pipeline-ideas/runs");
      if (res.success) setRuns(res.data);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    fetchRuns();
  }, [fetchRuns]);

  useEffect(() => {
    setLoading(true);
    fetchIdeas();
  }, [fetchIdeas]);

  const handleStageChange = useCallback(
    async (id: string, stage: string) => {
      try {
        const res = await apiFetch<{ success: boolean; data: PipelineIdea }>(
          `/api/pipeline-ideas/${id}/stage`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ stage }),
          },
        );
        if (res.success) {
          setIdeas((prev) =>
            prev.map((idea) =>
              idea.id === id ? { ...idea, pipeline_stage: stage } : idea,
            ),
          );
          toast.success(
            stage === "archived"
              ? "Idea archived"
              : stage === "validated"
                ? "Idea validated"
                : "Idea restored",
          );
        }
      } catch {
        toast.error("Failed to update idea");
      }
    },
    [toast],
  );

  // Stage counts from current data
  const stageCounts = useMemo(() => {
    const counts: Record<string, number> = { all: total };
    for (const idea of ideas) {
      const s = idea.pipeline_stage || "idea";
      counts[s] = (counts[s] ?? 0) + 1;
    }
    return counts;
  }, [ideas, total]);

  if (loading && ideas.length === 0) {
    return <LoadingState message="Loading pipeline ideas..." />;
  }

  return (
    <div>
      <PageHeader
        title="Pipeline Ideas"
        count={total}
        subtitle={`${total} ideas generated by AI pipelines`}
        actions={
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
        }
      />

      {/* Stage filter tabs */}
      <div className="flex gap-1.5 flex-wrap mb-4 p-2 bg-bg border border-border rounded-md">
        {(["all", "idea", "validated", "archived"] as const).map((stage) => (
          <button
            key={stage}
            className={cn(
              "px-4 py-[7px] rounded-md bg-transparent border border-transparent text-faint font-sans text-sm font-medium cursor-pointer capitalize transition-colors hover:bg-bg-2 hover:text-strong",
              stageFilter === stage &&
                "bg-accent-subtle border-accent text-accent font-semibold",
            )}
            onClick={() => setStageFilter(stageFilter === stage && stage !== "all" ? "all" : stage)}
          >
            {stage}
            {stageCounts[stage] !== undefined && (
              <span
                className={cn(
                  "inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 ml-1 rounded-full bg-bg-3 font-mono text-xs font-semibold",
                  stageFilter === stage && "bg-accent-subtle text-accent",
                )}
              >
                {stageCounts[stage]}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Filters row */}
      <div className="flex gap-3 mb-5 flex-wrap">
        {/* Search */}
        <div className="relative flex-1 min-w-[200px]">
          <Search
            size={14}
            className="absolute left-3.5 top-1/2 -translate-y-1/2 text-faint pointer-events-none"
          />
          <input
            type="text"
            className="w-full py-2.5 px-4 pl-9 rounded-lg border border-border bg-bg-1 text-strong font-sans text-sm outline-none transition-colors focus:border-accent placeholder:text-faint"
            placeholder="Search ideas..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
          {searchQuery && (
            <button
              className="absolute right-2.5 top-1/2 -translate-y-1/2 w-5 h-5 rounded-full border-none bg-bg-3 text-faint text-xs cursor-pointer flex items-center justify-center transition-colors p-0 hover:bg-bg-2 hover:text-strong"
              onClick={() => setSearchQuery("")}
            >
              <X size={10} />
            </button>
          )}
        </div>

        {/* Category filter */}
        <select
          aria-label="Filter by category"
          className="py-2 px-4 rounded-lg border border-border bg-bg-1 text-muted font-sans text-sm cursor-pointer outline-none transition-colors focus:border-accent"
          value={categoryFilter}
          onChange={(e) => setCategoryFilter(e.target.value as CategoryFilter)}
        >
          {CATEGORY_OPTIONS.map((opt) => (
            <option key={opt.id} value={opt.id}>
              {opt.label}
            </option>
          ))}
        </select>

        {/* Run filter */}
        {runs.length > 0 && (
          <select
            aria-label="Filter by pipeline run"
            className="py-2 px-4 rounded-lg border border-border bg-bg-1 text-muted font-sans text-sm cursor-pointer outline-none transition-colors focus:border-accent max-w-[240px]"
            value={runFilter}
            onChange={(e) => setRunFilter(e.target.value)}
          >
            <option value="all">All Runs</option>
            {runs.map((r) => (
              <option key={r.id} value={r.id}>
                {r.pipeline_id.replace(/-/g, " ")} ({r.idea_count} ideas) -{" "}
                {relativeTime(r.created_at)}
              </option>
            ))}
          </select>
        )}
      </div>

      {/* Ideas */}
      {ideas.length === 0 ? (
        <EmptyState
          title={searchQuery ? "No matching ideas" : "No pipeline ideas yet"}
          description={
            searchQuery
              ? `No ideas match "${searchQuery}".`
              : "Run a pipeline from the Pipelines page to generate ideas."
          }
        />
      ) : (
        <div className="flex flex-col gap-3">
          {ideas.map((idea) => (
            <IdeaCard
              key={idea.id}
              idea={idea}
              onStageChange={handleStageChange}
            />
          ))}
        </div>
      )}
    </div>
  );
}
