import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type React from "react";
import { apiFetch } from "../../api";
import { Button, EmptyState, LoadingState, SearchBar } from "../../components";
import { usePolledFetch } from "../../hooks/usePolledFetch";
import { cn } from "../../lib/cn";
import { formatNumber } from "../../lib/format";
import { useDebounce } from "../../lib/use-debounce";
import { FilterPanel, PresetBar, selectClass } from "./filter-bar";
import {
  ALL_PRESET,
  buildabilityBand,
  filtersEqual,
  formatAvgAgeDays,
  formatAvgRating,
  formatCompetitiveness,
  formatDemand,
  formatOpportunity,
  formatStore,
  formatTopAppReviews,
  INDIE_FILTERS,
  keywordVerdict,
  matchPreset,
  parseDraftNumber,
  PRESETS,
  toDraft,
  trendBadge,
} from "./opportunities-format";
import type {
  FilterState,
  NumericDraft,
  PresetId,
  TopApp,
  TrendFilterValue,
} from "./opportunities-format";
import type { OpportunityMeta, ScanHistoryPoint } from "./OpportunityTrendChart";
import { OpportunityTrendChart } from "./OpportunityTrendChart";

export { keywordVerdict } from "./opportunities-format";
export type { VerdictInput, VerdictTopApp } from "./opportunities-format";

// ─── Types ────────────────────────────────────────────────────────────────────

/** Mirrors `KeywordScanRow` (src/sources/appstore/keyword-store.ts) as serialized to JSON. */
interface OpportunityRow {
  readonly id: number;
  readonly keyword: string;
  readonly store: "app" | "play";
  readonly scannedAt: number;
  readonly competitiveness: number;
  readonly demand: number;
  readonly incumbentWeakness: number;
  readonly opportunity: number;
  /** Solo-indie "can I win this?" score, 0..100 — see opportunities-format.ts `buildabilityBand`. */
  readonly buildability: number;
  /** Best-ever opportunity score across the keyword's full scan history. */
  readonly peakOpportunity: number;
  readonly trend: string;
  readonly topAppReviews: number;
  readonly avgRating: number;
  readonly avgAgeDays: number;
  /** Epoch seconds the keyword first entered the corpus, or `null` if unknown. */
  readonly firstFoundAt: number | null;
  /** Keyword provenance, or `null` if unknown / not yet backfilled. */
  readonly source: string | null;
  /** Latest-scan incumbent snapshot — powers the row-expand incumbents panel. */
  readonly topApps: readonly TopApp[];
}

