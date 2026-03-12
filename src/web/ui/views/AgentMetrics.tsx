import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import * as echarts from "echarts";
import { apiFetch } from "../api";
import {
  PageHeader,
  LoadingState,
  EmptyState,
  FilterTabs,
} from "../components";
import {
  formatNumber,
  relativeTime,
  formatTime,
  formatCost,
  formatDuration,
} from "../lib/format";
import { cn } from "../lib/cn";

// ============================================================================
// Types
// ============================================================================

interface AgentUsage {
  agentId: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
  totalCostUsd: number;
  requestCount: number;
}

interface ModelUsage {
  model: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
  totalCostUsd: number;
  requestCount: number;
}

interface TimePoint {
  bucket: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  requestCount: number;
}

interface RecentRecord {
  id: string;
  agentId: string;
  model: string;
  provider: string;
  channel: string;
  source: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  durationMs: number;
  toolUseCount: number;
  createdAt: number;
}

interface CronJob {
  id: string;
  name: string;
  enabled: boolean;
  payload: { agentId?: string; message?: string };
  nextRunAt: number | null;
  lastRunAt: number | null;
  lastStatus: string | null;
  lastError: string | null;
}

// ============================================================================
// Constants
// ============================================================================

const RANGES = [
  { id: "24h", label: "24h", seconds: 86400 },
  { id: "7d", label: "7d", seconds: 7 * 86400 },
  { id: "30d", label: "30d", seconds: 30 * 86400 },
  { id: "all", label: "All", seconds: 0 },
] as const;

const AGENT_COLORS = [
  "#a78bfa", "#2dd4bf", "#f59e0b", "#f472b6", "#3b82f6",
  "#ef4444", "#06b6d4", "#84cc16", "#f97316", "#6366f1",
];

const MODEL_COLORS = [
  "#3b82f6", "#8b5cf6", "#06b6d4", "#10b981",
  "#f97316", "#ec4899", "#ef4444", "#84cc16",
];

const TOOLTIP_STYLE = {
  backgroundColor: "rgba(16, 19, 26, 0.95)",
  borderColor: "rgba(255,255,255,0.08)",
  borderWidth: 1,
  textStyle: { color: "#b0b0b8", fontSize: 12, fontFamily: "'JetBrains Mono', monospace" },
  extraCssText: "border-radius:8px;box-shadow:0 8px 32px rgba(0,0,0,0.3);",
};

const AXIS_LABEL = {
  color: "#454550",
  fontSize: 11,
  fontFamily: "'JetBrains Mono', monospace",
};

const SPLIT_LINE = {
  lineStyle: { color: "#1e1e24", type: "dashed" as const, opacity: 0.5 },
};

// ============================================================================
// Helpers
// ============================================================================

function sinceEpoch(rangeId: string): number | undefined {
  const range = RANGES.find((r) => r.id === rangeId);
  if (!range || range.seconds === 0) return undefined;
  return Math.floor(Date.now() / 1000) - range.seconds;
}

// ============================================================================
// ECharts Hook
// ============================================================================

function useChart(
  ref: React.RefObject<HTMLDivElement | null>,
  option: echarts.EChartsOption,
) {
  const chartRef = useRef<echarts.ECharts | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const chart = echarts.init(el, undefined, { renderer: "canvas" });
    chartRef.current = chart;
    const ro = new ResizeObserver(() => chart.resize());
    ro.observe(el);
    return () => {
      ro.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
  }, [ref]);

  useEffect(() => {
    chartRef.current?.setOption(option, { notMerge: true });
  }, [option]);
}

// ============================================================================
// Chart Card wrapper
// ============================================================================

function ChartCard({
  title,
  right,
  children,
  className,
}: {
  title: string;
  right?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("bg-bg-1 border border-border rounded-lg p-5", className)}>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-xs font-semibold text-muted uppercase tracking-[0.1em]">
          {title}
        </h3>
        {right && (
          <span className="text-[11px] font-mono text-faint">{right}</span>
        )}
      </div>
      {children}
    </div>
  );
}

// ============================================================================
// Stat Card
// ============================================================================

