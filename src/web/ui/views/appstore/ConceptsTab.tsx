// "Concepts" view of the App Store Keyword Research screen — groups keywords
// into app-concept clusters (see docs/superpowers/specs/2026-07-14-semantic-
// keyword-concepts-design.md). Backed by the precomputed
// `appstore_keyword_clusters` table (populated by the offline
// `appstore:cluster-keywords` job — this view is read-only and never triggers
// clustering itself). Sibling of OpportunitiesTab.tsx; shares the same
// preset/filter bar (`./filter-bar`) and formatters (`./opportunities-format`)
// so a keyword reads identically whether it's found via the Keywords table or
// a Concepts card's expand view.
import { useEffect, useMemo, useRef, useState } from "react";
import { apiFetch } from "../../api";
import { Button, EmptyState, LoadingState } from "../../components";
import { usePolledFetch } from "../../hooks/usePolledFetch";
import { cn } from "../../lib/cn";
import { useDebounce } from "../../lib/use-debounce";
import { FilterPanel, PresetBar, selectClass } from "./filter-bar";
import {
  ALL_PRESET,
  buildabilityBand,
  filtersEqual,
  formatCompetitiveness,
  formatDemand,
  formatOpportunity,
  INDIE_FILTERS,
  matchPreset,
  parseDraftNumber,
  PRESETS,
  titleCaseLabel,
  toDraft,
  trendBadge,
} from "./opportunities-format";
import type { FilterState, NumericDraft, PresetId, TrendFilterValue } from "./opportunities-format";

// ─── Types (mirror src/sources/appstore/keyword-store.ts as serialized to JSON) ─

/** Mirrors `ClusterTopMember` (keyword-store.ts). */
interface ClusterTopMember {
  readonly keyword: string;
  readonly buildability: number;
  readonly demand: number;
  readonly opportunity: number;
}

/** Mirrors `OpportunityCluster` (keyword-store.ts) — one app-concept card. */
interface OpportunityCluster {
  readonly clusterId: number;
  readonly label: string;
  readonly memberCount: number;
  readonly maxBuildability: number;
  readonly maxOpportunity: number;
  readonly avgDemand: number;
  readonly minTopAppReviews: number;
  readonly topMembers: readonly ClusterTopMember[];
}

