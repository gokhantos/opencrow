import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { apiFetch } from "../../api";
import { Button, EmptyState, LoadingState, SearchBar } from "../../components";
import { usePolledFetch } from "../../hooks/usePolledFetch";
import { cn } from "../../lib/cn";
import { useDebounce } from "../../lib/use-debounce";
import {
  formatFirstFound,
  formatOpportunity,
  sourceBadge,
  trendBadge,
} from "./opportunities-format";
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

/** Server-side ranking mode — mirrors the backend `sort` query param. */
type SortMode = "peak" | "latest";

const PAGE_SIZE = 50;
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

// ─── Local formatters ───────────────────────────────────────────────────────────

function formatDemand(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return value.toFixed(1);
}

function formatCompetitiveness(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return Math.round(value).toString();
}

// ─── Columns (display-only — ranking is now server-driven, see the Opportunity
// column's Peak/Latest toggle below) ────────────────────────────────────────

const DATA_COLUMNS: ReadonlyArray<{ readonly label: string }> = [
  { label: "Competitiveness" },
  { label: "Demand" },
  { label: "Incumbent Weakness" },
  { label: "Trend" },
  { label: "First Found" },
];

const TOTAL_COLUMN_COUNT = DATA_COLUMNS.length + 3; // star + keyword + opportunity

// ─── OpportunitiesTab (main) ───────────────────────────────────────────────────

export default function OpportunitiesTab() {
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebounce(search, SEARCH_DEBOUNCE_MS);
  const [sort, setSort] = useState<SortMode>("peak");
  const [offset, setOffset] = useState(0);

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

  // A new search term or ranking mode always restarts from the first page —
  // otherwise the user could land on an offset past the end of a narrower result set.
  useEffect(() => {
    setOffset(0);
  }, [debouncedSearch, sort]);

  const listPath = useMemo(() => {
    const params = new URLSearchParams({
      limit: String(PAGE_SIZE),
      offset: String(offset),
      sort,
    });
    const trimmed = debouncedSearch.trim();
    if (trimmed) params.set("search", trimmed);
    return `/api/appstore/opportunities?${params.toString()}`;
  }, [debouncedSearch, sort, offset]);

  // usePolledFetch aborts the previous request and refetches whenever
  // `listPath` changes (search/sort/page), and aborts on unmount — the same
  // machinery every other polled view relies on instead of hand-rolled
  // setInterval + AbortController bookkeeping.
  const { data, loading } = usePolledFetch<OpportunitiesResponse>(listPath, {
    intervalMs: 30_000,
  });

  const rows = data?.success ? data.data : [];
  const meta = data?.meta;
  const total = meta?.total ?? 0;
  const limit = meta?.limit ?? PAGE_SIZE;

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

  const canGoPrev = offset > 0;
  const canGoNext = offset + rows.length < total;

  function goToPrevPage(): void {
    setOffset((prev) => Math.max(0, prev - limit));
  }

  function goToNextPage(): void {
    setOffset((prev) => (prev + limit < total ? prev + limit : prev));
  }

  if (loading) return <LoadingState message="Loading keyword opportunities…" />;

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
          {rangeStart}-{rangeEnd} of {total}
        </span>
      </div>

      <div className="overflow-x-auto rounded-lg border border-border-2">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="border-b border-border-2 bg-bg-1">
              <th className="w-8" aria-hidden="true" />
              <th
                scope="col"
                className="text-left text-xs font-semibold text-faint uppercase tracking-wider px-3 py-2.5 whitespace-nowrap"
              >
                Keyword
              </th>
              <th
                scope="col"
                aria-sort="descending"
                className="text-left text-xs font-semibold text-faint uppercase tracking-wider px-3 py-2.5 whitespace-nowrap"
              >
                <div className="flex flex-col gap-1">
                  <span>Opportunity</span>
                  <div
                    className="flex gap-1 normal-case tracking-normal"
                    role="group"
                    aria-label="Rank by"
                  >
                    <button
                      type="button"
                      aria-pressed={sort === "peak"}
                      onClick={() => setSort("peak")}
                      className={cn(
                        "px-1.5 py-0.5 rounded text-[10px] font-semibold cursor-pointer border-none transition-colors",
                        sort === "peak"
                          ? "bg-accent text-white"
                          : "bg-bg-3 text-faint hover:text-muted",
                      )}
                    >
                      Peak
                    </button>
                    <button
                      type="button"
                      aria-pressed={sort === "latest"}
                      onClick={() => setSort("latest")}
                      className={cn(
                        "px-1.5 py-0.5 rounded text-[10px] font-semibold cursor-pointer border-none transition-colors",
                        sort === "latest"
                          ? "bg-accent text-white"
                          : "bg-bg-3 text-faint hover:text-muted",
                      )}
                    >
                      Latest
                    </button>
                  </div>
                </div>
              </th>
              {DATA_COLUMNS.map((col) => (
                <th
                  key={col.label}
                  scope="col"
                  className="text-left text-xs font-semibold text-faint uppercase tracking-wider px-3 py-2.5 whitespace-nowrap"
                >
                  {col.label}
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
                const badge = trendBadge(row.trend);
                const source = sourceBadge(row.source);
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
                      <td className="px-3 py-2 font-medium text-foreground">{row.keyword}</td>
                      <td className="px-3 py-2 font-mono text-foreground">
                        <div className="flex flex-col leading-tight">
                          <span>{formatOpportunity(row.peakOpportunity)}</span>
                          <span className="text-[10px] font-sans font-normal text-faint">
                            now {formatOpportunity(row.opportunity)}
                          </span>
                        </div>
                      </td>
                      <td className="px-3 py-2 font-mono text-muted">
                        {formatCompetitiveness(row.competitiveness)}
                      </td>
                      <td className="px-3 py-2 font-mono text-muted">{formatDemand(row.demand)}</td>
                      <td className="px-3 py-2 font-mono text-muted">
                        {formatOpportunity(row.incumbentWeakness)}
                      </td>
                      <td className="px-3 py-2">
                        <span
                          className={cn(
                            "px-1.5 py-0.5 rounded text-xs font-medium",
                            badge.className,
                          )}
                        >
                          {badge.label}
                        </span>
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-1.5 whitespace-nowrap">
                          <span className="font-mono text-muted">
                            {formatFirstFound(row.firstFoundAt)}
                          </span>
                          <span
                            className={cn(
                              "px-1.5 py-0.5 rounded text-xs font-medium",
                              source.className,
                            )}
                          >
                            {source.label}
                          </span>
                        </div>
                      </td>
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

      <div className="flex items-center justify-end gap-2">
        <Button variant="secondary" size="sm" onClick={goToPrevPage} disabled={!canGoPrev}>
          Prev
        </Button>
        <Button variant="secondary" size="sm" onClick={goToNextPage} disabled={!canGoNext}>
          Next
        </Button>
      </div>
    </div>
  );
}
