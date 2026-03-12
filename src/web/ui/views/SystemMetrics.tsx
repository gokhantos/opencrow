import React, { useState, useEffect, useRef } from "react";
import * as echarts from "echarts";
import { apiFetch } from "../api";
import {
  Activity,
  Cpu,
  HardDrive,
  Database,
  Zap,
  TrendingUp,
  AlertCircle,
  CheckCircle,
} from "lucide-react";
import { cn } from "../lib/cn";
import { LoadingState, Button } from "../components";

// ============================================================================
// Types
// ============================================================================

interface DiskInfo {
  filesystem: string;
  mount: string;
  total: number;
  used: number;
  available: number;
  percentage: number;
}

interface SystemMetricsData {
  timestamp: number;
  cpu: {
    usage: number;
    loadAvg: [number, number, number];
  };
  memory: {
    total: number;
    used: number;
    free: number;
    available: number;
    percentage: number;
  };
  disk: DiskInfo[];
  processes: Array<{
    pid: number;
    name: string;
    cpu: number;
    memory: number;
    memoryMB: number;
  }>;
}

// ============================================================================
// Design Tokens
// ============================================================================

const C = {
  teal: "#2dd4bf",
  purple: "#a78bfa",
  deepPurple: "#7928ca",
  amber: "#f5a623",
  red: "#f87171",
  blue: "#3b82f6",
  border: "rgba(255,255,255,0.06)",
  borderHover: "rgba(255,255,255,0.12)",
  cardBg: "rgba(19, 19, 22, 0.65)",
  tooltipBg: "rgba(10, 10, 14, 0.95)",
};

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

/** Convert 6-digit hex to rgba string */
function rgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
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
// Shared Chart Styles
// ============================================================================

const tooltipStyle: echarts.EChartsOption["tooltip"] = {
  backgroundColor: C.tooltipBg,
  borderColor: C.border,
  borderWidth: 1,
  textStyle: {
    color: "#b0b0b8",
    fontSize: 12,
    fontFamily: "'JetBrains Mono', monospace",
  },
  extraCssText:
    "border-radius:10px;box-shadow:0 8px 32px rgba(0,0,0,0.4);backdrop-filter:blur(8px);",
};

const axisLabel = {
  color: "#454550",
  fontSize: 11,
  fontFamily: "'JetBrains Mono', monospace",
};

const splitLine = {
  lineStyle: { color: "rgba(255,255,255,0.04)", type: "dashed" as const },
};

// ============================================================================
// Chart Option Builders
// ============================================================================

function buildTimelineOption(
  chartData: { time: string; cpu: number; memory: number }[],
): echarts.EChartsOption {
  return {
    tooltip: { ...tooltipStyle, trigger: "axis" },
    grid: { top: 16, right: 16, bottom: 28, left: 42, containLabel: false },
    xAxis: {
      type: "category",
      data: chartData.map((d) => d.time),
      axisLabel: { ...axisLabel, show: true },
      axisLine: { show: false },
      axisTick: { show: false },
      boundaryGap: false,
    },
    yAxis: {
      type: "value",
      min: 0,
      max: 100,
      axisLabel,
      splitLine,
      axisLine: { show: false },
      axisTick: { show: false },
    },
    series: [
      {
        name: "CPU %",
        type: "line",
        data: chartData.map((d) => d.cpu),
        smooth: true,
        showSymbol: false,
        lineStyle: { color: C.teal, width: 2.5 },
        areaStyle: {
          color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
            { offset: 0, color: rgba(C.teal, 0.35) },
            { offset: 0.6, color: rgba(C.teal, 0.08) },
            { offset: 1, color: rgba(C.teal, 0) },
          ]),
        },
        itemStyle: { color: C.teal },
      },
      {
        name: "Memory %",
        type: "line",
        data: chartData.map((d) => d.memory),
        smooth: true,
        showSymbol: false,
        lineStyle: { color: C.purple, width: 2.5 },
        areaStyle: {
          color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
            { offset: 0, color: rgba(C.purple, 0.3) },
            { offset: 0.6, color: rgba(C.purple, 0.06) },
            { offset: 1, color: rgba(C.purple, 0) },
          ]),
        },
        itemStyle: { color: C.purple },
      },
    ],
    animation: false,
  };
}