interface ClustersMeta {
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

/** Response shape of `GET /appstore/opportunity-clusters`. */
interface ClustersResponse {
  readonly success: boolean;
  readonly data: readonly OpportunityCluster[];
  readonly meta: ClustersMeta;
}

/**
 * Mirrors `OpportunityRow` (keyword-store.ts / OpportunitiesTab.tsx's local
 * `OpportunityRow`) — the full member-keyword projection returned by the
 * cluster expand endpoint. Only the fields the mini member-table renders are
 * declared; extra JSON fields (e.g. `topApps`) are simply ignored.
 */
interface ClusterMemberRow {
  readonly keyword: string;
  readonly buildability: number;
  readonly opportunity: number;
  readonly competitiveness: number;
  readonly demand: number;
  readonly incumbentWeakness: number;
  readonly trend: string;
}

/** Response shape of `GET /appstore/opportunity-clusters/:clusterId`. */
interface ClusterMembersResponse {
  readonly success: boolean;
  readonly data: readonly ClusterMemberRow[];
}

/** Cluster-level sort key — mirrors `ClusterSortKey` (keyword-store.ts). */
type ClusterSortKey = "maxBuildability" | "memberCount" | "avgDemand";
type SortDir = "asc" | "desc";

const DEFAULT_SORT_KEY: ClusterSortKey = "maxBuildability";
const DEFAULT_SORT_DIR: SortDir = "desc";

const CLUSTER_SORT_OPTIONS: ReadonlyArray<{ readonly key: ClusterSortKey; readonly label: string }> = [
  { key: "maxBuildability", label: "Buildability" },
  { key: "memberCount", label: "Keywords" },
  { key: "avgDemand", label: "Avg Demand" },
];

const PAGE_SIZE_OPTIONS = [12, 24, 48] as const;
const DEFAULT_PAGE_SIZE: number = 24;

const FILTER_DEBOUNCE_MS = 400;

// ─── Member mini-table (cluster expand view) ────────────────────────────────

interface MemberTableProps {
  readonly rows: readonly ClusterMemberRow[];
}

function MemberTable({ rows }: MemberTableProps) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs border-collapse">
        <thead>
          <tr className="border-b border-border-2 text-left">
            <th className="px-2 py-1.5 font-semibold uppercase tracking-wide text-faint">Keyword</th>
            <th className="px-2 py-1.5 font-semibold uppercase tracking-wide text-faint">Buildability</th>
            <th className="px-2 py-1.5 font-semibold uppercase tracking-wide text-faint">Opportunity</th>
            <th className="px-2 py-1.5 font-semibold uppercase tracking-wide text-faint">Competitiveness</th>
            <th className="px-2 py-1.5 font-semibold uppercase tracking-wide text-faint">Demand</th>
            <th className="px-2 py-1.5 font-semibold uppercase tracking-wide text-faint">Incumbent Weakness</th>
            <th className="px-2 py-1.5 font-semibold uppercase tracking-wide text-faint">Trend</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const band = buildabilityBand(row.buildability);
            const badge = trendBadge(row.trend);
            return (
              <tr key={row.keyword} className="border-b border-border-2/40">
                <td className="px-2 py-1.5 font-medium text-foreground whitespace-nowrap">{row.keyword}</td>
                <td className="px-2 py-1.5">
                  <span className="inline-flex items-center gap-1 whitespace-nowrap">
                    <span className="font-mono text-foreground">{row.buildability}</span>
                    <span
                      className={cn("px-1 py-0.5 rounded text-[10px] leading-none", band.className)}
                      aria-label={`Buildability band: ${band.label}`}
                      title={band.label}
                    >
                      {band.dot}
                    </span>
                  </span>
                </td>
                <td className="px-2 py-1.5 font-mono text-muted whitespace-nowrap">
                  {formatOpportunity(row.opportunity)}
                </td>
                <td className="px-2 py-1.5 font-mono text-muted whitespace-nowrap">
                  {formatCompetitiveness(row.competitiveness)}
                </td>
                <td className="px-2 py-1.5 font-mono text-muted whitespace-nowrap">
                  {formatDemand(row.demand)}
                </td>
                <td className="px-2 py-1.5 font-mono text-muted whitespace-nowrap">
                  {formatOpportunity(row.incumbentWeakness)}
                </td>
                <td className="px-2 py-1.5">
                  <span className={cn("px-1.5 py-0.5 rounded text-[10px] font-medium", badge.className)}>
                    {badge.label}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ─── Concept card ────────────────────────────────────────────────────────────

interface ConceptCardProps {
  readonly cluster: OpportunityCluster;
  readonly isExpanded: boolean;
  readonly onToggle: () => void;
  readonly memberRows: readonly ClusterMemberRow[] | undefined;
  readonly membersLoading: boolean;
  readonly membersError: string | null;
}

function ConceptCard({
  cluster,
  isExpanded,
  onToggle,
  memberRows,
  membersLoading,
  membersError,
}: ConceptCardProps) {
  const band = buildabilityBand(cluster.maxBuildability);

  return (
    <div className="flex flex-col gap-2.5 p-3.5 rounded-lg border border-border-2 bg-bg-1">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={isExpanded}
        aria-label={`${isExpanded ? "Collapse" : "Expand"} ${titleCaseLabel(cluster.label)}`}
        className="flex items-start justify-between gap-3 cursor-pointer bg-transparent border-none p-0 text-left"
      >
        <div className="flex flex-col gap-1 min-w-0">
          <span className="font-semibold text-sm text-foreground truncate">
            {titleCaseLabel(cluster.label)}
          </span>
          <span className="text-xs text-faint">
            {cluster.memberCount.toLocaleString()} keyword{cluster.memberCount === 1 ? "" : "s"} · avg
            demand {formatDemand(cluster.avgDemand)}
          </span>
        </div>
        <span
          className={cn(
            "shrink-0 inline-flex items-center gap-1.5 px-1.5 py-0.5 rounded text-xs font-semibold whitespace-nowrap",
            band.className,
          )}
          aria-label={`Buildability band: ${band.label}`}
          title={band.label}
        >
          <span className="font-mono">{cluster.maxBuildability}</span>
          {band.dot}
        </span>
      </button>

      {cluster.topMembers.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {cluster.topMembers.map((member) => (
            <span
              key={member.keyword}
              className="px-2 py-0.5 rounded-full bg-bg-3 text-xs text-muted whitespace-nowrap"
            >
              {member.keyword}
            </span>
          ))}
        </div>
      )}

      {isExpanded && (
        <div className="pt-2 border-t border-border-2/50">
          {membersLoading ? (
            <span className="text-xs text-faint">Loading member keywords…</span>
          ) : membersError ? (
            <span className="text-xs text-danger">{membersError}</span>
          ) : memberRows && memberRows.length > 0 ? (
            <MemberTable rows={memberRows} />
          ) : (
            <span className="text-xs text-faint">No member keywords match these filters.</span>
          )}
        </div>
      )}
    </div>
  );
}

// ─── ConceptsTab (main) ──────────────────────────────────────────────────────

export default function ConceptsTab() {
  const [sortKey, setSortKey] = useState<ClusterSortKey>(DEFAULT_SORT_KEY);
  const [sortDir, setSortDir] = useState<SortDir>(DEFAULT_SORT_DIR);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE);

