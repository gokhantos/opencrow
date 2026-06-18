import { useRef, useMemo } from "react";
import * as echarts from "echarts";
import { useChart } from "../../lib/useChart";
import { formatNumber, formatCost } from "../../lib/format";
import {
  type AgentUsage,
  type ModelUsage,
  type TimePoint,
  type RecentRecord,
  AGENT_COLORS,
  MODEL_COLORS,
  TOOLTIP_STYLE,
  AXIS_LABEL,
  SPLIT_LINE,
} from "./types";

// ============================================================================
// Cost Over Time Chart (area + bar overlay)
// ============================================================================

export function CostTimelineChart({
  data,
  granularity,
}: {
  readonly data: readonly TimePoint[];
  readonly granularity: "hour" | "day";
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
            <span style="color:#f59e0b">●</span> Cost: <b>${formatCost(point.costUsd)}</b><br/>
            <span style="color:#a78bfa">●</span> Requests: <b>${point.requestCount}</b><br/>
            <span style="color:#707078">●</span> Tokens: <b>${formatNumber(point.inputTokens + point.outputTokens)}</b>`;
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

export function CostByAgentChart({ data }: { readonly data: readonly AgentUsage[] }) {
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

export function CostByModelChart({ data }: { readonly data: readonly ModelUsage[] }) {
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

export function TokenDistributionChart({
  input,
  output,
  cacheRead,
  cacheCreation,
}: {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheCreation: number;
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

export function ActivityTimelineChart({
  data,
  granularity,
  agentIds,
}: {
  readonly data: readonly RecentRecord[];
  readonly granularity: "hour" | "day";
  readonly agentIds: readonly string[];
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