function StatCard({
  label,
  value,
  sub,
  accentColor,
  progress,
}: {
  label: string;
  value: string;
  sub?: string;
  accentColor?: string;
  progress?: number;
}) {
  return (
    <div className="relative bg-bg-1 border border-border rounded-lg px-5 py-4 overflow-hidden">
      {accentColor && (
        <div
          className="absolute top-0 left-0 w-full h-[2px]"
          style={{
            background: `linear-gradient(90deg, ${accentColor}, transparent)`,
          }}
        />
      )}
      <div className="text-[10px] font-semibold text-faint uppercase tracking-[0.12em] mb-2">
        {label}
      </div>
      <div className="text-2xl font-bold font-mono leading-none text-strong tabular-nums">
        {value}
      </div>
      {progress !== undefined && (
        <div className="w-full h-1 rounded-full bg-bg-3 mt-3 overflow-hidden">
          <div
            className="h-full rounded-full transition-all duration-500"
            style={{
              width: `${Math.min(progress, 100)}%`,
              backgroundColor: accentColor ?? "#a78bfa",
            }}
          />
        </div>
      )}
      {sub && (
        <div className="text-[11px] text-faint mt-2 leading-relaxed">{sub}</div>
      )}
    </div>
  );
}

// ============================================================================
// Cost Over Time Chart (area + bar overlay)
// ============================================================================

function CostTimelineChart({
  data,
  granularity,
}: {
  data: readonly TimePoint[];
  granularity: "hour" | "day";
}) {
  const ref = useRef<HTMLDivElement>(null);

  const option = useMemo<echarts.EChartsOption>(() => {
    if (data.length === 0) return {};

    const labels = data.map((d) => {
      const date = new Date(d.bucket);
      return granularity === "hour"
        ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
        : date.toLocaleDateString([], { month: "short", day: "numeric" });
    });

    return {
      tooltip: {
        ...TOOLTIP_STYLE,
        trigger: "axis",
        formatter: (params: unknown) => {
          const items = Array.isArray(params) ? params : [params];
          const p = items[0] as { name: string; dataIndex: number } | undefined;
          if (!p) return "";
          const point = data[p.dataIndex];
          if (!point) return "";
          return `<div style="font-weight:600;margin-bottom:6px">${p.name}</div>
            <span style="color:#f59e0b">\u25CF</span> Cost: <b>${formatCost(point.costUsd)}</b><br/>
            <span style="color:#a78bfa">\u25CF</span> Requests: <b>${point.requestCount}</b><br/>
            <span style="color:#707078">\u25CF</span> Tokens: <b>${formatNumber(point.inputTokens + point.outputTokens)}</b>`;
        },
      },
      grid: { top: 20, right: 20, bottom: 30, left: 50, containLabel: false },
      xAxis: {
        type: "category",
        data: labels,
        axisLabel: AXIS_LABEL,
        axisLine: { show: false },
        axisTick: { show: false },
        boundaryGap: true,
      },
      yAxis: [
        {
          type: "value",
          axisLabel: {
            ...AXIS_LABEL,
            formatter: (v: number) => (v < 0.01 ? "" : `$${v.toFixed(2)}`),
          },
          splitLine: SPLIT_LINE,
          axisLine: { show: false },
          axisTick: { show: false },
        },
        {
          type: "value",
          axisLabel: { ...AXIS_LABEL },
          splitLine: { show: false },
          axisLine: { show: false },
          axisTick: { show: false },
        },
      ],
      series: [
        {
          name: "Cost",
          type: "line",
          data: data.map((d) => d.costUsd),
          smooth: true,
          showSymbol: false,
          lineStyle: { color: "#f59e0b", width: 2 },
          areaStyle: {
            color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
              { offset: 0, color: "rgba(245, 158, 11, 0.25)" },
              { offset: 1, color: "rgba(245, 158, 11, 0)" },
            ]),
          },
          itemStyle: { color: "#f59e0b" },
        },
        {
          name: "Requests",
          type: "bar",
          yAxisIndex: 1,
          data: data.map((d) => d.requestCount),
          barMaxWidth: 12,
          itemStyle: {
            color: "rgba(167, 139, 250, 0.25)",
            borderRadius: [2, 2, 0, 0],
          },
        },
      ],
      animation: false,
    };
  }, [data, granularity]);

  useChart(ref, option);
  return <div ref={ref} className="w-full h-[280px]" />;
}