function buildGaugeOption(cpuUsage: number): echarts.EChartsOption {
  const gaugeColor =
    cpuUsage > 80 ? C.red : cpuUsage > 60 ? C.amber : C.teal;

  return {
    series: [
      {
        type: "gauge",
        startAngle: 220,
        endAngle: -40,
        min: 0,
        max: 100,
        radius: "88%",
        progress: {
          show: true,
          width: 16,
          roundCap: true,
          itemStyle: {
            color: new echarts.graphic.LinearGradient(0, 0, 1, 0, [
              { offset: 0, color: gaugeColor },
              { offset: 1, color: rgba(gaugeColor, 0.6) },
            ]),
            shadowColor: rgba(gaugeColor, 0.4),
            shadowBlur: 12,
          },
        },
        axisLine: {
          lineStyle: {
            width: 16,
            color: [[1, "rgba(255,255,255,0.04)"]],
          },
          roundCap: true,
        },
        axisTick: { show: false },
        splitLine: { show: false },
        axisLabel: { show: false },
        pointer: { show: false },
        title: {
          show: true,
          offsetCenter: [0, "32%"],
          fontSize: 12,
          color: "#707078",
          fontFamily: "'JetBrains Mono', monospace",
        },
        detail: {
          valueAnimation: true,
          offsetCenter: [0, "-5%"],
          fontSize: 30,
          fontWeight: 700,
          fontFamily: "'JetBrains Mono', monospace",
          formatter: "{value}%",
          color: "#e8e8ec",
        },
        data: [{ value: Math.round(cpuUsage * 10) / 10, name: "CPU" }],
      },
    ],
    animation: true,
  };
}

function buildPieOption(
  usedGB: number,
  availableGB: number,
): echarts.EChartsOption {
  return {
    tooltip: {
      ...tooltipStyle,
      trigger: "item",
      formatter: (p: unknown) => {
        const item = p as { name: string; value: number };
        return `${item.name}: ${item.value.toFixed(1)} GB`;
      },
    },
    series: [
      {
        type: "pie",
        radius: ["52%", "78%"],
        center: ["50%", "50%"],
        padAngle: 4,
        itemStyle: { borderRadius: 6 },
        label: { show: false },
        emphasis: {
          itemStyle: {
            shadowBlur: 16,
            shadowColor: "rgba(0,0,0,0.3)",
          },
        },
        data: [
          {
            value: usedGB,
            name: "Used",
            itemStyle: {
              color: new echarts.graphic.LinearGradient(0, 0, 1, 1, [
                { offset: 0, color: C.purple },
                { offset: 1, color: C.red },
              ]),
            },
          },
          {
            value: availableGB,
            name: "Available",
            itemStyle: {
              color: new echarts.graphic.LinearGradient(0, 0, 1, 1, [
                { offset: 0, color: C.teal },
                { offset: 1, color: rgba(C.teal, 0.5) },
              ]),
            },
          },
        ],
      },
    ],
    animation: true,
  };
}

