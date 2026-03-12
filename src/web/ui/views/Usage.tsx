import { useState, useEffect, useRef, useCallback } from "react";
import * as echarts from "echarts";
import { apiFetch } from "../api";
import { PageHeader, LoadingState, EmptyState, FilterTabs } from "../components";
import { formatNumber, relativeTime } from "../lib/format";
import { cn } from "../lib/cn";

interface UsageSummary {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
  totalCostUsd: number;
  totalRequests: number;
}

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

const RANGES = [
  { id: "24h", label: "24h", seconds: 86400 },
  { id: "7d", label: "7d", seconds: 7 * 86400 },
  { id: "30d", label: "30d", seconds: 30 * 86400 },
  { id: "all", label: "All", seconds: 0 },
] as const;

function formatCost(usd: number): string {
  if (usd === 0) return "$0.00";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

function formatDuration(ms: number): string {
  if (!ms) return "\u2014";
  if (ms < 1000) return `${ms}ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  return `${Math.floor(sec / 60)}m ${Math.round(sec % 60)}s`;
}

function sinceEpoch(rangeId: string): number | undefined {
  const range = RANGES.find((r) => r.id === rangeId);
  if (!range || range.seconds === 0) return undefined;
  return Math.floor(Date.now() / 1000) - range.seconds;
}

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
      {sub && <div className="text-[11px] text-faint mt-2 leading-relaxed">{sub}</div>}
    </div>
  );
}

function UsageChart({
  data,
  granularity,
}: {
  data: readonly TimePoint[];
  granularity: "hour" | "day";
}) {
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
      return granularity === "hour"
        ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
        : date.toLocaleDateString([], { month: "short", day: "numeric" });
    });

    chart.setOption(
      {
        tooltip: {
          trigger: "axis",
          backgroundColor: "rgba(20,20,25,0.95)",
          borderColor: "rgba(255,255,255,0.08)",
          textStyle: { color: "#e0e0e0", fontSize: 12 },
          formatter: (
            params: Array<{
              seriesName: string;
              value: number;
              marker: string;
            }>,
          ) => {
            const idx = (params[0] as unknown as { dataIndex: number })
              .dataIndex;
            const point = data[idx];
            if (!point) return "";
            const date = new Date(point.bucket);
            const header =
              granularity === "hour"
                ? date.toLocaleString()
                : date.toLocaleDateString();
            const fresh =
              point.inputTokens -
              point.cacheReadTokens -
              point.cacheCreationTokens;
            return `<div style="font-weight:600;margin-bottom:4px">${header}</div>
              ${params.map((p) => `${p.marker} ${p.seriesName}: <b>${typeof p.value === "number" && p.seriesName === "Cost" ? formatCost(p.value) : formatNumber(p.value)}</b>`).join("<br>")}
              <br/><span style="color:#888">Cache read: ${formatNumber(point.cacheReadTokens)} | Fresh: ${formatNumber(fresh)}</span>
              <br/><span style="color:#888">Requests: ${point.requestCount}</span>`;
          },
        },
        grid: { left: 60, right: 60, top: 20, bottom: 30 },
        xAxis: {
          type: "category",
          data: labels,
          axisLine: { lineStyle: { color: "rgba(255,255,255,0.1)" } },
          axisLabel: { color: "#888", fontSize: 11 },
        },
        yAxis: [
          {
            type: "value",
            name: "Tokens",
            nameTextStyle: { color: "#888", fontSize: 11 },
            axisLabel: {
              color: "#888",
              fontSize: 11,
              formatter: (v: number) => formatNumber(v),
            },
            splitLine: { lineStyle: { color: "rgba(255,255,255,0.05)" } },
          },
          {
            type: "value",
            name: "Cost",
            nameTextStyle: { color: "#888", fontSize: 11 },
            axisLabel: {
              color: "#888",
              fontSize: 11,
              formatter: (v: number) => formatCost(v),
            },
            splitLine: { show: false },
          },
        ],
        series: [
          {
            name: "Cache Read",
            type: "bar",
            stack: "input",
            data: data.map((d) => d.cacheReadTokens),
            itemStyle: { color: "rgba(59,130,246,0.35)" },
            barMaxWidth: 24,
          },
          {
            name: "Fresh Input",
            type: "bar",
            stack: "input",
            data: data.map(
              (d) =>
                d.inputTokens - d.cacheReadTokens - d.cacheCreationTokens,
            ),
            itemStyle: { color: "rgba(59,130,246,0.8)" },
            barMaxWidth: 24,
          },
          {
            name: "Output",
            type: "bar",
            stack: "output",
            data: data.map((d) => d.outputTokens),
            itemStyle: { color: "rgba(16,185,129,0.7)" },
            barMaxWidth: 24,
          },
          {
            name: "Cost",
            type: "line",
            yAxisIndex: 1,
            data: data.map((d) => d.costUsd),
            lineStyle: { color: "#f59e0b", width: 2 },
            itemStyle: { color: "#f59e0b" },
            symbol: "circle",
            symbolSize: 4,
            smooth: true,
          },
        ],
      },
      { notMerge: true },
    );
  }, [data, granularity]);

  return <div ref={containerRef} className="w-full h-[300px]" />;
}

function CacheBar({ total, cached }: { total: number; cached: number }) {
  if (total === 0) return <span className="text-faint">\u2014</span>;
  const pct = Math.round((cached / total) * 100);
  const barColor =
    pct >= 80
      ? "bg-success/60"
      : pct >= 40
        ? "bg-blue-400/60"
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

function CostBar({ cost, maxCost }: { cost: number; maxCost: number }) {
  if (maxCost === 0) return null;
  const pct = Math.round((cost / maxCost) * 100);
  return (
    <div className="flex items-center gap-2">
      <span className="font-mono text-amber-400 w-16 text-right shrink-0">
        {formatCost(cost)}
      </span>
      <div className="flex-1 h-1.5 rounded-full bg-bg-3 overflow-hidden min-w-8">
        <div
          className="h-full rounded-full bg-amber-400/40 transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

const TH =
  "text-[10px] font-semibold text-faint uppercase tracking-[0.1em] px-4 py-2.5";

function AgentTable({
  data,
  maxCost,
}: {
  data: readonly AgentUsage[];
  maxCost: number;
}) {
  return (
    <div className="bg-bg-1 border border-border rounded-lg overflow-hidden">
      <div className="px-4 py-3 border-b border-border flex items-center justify-between">
        <h3 className="text-xs font-semibold text-muted uppercase tracking-[0.1em]">
          By Agent
        </h3>
        <span className="text-[11px] font-mono text-faint">
          {data.length} agents
        </span>
      </div>
      {data.length === 0 ? (
        <div className="px-5 py-8 text-center text-faint text-sm">
          No data yet
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                <th className={cn(TH, "text-left")}>Agent</th>
                <th className={cn(TH, "text-right")}>Req</th>
                <th className={cn(TH, "text-right")}>Input</th>
                <th className={cn(TH, "text-right")}>Output</th>
                <th className={cn(TH, "text-center")}>Cache</th>
                <th className={cn(TH, "text-right")}>Cost</th>
              </tr>
            </thead>
            <tbody>
              {data.map((a) => (
                <tr
                  key={a.agentId}
                  className="border-b border-border/30 hover:bg-bg-2/50 transition-colors"
                >
                  <td className="px-4 py-2.5 font-mono text-foreground text-sm">
                    {a.agentId}
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono text-muted">
                    {a.requestCount}
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono text-blue-400">
                    {formatNumber(a.totalInputTokens)}
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono text-emerald-400">
                    {formatNumber(a.totalOutputTokens)}
                  </td>
                  <td className="px-4 py-2.5">
                    <CacheBar
                      total={a.totalInputTokens}
                      cached={a.totalCacheReadTokens}
                    />
                  </td>
                  <td className="px-4 py-2.5">
                    <CostBar cost={a.totalCostUsd} maxCost={maxCost} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ModelTable({
  data,
  maxCost,
}: {
  data: readonly ModelUsage[];
  maxCost: number;
}) {
  return (
    <div className="bg-bg-1 border border-border rounded-lg overflow-hidden">
      <div className="px-4 py-3 border-b border-border flex items-center justify-between">
        <h3 className="text-xs font-semibold text-muted uppercase tracking-[0.1em]">
          By Model
        </h3>
        <span className="text-[11px] font-mono text-faint">
          {data.length} models
        </span>
      </div>
      {data.length === 0 ? (
        <div className="px-5 py-8 text-center text-faint text-sm">
          No data yet
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                <th className={cn(TH, "text-left")}>Model</th>
                <th className={cn(TH, "text-right")}>Req</th>
                <th className={cn(TH, "text-right")}>Input</th>
                <th className={cn(TH, "text-right")}>Output</th>
                <th className={cn(TH, "text-center")}>Cache</th>
                <th className={cn(TH, "text-right")}>Cost</th>
              </tr>
            </thead>
            <tbody>
              {data.map((m) => (
                <tr
                  key={m.model}
                  className="border-b border-border/30 hover:bg-bg-2/50 transition-colors"
                >
                  <td className="px-4 py-2.5 font-mono text-foreground text-xs">
                    {m.model}
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono text-muted">
                    {m.requestCount}
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono text-blue-400">
                    {formatNumber(m.totalInputTokens)}
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono text-emerald-400">
                    {formatNumber(m.totalOutputTokens)}
                  </td>
                  <td className="px-4 py-2.5">
                    <CacheBar
                      total={m.totalInputTokens}
                      cached={m.totalCacheReadTokens}
                    />
                  </td>
                  <td className="px-4 py-2.5">
                    <CostBar cost={m.totalCostUsd} maxCost={maxCost} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default function Usage() {
  const [range, setRange] = useState("7d");
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [byAgent, setByAgent] = useState<AgentUsage[]>([]);
  const [byModel, setByModel] = useState<ModelUsage[]>([]);
  const [timeSeries, setTimeSeries] = useState<TimePoint[]>([]);
  const [recent, setRecent] = useState<RecentRecord[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    const since = sinceEpoch(range);
    const qs = since ? `?since=${since}` : "";
    const granularity = range === "24h" ? "hour" : "day";
    const tsQs = since
      ? `?since=${since}&granularity=${granularity}`
      : `?granularity=${granularity}`;

    try {
      const [sumRes, agentRes, modelRes, tsRes, recentRes] = await Promise.all([
        apiFetch<{ success: boolean; data: UsageSummary }>(
          `/api/usage/summary${qs}`,
        ),
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
          "/api/usage/recent?limit=50",
        ),
      ]);
      if (sumRes.success) setSummary(sumRes.data);
      if (agentRes.success) setByAgent(agentRes.data);
      if (modelRes.success) setByModel(modelRes.data);
      if (tsRes.success) setTimeSeries(tsRes.data);
      if (recentRes.success) setRecent(recentRes.data);
    } catch {
      // ignore
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
    return <LoadingState message="Loading usage data..." />;
  }

  const totalTokens =
    (summary?.totalInputTokens ?? 0) + (summary?.totalOutputTokens ?? 0);
  const totalReqs = summary?.totalRequests ?? 0;
  const costPerReq =
    totalReqs > 0 ? (summary?.totalCostUsd ?? 0) / totalReqs : 0;
  const cacheHitPct =
    (summary?.totalInputTokens ?? 0) > 0
      ? Math.round(
          ((summary?.totalCacheReadTokens ?? 0) /
            (summary?.totalInputTokens ?? 1)) *
            100,
        )
      : 0;

  const agentMaxCost = Math.max(...byAgent.map((a) => a.totalCostUsd), 0);
  const modelMaxCost = Math.max(...byModel.map((m) => m.totalCostUsd), 0);

  return (
    <div className="max-w-[1200px]">
      <PageHeader
        title="Usage"
        subtitle="Token consumption and cost tracking"
      />

      <FilterTabs
        tabs={RANGES.map((r) => ({ id: r.id, label: r.label }))}
        active={range}
        onChange={setRange}
      />

      {/* Summary cards */}
      <div className="grid grid-cols-3 max-lg:grid-cols-2 max-sm:grid-cols-1 gap-3 mb-6">
        <StatCard
          label="Total Cost"
          value={formatCost(summary?.totalCostUsd ?? 0)}
          accent="text-amber-400"
          sub={
            totalReqs > 0
              ? `${formatCost(costPerReq)} avg per request`
              : undefined
          }
        />
        <StatCard
          label="Requests"
          value={formatNumber(totalReqs)}
          sub={
            totalTokens > 0
              ? `${formatNumber(totalTokens)} total tokens`
              : undefined
          }
        />
        <StatCard
          label="Cache Hit Rate"
          value={`${cacheHitPct}%`}
          accent={
            cacheHitPct >= 70
              ? "text-success"
              : cacheHitPct >= 40
                ? "text-blue-400"
                : "text-warning"
          }
          sub={
            (summary?.totalCacheReadTokens ?? 0) > 0
              ? `${formatNumber(summary?.totalCacheReadTokens ?? 0)} cached / ${formatNumber(summary?.totalInputTokens ?? 0)} input`
              : undefined
          }
        />
        <StatCard
          label="Input Tokens"
          value={formatNumber(summary?.totalInputTokens ?? 0)}
          accent="text-blue-400"
          sub={
            (summary?.totalCacheCreationTokens ?? 0) > 0
              ? `${formatNumber(summary?.totalCacheCreationTokens ?? 0)} cache writes`
              : undefined
          }
        />
        <StatCard
          label="Output Tokens"
          value={formatNumber(summary?.totalOutputTokens ?? 0)}
          accent="text-emerald-400"
        />
        <StatCard
          label="Avg Tokens / Request"
          value={
            totalReqs > 0
              ? formatNumber(Math.round(totalTokens / totalReqs))
              : "\u2014"
          }
          sub={
            totalReqs > 0
              ? `${formatNumber(Math.round((summary?.totalInputTokens ?? 0) / totalReqs))} in / ${formatNumber(Math.round((summary?.totalOutputTokens ?? 0) / totalReqs))} out`
              : undefined
          }
        />
      </div>

      {/* Time series chart */}
      {timeSeries.length > 0 && (
        <div className="bg-bg-1 border border-border rounded-lg p-5 mb-6">
          <h3 className="text-xs font-semibold text-muted uppercase tracking-[0.1em] mb-3">
            Usage Over Time
          </h3>
          <UsageChart
            data={timeSeries}
            granularity={range === "24h" ? "hour" : "day"}
          />
        </div>
      )}

      {/* Per-agent and per-model tables */}
      <div className="grid grid-cols-2 max-lg:grid-cols-1 gap-4 mb-6">
        <AgentTable data={byAgent} maxCost={agentMaxCost} />
        <ModelTable data={byModel} maxCost={modelMaxCost} />
      </div>

      {/* Recent usage records */}
      <div className="bg-bg-1 border border-border rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-border flex items-center justify-between">
          <h3 className="text-xs font-semibold text-muted uppercase tracking-[0.1em]">
            Recent Activity
          </h3>
          <span className="text-[11px] font-mono text-faint">
            Last {recent.length} requests
          </span>
        </div>
        {recent.length === 0 ? (
          <EmptyState description="No usage records yet. Token tracking starts when agents respond." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className={cn(TH, "text-left")}>Agent</th>
                  <th className={cn(TH, "text-left")}>Source</th>
                  <th className={cn(TH, "text-left")}>Model</th>
                  <th className={cn(TH, "text-right")}>Input</th>
                  <th className={cn(TH, "text-right")}>Output</th>
                  <th className={cn(TH, "text-center")}>Cache</th>
                  <th className={cn(TH, "text-right")}>Cost</th>
                  <th className={cn(TH, "text-right")}>Duration</th>
                  <th className={cn(TH, "text-right")}>When</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((r) => (
                  <tr
                    key={r.id}
                    className="border-b border-border/30 hover:bg-bg-2/50 transition-colors"
                  >
                    <td className="px-4 py-2 font-mono text-foreground text-sm">
                      {r.agentId}
                    </td>
                    <td className="px-4 py-2">
                      <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium bg-bg-3 text-muted">
                        {r.source}
                      </span>
                    </td>
                    <td className="px-4 py-2 font-mono text-xs text-muted max-w-[140px] truncate">
                      {r.model}
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
