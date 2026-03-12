import { useMemo, useRef } from "react";
import type { EChartsOption } from "echarts";
import { useECharts } from "./useECharts";
import { CHART_COLORS, AXIS_DEFAULTS, TOOLTIP_DEFAULTS } from "./chartTheme";
import { formatDateTime, formatFundingRate } from "./format";
import type { FundingRate } from "./types";

interface Props {
  readonly data: readonly FundingRate[];
  readonly compact?: boolean;
}

export default function FundingRateChart({ data, compact }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);

  const option = useMemo((): EChartsOption => {
    const dates = data.map((d) => formatDateTime(d.fundingTime));
    const barData = data.map((d) => ({
      value: d.fundingRate,
      itemStyle: {
        color:
          d.fundingRate >= 0
            ? "rgba(45, 212, 191, 0.6)"
            : "rgba(248, 113, 113, 0.6)",
      },
    }));

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
              formatter: (v: number) => `${(v * 100).toFixed(3)}%`,
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
          return `<span style="color:${CHART_COLORS.text}">${p.name}</span><br/>Funding: <b>${formatFundingRate(p.value)}</b>`;
        },
      },
      series: [
        {
          type: "bar",
          data: barData,
          barMaxWidth: 5,
          markLine: {
            silent: true,
            data: [
              {
                yAxis: 0,
                lineStyle: {
                  color: CHART_COLORS.text,
                  type: "dashed",
                  opacity: 0.4,
                },
                label: { show: false },
              },
            ],
          },
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