function buildLoadOption(
  chartData: {
    time: string;
    load1m: number;
    load5m: number;
    load15m: number;
  }[],
): echarts.EChartsOption {
  return {
    tooltip: { ...tooltipStyle, trigger: "axis" },
    grid: { top: 16, right: 16, bottom: 28, left: 42, containLabel: false },
    xAxis: {
      type: "category",
      data: chartData.map((d) => d.time),
      axisLabel: { ...axisLabel, show: true },
      axisLine: { show: false },
      axisTick: { show: false },
      boundaryGap: false,
    },
    yAxis: {
      type: "value",
      axisLabel,
      splitLine,
      axisLine: { show: false },
      axisTick: { show: false },
    },
    series: [
      {
        name: "1m Load",
        type: "line",
        data: chartData.map((d) => d.load1m),
        smooth: true,
        showSymbol: false,
        lineStyle: { color: C.deepPurple, width: 2 },
        areaStyle: {
          color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
            { offset: 0, color: rgba(C.deepPurple, 0.2) },
            { offset: 1, color: rgba(C.deepPurple, 0) },
          ]),
        },
        itemStyle: { color: C.deepPurple },
      },
      {
        name: "5m Load",
        type: "line",
        data: chartData.map((d) => d.load5m),
        smooth: true,
        showSymbol: false,
        lineStyle: { color: C.amber, width: 2 },
        itemStyle: { color: C.amber },
      },
      {
        name: "15m Load",
        type: "line",
        data: chartData.map((d) => d.load15m),
        smooth: true,
        showSymbol: false,
        lineStyle: { color: C.red, width: 2, type: "dashed" },
        itemStyle: { color: C.red },
      },
    ],
    animation: false,
  };
}

// ============================================================================
// Chart Wrapper Components
// ============================================================================

function TimelineChart({
  data,
}: {
  data: { time: string; cpu: number; memory: number }[];
}) {
  const ref = useRef<HTMLDivElement>(null);
  useChart(ref, buildTimelineOption(data));
  return <div ref={ref} style={{ width: "100%", height: 320 }} />;
}

