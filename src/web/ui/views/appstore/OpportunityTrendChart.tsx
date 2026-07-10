/**
 * Lazy, per-row expand content for the Opportunities leaderboard: a real
 * ECharts trend chart over a keyword's scan history, plus a small detail
 * block (first-found date, source, current top incumbents).
 *
 * Replaces the earlier inline SVG `Sparkline` with something that actually
 * shows demand alongside opportunity and colors/annotates by `trend`.
 */
import { useMemo, useRef } from "react";
import type React from "react";
import * as echarts from "echarts";
import { useChart } from "../../lib/useChart";
import { formatNumber } from "../../lib/format";
import { cn } from "../../lib/cn";
import {
  formatFirstFound,
  formatOpportunity,
  sourceBadge,
  trendBadge,
} from "./opportunities-format";

// ─── Types ────────────────────────────────────────────────────────────────────

/** Mirrors `TopApp` (src/sources/appstore/keyword-types.ts), display fields only. */
export interface TrendTopApp {
  readonly id: string;
  readonly name: string;
  readonly reviews: number;
  readonly rating: number;
}

/** A single scan history point, as returned in `data.history` by `/appstore/opportunities/:keyword`. */
export interface ScanHistoryPoint {
  readonly scannedAt: number;
  readonly opportunity: number;
  readonly demand: number;
  readonly competitiveness: number;
  readonly incumbentWeakness: number;
  readonly trend: string;
  readonly topApps: readonly TrendTopApp[];
}

export interface OpportunityMeta {
  readonly keyword: string;
  readonly firstFoundAt: number | null;
  readonly source: string | null;
}

interface OpportunityTrendChartProps {
  readonly history: readonly ScanHistoryPoint[];
  readonly meta: OpportunityMeta;
}

// ─── Trend point colors (hardcoded — ECharts canvas can't read CSS vars) ──────
// Chosen to echo `trendBadge`'s Tailwind classes: danger / accent / muted / green.

const TREND_POINT_COLORS: Readonly<Record<string, string>> = {
  heating: "#f87171",
  cooling: "#a78bfa",
  stable: "#707078",
  new: "#4ade80",
};
const UNKNOWN_TREND_COLOR = "#454550";

function trendColor(trend: string): string {
  return TREND_POINT_COLORS[trend] ?? UNKNOWN_TREND_COLOR;
}

// ─── Chart option builder ───────────────────────────────────────────────────

function buildTrendOption(
  ordered: readonly ScanHistoryPoint[],
  showFirstFoundMarker: boolean,
): echarts.EChartsOption {
  const labels = ordered.map((p) =>
    new Date(p.scannedAt * 1000).toLocaleDateString([], { month: "short", day: "numeric" }),
  );

  const opportunityData = ordered.map((p) => ({
    value: Math.round(Math.max(0, Math.min(1, p.opportunity)) * 100),
    itemStyle: { color: trendColor(p.trend) },
  }));

  return {
    tooltip: {
      trigger: "axis",
      backgroundColor: "rgba(16, 19, 26, 0.95)",
      borderColor: "rgba(255,255,255,0.08)",
      borderWidth: 1,
      textStyle: { color: "#b0b0b8", fontSize: 12, fontFamily: "'JetBrains Mono', monospace" },
      extraCssText: "border-radius:8px;box-shadow:0 8px 32px rgba(0,0,0,0.3);",
      formatter: (params: unknown) => {
        const items = Array.isArray(params) ? params : [params];
        const first = items[0] as { dataIndex: number; name: string } | undefined;
        if (!first) return "";
        const point = ordered[first.dataIndex];
        if (!point) return "";
        const badge = trendBadge(point.trend);
        // SECURITY: this is the one HTML sink in this component — ECharts renders
        // the returned string as raw HTML. Only interpolate date labels
        // (`first.name`), numbers, and the constrained `trend` enum here. NEVER
        // route scraped/attacker-controlled text (app names, raw keywords) into
        // this string without escaping — that would be stored XSS.
        return `<div style="font-weight:600;margin-bottom:4px">${first.name}</div>
          <span style="color:${trendColor(point.trend)}">●</span> Opportunity: <b>${formatOpportunity(point.opportunity)}</b><br/>
          <span style="color:#707078">●</span> Demand: <b>${point.demand.toFixed(1)}/day</b><br/>
          Trend: <b>${badge.label}</b>`;
      },
    },
    grid: { top: 20, right: 44, bottom: 30, left: 42, containLabel: false },
    xAxis: {
      type: "category",
      data: labels,
      axisLabel: { color: "#454550", fontSize: 11, fontFamily: "'JetBrains Mono', monospace" },
      axisLine: { show: false },
      axisTick: { show: false },
      boundaryGap: false,
    },
    yAxis: [
      {
        type: "value",
        name: "Opportunity",
        min: 0,
        max: 100,
        axisLabel: {
          color: "#454550",
          fontSize: 11,
          fontFamily: "'JetBrains Mono', monospace",
          formatter: "{value}%",
        },
        splitLine: { lineStyle: { color: "#1e1e24", type: "dashed", opacity: 0.5 } },
        axisLine: { show: false },
        axisTick: { show: false },
      },
      {
        type: "value",
        name: "Demand",
        axisLabel: { color: "#454550", fontSize: 11, fontFamily: "'JetBrains Mono', monospace" },
        splitLine: { show: false },
        axisLine: { show: false },
        axisTick: { show: false },
      },
    ],
    series: [
      {
        name: "Opportunity",
        type: "line",
        data: opportunityData,
        smooth: true,
        showSymbol: true,
        symbolSize: 7,
        lineStyle: { color: "#a78bfa", width: 2 },
        markPoint: showFirstFoundMarker
          ? {
              symbol: "pin",
              symbolSize: 36,
              data: [
                {
                  name: "First found",
                  coord: [0, opportunityData[0]?.value ?? 0],
                  itemStyle: { color: "#a78bfa" },
                  label: { formatter: "First found", fontSize: 9, color: "#0a0a0c" },
                },
              ],
            }
          : undefined,
      },
      {
        name: "Demand",
        type: "line",
        yAxisIndex: 1,
        data: ordered.map((p) => p.demand),
        smooth: true,
        showSymbol: false,
        lineStyle: { color: "#707078", width: 1.5, type: "dashed" },
      },
    ],
    legend: {
      data: ["Opportunity", "Demand"],
      textStyle: { color: "#707078", fontSize: 11, fontFamily: "'JetBrains Mono', monospace" },
      top: 0,
      right: 0,
      itemWidth: 12,
      itemHeight: 8,
    },
    animation: false,
  };
}

