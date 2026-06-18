import * as echarts from "echarts";
import { C, rgba } from "./types";

// ============================================================================
// Shared chart style constants
// ============================================================================

export const tooltipStyle: echarts.EChartsOption["tooltip"] = {
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

export const axisLabel = {
  color: "#454550",
  fontSize: 11,
  fontFamily: "'JetBrains Mono', monospace",
};

export const splitLine = {
  lineStyle: { color: "rgba(255,255,255,0.04)", type: "dashed" as const },
};

// ============================================================================
// Option builders — pure functions, no React
// ============================================================================

export function buildTimelineOption(
  chartData: readonly { time: string; cpu: number; memory: number }[],
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

export function buildGaugeOption(cpuUsage: number): echarts.EChartsOption {
  const gaugeColor = cpuUsage > 80 ? C.red : cpuUsage > 60 ? C.amber : C.teal;

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

export function buildPieOption(
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

export function buildLoadOption(
  chartData: readonly {
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