interface OpportunitiesMeta {
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

/** Response shape of `GET /appstore/opportunities`. */
interface OpportunitiesResponse {
  readonly success: boolean;
  readonly data: readonly OpportunityRow[];
  readonly meta: OpportunitiesMeta;
}

/** Response shape of `GET /appstore/opportunities/:keyword` (unchanged). */
interface HistoryResponse {
  readonly success: boolean;
  readonly data: {
    readonly history: readonly ScanHistoryPoint[];
    readonly meta: OpportunityMeta;
  };
}

/** Server-side sort key — mirrors the backend `sort` query param. Every column is sortable. */
type SortKey =
  | "keyword"
  | "buildability"
  | "store"
  | "opportunity"
  | "competitiveness"
  | "demand"
  | "incumbentWeakness"
  | "trend"
  | "topAppReviews"
  | "avgRating"
  | "avgAgeDays";

type SortDir = "asc" | "desc";

// The screen opens on the "Indie sweet spot" preset, which now default-sorts
// by Buildability (the headline score) rather than raw Opportunity — see
// docs/superpowers/specs/2026-07-14-buildability-score-design.md.
const DEFAULT_SORT_KEY: SortKey = "buildability";
const DEFAULT_SORT_DIR: SortDir = "desc";

const PAGE_SIZE_OPTIONS = [25, 50, 100] as const;
const DEFAULT_PAGE_SIZE: number = 50;

const SEARCH_DEBOUNCE_MS = 300;
const FILTER_DEBOUNCE_MS = 400;

// ─── Watchlist (localStorage) ──────────────────────────────────────────────────

const WATCHLIST_STORAGE_KEY = "opencrow_appstore_opportunities_watchlist";

function loadWatchlist(): Set<string> {
  try {
    const raw = localStorage.getItem(WATCHLIST_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? new Set(parsed.filter((v): v is string => typeof v === "string"))
      : new Set();
  } catch {
    return new Set();
  }
}

function saveWatchlist(keywords: ReadonlySet<string>): void {
  try {
    localStorage.setItem(WATCHLIST_STORAGE_KEY, JSON.stringify(Array.from(keywords)));
  } catch {
    // localStorage may be unavailable (private mode, quota) — watchlist is a
    // nice-to-have, so fail silently rather than breaking the table.
  }
}

// ─── Columns (single source of truth for both the header row and the cell
// rendering below — every column is sortable server-side per the API contract) ─

interface ColumnDef {
  readonly key: SortKey;
  readonly label: string;
}

const COLUMNS: readonly ColumnDef[] = [
  { key: "keyword", label: "Keyword" },
  { key: "buildability", label: "Buildability" },
  { key: "store", label: "Store" },
  { key: "opportunity", label: "Opportunity" },
  { key: "competitiveness", label: "Competitiveness" },
  { key: "demand", label: "Demand" },
  { key: "incumbentWeakness", label: "Incumbent Weakness" },
  { key: "trend", label: "Trend" },
  { key: "topAppReviews", label: "Top App Reviews" },
  { key: "avgRating", label: "Avg Rating" },
  { key: "avgAgeDays", label: "Avg Age (days)" },
];

const TOTAL_COLUMN_COUNT = COLUMNS.length + 1; // + star column

function renderCell(row: OpportunityRow, key: SortKey): React.ReactNode {
  switch (key) {
    case "keyword":
      return <span className="font-medium text-foreground">{row.keyword}</span>;
    case "buildability": {
      const band = buildabilityBand(row.buildability);
      return (
        <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
          <span className="font-mono font-semibold text-foreground">{row.buildability}</span>
          <span
            className={cn("px-1 py-0.5 rounded text-xs leading-none", band.className)}
            aria-label={`Buildability band: ${band.label}`}
            title={band.label}
          >
            {band.dot}
          </span>
        </span>
      );
    }
    case "store":
      return <span className="text-muted whitespace-nowrap">{formatStore(row.store)}</span>;
    case "opportunity":
      return (
        <div className="flex flex-col leading-tight font-mono text-foreground">
          <span>{formatOpportunity(row.peakOpportunity)}</span>
          <span className="text-[10px] font-sans font-normal text-faint">
            now {formatOpportunity(row.opportunity)}
          </span>
        </div>
      );
    case "competitiveness":
      return (
        <span className="font-mono text-muted whitespace-nowrap">
          {formatCompetitiveness(row.competitiveness)}
        </span>
      );
    case "demand":
      return (
        <span className="font-mono text-muted whitespace-nowrap">{formatDemand(row.demand)}</span>
      );
    case "incumbentWeakness":
      return (
        <span className="font-mono text-muted whitespace-nowrap">
          {formatOpportunity(row.incumbentWeakness)}
        </span>
      );
    case "trend": {
      const badge = trendBadge(row.trend);
      return (
        <span className={cn("px-1.5 py-0.5 rounded text-xs font-medium", badge.className)}>
          {badge.label}
        </span>
      );
    }
    case "topAppReviews":
      return (
        <span className="font-mono text-muted whitespace-nowrap">
          {formatTopAppReviews(row.topAppReviews)}
        </span>
      );
    case "avgRating":
      return (
        <span className="font-mono text-muted whitespace-nowrap">
          {formatAvgRating(row.avgRating)}
        </span>
      );
    case "avgAgeDays":
      return (
        <span className="font-mono text-muted whitespace-nowrap">
          {formatAvgAgeDays(row.avgAgeDays)}
        </span>
      );
  }
}

function ariaSortFor(key: SortKey, sortKey: SortKey, sortDir: SortDir): "ascending" | "descending" | "none" {
  if (key !== sortKey) return "none";
  return sortDir === "asc" ? "ascending" : "descending";
}

// ─── Incumbents panel (row-expand — frontend-only, driven by row.topApps) ───

interface IncumbentsPanelProps {
  readonly row: OpportunityRow;
}

function IncumbentsPanel({ row }: IncumbentsPanelProps) {
  const topApps = useMemo(
    () => [...row.topApps].sort((a, b) => b.reviews - a.reviews).slice(0, 5),
    [row.topApps],
  );
  const verdict = useMemo(
    () =>
      keywordVerdict({
        demand: row.demand,
        incumbentWeakness: row.incumbentWeakness,
        topApps: row.topApps,
      }),
    [row.demand, row.incumbentWeakness, row.topApps],
  );
  const band = useMemo(() => buildabilityBand(row.buildability), [row.buildability]);

  return (
    <div className="flex flex-col gap-2 text-xs">
      <div>
        <div className="text-faint mb-1">Verdict</div>
        <p className="text-foreground">
          <span aria-hidden="true" className="mr-1">
            {band.dot}
          </span>
          {verdict}
        </p>
      </div>
      {topApps.length > 0 && (
        <div>
          <div className="text-faint mb-1">Top incumbents</div>
          <div className="flex flex-wrap gap-x-4 gap-y-1.5">
            {topApps.map((app) => (
              <span key={app.id} className="whitespace-nowrap text-muted">
                <span className="text-foreground font-medium">{app.name}</span>{" "}
                <span className="font-mono">
                  {formatNumber(app.reviews)} · {app.rating.toFixed(1)}★ ·{" "}
                  {Math.round(app.ageDays).toLocaleString()}d
                </span>
                {app.titleMatch && (
                  <span className="ml-1.5 px-1 py-0.5 rounded bg-bg-3 text-faint text-[10px] font-medium">
                    title match
                  </span>
                )}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── OpportunitiesTab (main) ───────────────────────────────────────────────────

export default function OpportunitiesTab() {
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebounce(search, SEARCH_DEBOUNCE_MS);
  const [sortKey, setSortKey] = useState<SortKey>(DEFAULT_SORT_KEY);
  const [sortDir, setSortDir] = useState<SortDir>(DEFAULT_SORT_DIR);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE);

  // Opens already filtered to the "Indie sweet spot" — the raw corpus is 54%
  // dead-demand/noise keywords (see design doc); showing that unfiltered
  // would bury the buildable set.
  const [filters, setFilters] = useState<FilterState>(INDIE_FILTERS);
  const [draft, setDraft] = useState<NumericDraft>(() => toDraft(INDIE_FILTERS));
  const debouncedDraft = useDebounce(draft, FILTER_DEBOUNCE_MS);

  const [watchlist, setWatchlist] = useState<Set<string>>(() => loadWatchlist());
  const [expandedKeyword, setExpandedKeyword] = useState<string | null>(null);
  const [history, setHistory] = useState<
    Record<
      string,
      { readonly history: readonly ScanHistoryPoint[]; readonly meta: OpportunityMeta }
    >
  >({});
  const [historyLoading, setHistoryLoading] = useState<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  // Commit the debounced numeric drafts into `filters`. Bails out (returns
  // the same object reference) when nothing actually changed, so this never
  // triggers a spurious page-reset/refetch on mount or on a no-op edit.
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

  // A new search term, sort column/direction, page size, or filter state
  // always restarts from the first page — otherwise the user could land on
  // an offset past the end of a narrower/reordered result set.
  useEffect(() => {
    setPage(0);
  }, [debouncedSearch, sortKey, sortDir, pageSize, filters]);

  const offset = page * pageSize;
  const activePreset = matchPreset(filters);

  function applyPreset(id: PresetId): void {
    const preset = PRESETS.find((p) => p.id === id) ?? ALL_PRESET;
    setFilters(preset.filters);
    setDraft(toDraft(preset.filters));
    // `Preset.sort` is a loosely-typed `string` in opportunities-format.ts (to
    // avoid a type-only import cycle with this component's `SortKey`) — every
    // preset constant only ever sets it to a real column key, so the cast is safe.
    if (preset.sort) setSortKey(preset.sort as SortKey);
    if (preset.dir) setSortDir(preset.dir);
    setPage(0);
  }

  function setTrend(value: TrendFilterValue | ""): void {
    setFilters((prev) => ({ ...prev, trend: value === "" ? null : value }));
  }

  function setHideJunk(checked: boolean): void {
    setFilters((prev) => ({ ...prev, hideJunk: checked }));
  }

  const listPath = useMemo(() => {
    const params = new URLSearchParams({
      limit: String(pageSize),
      offset: String(offset),
      sort: sortKey,
      dir: sortDir,
    });
    const trimmed = debouncedSearch.trim();
    if (trimmed) params.set("search", trimmed);
    if (filters.trend) params.set("trend", filters.trend);
    if (filters.minDemand !== null) params.set("minDemand", String(filters.minDemand));
    if (filters.maxCompetitiveness !== null) {
      params.set("maxCompetitiveness", String(filters.maxCompetitiveness));
    }
    if (filters.minIncumbentWeakness !== null) {
      params.set("minIncumbentWeakness", String(filters.minIncumbentWeakness));
    }
    if (filters.minOpportunity !== null) {
      params.set("minOpportunity", String(filters.minOpportunity));
    }
    if (filters.minBuildability !== null) {
      params.set("minBuildability", String(filters.minBuildability));
    }
    // hideJunk is always driven by the active preset/toggle in this UI (never
    // an ambiguous "untouched" state), so it's always sent explicitly as the
    // "true"/"false" STRING the Zod schema expects — z.coerce.boolean() would
    // treat the string "false" as truthy, so a bare boolean must never be sent.
    params.set("hideJunk", filters.hideJunk ? "true" : "false");
    return `/api/appstore/opportunities?${params.toString()}`;
  }, [debouncedSearch, sortKey, sortDir, offset, pageSize, filters]);

  // usePolledFetch aborts the previous request and refetches whenever
  // `listPath` changes (search/sort/page/pageSize/filters), and aborts on
  // unmount — the same machinery every other polled view relies on instead
  // of hand-rolled setInterval + AbortController bookkeeping. Because the
  // in-flight request is aborted before the next one starts, a slow stale
  // response can never clobber state out of order.
  const { data, loading } = usePolledFetch<OpportunitiesResponse>(listPath, {
    intervalMs: 30_000,
  });

  const rows = data?.success ? data.data : [];
  const meta = data?.meta;
  const total = meta?.total ?? 0;

  // Clamp the current page if the corpus shrank out from under it (e.g. a
  // background poll picks up fewer rows than before) so the user never lands
  // on an offset past the end of the result set.
  useEffect(() => {
    if (total === 0) return;
    const maxPage = Math.max(0, Math.ceil(total / pageSize) - 1);
    setPage((prev) => (prev > maxPage ? maxPage : prev));
  }, [total, pageSize]);

  // Abort any in-flight per-row history fetch on unmount so a slow response
  // can't resolve into state updates after the component is gone.
  useEffect(() => {
    return () => {
      abortControllerRef.current?.abort();
    };
  }, []);

  function toggleStar(keyword: string): void {
    setWatchlist((prev) => {
      const next = new Set(prev);
      if (next.has(keyword)) {
        next.delete(keyword);
      } else {
        next.add(keyword);
      }
      saveWatchlist(next);
      return next;
    });
  }

  function handleSort(key: SortKey): void {
    if (sortKey === key) {
      setSortDir((prev) => (prev === "desc" ? "asc" : "desc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  }

  async function toggleExpand(keyword: string): Promise<void> {
    if (expandedKeyword === keyword) {
      abortControllerRef.current?.abort();
      setExpandedKeyword(null);
      return;
    }

    // Only one row is ever expanded at a time — abort the previous row's
    // in-flight fetch (if any) before starting this one.
    abortControllerRef.current?.abort();
    setExpandedKeyword(keyword);
    if (history[keyword]) return;

    const controller = new AbortController();
    abortControllerRef.current = controller;
    setHistoryLoading(keyword);
    try {
      const res = await apiFetch<HistoryResponse>(
        `/api/appstore/opportunities/${encodeURIComponent(keyword)}?limit=30`,
        { signal: controller.signal },
      );
      if (controller.signal.aborted) return;
      if (res.success) {
        setHistory((prev) => ({ ...prev, [keyword]: res.data }));
      }
    } catch {
      if (controller.signal.aborted) return;
      // ignore — the trend chart is a nice-to-have, not core table data
    } finally {
      if (!controller.signal.aborted) setHistoryLoading(null);
    }
  }

  const canGoPrev = page > 0;
  const canGoNext = offset + rows.length < total;
  const totalPages = total > 0 ? Math.max(1, Math.ceil(total / pageSize)) : 1;

  function goToPrevPage(): void {
    setPage((prev) => Math.max(0, prev - 1));
  }

  function goToNextPage(): void {
    setPage((prev) => (canGoNext ? prev + 1 : prev));
  }

  // Only the true first load (no data at all yet) unmounts the table into a
  // full-page spinner; subsequent sort/page/search/filter refetches keep the
  // existing rows visible (dimmed) so the table doesn't flicker/reset scroll.
  const isInitialLoad = loading && data === null;
  if (isInitialLoad) return <LoadingState message="Loading keyword opportunities…" />;

  const rangeStart = rows.length === 0 ? 0 : offset + 1;
  const rangeEnd = offset + rows.length;

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
        <div className="max-w-sm flex-1 min-w-[220px]">
          <SearchBar value={search} onChange={setSearch} placeholder="Search all keywords…" />
        </div>
        <span className="text-xs text-faint whitespace-nowrap">
          Showing {rangeStart.toLocaleString()}–{rangeEnd.toLocaleString()} of{" "}
          {total.toLocaleString()}
        </span>
      </div>

      {total === 0 ? (
        <EmptyState
          title="No opportunities yet"
          description="No keywords match these filters — try widening or hit All."
        >
          <Button variant="secondary" size="sm" className="mt-3" onClick={() => applyPreset("all")}>
            All
          </Button>
        </EmptyState>
      ) : (
        <div
          className={cn(
            "overflow-x-auto rounded-lg border border-border-2 transition-opacity duration-150",
            loading && "opacity-60",
          )}
        >
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="border-b border-border-2 bg-bg-1">
                <th className="w-8" aria-hidden="true" />
                {COLUMNS.map((col) => (
                  <th
                    key={col.key}
                    scope="col"
                    aria-sort={ariaSortFor(col.key, sortKey, sortDir)}
                    className="px-3 py-2.5 whitespace-nowrap"
                  >
                    <button
                      type="button"
                      onClick={() => handleSort(col.key)}
                      aria-label={`Sort by ${col.label}`}
                      className={cn(
                        "inline-flex items-center gap-1 cursor-pointer border-none bg-transparent p-0 text-xs font-semibold uppercase tracking-wider transition-colors duration-150",
                        sortKey === col.key ? "text-accent" : "text-faint hover:text-muted",
                      )}
                    >
                      {col.label}
                      {sortKey === col.key && (
                        <span aria-hidden="true">{sortDir === "asc" ? "▲" : "▼"}</span>
                      )}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const starred = watchlist.has(row.keyword);
                const isExpanded = expandedKeyword === row.keyword;
                const rowHistory = history[row.keyword];

                return (
                  <Fragment key={row.keyword}>
                    <tr
                      className="border-b border-border-2/50 hover:bg-bg-1 transition-colors duration-150 cursor-pointer"
                      onClick={() => void toggleExpand(row.keyword)}
                      aria-expanded={isExpanded}
                    >
                      <td className="px-2 py-2 text-center">
                        <button
                          type="button"
                          aria-label={
                            starred
                              ? `Remove ${row.keyword} from watchlist`
                              : `Add ${row.keyword} to watchlist`
                          }
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleStar(row.keyword);
                          }}
                          className={cn(
                            "cursor-pointer bg-transparent border-none p-0.5 text-base leading-none",
                            starred ? "text-yellow-400" : "text-faint hover:text-muted",
                          )}
                        >
                          {starred ? "★" : "☆"}
                        </button>
                      </td>
                      {COLUMNS.map((col) => (
                        <td key={col.key} className="px-3 py-2">
                          {renderCell(row, col.key)}
                        </td>
                      ))}
                    </tr>
                    {isExpanded && (
                      <tr className="bg-bg-1/50 border-b border-border-2/50">
                        <td colSpan={TOTAL_COLUMN_COUNT} className="px-4 py-3">
                          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:gap-6">
                            <div className="min-w-0 flex-1">
                              {historyLoading === row.keyword ? (
                                <span className="text-xs text-faint">Loading trend history…</span>
                              ) : rowHistory ? (
                                <OpportunityTrendChart
                                  history={rowHistory.history}
                                  meta={rowHistory.meta}
                                />
                              ) : (
                                <span className="text-xs text-faint">
                                  Not enough scan history yet.
                                </span>
                              )}
                            </div>
                            <div className="lg:w-[320px] lg:shrink-0">
                              <IncumbentsPanel row={row} />
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <span className="text-xs text-faint">Rows per page</span>
          <select
            className={selectClass}
            value={pageSize}
            onChange={(e) => setPageSize(Number(e.target.value))}
            aria-label="Rows per page"
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