// ─── Chart component ────────────────────────────────────────────────────────

function TrendChart({
  ordered,
  meta,
}: {
  ordered: readonly ScanHistoryPoint[];
  meta: OpportunityMeta;
}) {
  const ref = useRef<HTMLDivElement>(null);

  const showFirstFoundMarker = useMemo(() => {
    const oldest = ordered[0]?.scannedAt;
    if (meta.firstFoundAt === null || oldest === undefined) return false;
    return Math.abs(oldest - meta.firstFoundAt) <= 2 * 86400;
  }, [ordered, meta.firstFoundAt]);

  const option = useMemo<echarts.EChartsOption>(
    () => buildTrendOption(ordered, showFirstFoundMarker),
    [ordered, showFirstFoundMarker],
  );

  useChart(ref, option);
  return <div ref={ref} className="w-full h-[240px]" data-testid="opportunity-trend-chart" />;
}

// ─── Detail block (first found, source, top incumbents) ────────────────────

function DetailBlock({
  meta,
  latest,
}: {
  readonly meta: OpportunityMeta;
  readonly latest: ScanHistoryPoint | undefined;
}) {
  const badge = sourceBadge(meta.source);
  const topApps = [...(latest?.topApps ?? [])].sort((a, b) => b.reviews - a.reviews).slice(0, 5);

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:gap-6 mt-3 text-xs">
      <div className="flex items-center gap-2 shrink-0">
        <span className="text-faint">First found</span>
        <span className="font-mono text-foreground">{formatFirstFound(meta.firstFoundAt)}</span>
        <span className={cn("px-1.5 py-0.5 rounded text-xs font-medium", badge.className)}>
          {badge.label}
        </span>
      </div>

      {topApps.length > 0 && (
        <div className="min-w-0 flex-1">
          <div className="text-faint mb-1">Top incumbents</div>
          <div className="overflow-x-auto">
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              {topApps.map((app) => (
                <span key={app.id} className="whitespace-nowrap text-muted">
                  <span className="text-foreground">{app.name}</span>{" "}
                  <span className="font-mono">
                    {formatNumber(app.reviews)} reviews · {app.rating.toFixed(1)}★
                  </span>
                </span>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── OpportunityTrendChart (main) ───────────────────────────────────────────

export function OpportunityTrendChart({
  history,
  meta,
}: OpportunityTrendChartProps): React.JSX.Element {
  if (history.length < 2) {
    return <span className="text-xs text-faint">Not enough scan history yet.</span>;
  }

  // History arrives newest-first (ORDER BY scanned_at DESC); plot oldest→newest.
  const ordered = [...history].reverse();
  const latest = history[0];

  return (
    <div>
      <div className="overflow-x-auto">
        <TrendChart ordered={ordered} meta={meta} />
      </div>
      <DetailBlock meta={meta} latest={latest} />
    </div>
  );
}
