import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type React from "react";
import { apiFetch } from "../../api";
import { Button, EmptyState, LoadingState, SearchBar } from "../../components";
import { usePolledFetch } from "../../hooks/usePolledFetch";
import { cn } from "../../lib/cn";
import { useDebounce } from "../../lib/use-debounce";
import { formatOpportunity, trendBadge } from "./opportunities-format";
import type { OpportunityMeta, ScanHistoryPoint } from "./OpportunityTrendChart";
import { OpportunityTrendChart } from "./OpportunityTrendChart";

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

const DEFAULT_SORT_KEY: SortKey = "opportunity";
const DEFAULT_SORT_DIR: SortDir = "desc";

const PAGE_SIZE_OPTIONS = [25, 50, 100] as const;
const DEFAULT_PAGE_SIZE: number = 50;

const SEARCH_DEBOUNCE_MS = 300;

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

// ─── Local formatters (page-local — not shared with OpportunityTrendChart,
// unlike the ones in ./opportunities-format) ────────────────────────────────

function formatDemand(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return value.toFixed(1);
}

function formatCompetitiveness(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return Math.round(value).toString();
}

function formatStore(store: OpportunityRow["store"]): string {
  return store === "play" ? "Play" : "App Store";
}

function formatTopAppReviews(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return Math.round(value).toLocaleString();
}

function formatAvgRating(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return value.toFixed(1);
}

function formatAvgAgeDays(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return Math.round(value).toLocaleString();
}

// ─── Columns (single source of truth for both the header row and the cell
// rendering below — every column is sortable server-side per the API contract) ─

interface ColumnDef {
  readonly key: SortKey;
  readonly label: string;
}

const COLUMNS: readonly ColumnDef[] = [
  { key: "keyword", label: "Keyword" },
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

const selectClass =
  "px-2 py-1.5 bg-bg-1 border border-border-2 rounded-lg text-foreground text-xs font-mono outline-none transition-colors duration-150 focus:border-accent cursor-pointer";

// ─── OpportunitiesTab (main) ───────────────────────────────────────────────────

export default function OpportunitiesTab() {
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebounce(search, SEARCH_DEBOUNCE_MS);
  const [sortKey, setSortKey] = useState<SortKey>(DEFAULT_SORT_KEY);
  const [sortDir, setSortDir] = useState<SortDir>(DEFAULT_SORT_DIR);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE);

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

  // A new search term, sort column/direction, or page size always restarts
  // from the first page — otherwise the user could land on an offset past
  // the end of a narrower/reordered result set.
  useEffect(() => {
    setPage(0);
  }, [debouncedSearch, sortKey, sortDir, pageSize]);

  const offset = page * pageSize;

  const listPath = useMemo(() => {
    const params = new URLSearchParams({
      limit: String(pageSize),
      offset: String(offset),
      sort: sortKey,
      dir: sortDir,
    });
    const trimmed = debouncedSearch.trim();
    if (trimmed) params.set("search", trimmed);
    return `/api/appstore/opportunities?${params.toString()}`;
  }, [debouncedSearch, sortKey, sortDir, offset, pageSize]);

  // usePolledFetch aborts the previous request and refetches whenever
  // `listPath` changes (search/sort/page/pageSize), and aborts on unmount —
  // the same machinery every other polled view relies on instead of
  // hand-rolled setInterval + AbortController bookkeeping. Because the
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
  // full-page spinner; subsequent sort/page/search refetches keep the
  // existing rows visible (dimmed) so the table doesn't flicker/reset scroll.
  const isInitialLoad = loading && data === null;
  if (isInitialLoad) return <LoadingState message="Loading keyword opportunities…" />;

  if (total === 0 && !debouncedSearch.trim()) {
    return (
      <EmptyState
        title="No opportunities yet"
        description="Keyword gap scans will appear here once the scanner has run."
      />
    );
  }

  const rangeStart = rows.length === 0 ? 0 : offset + 1;
  const rangeEnd = offset + rows.length;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="max-w-sm flex-1 min-w-[220px]">
          <SearchBar value={search} onChange={setSearch} placeholder="Search all keywords…" />
        </div>
        <span className="text-xs text-faint whitespace-nowrap">
          Showing {rangeStart.toLocaleString()}–{rangeEnd.toLocaleString()} of{" "}
          {total.toLocaleString()}
        </span>
      </div>

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
            {rows.length === 0 ? (
              <tr>
                <td
                  colSpan={TOTAL_COLUMN_COUNT}
                  className="px-3 py-6 text-center text-sm text-faint"
                >
                  No keywords match &ldquo;{search}&rdquo;.
                </td>
              </tr>
            ) : (
              rows.map((row) => {
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
                          {historyLoading === row.keyword ? (
                            <span className="text-xs text-faint">Loading trend history…</span>
                          ) : rowHistory ? (
                            <OpportunityTrendChart
                              history={rowHistory.history}
                              meta={rowHistory.meta}
                            />
                          ) : (
                            <span className="text-xs text-faint">Not enough scan history yet.</span>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })
            )}
          </tbody>
        </table>
      </div>

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
