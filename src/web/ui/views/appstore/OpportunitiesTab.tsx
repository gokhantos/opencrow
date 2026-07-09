import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { apiFetch } from "../../api";
import { EmptyState, LoadingState } from "../../components";
import { cn } from "../../lib/cn";
import { formatOpportunity, trendBadge } from "./opportunities-format";

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
  readonly trend: string;
  readonly topAppReviews: number;
  readonly avgRating: number;
  readonly avgAgeDays: number;
}

type SortKey =
  | "keyword"
  | "opportunity"
  | "competitiveness"
  | "demand"
  | "incumbentWeakness"
  | "trend";
type SortDir = "asc" | "desc";

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

function compareRows(a: OpportunityRow, b: OpportunityRow, key: SortKey): number {
  if (key === "keyword" || key === "trend") {
    return a[key].localeCompare(b[key]);
  }
  return a[key] - b[key];
}

// ─── Columns ──────────────────────────────────────────────────────────────────

const COLUMNS: ReadonlyArray<{ readonly key: SortKey; readonly label: string }> = [
  { key: "keyword", label: "Keyword" },
  { key: "opportunity", label: "Opportunity" },
  { key: "competitiveness", label: "Competitiveness" },
  { key: "demand", label: "Demand" },
  { key: "incumbentWeakness", label: "Incumbent Weakness" },
  { key: "trend", label: "Trend" },
];

// ─── Sparkline (lazy, per-row expand) ──────────────────────────────────────────

interface SparklineProps {
  readonly history: readonly OpportunityRow[];
}

function Sparkline({ history }: SparklineProps) {
  if (history.length < 2) {
    return (
      <span className="text-xs text-faint">Not enough scan history for a trend chart yet.</span>
    );
  }

  // History arrives newest-first (ORDER BY scanned_at DESC); plot oldest→newest.
  const ordered = [...history].reverse();
  const values = ordered.map((p) => p.opportunity);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const width = 220;
  const height = 36;
  const step = ordered.length > 1 ? width / (ordered.length - 1) : 0;
  const points = values
    .map((v, i) => {
      const x = i * step;
      const y = height - ((v - min) / range) * height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  return (
    <div className="flex items-center gap-3">
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label="Opportunity trend sparkline"
        className="text-accent shrink-0"
      >
        <polyline points={points} fill="none" stroke="currentColor" strokeWidth={1.5} />
      </svg>
      <span className="text-xs text-faint font-mono">{ordered.length} scans</span>
    </div>
  );
}

// ─── OpportunitiesTab (main) ───────────────────────────────────────────────────

export default function OpportunitiesTab() {
  const [rows, setRows] = useState<OpportunityRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [sortKey, setSortKey] = useState<SortKey>("opportunity");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [watchlist, setWatchlist] = useState<Set<string>>(() => loadWatchlist());
  const [expandedKeyword, setExpandedKeyword] = useState<string | null>(null);
  const [history, setHistory] = useState<Record<string, readonly OpportunityRow[]>>({});
  const [historyLoading, setHistoryLoading] = useState<string | null>(null);

  const fetchAll = useCallback(async () => {
    try {
      const res = await apiFetch<{ success: boolean; data: OpportunityRow[] }>(
        "/api/appstore/opportunities?limit=100",
      );
      if (res.success) setRows(res.data);
    } catch {
      // silently ignore, follow AppStore.tsx's existing fetch convention
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    void fetchAll();
  }, [fetchAll]);

  function handleSort(key: SortKey): void {
    if (key === sortKey) {
      setSortDir((prev) => (prev === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  }

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
      setExpandedKeyword(null);
      return;
    }
    setExpandedKeyword(keyword);
    if (history[keyword]) return;

    setHistoryLoading(keyword);
    try {
      const res = await apiFetch<{ success: boolean; data: OpportunityRow[] }>(
        `/api/appstore/opportunities/${encodeURIComponent(keyword)}?limit=30`,
      );
      if (res.success) {
        setHistory((prev) => ({ ...prev, [keyword]: res.data }));
      }
    } catch {
      // ignore — the sparkline is a nice-to-have, not core table data
    } finally {
      setHistoryLoading(null);
    }
  }

  const sorted = useMemo(() => {
    const copy = [...rows];
    copy.sort((a, b) => {
      const cmp = compareRows(a, b, sortKey);
      return sortDir === "asc" ? cmp : -cmp;
    });
    return copy;
  }, [rows, sortKey, sortDir]);

  if (loading) return <LoadingState message="Loading keyword opportunities…" />;

  if (rows.length === 0) {
    return (
      <EmptyState
        title="No opportunities yet"
        description="Keyword gap scans will appear here once the scanner has run."
      />
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-border-2">
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="border-b border-border-2 bg-bg-1">
            <th className="w-8" aria-hidden="true" />
            {COLUMNS.map((col) => (
              <th
                key={col.key}
                scope="col"
                aria-sort={
                  sortKey === col.key ? (sortDir === "asc" ? "ascending" : "descending") : "none"
                }
                className="text-left text-xs font-semibold text-faint uppercase tracking-wider px-3 py-2.5 cursor-pointer select-none whitespace-nowrap hover:text-muted"
                onClick={() => handleSort(col.key)}
              >
                {col.label}
                {sortKey === col.key && (
                  <span className="ml-1 text-accent" aria-hidden="true">
                    {sortDir === "asc" ? "▲" : "▼"}
                  </span>
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => {
            const starred = watchlist.has(row.keyword);
            const badge = trendBadge(row.trend);
            const isExpanded = expandedKeyword === row.keyword;

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
                    {formatOpportunity(row.opportunity)}
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
                      className={cn("px-1.5 py-0.5 rounded text-xs font-medium", badge.className)}
                    >
                      {badge.label}
                    </span>
                  </td>
                </tr>
                {isExpanded && (
                  <tr className="bg-bg-1/50 border-b border-border-2/50">
                    <td colSpan={COLUMNS.length + 1} className="px-4 py-3">
                      {historyLoading === row.keyword ? (
                        <span className="text-xs text-faint">Loading trend history…</span>
                      ) : (
                        <Sparkline history={history[row.keyword] ?? []} />
                      )}
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