  // Opens on the same "Indie sweet spot" preset as the Keywords table — a
  // concept aggregates its member keywords, so the same buildable-keyword
  // filter floor keeps noise clusters out of the default view.
  const [filters, setFilters] = useState<FilterState>(INDIE_FILTERS);
  const [draft, setDraft] = useState<NumericDraft>(() => toDraft(INDIE_FILTERS));
  const debouncedDraft = useDebounce(draft, FILTER_DEBOUNCE_MS);

  const [expandedClusterId, setExpandedClusterId] = useState<number | null>(null);
  const [members, setMembers] = useState<Record<number, readonly ClusterMemberRow[]>>({});
  const [membersLoading, setMembersLoading] = useState<number | null>(null);
  const [membersError, setMembersError] = useState<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  // Commit the debounced numeric drafts into `filters` — mirrors
  // OpportunitiesTab's identical effect. Bails out (same object reference)
  // when nothing changed so this never triggers a spurious page reset.
  useEffect(() => {
    setFilters((prev) => {
      const next: FilterState = {
        ...prev,
        minDemand: parseDraftNumber(debouncedDraft.minDemand),
        maxCompetitiveness: parseDraftNumber(debouncedDraft.maxCompetitiveness),
        minIncumbentWeakness: parseDraftNumber(debouncedDraft.minIncumbentWeakness),
        minOpportunity: parseDraftNumber(debouncedDraft.minOpportunity),
        minBuildability: parseDraftNumber(debouncedDraft.minBuildability),
      };
      return filtersEqual(prev, next) ? prev : next;
    });
  }, [debouncedDraft]);

  // A new sort column/direction, page size, or filter state always restarts
  // from the first page.
  useEffect(() => {
    setPage(0);
  }, [sortKey, sortDir, pageSize, filters]);

  const offset = page * pageSize;
  const activePreset = matchPreset(filters);

  // Unlike OpportunitiesTab, a preset never pins the cluster-level `sortKey`
  // here: `Preset.sort`/`dir` are keyword-table `SortKey` values ("buildability"),
  // not `ClusterSortKey` values ("maxBuildability") — the two enums don't
  // share a name, so casting one into the other would silently pick the wrong
  // column. The Indie preset's intent (buildability-first) is already this
  // view's default sort, so no mapping is needed in practice.
  function applyPreset(id: PresetId): void {
    const preset = PRESETS.find((p) => p.id === id) ?? ALL_PRESET;
    setFilters(preset.filters);
    setDraft(toDraft(preset.filters));
    setPage(0);
  }

