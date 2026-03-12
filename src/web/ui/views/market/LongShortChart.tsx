import { useMemo, useRef } from "react";
import type { EChartsOption } from "echarts";
import { useECharts } from "./useECharts";
import { CHART_COLORS, AXIS_DEFAULTS, TOOLTIP_DEFAULTS } from "./chartTheme";
import { formatDateTime } from "./format";
import type { FuturesMetrics } from "./types";

interface Props {
  readonly data: readonly FuturesMetrics[];
  readonly compact?: boolean;
}

export default function LongShortChart({ data, compact }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);

  const option = useMemo((): EChartsOption => {
    const dates = data.map((d) => formatDateTime(d.createTime));

    return {
      animation: false,
      grid: compact
        ? { left: 6, right: 6, top: 6, bottom: 20, containLabel: false }
        : { left: 12, right: 60, top: 30, bottom: 30, containLabel: false },
      legend: compact
        ? { show: false }
        : {
            data: ["Account L/S", "Top Trader L/S", "Taker B/S"],
            textStyle: {
              color: CHART_COLORS.text,
              fontSize: 11,
              fontFamily: "'JetBrains Mono', monospace",
            },
            top: 0,
            left: 0,
          },
      xAxis: {
        type: "category",
        data: dates,
        ...AXIS_DEFAULTS,
        axisLabel: compact
          ? { show: false }
          : { ...AXIS_DEFAULTS.axisLabel, interval: "auto" },
      },
      yAxis: {
        scale: true,
        ...AXIS_DEFAULTS,
        position: "right",
        axisLabel: compact
          ? { show: false }
          : {
              ...AXIS_DEFAULTS.axisLabel,
              formatter: (v: number) => v.toFixed(2),
            },
        splitLine: compact
          ? { show: true, lineStyle: { color: "rgba(255,255,255,0.03)" } }
          : AXIS_DEFAULTS.splitLine,
      },
      tooltip: {
        trigger: "axis",
        ...TOOLTIP_DEFAULTS,
      },
      series: [
        {
          type: "line",
          name: "Account L/S",
          data: data.map((d) => d.countLongShortRatio),
          smooth: true,
          symbol: "none",
          lineStyle: { width: 2, color: CHART_COLORS.blue },
          itemStyle: { color: CHART_COLORS.blue },
        },
        {
          type: "line",
          name: "Top Trader L/S",
          data: data.map((d) => d.sumTopTraderLongShortRatio),
          smooth: true,
          symbol: "none",
          lineStyle: { width: 2, color: CHART_COLORS.purple },
          itemStyle: { color: CHART_COLORS.purple },
        },
        {
          type: "line",
          name: "Taker B/S",
          data: data.map((d) => d.sumTakerLongShortVolRatio),
          smooth: true,
          symbol: "none",
          lineStyle: { width: 2, color: CHART_COLORS.accent },
          itemStyle: { color: CHART_COLORS.accent },
        },
      ],
    };
  }, [data, compact]);

  useECharts(containerRef, option);

  return (
    <div
      ref={containerRef}
      style={{ width: "100%", height: compact ? 120 : 260 }}
    />
  );
}