// ============================================================================
// Cost by Agent Chart
// ============================================================================

function CostByAgentChart({ data }: { data: readonly AgentUsage[] }) {
  const ref = useRef<HTMLDivElement>(null);

  const option = useMemo<echarts.EChartsOption>(() => {
    if (data.length === 0) return {};
    const sorted = [...data].sort((a, b) => a.totalCostUsd - b.totalCostUsd);

    return {
      tooltip: {
        ...TOOLTIP_STYLE,
        trigger: "axis",
        axisPointer: { type: "shadow" },
        formatter: (params: unknown) => {
          const items = Array.isArray(params) ? params : [params];
          const p = items[0] as { name: string; value: number; marker: string } | undefined;
          const agent = p ? sorted.find((d) => d.agentId === p.name) : null;
          if (!p || !agent) return "";
          return `<div style="font-weight:600;margin-bottom:6px">${p.name}</div>
            ${p.marker} Cost: <b>${formatCost(p.value)}</b><br/>
            Requests: <b>${formatNumber(agent.requestCount)}</b><br/>
            Tokens: <b>${formatNumber(agent.totalInputTokens + agent.totalOutputTokens)}</b>`;
        },
      },
      grid: { left: 120, right: 30, top: 8, bottom: 8 },
      xAxis: {
        type: "value",
        axisLabel: { ...AXIS_LABEL, formatter: (v: number) => formatCost(v) },
        splitLine: SPLIT_LINE,
        axisLine: { show: false },
        axisTick: { show: false },
      },
      yAxis: {
        type: "category",
        data: sorted.map((d) => d.agentId),
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { ...AXIS_LABEL, color: "#b0b0b8" },
      },
      series: [
        {
          type: "bar",
          data: sorted.map((d, i) => ({
            value: d.totalCostUsd,
            itemStyle: {
              color: new echarts.graphic.LinearGradient(0, 0, 1, 0, [
                { offset: 0, color: AGENT_COLORS[i % AGENT_COLORS.length] + "30" },
                { offset: 1, color: AGENT_COLORS[i % AGENT_COLORS.length]! },
              ]),
              borderRadius: [0, 4, 4, 0],
            },
          })),
          barMaxWidth: 18,
        },
      ],
      animation: true,
    };
  }, [data]);

  useChart(ref, option);
  const height = Math.max(160, data.length * 32 + 16);
  return <div ref={ref} className="w-full" style={{ height }} />;
}

// ============================================================================
// Cost by Model Chart
// ============================================================================

function CostByModelChart({ data }: { data: readonly ModelUsage[] }) {
  const ref = useRef<HTMLDivElement>(null);

  const option = useMemo<echarts.EChartsOption>(() => {
    if (data.length === 0) return {};
    const sorted = [...data].sort((a, b) => a.totalCostUsd - b.totalCostUsd);

    return {
      tooltip: {
        ...TOOLTIP_STYLE,
        trigger: "axis",
        axisPointer: { type: "shadow" },
        formatter: (params: unknown) => {
          const items = Array.isArray(params) ? params : [params];
          const p = items[0] as { name: string; value: number; marker: string } | undefined;
          const model = p ? sorted.find((d) => d.model === p.name) : null;
          if (!p || !model) return "";
          return `<div style="font-weight:600;margin-bottom:6px">${p.name}</div>
            ${p.marker} Cost: <b>${formatCost(p.value)}</b><br/>
            Requests: <b>${formatNumber(model.requestCount)}</b>`;
        },
      },
      grid: { left: 160, right: 30, top: 8, bottom: 8 },
      xAxis: {
        type: "value",
        axisLabel: { ...AXIS_LABEL, formatter: (v: number) => formatCost(v) },
        splitLine: SPLIT_LINE,
        axisLine: { show: false },
        axisTick: { show: false },
      },
      yAxis: {
        type: "category",
        data: sorted.map((d) => d.model),
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { ...AXIS_LABEL, color: "#b0b0b8", width: 140, overflow: "truncate" as const },
      },
      series: [
        {
          type: "bar",
          data: sorted.map((d, i) => ({
            value: d.totalCostUsd,
            itemStyle: {
              color: new echarts.graphic.LinearGradient(0, 0, 1, 0, [
                { offset: 0, color: MODEL_COLORS[i % MODEL_COLORS.length] + "30" },
                { offset: 1, color: MODEL_COLORS[i % MODEL_COLORS.length]! },
              ]),
              borderRadius: [0, 4, 4, 0],
            },
          })),
          barMaxWidth: 18,
        },
      ],
      animation: true,
    };
  }, [data]);

  useChart(ref, option);
  const height = Math.max(120, data.length * 32 + 16);
  return <div ref={ref} className="w-full" style={{ height }} />;
}

