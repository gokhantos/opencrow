import React, { useState, useEffect, useRef, useCallback } from "react";
import { useLocalStorage } from "../lib/useLocalStorage";
import * as echarts from "echarts";
import { apiFetch } from "../api";
import { PageHeader, LoadingState, EmptyState, FilterTabs } from "../components";
import { formatNumber, relativeTime } from "../lib/format";
import { cn } from "../lib/cn";

/* ── types ─────────────────────────────────────────────────────── */

interface AgentErrors {
  agentId: string;
  errorCount: number;
  uniqueErrors: number;
}

interface TimelineBucket {
  bucket: string;
  count: number;
}

interface FailureSummary {
  totalErrors: number;
  uniqueErrors: number;
  errorRate: number;
  mostFailingAgent: string | null;
  byAgent: AgentErrors[];
  timeline: TimelineBucket[];
}

interface FailureRecord {
  id: string;
  sessionId: string;
  agentId: string;
  domain: string;
  errorMessage: string;
  errorSignature: string;
  errorType: string;
  createdAt: string;
}

interface FailurePattern {
  id: string;
  domain: string;
  agentId: string | null;
  errorSignature: string;
  occurrenceCount: number;
  firstSeen: string | null;
  lastSeen: string | null;
  recommendedAction: string | null;
  isResolved: boolean;
  severity: string;
}

interface AlertRecord {
  id: string;
  category: string;
  level: string;
  title: string;
  detail: string;
  metric: number | null;
  threshold: number | null;
  firedAt: number;
  resolvedAt: number | null;
}

interface AntiRec {
  id: string;
  agentId: string;
  domain: string | null;
  reason: string;
  failureCount: number;
  confidence: number;
  validUntil: string;
  createdAt: string;
}

/* ── constants ─────────────────────────────────────────────────── */

const RANGES = [
  { id: "24h", label: "24h" },
  { id: "7d", label: "7d" },
  { id: "30d", label: "30d" },
] as const;

const TH =
  "text-[10px] font-semibold text-faint uppercase tracking-[0.1em] px-4 py-2.5";

/* ── helpers ───────────────────────────────────────────────────── */

function severityColor(severity: string): string {
  switch (severity) {
    case "high":
    case "critical":
      return "text-red-400";
    case "medium":
      return "text-amber-400";
    default:
      return "text-faint";
  }
}