  function setTrend(value: TrendFilterValue | ""): void {
    setFilters((prev) => ({ ...prev, trend: value === "" ? null : value }));
  }

  function setHideJunk(checked: boolean): void {
    setFilters((prev) => ({ ...prev, hideJunk: checked }));
  }

  /** Member-level filter query params shared by the list + expand endpoints. */
  function filterParams(): URLSearchParams {
    const params = new URLSearchParams();
    if (filters.trend) params.set("trend", filters.trend);
    if (filters.minDemand !== null) params.set("minDemand", String(filters.minDemand));
    if (filters.maxCompetitiveness !== null) {
      params.set("maxCompetitiveness", String(filters.maxCompetitiveness));
    }
    if (filters.minIncumbentWeakness !== null) {
      params.set("minIncumbentWeakness", String(filters.minIncumbentWeakness));
    }
    if (filters.minOpportunity !== null) params.set("minOpportunity", String(filters.minOpportunity));
    if (filters.minBuildability !== null) params.set("minBuildability", String(filters.minBuildability));
    // Always sent explicitly as "true"/"false" — z.coerce.boolean() on the
    // backend would treat the string "false" as truthy (see OpportunitiesTab).
    params.set("hideJunk", filters.hideJunk ? "true" : "false");
    return params;
  }

  const listPath = useMemo(() => {
    const params = filterParams();
    params.set("limit", String(pageSize));
    params.set("offset", String(offset));
    params.set("sort", sortKey);
    params.set("dir", sortDir);
    return `/api/appstore/opportunity-clusters?${params.toString()}`;
  }, [sortKey, sortDir, offset, pageSize, filters]);

  // Same stale-response-safe polling machinery as OpportunitiesTab: aborts
  // the previous request and refetches whenever `listPath` changes, pauses
  // when the tab is hidden, aborts on unmount.
  const { data, loading } = usePolledFetch<ClustersResponse>(listPath, {
    intervalMs: 30_000,
  });

  const clusters = data?.success ? data.data : [];
  const meta = data?.meta;
  const total = meta?.total ?? 0;

  // Clamp the current page if a background poll picks up fewer clusters than
  // before, so the user never lands on an offset past the end of the results.
  useEffect(() => {
    if (total === 0) return;
    const maxPage = Math.max(0, Math.ceil(total / pageSize) - 1);
    setPage((prev) => (prev > maxPage ? maxPage : prev));
  }, [total, pageSize]);

  // Abort any in-flight member fetch on unmount.
  useEffect(() => {
    return () => {
      abortControllerRef.current?.abort();
    };
  }, []);