function GaugeChart({ value }: { value: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useChart(ref, buildGaugeOption(value));
  return <div ref={ref} style={{ width: "100%", height: 160 }} />;
}

function MemoryPieChart({
  usedGB,
  availableGB,
}: {
  usedGB: number;
  availableGB: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useChart(ref, buildPieOption(usedGB, availableGB));
  return <div ref={ref} style={{ width: "100%", height: 160 }} />;
}

function LoadChart({
  data,
}: {
  data: { time: string; load1m: number; load5m: number; load15m: number }[];
}) {
  const ref = useRef<HTMLDivElement>(null);
  useChart(ref, buildLoadOption(data));
  return <div ref={ref} style={{ width: "100%", height: 240 }} />;
}

// ============================================================================
// Glass Card (shared container)
// ============================================================================

function GlassCard({
  children,
  className,
  accentColor,
}: {
  children: React.ReactNode;
  className?: string;
  accentColor?: string;
}) {
  return (
    <div
      className={cn(
        "relative rounded-xl overflow-hidden border transition-all duration-300",
        "hover:border-white/[0.12] hover:shadow-[0_0_30px_rgba(0,0,0,0.3)]",
        className,
      )}
      style={{
        background: C.cardBg,
        borderColor: C.border,
        backdropFilter: "blur(16px)",
      }}
    >
      {accentColor && (
        <div
          className="absolute top-0 left-0 right-0 h-[2px]"
          style={{
            background: `linear-gradient(90deg, ${accentColor}, ${rgba(accentColor, 0.2)}, transparent)`,
          }}
        />
      )}
      {children}
    </div>
  );
}

// ============================================================================
// Metric Card (premium)
// ============================================================================

function MetricCard({
  title,
  value,
  detail,
  icon: Icon,
  color,
  trend,
}: {
  title: string;
  value: string;
  detail?: string;
  icon: React.ElementType;
  color: string;
  trend?: number;
}) {
  return (
    <GlassCard accentColor={color} className="p-6 group">
      <div className="flex items-center gap-4 mb-4">
        {/* Icon with glow */}
        <div className="relative">
          <div
            className="absolute inset-[-4px] rounded-xl blur-xl opacity-25 transition-opacity duration-300 group-hover:opacity-40"
            style={{ backgroundColor: color }}
          />
          <div
            className="relative w-10 h-10 rounded-xl flex items-center justify-center"
            style={{ backgroundColor: rgba(color, 0.12) }}
          >
            <Icon size={20} style={{ color }} />
          </div>
        </div>
        <h3 className="text-[10px] font-semibold text-faint uppercase tracking-[0.12em]">
          {title}
        </h3>
      </div>

      {/* Value with glow */}
      <div
        className="font-mono text-[2rem] font-bold text-strong mb-1 tabular-nums tracking-tight leading-none"
        style={{ textShadow: `0 0 40px ${rgba(color, 0.25)}` }}
      >
        {value}
      </div>
      {detail && (
        <div className="font-mono text-sm text-faint mt-2">{detail}</div>
      )}

      {/* Trend badge */}
      {trend !== undefined && Math.abs(trend) > 0.1 && (
        <div
          className="absolute top-5 right-5 flex items-center gap-1.5 font-mono text-xs font-semibold px-2.5 py-1 rounded-full"
          style={{
            color: trend > 0 ? C.red : C.teal,
            backgroundColor: rgba(trend > 0 ? C.red : C.teal, 0.1),
            border: `1px solid ${rgba(trend > 0 ? C.red : C.teal, 0.2)}`,
          }}
        >
          <TrendingUp
            size={14}
            style={{ transform: trend < 0 ? "scaleY(-1)" : "none" }}
          />
          <span>{Math.abs(trend).toFixed(1)}%</span>
        </div>
      )}
    </GlassCard>
  );
}

// ============================================================================
// Chart Section Card
// ============================================================================

function ChartSection({
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
    <GlassCard className={cn("p-6", className)}>
      <div className="flex justify-between items-center mb-5">
        <h3 className="text-sm font-semibold m-0 text-strong tracking-tight">
          {title}
        </h3>
        {right}
      </div>
      {children}
    </GlassCard>
  );
}

// ============================================================================
// Main Component
// ============================================================================

export default function SystemMetrics() {
  const [metrics, setMetrics] = useState<SystemMetricsData[]>([]);
  const [currentMetrics, setCurrentMetrics] =
    useState<SystemMetricsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchMetrics();
    const interval = setInterval(fetchMetrics, 2000);
    return () => clearInterval(interval);
  }, []);

  async function fetchMetrics() {
    try {
      const data = await apiFetch<SystemMetricsData>("/api/system/metrics");
      setCurrentMetrics(data);
      setMetrics((prev) => {
        const newMetrics = [...prev, data];
        return newMetrics.slice(-60);
      });
      setLoading(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch metrics");
      setLoading(false);
    }
  }

  if (loading) return <LoadingState />;

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-[60vh] gap-5 text-center">
        <AlertCircle size={52} color={C.red} />
        <h2 className="text-xl font-bold text-strong m-0">
          Unable to load metrics
        </h2>
        <p className="text-faint m-0 text-sm">{error}</p>
        <Button variant="secondary" onClick={fetchMetrics}>
          Retry
        </Button>
      </div>
    );
  }

  const chartData = metrics.map((m) => ({
    time: new Date(m.timestamp).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }),
    cpu: m.cpu.usage,
    memory: m.memory.percentage,
    load1m: m.cpu.loadAvg[0],
    load5m: m.cpu.loadAvg[1],
    load15m: m.cpu.loadAvg[2],
  }));

  const processData =
    currentMetrics?.processes
      .filter((p) => p.cpu > 0 || p.memoryMB > 50)
      .sort((a, b) => b.cpu - a.cpu)
      .slice(0, 8) || [];

  const cpuTrend =
    metrics.length > 10
      ? metrics[metrics.length - 1]!.cpu.usage -
        metrics[metrics.length - 10]!.cpu.usage
      : 0;

  const memoryTrend =
    metrics.length > 10
      ? metrics[metrics.length - 1]!.memory.percentage -
        metrics[metrics.length - 10]!.memory.percentage
      : 0;

  const usedGB = currentMetrics
    ? currentMetrics.memory.used / 1024 / 1024 / 1024
    : 0;
  const availableGB = currentMetrics
    ? currentMetrics.memory.available / 1024 / 1024 / 1024
    : 0;

  const getHealthStatus = () => {
    if (!currentMetrics)
      return { status: "unknown", color: "#666", icon: AlertCircle };
    const { cpu, memory, disk } = currentMetrics;
    const maxDiskPct =
      disk.length > 0 ? Math.max(...disk.map((d) => d.percentage)) : 0;

    if (cpu.usage > 90 || memory.percentage > 90 || maxDiskPct > 95) {
      return { status: "Critical", color: C.red, icon: AlertCircle };
    }
    if (cpu.usage > 70 || memory.percentage > 70 || maxDiskPct > 85) {
      return { status: "Warning", color: C.amber, icon: AlertCircle };
    }
    return { status: "Healthy", color: C.teal, icon: CheckCircle };
  };

  const health = getHealthStatus();

  return (
    <div className="max-w-[1600px] mx-auto">
      {/* Page Header */}
      <div className="flex justify-between items-start mb-8 pb-6 border-b border-white/[0.06] max-md:flex-col max-md:gap-4 max-md:items-start">
        <div className="flex flex-col gap-1.5">
          <h1 className="m-0 font-bold text-[1.85rem] tracking-tight text-strong leading-[1.2]">
            System Metrics
          </h1>
          <p className="text-faint text-sm m-0">
            Real-time monitoring and performance analysis
          </p>
        </div>

        {/* Health badge with glow */}
        <div
          className="inline-flex items-center gap-2.5 px-4 py-2.5 rounded-xl text-sm font-semibold transition-all duration-300"
          style={{
            color: health.color,
            backgroundColor: rgba(health.color, 0.08),
            border: `1px solid ${rgba(health.color, 0.25)}`,
            boxShadow: `0 0 20px ${rgba(health.color, 0.1)}`,
          }}
        >
          {/* Animated pulse dot */}
          <span className="relative flex h-2.5 w-2.5">
            <span
              className="absolute inline-flex h-full w-full rounded-full opacity-60 animate-ping"
              style={{ backgroundColor: health.color }}
            />
            <span
              className="relative inline-flex rounded-full h-2.5 w-2.5"
              style={{ backgroundColor: health.color }}
            />
          </span>
          System {health.status}
        </div>
      </div>

      {currentMetrics && (
        <>
          {/* Metric Cards */}
          <div className="grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-4 mb-6 max-md:grid-cols-1">
            <MetricCard
              title="CPU Usage"
              value={`${currentMetrics.cpu.usage.toFixed(1)}%`}
              detail={`Load: ${currentMetrics.cpu.loadAvg.map((l) => l.toFixed(2)).join(" / ")}`}
              icon={Cpu}
              color={C.teal}
              trend={cpuTrend}
            />
            <MetricCard
              title="Memory Usage"
              value={`${currentMetrics.memory.percentage.toFixed(1)}%`}
              detail={`${(currentMetrics.memory.used / 1024 / 1024 / 1024).toFixed(1)} / ${(currentMetrics.memory.total / 1024 / 1024 / 1024).toFixed(1)} GB`}
              icon={HardDrive}
              color={C.purple}
              trend={memoryTrend}
            />
            <MetricCard
              title="Active Processes"
              value={processData.length.toString()}
              detail="High resource usage"
              icon={Activity}
              color={C.deepPurple}
            />
            <MetricCard
              title="System Load"
              value={currentMetrics.cpu.loadAvg[0].toFixed(2)}
              detail="1 minute average"
              icon={Zap}
              color={C.amber}
            />
            {currentMetrics.disk.length > 0 && (
              <MetricCard
                title="Disk Usage"
                value={`${currentMetrics.disk[0]!.percentage.toFixed(0)}%`}
                detail={`${formatBytes(currentMetrics.disk[0]!.used)} / ${formatBytes(currentMetrics.disk[0]!.total)}`}
                icon={Database}
                color={C.blue}
              />
            )}
          </div>

          {/* Performance Timeline + Side Charts */}
          <div className="grid grid-cols-[2fr_1fr] gap-4 mb-5 max-lg:grid-cols-1">
            <ChartSection
              title="Performance Timeline"
              right={
                <div className="flex gap-5">
                  <span className="flex items-center gap-2 text-xs text-muted font-mono">
                    <span
                      className="w-2 h-2 rounded-full"
                      style={{ backgroundColor: C.teal }}
                    />
                    CPU
                  </span>
                  <span className="flex items-center gap-2 text-xs text-muted font-mono">
                    <span
                      className="w-2 h-2 rounded-full"
                      style={{ backgroundColor: C.purple }}
                    />
                    Memory
                  </span>
                </div>
              }
            >
              <TimelineChart data={chartData} />
            </ChartSection>

            <div className="flex flex-col gap-4 max-lg:flex-row max-md:flex-col">
              <ChartSection title="CPU Gauge">
                <GaugeChart value={currentMetrics.cpu.usage} />
              </ChartSection>
              <ChartSection title="Memory Split">
                <MemoryPieChart usedGB={usedGB} availableGB={availableGB} />
                <div className="flex justify-center gap-5 mt-2">
                  <span className="flex items-center gap-1.5 text-[11px] text-muted font-mono">
                    <span
                      className="w-2 h-2 rounded-full"
                      style={{ backgroundColor: C.purple }}
                    />
                    Used: {usedGB.toFixed(1)} GB
                  </span>
                  <span className="flex items-center gap-1.5 text-[11px] text-muted font-mono">
                    <span
                      className="w-2 h-2 rounded-full"
                      style={{ backgroundColor: C.teal }}
                    />
                    Free: {availableGB.toFixed(1)} GB
                  </span>
                </div>
              </ChartSection>
            </div>
          </div>

          {/* Disk Usage */}
          {currentMetrics.disk.length > 0 && (
            <ChartSection title="Disk Usage" className="mb-5">
              <div className="flex flex-col gap-3">
                {currentMetrics.disk.map((d) => {
                  const barColor =
                    d.percentage > 90
                      ? C.red
                      : d.percentage > 75
                        ? C.amber
                        : C.teal;
                  return (
                    <div
                      key={d.mount}
                      className="grid grid-cols-[180px_1fr_60px] gap-4 items-center p-4 rounded-lg transition-all duration-200 hover:bg-white/[0.02] max-md:grid-cols-[1fr_60px]"
                      style={{ border: `1px solid ${C.border}` }}
                    >
                      <div className="flex flex-col gap-0.5 min-w-0 max-md:col-span-full">
                        <div className="font-mono font-semibold text-sm text-strong whitespace-nowrap overflow-hidden text-ellipsis">
                          {d.mount}
                        </div>
                        <div className="font-mono text-xs text-faint whitespace-nowrap overflow-hidden text-ellipsis">
                          {d.filesystem}
                        </div>
                      </div>
                      <div className="flex flex-col gap-1.5">
                        <div className="h-2.5 rounded-full overflow-hidden bg-white/[0.04]">
                          <div
                            className="h-full rounded-full transition-all duration-500"
                            style={{
                              width: `${Math.min(d.percentage, 100)}%`,
                              background: `linear-gradient(90deg, ${barColor}, ${rgba(barColor, 0.6)})`,
                              boxShadow: `0 0 8px ${rgba(barColor, 0.3)}`,
                            }}
                          />
                        </div>
                        <div className="flex justify-between font-mono text-xs text-faint max-md:flex-wrap max-md:gap-1">
                          <span>{formatBytes(d.used)} used</span>
                          <span>{formatBytes(d.available)} free</span>
                          <span>{formatBytes(d.total)} total</span>
                        </div>
                      </div>
                      <div
                        className="font-mono font-bold text-base text-right tabular-nums"
                        style={{
                          color: barColor,
                          textShadow: `0 0 20px ${rgba(barColor, 0.3)}`,
                        }}
                      >
                        {d.percentage.toFixed(0)}%
                      </div>
                    </div>
                  );
                })}
              </div>
            </ChartSection>
          )}

          {/* Load Average + Processes */}
          <div className="grid grid-cols-2 gap-4 mb-5 max-md:grid-cols-1">
            <ChartSection
              title="System Load Average"
              right={
                <div className="flex gap-4">
                  <span className="flex items-center gap-1.5 text-[11px] text-muted font-mono">
                    <span
                      className="w-2 h-2 rounded-full"
                      style={{ backgroundColor: C.deepPurple }}
                    />
                    1m
                  </span>
                  <span className="flex items-center gap-1.5 text-[11px] text-muted font-mono">
                    <span
                      className="w-2 h-2 rounded-full"
                      style={{ backgroundColor: C.amber }}
                    />
                    5m
                  </span>
                  <span className="flex items-center gap-1.5 text-[11px] text-muted font-mono">
                    <span
                      className="w-2 h-2 rounded-full"
                      style={{ backgroundColor: C.red }}
                    />
                    15m
                  </span>
                </div>
              }
            >
              <LoadChart data={chartData} />
            </ChartSection>

            <ChartSection title="Top Processes">
              <div className="flex flex-col gap-2.5">
                {processData.map((process, index) => {
                  const rankColors = [C.teal, C.purple, C.amber];
                  const rankColor = rankColors[index] ?? "#454550";
                  return (
                    <div
                      key={process.pid}
                      className="grid grid-cols-[36px_1fr_180px] gap-4 items-center p-3 px-4 rounded-lg transition-all duration-200 hover:bg-white/[0.03] max-md:grid-cols-[36px_1fr]"
                      style={{ border: `1px solid ${C.border}` }}
                    >
                      <div
                        className="w-9 h-9 rounded-lg flex items-center justify-center font-mono font-bold text-sm"
                        style={{
                          color: rankColor,
                          backgroundColor: rgba(rankColor, 0.1),
                          border: `1px solid ${rgba(rankColor, 0.2)}`,
                        }}
                      >
                        {index + 1}
                      </div>
                      <div className="flex flex-col gap-0.5">
                        <div className="font-semibold text-sm text-strong">
                          {process.name}
                        </div>
                        <div className="flex gap-4 font-mono text-xs text-muted">
                          <span className="flex items-center gap-1">
                            <Cpu size={12} />
                            {process.cpu.toFixed(1)}%
                          </span>
                          <span className="flex items-center gap-1">
                            <HardDrive size={12} />
                            {process.memoryMB.toFixed(0)} MB
                          </span>
                        </div>
                      </div>
                      <div className="flex flex-col gap-[5px] max-md:hidden">
                        <div className="h-[5px] rounded-full overflow-hidden bg-white/[0.04]">
                          <div
                            className="h-full rounded-full transition-all duration-500"
                            style={{
                              width: `${Math.min(process.cpu, 100)}%`,
                              background: `linear-gradient(90deg, ${C.teal}, ${rgba(C.teal, 0.4)})`,
                            }}
                          />
                        </div>
                        <div className="h-[5px] rounded-full overflow-hidden bg-white/[0.04]">
                          <div
                            className="h-full rounded-full transition-all duration-500"
                            style={{
                              width: `${Math.min((process.memoryMB / 1000) * 100, 100)}%`,
                              background: `linear-gradient(90deg, ${C.purple}, ${rgba(C.purple, 0.4)})`,
                            }}
                          />
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </ChartSection>
          </div>
        </>
      )}
    </div>
  );
}
