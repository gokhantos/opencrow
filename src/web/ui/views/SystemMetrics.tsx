import { useState, useEffect } from "react";
import type { ZodType } from "zod";
import { usePolledFetch } from "../hooks/usePolledFetch";
import { systemMetricsSchema } from "../lib/schemas";
import {
  Activity,
  Cpu,
  HardDrive,
  Database,
  Zap,
  AlertCircle,
  CheckCircle,
} from "lucide-react";
import { LoadingState, Button, PageHeader } from "../components";
import { type SystemMetricsData, type DiskInfo, C, formatBytes, rgba } from "./system-metrics/types";
import { TimelineChart, GaugeChart, MemoryPieChart, LoadChart } from "./system-metrics/charts";
import { MetricCard, ChartSection } from "./system-metrics/primitives";

// ============================================================================
// Main Component
// ============================================================================

export default function SystemMetrics() {
  const [metrics, setMetrics] = useState<SystemMetricsData[]>([]);

  const {
    data: currentMetrics,
    loading,
    error,
    refetch,
  } = usePolledFetch<SystemMetricsData>("/api/system/metrics", {
    intervalMs: 2000,
    extras: {
      schema: systemMetricsSchema as unknown as ZodType<SystemMetricsData>,
    },
  });

  // Accumulate a rolling window of the most recent 60 samples for the charts.
  useEffect(() => {
    if (!currentMetrics) return;
    setMetrics((prev) => [...prev, currentMetrics].slice(-60));
  }, [currentMetrics]);

  if (loading) return <LoadingState />;

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-[60vh] gap-5 text-center">
        <AlertCircle size={52} color={C.red} />
        <h2 className="text-xl font-bold text-strong m-0">
          Unable to load metrics
        </h2>
        <p className="text-faint m-0 text-sm">{error}</p>
        <Button variant="secondary" onClick={refetch}>
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
      .slice(0, 8) ?? [];

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

  const healthBadge = (
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
  );

  return (
    <div className="max-w-[1600px] mx-auto">
      <PageHeader
        title="System Metrics"
        subtitle="Real-time monitoring and performance analysis"
        actions={healthBadge}
      />

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
                {currentMetrics.disk.map((d: DiskInfo) => {
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
