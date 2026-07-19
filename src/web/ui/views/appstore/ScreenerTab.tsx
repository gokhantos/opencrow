/**
 * ScreenerTab — newborn-velocity screener signature hits (App Store keyword
 * research). Lists keywords that have crossed the validated "window-opening
 * signature" (see `src/sources/appstore/keyword-screener.ts`) and lets an
 * operator triage each hit: Acknowledge (new -> active) or Dismiss
 * (new/active -> dismissed). Backed by `GET/PATCH /api/appstore/signature-hits`.
 */

import { Fragment, useMemo, useState } from "react";
import { apiFetch } from "../../api";
import { Button, EmptyState, FilterTabs, LoadingState, StatusBadge } from "../../components";
import { useToast } from "../../components/Toast";
import { usePolledFetch } from "../../hooks/usePolledFetch";
import { cn } from "../../lib/cn";
import { formatNumber, timeAgo } from "../../lib/format";
import { formatCompetitiveness } from "./opportunities-format";
import {
  countByStatus,
  DEFAULT_STATUS_FILTER,
  formatIntOrDash,
  formatVelocityRatio,
  formatZone,
  matchesStatusFilter,
  SIGNATURE_SUMMARY,
  STATUS_BADGE_COLOR_MAP,
  STATUS_FILTER_TABS,
  type SignatureHit,
  type SignatureHitStatus,
  type StatusFilter,
} from "./screener-format";

const LIST_PATH = "/api/appstore/signature-hits?limit=300";
const POLL_INTERVAL_MS = 30_000;

/** Response shape of `GET /appstore/signature-hits`. */
interface SignatureHitsResponse {
  readonly success: boolean;
  readonly data: readonly SignatureHit[];
}

/** Response shape of `PATCH /appstore/signature-hits/:keyword`. */
interface PatchResponse {
  readonly success: boolean;
  readonly data?: SignatureHit;
  readonly error?: string;
}

// Keyword, Zone, Comp, Velocity ratio, Fast newcomers, Accelerating, Max
// reviews, First detected, Times seen, Status, Actions.
const COLUMN_LABELS: readonly string[] = [
  "Keyword",
  "Zone",
  "Comp",
  "Velocity ratio",
  "Fast newcomers",
  "Accelerating",
  "Max reviews",
  "First detected",
  "Times seen",
  "Status",
  "Actions",
];
const TOTAL_COLUMN_COUNT = COLUMN_LABELS.length;

// ─── Top-apps snapshot (row-expand — frontend-only, driven by hit.topAppsSnapshot) ──

interface SnapshotPanelProps {
  readonly hit: SignatureHit;
}

