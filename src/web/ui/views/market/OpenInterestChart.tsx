import { useMemo, useRef } from "react";
import type { EChartsOption } from "echarts";
import { useECharts } from "./useECharts";
import { CHART_COLORS, AXIS_DEFAULTS, TOOLTIP_DEFAULTS } from "./chartTheme";
import { formatDateTime, formatCompactNumber } from "./format";
import type { FuturesMetrics } from "./types";

interface Props {
  readonly data: readonly FuturesMetrics[];
  readonly compact?: boolean;
}

export default function OpenInterestChart({ data, compact }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);

  const option = useMemo((): EChartsOption => {
    const dates = data.map((d) => formatDateTime(d.createTime));
    const values = data.map((d) => d.sumOpenInterestValue);

    return {
      animation: false,
      grid: compact
        ? { left: 6, right: 6, top: 6, bottom: 20, containLabel: false }
        : { left: 12, right: 60, top: 12, bottom: 30, containLabel: false },
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
              formatter: (v: number) => formatCompactNumber(v),
            },
        splitLine: compact
          ? { show: true, lineStyle: { color: "rgba(255,255,255,0.03)" } }
          : AXIS_DEFAULTS.splitLine,
      },
      tooltip: {
        trigger: "axis",
        ...TOOLTIP_DEFAULTS,
        formatter: (params: unknown) => {
          const p = (params as { name: string; value: number }[])[0];
          if (!p) return "";
          return `<span style="color:${CHART_COLORS.text}">${p.name}</span><br/>OI: <b>$${formatCompactNumber(p.value)}</b>`;
        },
      },
      series: [
        {
          type: "line",
          data: values,
          smooth: true,
          symbol: "none",
          lineStyle: { width: 2, color: CHART_COLORS.blue },
          areaStyle: {
            color: {
              type: "linear",
              x: 0,
              y: 0,
              x2: 0,
              y2: 1,
              colorStops: [
                { offset: 0, color: "rgba(96, 165, 250, 0.20)" },
                { offset: 1, color: "rgba(96, 165, 250, 0.01)" },
              ],
            },
          },
          itemStyle: { color: CHART_COLORS.blue },
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