  function handleSort(key: ClusterSortKey): void {
    if (sortKey === key) {
      setSortDir((prev) => (prev === "desc" ? "asc" : "desc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  }

  async function toggleExpand(clusterId: number): Promise<void> {
    if (expandedClusterId === clusterId) {
      abortControllerRef.current?.abort();
      setExpandedClusterId(null);
      return;
    }

    // Only one cluster is ever expanded at a time — abort the previous
    // in-flight fetch (if any) before starting this one.
    abortControllerRef.current?.abort();
    setExpandedClusterId(clusterId);
    setMembersError(null);
    if (members[clusterId]) return;

    const controller = new AbortController();
    abortControllerRef.current = controller;
    setMembersLoading(clusterId);
    try {
      const params = filterParams();
      const res = await apiFetch<ClusterMembersResponse>(
        `/api/appstore/opportunity-clusters/${clusterId}?${params.toString()}`,
        { signal: controller.signal },
      );
      if (controller.signal.aborted) return;
      if (res.success) {
        setMembers((prev) => ({ ...prev, [clusterId]: res.data }));
      } else {
        setMembersError("Failed to load member keywords.");
      }
    } catch (err) {
      if (controller.signal.aborted) return;
      const message =
        err instanceof Error
          ? err.message
          : typeof err === "object" && err !== null && "message" in err
            ? String((err as { message: unknown }).message)
            : "Failed to load member keywords.";
      setMembersError(message);
    } finally {
      if (!controller.signal.aborted) setMembersLoading(null);
    }
  }

  const canGoPrev = page > 0;
  const canGoNext = offset + clusters.length < total;
  const totalPages = total > 0 ? Math.max(1, Math.ceil(total / pageSize)) : 1;

  function goToPrevPage(): void {
    setPage((prev) => Math.max(0, prev - 1));
  }

  function goToNextPage(): void {
    setPage((prev) => (canGoNext ? prev + 1 : prev));
  }

  const isInitialLoad = loading && data === null;
  if (isInitialLoad) return <LoadingState message="Loading keyword concepts…" />;

  const rangeStart = clusters.length === 0 ? 0 : offset + 1;
  const rangeEnd = offset + clusters.length;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2">
        <PresetBar activePreset={activePreset} onSelect={applyPreset} />
        <FilterPanel
          draft={draft}
          onDraftChange={setDraft}
          trend={filters.trend}
          onTrendChange={setTrend}
          hideJunk={filters.hideJunk}
          onHideJunkChange={setHideJunk}
        />
      </div>

      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-1.5" role="group" aria-label="Sort concepts">
          {CLUSTER_SORT_OPTIONS.map((opt) => (
            <button
              key={opt.key}
              type="button"
              onClick={() => handleSort(opt.key)}
              aria-label={`Sort by ${opt.label}`}
              className={cn(
                "px-2.5 py-1 rounded-lg text-xs font-semibold cursor-pointer transition-colors duration-150 border",
                sortKey === opt.key
                  ? "bg-accent/15 text-accent border-accent/40"
                  : "bg-transparent border-border-2 text-muted hover:bg-bg-2 hover:border-border-hover hover:text-foreground",
              )}
            >
              {opt.label}
              {sortKey === opt.key && (
                <span aria-hidden="true" className="ml-1">
                  {sortDir === "asc" ? "▲" : "▼"}
                </span>
              )}
            </button>
          ))}
        </div>
        <span className="text-xs text-faint whitespace-nowrap">
          Showing {rangeStart.toLocaleString()}–{rangeEnd.toLocaleString()} of{" "}
          {total.toLocaleString()}
        </span>
      </div>

      {total === 0 ? (
        <EmptyState
          title="No concepts match these filters"
          description="Concepts are precomputed by the keyword clustering job — try widening the filters, or run the clustering job to populate concepts."
        >
          <Button variant="secondary" size="sm" className="mt-3" onClick={() => applyPreset("all")}>
            All
          </Button>
        </EmptyState>
      ) : (
        <div
          className={cn(
            "grid gap-3 grid-cols-1 lg:grid-cols-2 transition-opacity duration-150",
            loading && "opacity-60",
          )}
        >
          {clusters.map((cluster) => (
            <ConceptCard
              key={cluster.clusterId}
              cluster={cluster}
              isExpanded={expandedClusterId === cluster.clusterId}
              onToggle={() => void toggleExpand(cluster.clusterId)}
              memberRows={members[cluster.clusterId]}
              membersLoading={membersLoading === cluster.clusterId}
              membersError={expandedClusterId === cluster.clusterId ? membersError : null}
            />
          ))}
        </div>
      )}

      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <span className="text-xs text-faint">Cards per page</span>
          <select
            className={selectClass}
            value={pageSize}
            onChange={(e) => setPageSize(Number(e.target.value))}
            aria-label="Cards per page"
          >
            {PAGE_SIZE_OPTIONS.map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-center gap-3">
          <span className="text-xs text-faint whitespace-nowrap">
            Page {(page + 1).toLocaleString()} of {totalPages.toLocaleString()}
          </span>
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={goToPrevPage} disabled={!canGoPrev}>
              Prev
            </Button>
            <Button variant="secondary" size="sm" onClick={goToNextPage} disabled={!canGoNext}>
              Next
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