// ============================================================================
// Token Distribution Ring Chart
// ============================================================================

function TokenDistributionChart({
  input,
  output,
  cacheRead,
  cacheCreation,
}: {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}) {
  const ref = useRef<HTMLDivElement>(null);

  const pureInput = Math.max(0, input - cacheRead - cacheCreation);
  const total = pureInput + output + cacheRead + cacheCreation;

  const option = useMemo<echarts.EChartsOption>(() => {
    if (total === 0) return {};

    return {
      tooltip: {
        ...TOOLTIP_STYLE,
        trigger: "item",
        formatter: (p: unknown) => {
          const item = p as { marker: string; name: string; value: number; percent: number };
          return `${item.marker} ${item.name}: <b>${formatNumber(item.value)}</b> (${item.percent}%)`;
        },
      },
      series: [
        {
          type: "pie",
          radius: ["48%", "72%"],
          center: ["50%", "45%"],
          padAngle: 3,
          itemStyle: { borderRadius: 6 },
          label: { show: false },
          emphasis: {
            itemStyle: {
              shadowBlur: 10,
              shadowOffsetX: 0,
              shadowColor: "rgba(0,0,0,0.3)",
            },
          },
          data: [
            { value: pureInput, name: "Input", itemStyle: { color: "#3b82f6" } },
            { value: output, name: "Output", itemStyle: { color: "#2dd4bf" } },
            { value: cacheRead, name: "Cache Read", itemStyle: { color: "#a78bfa" } },
            { value: cacheCreation, name: "Cache Write", itemStyle: { color: "#f59e0b" } },
          ].filter((d) => d.value > 0),
        },
      ],
      animation: true,
    };
  }, [pureInput, output, cacheRead, cacheCreation, total]);

  useChart(ref, option);

  const legendItems = [
    { label: "Input", value: pureInput, color: "#3b82f6" },
    { label: "Output", value: output, color: "#2dd4bf" },
    { label: "Cache Read", value: cacheRead, color: "#a78bfa" },
    { label: "Cache Write", value: cacheCreation, color: "#f59e0b" },
  ].filter((d) => d.value > 0);

  return (
    <div className="flex flex-col items-center">
      <div ref={ref} className="w-full h-[200px]" />
      {total > 0 && (
        <div className="flex flex-wrap justify-center gap-x-4 gap-y-1.5 mt-1">
          {legendItems.map((d) => (
            <span
              key={d.label}
              className="flex items-center gap-1.5 text-[11px] text-muted"
            >
              <span
                className="w-2 h-2 rounded-full shrink-0"
                style={{ backgroundColor: d.color }}
              />
              {d.label}: {formatNumber(d.value)}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Activity Timeline Chart
// ============================================================================

function ActivityTimelineChart({
  data,
  granularity,
  agentIds,
}: {
  data: readonly RecentRecord[];
  granularity: "hour" | "day";
  agentIds: readonly string[];
}) {
  const ref = useRef<HTMLDivElement>(null);

  const option = useMemo<echarts.EChartsOption>(() => {
    if (data.length === 0) return {};

    const truncMs = granularity === "hour" ? 3600_000 : 86400_000;
    const bucketMap = new Map<string, Map<string, number>>();
    for (const r of data) {
      const key = new Date(
        Math.floor((r.createdAt * 1000) / truncMs) * truncMs,
      ).toISOString();
      if (!bucketMap.has(key)) bucketMap.set(key, new Map());
      const m = bucketMap.get(key)!;
      m.set(r.agentId, (m.get(r.agentId) ?? 0) + 1);
    }

    const buckets = [...bucketMap.keys()].sort();
    const labels = buckets.map((b) => {
      const d = new Date(b);
      return granularity === "hour"
        ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
        : d.toLocaleDateString([], { month: "short", day: "numeric" });
    });

    return {
      tooltip: { ...TOOLTIP_STYLE, trigger: "axis" },
      legend: {
        data: agentIds as string[],
        textStyle: {
          color: "#707078",
          fontSize: 11,
          fontFamily: "'JetBrains Mono', monospace",
        },
        bottom: 0,
        type: "scroll",
      },
      grid: { left: 50, right: 20, top: 10, bottom: 40 },
      xAxis: {
        type: "category",
        data: labels,
        axisLabel: AXIS_LABEL,
        axisLine: { show: false },
        axisTick: { show: false },
        boundaryGap: false,
      },
      yAxis: {
        type: "value",
        name: "Requests",
        nameTextStyle: AXIS_LABEL,
        axisLabel: AXIS_LABEL,
        splitLine: SPLIT_LINE,
        axisLine: { show: false },
        axisTick: { show: false },
        minInterval: 1,
      },
      series: agentIds.map((id, i) => ({
        name: id,
        type: "line" as const,
        smooth: true,
        symbol: "circle",
        symbolSize: 4,
        showSymbol: false,
        data: buckets.map((b) => bucketMap.get(b)?.get(id) ?? 0),
        lineStyle: { width: 2 },
        itemStyle: { color: AGENT_COLORS[i % AGENT_COLORS.length] },
        areaStyle: {
          color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
            { offset: 0, color: AGENT_COLORS[i % AGENT_COLORS.length] + "20" },
            { offset: 1, color: AGENT_COLORS[i % AGENT_COLORS.length] + "00" },
          ]),
        },
      })),
      animation: false,
    };
  }, [data, granularity, agentIds]);

  useChart(ref, option);
  return <div ref={ref} className="w-full h-[280px]" />;
}

// ============================================================================
// Cache Bar (inline)
// ============================================================================

function CacheBar({ total, cached }: { total: number; cached: number }) {
  if (total === 0) return <span className="text-faint">{"\u2014"}</span>;
  const pct = Math.round((cached / total) * 100);
  const barColor =
    pct >= 80
      ? "bg-success/60"
      : pct >= 40
        ? "bg-accent/60"
        : "bg-warning/60";
  return (
    <div className="flex items-center gap-2">
      <div className="w-14 h-1.5 rounded-full bg-bg-3 overflow-hidden">
        <div
          className={cn("h-full rounded-full transition-all", barColor)}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-xs font-mono text-faint w-8 text-right">
        {pct}%
      </span>
    </div>
  );
}

// ============================================================================
// Table Styles
// ============================================================================

const TH =
  "text-[10px] font-semibold text-faint uppercase tracking-[0.1em] px-4 py-2.5";

// ============================================================================
// Main Component
// ============================================================================

export default function AgentMetrics() {
  const [range, setRange] = useState("7d");
  const [selectedAgent, setSelectedAgent] = useState("all");
  const [byAgent, setByAgent] = useState<AgentUsage[]>([]);
  const [byModel, setByModel] = useState<ModelUsage[]>([]);
  const [timeseries, setTimeseries] = useState<TimePoint[]>([]);
  const [recent, setRecent] = useState<RecentRecord[]>([]);
  const [cronJobs, setCronJobs] = useState<CronJob[]>([]);
  const [loading, setLoading] = useState(true);

  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    const since = sinceEpoch(range);
    const qs = since ? `?since=${since}` : "";
    const granularity = range === "24h" ? "hour" : "day";
    const tsQs = since
      ? `?since=${since}&granularity=${granularity}`
      : `?granularity=${granularity}`;

    try {
      const [agentRes, modelRes, tsRes, recentRes, cronRes] =
        await Promise.all([
          apiFetch<{ success: boolean; data: AgentUsage[] }>(
            `/api/usage/by-agent${qs}`,
          ),
          apiFetch<{ success: boolean; data: ModelUsage[] }>(
            `/api/usage/by-model${qs}`,
          ),
          apiFetch<{ success: boolean; data: TimePoint[] }>(
            `/api/usage/timeseries${tsQs}`,
          ),
          apiFetch<{ success: boolean; data: RecentRecord[] }>(
            `/api/usage/recent?limit=200${since ? `&since=${since}` : ""}`,
          ),
          apiFetch<{ success: boolean; data: CronJob[] }>("/api/cron/jobs"),
        ]);

      if (agentRes.success) setByAgent(agentRes.data);
      if (modelRes.success) setByModel(modelRes.data);
      if (tsRes.success) setTimeseries(tsRes.data);
      if (recentRes.success) setRecent(recentRes.data);
      if (cronRes.success) setCronJobs(cronRes.data);
      setError(null);
    } catch (err) {
      setError("Failed to load metrics. Will retry.");
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

  if (loading && byAgent.length === 0)
    return <LoadingState message="Loading metrics..." />;

  if (error && byAgent.length === 0)
    return <EmptyState description={error} />;

  // ---------- Derived data ----------

  const agentIds = byAgent.map((a) => a.agentId);
  const isAllAgents = selectedAgent === "all";

  const selected = isAllAgents
    ? null
    : (byAgent.find((a) => a.agentId === selectedAgent) ?? null);

  const filteredRecent = isAllAgents
    ? recent
    : recent.filter((r) => r.agentId === selectedAgent);

  const agentCronJobs = isAllAgents
    ? cronJobs.filter((j) => j.payload.agentId)
    : cronJobs.filter((j) => j.payload.agentId === selectedAgent);

  const sum = (fn: (a: AgentUsage) => number) =>
    byAgent.reduce((s, a) => s + fn(a), 0);

  const totalReqs = selected?.requestCount ?? sum((a) => a.requestCount);
  const totalCost = selected?.totalCostUsd ?? sum((a) => a.totalCostUsd);
  const totalInput =
    selected?.totalInputTokens ?? sum((a) => a.totalInputTokens);
  const totalOutput =
    selected?.totalOutputTokens ?? sum((a) => a.totalOutputTokens);
  const totalCacheRead =
    selected?.totalCacheReadTokens ?? sum((a) => a.totalCacheReadTokens);
  const totalCacheCreation =
    selected?.totalCacheCreationTokens ??
    sum((a) => a.totalCacheCreationTokens);
  const costPerReq = totalReqs > 0 ? totalCost / totalReqs : 0;
  const cacheHitPct =
    totalInput > 0 ? Math.round((totalCacheRead / totalInput) * 100) : 0;

  const relevantRecent = filteredRecent.filter((r) => r.durationMs > 0);
  const avgDuration =
    relevantRecent.length > 0
      ? Math.round(
          relevantRecent.reduce((s, r) => s + r.durationMs, 0) /
            relevantRecent.length,
        )
      : 0;

  // ---------- Render ----------

  return (
    <div className="max-w-[1400px]">
      <PageHeader
        title="Agent Metrics"
        subtitle="Performance, cost, and usage analysis"
      />

      <FilterTabs
        tabs={RANGES.map((r) => ({ id: r.id, label: r.label }))}
        active={range}
        onChange={setRange}
      />

      {/* Agent selector */}
      <div className="flex flex-wrap gap-1.5 mb-6">
        {[
          { id: "all", label: "All Agents" },
          ...agentIds.map((id) => ({ id, label: id })),
        ].map((t) => (
          <button
            key={t.id}
            onClick={() => setSelectedAgent(t.id)}
            className={cn(
              "px-3 py-1.5 rounded-md text-xs font-medium transition-colors cursor-pointer border-none",
              selectedAgent === t.id
                ? "bg-accent text-white"
                : "bg-bg-1 text-muted hover:bg-bg-2",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-4 max-lg:grid-cols-2 max-sm:grid-cols-1 gap-3 mb-6">
        <StatCard
          label="Total Requests"
          value={formatNumber(totalReqs)}
          sub={`${formatNumber(totalInput + totalOutput)} total tokens`}
          accentColor="#a78bfa"
        />
        <StatCard
          label="Total Cost"
          value={formatCost(totalCost)}
          sub={
            totalReqs > 0
              ? `${formatCost(costPerReq)} avg per request`
              : undefined
          }
          accentColor="#f59e0b"
        />
        <StatCard
          label="Avg Response"
          value={formatDuration(avgDuration)}
          sub={
            relevantRecent.length > 0
              ? `from ${relevantRecent.length} recent requests`
              : undefined
          }
          accentColor="#2dd4bf"
        />
        <StatCard
          label="Cache Hit Rate"
          value={`${cacheHitPct}%`}
          progress={cacheHitPct}
          sub={
            totalCacheRead > 0
              ? `${formatNumber(totalCacheRead)} cached / ${formatNumber(totalInput)} input`
              : undefined
          }
          accentColor={
            cacheHitPct >= 70
              ? "#2dd4bf"
              : cacheHitPct >= 40
                ? "#3b82f6"
                : "#fbbf24"
          }
        />
      </div>

      {/* Cost over time */}
      {timeseries.length > 0 && (
        <ChartCard title="Cost & Requests Over Time" className="mb-5">
          <CostTimelineChart
            data={timeseries}
            granularity={range === "24h" ? "hour" : "day"}
          />
        </ChartCard>
      )}

      {/* Two-column: Agent/Model breakdown + Token Distribution */}
      {isAllAgents && byAgent.length > 0 && (
        <div className="grid grid-cols-[1fr_320px] max-lg:grid-cols-1 gap-4 mb-5">
          <ChartCard title="Cost by Agent">
            <CostByAgentChart data={byAgent} />
          </ChartCard>
          <ChartCard title="Token Distribution">
            <TokenDistributionChart
              input={totalInput}
              output={totalOutput}
              cacheRead={totalCacheRead}
              cacheCreation={totalCacheCreation}
            />
          </ChartCard>
        </div>
      )}

      {/* Single agent: Token dist + Activity in two columns */}
      {!isAllAgents && (
        <div className="grid grid-cols-[320px_1fr] max-lg:grid-cols-1 gap-4 mb-5">
          <ChartCard title="Token Distribution">
            <TokenDistributionChart
              input={totalInput}
              output={totalOutput}
              cacheRead={totalCacheRead}
              cacheCreation={totalCacheCreation}
            />
          </ChartCard>
          {filteredRecent.length > 0 && (
            <ChartCard title="Activity Timeline">
              <ActivityTimelineChart
                data={filteredRecent}
                granularity={range === "24h" ? "hour" : "day"}
                agentIds={[selectedAgent]}
              />
            </ChartCard>
          )}
        </div>
      )}

      {/* All Agents: Model breakdown + Activity */}
      {isAllAgents && (
        <div className="grid grid-cols-2 max-lg:grid-cols-1 gap-4 mb-5">
          {byModel.length > 0 && (
            <ChartCard title="Cost by Model">
              <CostByModelChart data={byModel} />
            </ChartCard>
          )}
          {filteredRecent.length > 0 && (
            <ChartCard title="Activity Timeline">
              <ActivityTimelineChart
                data={filteredRecent}
                granularity={range === "24h" ? "hour" : "day"}
                agentIds={agentIds}
              />
            </ChartCard>
          )}
        </div>
      )}

      {/* Cron jobs */}
      {agentCronJobs.length > 0 && (
        <div className="bg-bg-1 border border-border rounded-lg overflow-hidden mb-5">
          <div className="px-5 py-3 border-b border-border flex items-center justify-between">
            <h3 className="text-xs font-semibold text-muted uppercase tracking-[0.1em]">
              Cron Jobs
            </h3>
            <span className="text-[11px] font-mono text-faint">
              {agentCronJobs.length} jobs
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className={cn(TH, "text-left")}>Name</th>
                  <th className={cn(TH, "text-left")}>Agent</th>
                  <th className={cn(TH, "text-center")}>Status</th>
                  <th className={cn(TH, "text-right")}>Last Run</th>
                  <th className={cn(TH, "text-right")}>Next Run</th>
                </tr>
              </thead>
              <tbody>
                {agentCronJobs.map((job) => (
                  <tr
                    key={job.id}
                    className="border-b border-border/30 hover:bg-bg-2/50 transition-colors"
                  >
                    <td className="px-4 py-2.5 font-mono text-foreground text-sm">
                      {job.name}
                    </td>
                    <td className="px-4 py-2.5 font-mono text-muted text-xs">
                      {job.payload.agentId ?? "\u2014"}
                    </td>
                    <td className="px-4 py-2.5 text-center">
                      <span
                        className={cn(
                          "inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium",
                          job.lastStatus === "ok"
                            ? "bg-success/10 text-success"
                            : job.lastStatus === "error"
                              ? "bg-danger-subtle text-danger"
                              : "bg-bg-3 text-faint",
                        )}
                      >
                        {job.lastStatus ?? "pending"}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-right text-faint text-xs whitespace-nowrap">
                      {job.lastRunAt ? relativeTime(job.lastRunAt) : "\u2014"}
                    </td>
                    <td className="px-4 py-2.5 text-right text-faint text-xs whitespace-nowrap">
                      {job.nextRunAt ? formatTime(job.nextRunAt) : "\u2014"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Recent activity */}
      <div className="bg-bg-1 border border-border rounded-lg overflow-hidden">
        <div className="px-5 py-3 border-b border-border flex items-center justify-between">
          <h3 className="text-xs font-semibold text-muted uppercase tracking-[0.1em]">
            Recent Activity
          </h3>
          <span className="text-[11px] font-mono text-faint">
            {filteredRecent.length} requests
          </span>
        </div>
        {filteredRecent.length === 0 ? (
          <EmptyState description="No usage records yet." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  {isAllAgents && (
                    <th className={cn(TH, "text-left")}>Agent</th>
                  )}
                  <th className={cn(TH, "text-left")}>Model</th>
                  <th className={cn(TH, "text-left")}>Source</th>
                  <th className={cn(TH, "text-right")}>Input</th>
                  <th className={cn(TH, "text-right")}>Output</th>
                  <th className={cn(TH, "text-center")}>Cache</th>
                  <th className={cn(TH, "text-right")}>Cost</th>
                  <th className={cn(TH, "text-right")}>Duration</th>
                  <th className={cn(TH, "text-right")}>When</th>
                </tr>
              </thead>
              <tbody>
                {filteredRecent.slice(0, 50).map((r) => (
                  <tr
                    key={r.id}
                    className="border-b border-border/30 hover:bg-bg-2/50 transition-colors"
                  >
                    {isAllAgents && (
                      <td className="px-4 py-2 font-mono text-foreground text-sm">
                        {r.agentId}
                      </td>
                    )}
                    <td className="px-4 py-2 font-mono text-xs text-muted max-w-[140px] truncate">
                      {r.model}
                    </td>
                    <td className="px-4 py-2">
                      <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium bg-bg-3 text-muted">
                        {r.source}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-right font-mono text-blue-400">
                      {formatNumber(r.inputTokens)}
                    </td>
                    <td className="px-4 py-2 text-right font-mono text-emerald-400">
                      {formatNumber(r.outputTokens)}
                    </td>
                    <td className="px-4 py-2">
                      <CacheBar
                        total={r.inputTokens}
                        cached={r.cacheReadTokens}
                      />
                    </td>
                    <td className="px-4 py-2 text-right font-mono text-amber-400">
                      {formatCost(r.costUsd)}
                    </td>
                    <td className="px-4 py-2 text-right font-mono text-muted text-xs">
                      {formatDuration(r.durationMs)}
                    </td>
                    <td className="px-4 py-2 text-right text-faint whitespace-nowrap text-xs">
                      {relativeTime(r.createdAt)}
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