function SnapshotPanel({ hit }: SnapshotPanelProps) {
  const topApps = useMemo(
    () => [...hit.topAppsSnapshot].sort((a, b) => b.reviews - a.reviews).slice(0, 6),
    [hit.topAppsSnapshot],
  );

  if (topApps.length === 0) {
    return <span className="text-xs text-faint">No incumbent snapshot recorded.</span>;
  }

  return (
    <div className="flex flex-col gap-1.5 text-xs">
      <div className="text-faint mb-0.5">Top apps at detection</div>
      <div className="flex flex-wrap gap-x-4 gap-y-1.5">
        {topApps.map((app) => (
          <span key={app.id} className="whitespace-nowrap text-muted">
            <span className="text-foreground font-medium">{app.name}</span>{" "}
            <span className="font-mono">
              {formatNumber(app.reviews)} · {app.rating.toFixed(1)}★ · {Math.round(app.ageDays)}d
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}

// ─── ScreenerTab (main) ──────────────────────────────────────────────────────

export default function ScreenerTab() {
  const toast = useToast();
  const [statusFilter, setStatusFilter] = useState<StatusFilter>(DEFAULT_STATUS_FILTER);
  const [expandedKeyword, setExpandedKeyword] = useState<string | null>(null);
  const [mutatingKeyword, setMutatingKeyword] = useState<string | null>(null);

  // A single, constant list path — the screener corpus is small (max 500
  // server-side) so filtering happens client-side against the full fetch
  // rather than re-querying per tab, which keeps tab switches instant and
  // avoids re-triggering the initial-load spinner on every filter change.
  const { data, loading, refetch } = usePolledFetch<SignatureHitsResponse>(LIST_PATH, {
    intervalMs: POLL_INTERVAL_MS,
  });

  const hits = data?.success ? data.data : [];
  const counts = useMemo(() => countByStatus(hits), [hits]);
  const filteredHits = useMemo(
    () => hits.filter((hit) => matchesStatusFilter(hit.status, statusFilter)),
    [hits, statusFilter],
  );
  const tabs = useMemo(
    () => STATUS_FILTER_TABS.map((tab) => ({ ...tab, count: counts[tab.id] })),
    [counts],
  );

  async function updateStatus(
    keyword: string,
    status: Exclude<SignatureHitStatus, "new">,
  ): Promise<void> {
    setMutatingKeyword(keyword);
    try {
      const res = await apiFetch<PatchResponse>(
        `/api/appstore/signature-hits/${encodeURIComponent(keyword)}`,
        { method: "PATCH", body: JSON.stringify({ status }) },
      );
      if (res.success) {
        toast.success(status === "active" ? `Acknowledged "${keyword}"` : `Dismissed "${keyword}"`);
        refetch();
      } else {
        toast.error(res.error ?? "Failed to update signature hit");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update signature hit");
    } finally {
      setMutatingKeyword(null);
    }
  }

  function toggleExpand(keyword: string): void {
    setExpandedKeyword((prev) => (prev === keyword ? null : keyword));
  }

  // Only the true first load (no data at all yet) unmounts the table into a
  // full-page spinner; subsequent poll refreshes keep the existing rows
  // visible (dimmed) so the table doesn't flicker.
  const isInitialLoad = loading && data === null;
  if (isInitialLoad) return <LoadingState message="Loading signature hits…" />;

  return (
    <div className="flex flex-col gap-3">
      <div>
        <div className="flex items-center gap-2 mb-1">
          <h3 className="text-sm font-semibold text-foreground uppercase tracking-wide">
            Screener
          </h3>
          {counts.new > 0 && (
            <span
              className="inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded font-mono text-xs font-semibold bg-accent-subtle text-accent"
              aria-label={`${counts.new} new signature hits`}
            >
              {counts.new} new
            </span>
          )}
        </div>
        <p className="text-xs text-muted">{SIGNATURE_SUMMARY}</p>
      </div>

      <FilterTabs
        tabs={tabs}
        active={statusFilter}
        onChange={(id) => setStatusFilter(id as StatusFilter)}
      />

      {filteredHits.length === 0 ? (
        <EmptyState
          title="No signature hits"
          description="No keywords in this filter have crossed the newborn-velocity signature yet."
        />
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
                {COLUMN_LABELS.map((label) => (
                  <th
                    key={label}
                    scope="col"
                    className="px-3 py-2.5 whitespace-nowrap text-left text-xs font-semibold uppercase tracking-wider text-faint"
                  >
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filteredHits.map((hit) => {
                const isExpanded = expandedKeyword === hit.keyword;
                const isMutating = mutatingKeyword === hit.keyword;

                return (
                  <Fragment key={hit.keyword}>
                    <tr
                      className="border-b border-border-2/50 hover:bg-bg-1 transition-colors duration-150 cursor-pointer"
                      onClick={() => toggleExpand(hit.keyword)}
                      aria-expanded={isExpanded}
                    >
                      <td className="px-3 py-2 font-medium text-foreground">{hit.keyword}</td>
                      <td className="px-3 py-2 text-muted whitespace-nowrap">
                        {formatZone(hit.genreZone)}
                      </td>
                      <td className="px-3 py-2 font-mono text-muted whitespace-nowrap">
                        {hit.competitiveness === null ? "—" : formatCompetitiveness(hit.competitiveness)}
                      </td>
                      <td className="px-3 py-2 font-mono text-muted whitespace-nowrap">
                        {formatVelocityRatio(hit.velocityRatio)}
                      </td>
                      <td className="px-3 py-2 font-mono text-muted whitespace-nowrap">
                        {formatIntOrDash(hit.fastNewcomers)}
                      </td>
                      <td className="px-3 py-2 font-mono text-muted whitespace-nowrap">
                        {formatIntOrDash(hit.acceleratingApps)}
                      </td>
                      <td className="px-3 py-2 font-mono text-muted whitespace-nowrap">
                        {formatIntOrDash(hit.maxReviews)}
                      </td>
                      <td className="px-3 py-2 text-muted whitespace-nowrap">
                        {timeAgo(hit.firstDetectedAt)}
                      </td>
                      <td className="px-3 py-2 font-mono text-muted whitespace-nowrap">
                        {hit.timesSeen}
                      </td>
                      <td className="px-3 py-2">
                        <StatusBadge status={hit.status} colorMap={STATUS_BADGE_COLOR_MAP} />
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        <div className="flex items-center gap-1.5">
                          {hit.status === "new" && (
                            <Button
                              variant="secondary"
                              size="sm"
                              disabled={isMutating}
                              onClick={(e) => {
                                e.stopPropagation();
                                void updateStatus(hit.keyword, "active");
                              }}
                            >
                              Acknowledge
                            </Button>
                          )}
                          {(hit.status === "new" || hit.status === "active") && (
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={isMutating}
                              onClick={(e) => {
                                e.stopPropagation();
                                void updateStatus(hit.keyword, "dismissed");
                              }}
                            >
                              Dismiss
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                    {isExpanded && (
                      <tr className="bg-bg-1/50 border-b border-border-2/50">
                        <td colSpan={TOTAL_COLUMN_COUNT} className="px-4 py-3">
                          <SnapshotPanel hit={hit} />
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
    </div>
  );
}
