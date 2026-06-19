/**
 * SigeIdeas — aggregation page showing every idea SIGE has produced across
 * all runs and rounds in one flat, ranked, filterable list.
 *
 * Server-side params: finalOnly, runId, minScore, limit.
 * Client-side filters: search (title+description), roundFilter, sortMode.
 * Filter state is persisted to localStorage via useLocalStorage.
 */

import { useMemo } from "react";
import {
  PageHeader,
  LoadingState,
  EmptyState,
  FilterTabs,
  SearchBar,
} from "../components";
import { usePolledFetch } from "../hooks/usePolledFetch";
import { useLocalStorage } from "../lib/useLocalStorage";
import { cn } from "../lib/cn";
import { IdeaCard } from "./sige-ideas/IdeaCard";
import type { AggregatedIdea, IdeasResponse, RunSummary } from "./sige-ideas/types";
import { DEFAULT_FILTER_STATE } from "./sige-ideas/types";
import type { Tab } from "../navigation";

// ─── Props ───────────────────────────────────────────────────────────────────

interface SigeIdeasProps {
  readonly navigateTo: (tab: Tab) => void;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const ROUND_FILTER_TABS = [
  { id: "0", label: "All rounds" },
  { id: "1", label: "R1" },
  { id: "2", label: "R2" },
  { id: "3", label: "R3" },
  { id: "4", label: "R4" },
] as const;

const MIN_SCORE_OPTIONS = [
  { value: 0, label: "Any score" },
  { value: 0.3, label: "≥ 0.30" },
  { value: 0.5, label: "≥ 0.50" },
  { value: 0.7, label: "≥ 0.70" },
  { value: 0.8, label: "≥ 0.80" },
] as const;

const LIMIT_OPTIONS = [
  { value: 10, label: "10 runs" },
  { value: 25, label: "25 runs" },
  { value: 50, label: "50 runs" },
] as const;

const SELECT_CLASS =
  "py-2 px-3 rounded-lg border border-border bg-bg-1 text-muted font-sans text-sm cursor-pointer outline-none transition-colors h-[36px] focus:border-accent";

function buildQueryString(
  finalOnly: boolean,
  runId: string,
  minScore: number,
  limit: number,
): string {
  const params = new URLSearchParams();
  if (finalOnly) params.set("finalOnly", "true");
  if (runId) params.set("runId", runId);
  if (minScore > 0) params.set("minScore", String(minScore));
  params.set("limit", String(limit));
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

function runLabel(run: RunSummary): string {
  if (run.seed) {
    const truncated = run.seed.length > 24 ? `${run.seed.slice(0, 24)}…` : run.seed;
    return `${truncated} (${run.ideaCount} ideas)`;
  }
  return `Auto ${run.runId.slice(0, 8)} (${run.ideaCount} ideas)`;
}

function applyClientFilters(
  ideas: readonly AggregatedIdea[],
  search: string,
  roundFilter: number,
  sortMode: "score" | "newest",
): readonly AggregatedIdea[] {
  let filtered = ideas;

  if (search.trim()) {
    const q = search.trim().toLowerCase();
    filtered = filtered.filter(
      (idea) =>
        idea.title.toLowerCase().includes(q) ||
        idea.description.toLowerCase().includes(q),
    );
  }

  if (roundFilter > 0) {
    filtered = filtered.filter((idea) => idea.round === roundFilter);
  }

  if (sortMode === "newest") {
    filtered = [...filtered].sort(
      (a, b) =>
        new Date(b.runCreatedAt).getTime() - new Date(a.runCreatedAt).getTime(),
    );
  }
  // "score" is the default order from the API (fusedScore ?? expertScore DESC)

  return filtered;
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function SigeIdeas({ navigateTo }: SigeIdeasProps) {
  // ── Persisted filter state ────────────────────────────────────────────────
  const [finalOnly, setFinalOnly] = useLocalStorage<boolean>(
    "sige-ideas:finalOnly",
    DEFAULT_FILTER_STATE.finalOnly,
  );
  const [runId, setRunId] = useLocalStorage<string>(
    "sige-ideas:runId",
    DEFAULT_FILTER_STATE.runId,
  );
  const [minScore, setMinScore] = useLocalStorage<number>(
    "sige-ideas:minScore",
    DEFAULT_FILTER_STATE.minScore,
  );
  const [roundFilter, setRoundFilter] = useLocalStorage<number>(
    "sige-ideas:roundFilter",
    DEFAULT_FILTER_STATE.roundFilter,
  );
  const [sortMode, setSortMode] = useLocalStorage<"score" | "newest">(
    "sige-ideas:sortMode",
    DEFAULT_FILTER_STATE.sortMode,
  );
  const [search, setSearch] = useLocalStorage<string>(
    "sige-ideas:search",
    DEFAULT_FILTER_STATE.search,
  );
  const [limit, setLimit] = useLocalStorage<number>(
    "sige-ideas:limit",
    DEFAULT_FILTER_STATE.limit,
  );

  // ── Data fetching ─────────────────────────────────────────────────────────
  // Build the path including server-side query params so usePolledFetch
  // re-fetches whenever any server param changes (path identity triggers the effect).
  const path = `/api/sige/ideas${buildQueryString(finalOnly, runId, minScore, limit)}`;

  const { data, loading, error } = usePolledFetch<IdeasResponse>(path, {
    intervalMs: 30000,
  });

  const allIdeas: readonly AggregatedIdea[] = data?.data.ideas ?? [];
  const runs: readonly RunSummary[] = data?.data.runs ?? [];

  // ── Client-side filtering ─────────────────────────────────────────────────
  const displayedIdeas = useMemo(
    () => applyClientFilters(allIdeas, search, roundFilter, sortMode),
    [allIdeas, search, roundFilter, sortMode],
  );

  // ── Render ────────────────────────────────────────────────────────────────

  if (loading && allIdeas.length === 0) {
    return <LoadingState message="Loading SIGE ideas..." />;
  }

  if (error && allIdeas.length === 0) {
    return (
      <div>
        <PageHeader
          title="SIGE Ideas"
          subtitle="Game-theoretic ideas aggregated across all runs"
        />
        <div className="bg-danger-subtle border border-danger/20 rounded-lg px-5 py-4 text-danger text-sm">
          Failed to load ideas: {error}
        </div>
      </div>
    );
  }

  return (
    <div>
      {/* Header */}
      <PageHeader
        title="SIGE Ideas"
        count={displayedIdeas.length}
        subtitle="All ideas produced by SIGE across every run and round, ranked by score"
        actions={
          <div className="flex items-center gap-2">
            {/* Sort */}
            <select
              aria-label="Sort ideas"
              className={SELECT_CLASS}
              value={sortMode}
              onChange={(e) => setSortMode(e.target.value as "score" | "newest")}
            >
              <option value="score">Top score</option>
              <option value="newest">Newest run</option>
            </select>

            {/* Limit (sessions to scan) */}
            <select
              aria-label="Sessions to scan"
              className={SELECT_CLASS}
              value={limit}
              onChange={(e) => setLimit(Number(e.target.value))}
            >
              {LIMIT_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
        }
      />

      {/* Final-only toggle: All rounds ↔ Final only */}
      <FilterTabs
        tabs={[
          { id: "all", label: "All rounds", count: allIdeas.length },
          {
            id: "final",
            label: "Final only",
            count: allIdeas.filter((i) => i.isFinal).length,
          },
        ]}
        active={finalOnly ? "final" : "all"}
        onChange={(id) => setFinalOnly(id === "final")}
      />

      {/* Controls row */}
      <div className="flex flex-wrap gap-3 mb-5">
        {/* Search */}
        <div className="flex-1 min-w-[180px]">
          <SearchBar
            value={search}
            onChange={setSearch}
            placeholder="Search ideas by title or description..."
          />
        </div>

        {/* Run filter */}
        <select
          aria-label="Filter by run"
          className={cn(SELECT_CLASS, "max-w-[220px]")}
          value={runId}
          onChange={(e) => setRunId(e.target.value)}
        >
          <option value="">All runs</option>
          {runs.map((run) => (
            <option key={run.runId} value={run.runId}>
              {runLabel(run)}
            </option>
          ))}
        </select>

        {/* Min score */}
        <select
          aria-label="Minimum score"
          className={SELECT_CLASS}
          value={minScore}
          onChange={(e) => setMinScore(Number(e.target.value))}
        >
          {MIN_SCORE_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>

      {/* Round filter (client-side) */}
      <div className="flex gap-1.5 flex-wrap mb-5">
        {ROUND_FILTER_TABS.map((tab) => {
          const id = Number(tab.id);
          const isActive = roundFilter === id;
          return (
            <button
              key={tab.id}
              type="button"
              className={cn(
                "px-3 py-1.5 rounded-md text-xs font-medium cursor-pointer transition-colors border",
                isActive
                  ? "bg-accent-subtle border-accent text-accent font-semibold"
                  : "bg-transparent border-border text-faint hover:bg-bg-2 hover:text-foreground hover:border-border-hover",
              )}
              onClick={() => setRoundFilter(isActive && id !== 0 ? 0 : id)}
              aria-pressed={isActive}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* Ideas list */}
      {displayedIdeas.length === 0 ? (
        <EmptyState
          icon="♟"
          title={
            search || roundFilter > 0 || finalOnly
              ? "No ideas match your filters"
              : "No SIGE ideas yet"
          }
          description={
            search || roundFilter > 0 || finalOnly
              ? "Try adjusting your filters or expanding the sessions scanned."
              : "Run a SIGE session from the SIGE page to generate strategically-ranked ideas."
          }
        />
      ) : (
        <div className="flex flex-col gap-2">
          {displayedIdeas.map((idea, i) => (
            <IdeaCard
              key={idea.ideaId}
              idea={idea}
              rank={i + 1}
              animationDelay={Math.min(i * 30, 300)}
              navigateTo={navigateTo}
            />
          ))}
        </div>
      )}
    </div>
  );
}