function levelBadge(level: string) {
  const base = "inline-flex items-center px-2 py-0.5 rounded text-[11px] font-semibold";
  switch (level) {
    case "critical":
      return cn(base, "bg-red-500/20 text-red-400");
    case "warning":
      return cn(base, "bg-amber-500/20 text-amber-400");
    default:
      return cn(base, "bg-blue-500/20 text-blue-400");
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}...` : s;
}

function isoRelative(iso: string): string {
  const epoch = Math.floor(new Date(iso).getTime() / 1000);
  return relativeTime(epoch);
}

/* ── stat card ─────────────────────────────────────────────────── */

function StatCard({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: string;
}) {
  return (
    <div className="bg-bg-1 border border-border rounded-lg px-5 py-4">
      <div className="text-[10px] font-semibold text-faint uppercase tracking-[0.12em] mb-2">
        {label}
      </div>
      <div
        className={cn(
          "text-xl font-bold font-mono leading-none",
          accent ?? "text-strong",
        )}
      >
        {value}
      </div>
      {sub && (
        <div className="text-[11px] text-faint mt-2 leading-relaxed">{sub}</div>
      )}
    </div>
  );
}

/* ── timeline chart ────────────────────────────────────────────── */

function ErrorTimeline({ data }: { data: readonly TimelineBucket[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const chart = echarts.init(el, undefined, { renderer: "canvas" });
    chartRef.current = chart;

    const handleResize = () => chart.resize();
    window.addEventListener("resize", handleResize);
    const ro = new ResizeObserver(() => chart.resize());
    ro.observe(el);

    return () => {
      window.removeEventListener("resize", handleResize);
      ro.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || data.length === 0) return;

    const labels = data.map((d) => {
      const date = new Date(d.bucket);
      return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    });

    chart.setOption(
      {
        tooltip: {
          trigger: "axis",
          backgroundColor: "rgba(20,20,25,0.95)",
          borderColor: "rgba(255,255,255,0.08)",
          textStyle: { color: "#e0e0e0", fontSize: 12 },
        },
        grid: { left: 50, right: 20, top: 20, bottom: 30 },
        xAxis: {
          type: "category",
          data: labels,
          axisLine: { lineStyle: { color: "rgba(255,255,255,0.1)" } },
          axisLabel: { color: "#888", fontSize: 11 },
        },
        yAxis: {
          type: "value",
          name: "Errors",
          nameTextStyle: { color: "#888", fontSize: 11 },
          axisLabel: { color: "#888", fontSize: 11 },
          splitLine: { lineStyle: { color: "rgba(255,255,255,0.05)" } },
          minInterval: 1,
        },
        series: [
          {
            name: "Errors",
            type: "bar",
            data: data.map((d) => d.count),
            itemStyle: { color: "rgba(239,68,68,0.7)" },
            barMaxWidth: 24,
          },
        ],
      },
      { notMerge: true },
    );
  }, [data]);

  return <div ref={containerRef} className="w-full h-[240px]" />;
}

/* ── main component ────────────────────────────────────────────── */

export default function Failures() {
  const [range, setRange] = useLocalStorage<string>("failures:range", "24h");
  const [summary, setSummary] = useState<FailureSummary | null>(null);
  const [recent, setRecent] = useState<FailureRecord[]>([]);
  const [patterns, setPatterns] = useState<FailurePattern[]>([]);
  const [alerts, setAlerts] = useState<AlertRecord[]>([]);
  const [antiRecs, setAntiRecs] = useState<AntiRec[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const [sumRes, recentRes, patternsRes, alertsRes, antiRes] =
        await Promise.all([
          apiFetch<{ success: boolean; data: FailureSummary }>(
            `/api/failures/summary?window=${range}`,
          ),
          apiFetch<{ success: boolean; data: FailureRecord[] }>(
            "/api/failures/recent?limit=50",
          ),
          apiFetch<{ success: boolean; data: FailurePattern[] }>(
            "/api/failures/patterns?minOccurrences=2",
          ),
          apiFetch<{ success: boolean; data: AlertRecord[] }>(
            "/api/failures/alerts?limit=50",
          ),
          apiFetch<{ success: boolean; data: AntiRec[] }>(
            "/api/failures/anti-recommendations",
          ),
        ]);
      if (sumRes.success) setSummary(sumRes.data);
      if (recentRes.success) setRecent(recentRes.data);
      if (patternsRes.success) setPatterns(patternsRes.data);
      if (alertsRes.success) setAlerts(alertsRes.data);
      if (antiRes.success) setAntiRecs(antiRes.data);
    } catch {
      // silently handle
    } finally {
      setLoading(false);
    }
  }, [range]);

  useEffect(() => {
    setLoading(true);
    fetchData();
    const interval = setInterval(fetchData, 30_000);
    return () => clearInterval(interval);
  }, [fetchData]);

  if (loading && !summary) {
    return <LoadingState message="Loading failure data..." />;
  }

  const totalErrors = summary?.totalErrors ?? 0;
  const errorRatePct = ((summary?.errorRate ?? 0) * 100).toFixed(1);
  const activePatterns = patterns.filter((p) => !p.isResolved);

  return (
    <div className="max-w-[1200px]">
      <PageHeader
        title="Failure Patterns"
        subtitle="Agent error analysis, patterns, and alerts"
      />

      <FilterTabs
        tabs={RANGES.map((r) => ({ id: r.id, label: r.label }))}
        active={range}
        onChange={setRange}
      />

      {/* Summary cards */}
      <div className="grid grid-cols-4 max-lg:grid-cols-2 max-sm:grid-cols-1 gap-3 mb-6">
        <StatCard
          label="Total Errors"
          value={formatNumber(totalErrors)}
          accent="text-red-400"
          sub={`${range} window`}
        />
        <StatCard
          label="Error Rate"
          value={`${errorRatePct}%`}
          accent={
            Number(errorRatePct) >= 10
              ? "text-red-400"
              : Number(errorRatePct) >= 5
                ? "text-amber-400"
                : "text-emerald-400"
          }
          sub="failures / (failures + tasks)"
        />
        <StatCard
          label="Most Failing Agent"
          value={summary?.mostFailingAgent ?? "\u2014"}
          accent="text-amber-400"
        />
        <StatCard
          label="Active Patterns"
          value={String(activePatterns.length)}
          accent={activePatterns.length > 0 ? "text-amber-400" : "text-emerald-400"}
          sub={`${summary?.uniqueErrors ?? 0} unique signatures`}
        />
      </div>

      {/* Error timeline */}
      {(summary?.timeline?.length ?? 0) > 0 && (
        <div className="bg-bg-1 border border-border rounded-lg p-5 mb-6">
          <h3 className="text-xs font-semibold text-muted uppercase tracking-[0.1em] mb-3">
            Error Timeline
          </h3>
          <ErrorTimeline data={summary!.timeline} />
        </div>
      )}

      {/* Error rate by agent */}
      {(summary?.byAgent?.length ?? 0) > 0 && (
        <div className="bg-bg-1 border border-border rounded-lg overflow-hidden mb-6">
          <div className="px-4 py-3 border-b border-border flex items-center justify-between">
            <h3 className="text-xs font-semibold text-muted uppercase tracking-[0.1em]">
              Errors by Agent
            </h3>
            <span className="text-[11px] font-mono text-faint">
              {summary!.byAgent.length} agents
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className={cn(TH, "text-left")}>Agent</th>
                  <th className={cn(TH, "text-right")}>Errors</th>
                  <th className={cn(TH, "text-right")}>Unique</th>
                  <th className={cn(TH, "text-left")}>Distribution</th>
                </tr>
              </thead>
              <tbody>
                {summary!.byAgent.map((a) => {
                  const maxCount = summary!.byAgent[0]?.errorCount ?? 1;
                  const pct = Math.round((a.errorCount / maxCount) * 100);
                  return (
                    <tr
                      key={a.agentId}
                      className="border-b border-border/30 hover:bg-bg-2/50 transition-colors"
                    >
                      <td className="px-4 py-2.5 font-mono text-foreground text-sm">
                        {a.agentId}
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono text-red-400">
                        {a.errorCount}
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono text-muted">
                        {a.uniqueErrors}
                      </td>
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-2">
                          <div className="flex-1 h-1.5 rounded-full bg-bg-3 overflow-hidden min-w-[60px]">
                            <div
                              className="h-full rounded-full bg-red-400/60 transition-all"
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Failure patterns */}
      <div className="bg-bg-1 border border-border rounded-lg overflow-hidden mb-6">
        <div className="px-4 py-3 border-b border-border flex items-center justify-between">
          <h3 className="text-xs font-semibold text-muted uppercase tracking-[0.1em]">
            Failure Patterns
          </h3>
          <span className="text-[11px] font-mono text-faint">
            {activePatterns.length} active / {patterns.length} total
          </span>
        </div>
        {patterns.length === 0 ? (
          <EmptyState description="No failure patterns detected yet." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className={cn(TH, "text-left")}>Signature</th>
                  <th className={cn(TH, "text-left")}>Domain</th>
                  <th className={cn(TH, "text-left")}>Agent</th>
                  <th className={cn(TH, "text-right")}>Count</th>
                  <th className={cn(TH, "text-left")}>Severity</th>
                  <th className={cn(TH, "text-left")}>Status</th>
                  <th className={cn(TH, "text-right")}>Last Seen</th>
                </tr>
              </thead>
              <tbody>
                {patterns.map((p) => (
                  <tr
                    key={p.id}
                    className="border-b border-border/30 hover:bg-bg-2/50 transition-colors"
                  >
                    <td
                      className="px-4 py-2.5 font-mono text-xs text-foreground max-w-[300px] truncate"
                      title={p.errorSignature}
                    >
                      {truncate(p.errorSignature, 60)}
                    </td>
                    <td className="px-4 py-2.5 text-muted text-xs">{p.domain}</td>
                    <td className="px-4 py-2.5 font-mono text-xs text-muted">
                      {p.agentId ?? "\u2014"}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono text-red-400">
                      {p.occurrenceCount}
                    </td>
                    <td className="px-4 py-2.5">
                      <span className={cn("text-xs font-semibold", severityColor(p.severity))}>
                        {p.severity}
                      </span>
                    </td>
                    <td className="px-4 py-2.5">
                      {p.isResolved ? (
                        <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium bg-emerald-500/20 text-emerald-400">
                          resolved
                        </span>
                      ) : (
                        <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium bg-red-500/20 text-red-400">
                          active
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-right text-faint whitespace-nowrap text-xs">
                      {p.lastSeen ? isoRelative(p.lastSeen) : "\u2014"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Anti-recommendations */}
      {antiRecs.length > 0 && (
        <div className="bg-bg-1 border border-border rounded-lg overflow-hidden mb-6">
          <div className="px-4 py-3 border-b border-border">
            <h3 className="text-xs font-semibold text-muted uppercase tracking-[0.1em]">
              Active Anti-Recommendations
            </h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className={cn(TH, "text-left")}>Agent</th>
                  <th className={cn(TH, "text-left")}>Domain</th>
                  <th className={cn(TH, "text-left")}>Reason</th>
                  <th className={cn(TH, "text-right")}>Failures</th>
                  <th className={cn(TH, "text-right")}>Confidence</th>
                  <th className={cn(TH, "text-right")}>Expires</th>
                </tr>
              </thead>
              <tbody>
                {antiRecs.map((ar) => (
                  <tr
                    key={ar.id}
                    className="border-b border-border/30 hover:bg-bg-2/50 transition-colors"
                  >
                    <td className="px-4 py-2.5 font-mono text-foreground text-sm">
                      {ar.agentId}
                    </td>
                    <td className="px-4 py-2.5 text-muted text-xs">
                      {ar.domain ?? "\u2014"}
                    </td>
                    <td className="px-4 py-2.5 text-xs text-foreground max-w-[250px] truncate">
                      {ar.reason}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono text-red-400">
                      {ar.failureCount}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono text-amber-400">
                      {(ar.confidence * 100).toFixed(0)}%
                    </td>
                    <td className="px-4 py-2.5 text-right text-faint whitespace-nowrap text-xs">
                      {isoRelative(ar.validUntil)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Recent errors table */}
      <div className="bg-bg-1 border border-border rounded-lg overflow-hidden mb-6">
        <div className="px-4 py-3 border-b border-border flex items-center justify-between">
          <h3 className="text-xs font-semibold text-muted uppercase tracking-[0.1em]">
            Recent Errors
          </h3>
          <span className="text-[11px] font-mono text-faint">
            Last {recent.length} failures
          </span>
        </div>
        {recent.length === 0 ? (
          <EmptyState description="No failure records yet. Errors are tracked when agents fail." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className={cn(TH, "text-left")}>Agent</th>
                  <th className={cn(TH, "text-left")}>Domain</th>
                  <th className={cn(TH, "text-left")}>Type</th>
                  <th className={cn(TH, "text-left")}>Error</th>
                  <th className={cn(TH, "text-right")}>When</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((r) => {
                  const isExpanded = expandedId === r.id;
                  return (
                    <tr
                      key={r.id}
                      className="border-b border-border/30 hover:bg-bg-2/50 transition-colors cursor-pointer"
                      onClick={() =>
                        setExpandedId(isExpanded ? null : r.id)
                      }
                    >
                      <td className="px-4 py-2.5 font-mono text-foreground text-sm">
                        {r.agentId}
                      </td>
                      <td className="px-4 py-2.5">
                        <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium bg-bg-3 text-muted">
                          {r.domain}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-xs text-muted">
                        {r.errorType}
                      </td>
                      <td className="px-4 py-2.5 text-xs text-foreground max-w-[400px]">
                        {isExpanded ? (
                          <div className="whitespace-pre-wrap break-all font-mono text-[11px] text-red-300">
                            {r.errorMessage}
                          </div>
                        ) : (
                          <span className="truncate block" title={r.errorMessage}>
                            {truncate(r.errorMessage, 80)}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-right text-faint whitespace-nowrap text-xs">
                        {isoRelative(r.createdAt)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Alert history */}
      <div className="bg-bg-1 border border-border rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-border flex items-center justify-between">
          <h3 className="text-xs font-semibold text-muted uppercase tracking-[0.1em]">
            Alert History
          </h3>
          <span className="text-[11px] font-mono text-faint">
            {alerts.filter((a) => !a.resolvedAt).length} active
          </span>
        </div>
        {alerts.length === 0 ? (
          <EmptyState description="No monitor alerts recorded yet." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className={cn(TH, "text-left")}>Level</th>
                  <th className={cn(TH, "text-left")}>Category</th>
                  <th className={cn(TH, "text-left")}>Title</th>
                  <th className={cn(TH, "text-left")}>Detail</th>
                  <th className={cn(TH, "text-right")}>Fired</th>
                  <th className={cn(TH, "text-right")}>Resolved</th>
                </tr>
              </thead>
              <tbody>
                {alerts.map((a) => (
                  <tr
                    key={a.id}
                    className="border-b border-border/30 hover:bg-bg-2/50 transition-colors"
                  >
                    <td className="px-4 py-2.5">
                      <span className={levelBadge(a.level)}>{a.level}</span>
                    </td>
                    <td className="px-4 py-2.5 text-xs text-muted">{a.category}</td>
                    <td className="px-4 py-2.5 text-sm text-foreground">
                      {a.title}
                    </td>
                    <td className="px-4 py-2.5 text-xs text-muted max-w-[300px] truncate">
                      {a.detail}
                    </td>
                    <td className="px-4 py-2.5 text-right text-faint whitespace-nowrap text-xs">
                      {relativeTime(a.firedAt)}
                    </td>
                    <td className="px-4 py-2.5 text-right whitespace-nowrap text-xs">
                      {a.resolvedAt ? (
                        <span className="text-emerald-400">
                          {relativeTime(a.resolvedAt)}
                        </span>
                      ) : (
                        <span className="text-red-400 font-semibold">active</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
