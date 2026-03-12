import { useMemo, useRef } from "react";
import { cn } from "../../lib/cn";
import type { EChartsOption } from "echarts";
import { useECharts } from "./useECharts";
import { CHART_COLORS, AXIS_DEFAULTS, TOOLTIP_DEFAULTS } from "./chartTheme";
import {
  formatDateTime,
  formatVolume,
  formatPrice,
  formatTime,
  formatCompactNumber,
} from "./format";
import type { LiquidationBucket, LiquidationEvent } from "./types";

interface Props {
  readonly buckets: readonly LiquidationBucket[];
  readonly recent: readonly LiquidationEvent[];
  readonly totalLongUsd: number;
  readonly totalShortUsd: number;
  readonly compact?: boolean;
}

export default function LiquidationsPanel({
  buckets,
  recent,
  totalLongUsd,
  totalShortUsd,
  compact,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);

  const option = useMemo((): EChartsOption => {
    const dates = buckets.map((b) => formatDateTime(b.bucket));
    const longData = buckets.map((b) => -b.long_usd);
    const shortData = buckets.map((b) => b.short_usd);

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
              formatter: (v: number) => formatCompactNumber(Math.abs(v)),
            },
        splitLine: compact
          ? { show: true, lineStyle: { color: "rgba(255,255,255,0.03)" } }
          : AXIS_DEFAULTS.splitLine,
      },
      tooltip: {
        trigger: "axis",
        ...TOOLTIP_DEFAULTS,
        formatter: (params: unknown) => {
          const items = params as {
            name: string;
            seriesName: string;
            value: number;
          }[];
          if (!items || items.length === 0) return "";
          let html = `<span style="color:${CHART_COLORS.text}">${items[0]!.name}</span>`;
          for (const item of items) {
            const color =
              item.seriesName === "Long Liqs"
                ? CHART_COLORS.red
                : CHART_COLORS.green;
            html += `<br/><span style="color:${color}">${item.seriesName}: $${formatCompactNumber(Math.abs(item.value))}</span>`;
          }
          return html;
        },
      },
      series: [
        {
          type: "bar",
          name: "Long Liqs",
          data: longData,
          stack: "liq",
          itemStyle: { color: "rgba(248, 113, 113, 0.6)" },
          barMaxWidth: 6,
          markLine: {
            silent: true,
            data: [
              {
                yAxis: 0,
                lineStyle: {
                  color: CHART_COLORS.text,
                  type: "dashed",
                  opacity: 0.3,
                },
                label: { show: false },
              },
            ],
          },
        },
        {
          type: "bar",
          name: "Short Liqs",
          data: shortData,
          stack: "liq",
          itemStyle: { color: "rgba(45, 212, 191, 0.6)" },
          barMaxWidth: 6,
        },
      ],
    };
  }, [buckets, compact]);

  useECharts(containerRef, option);

  return (
    <div className="flex flex-col gap-3">
      {buckets.length > 0 && (
        <div
          ref={containerRef}
          style={{ width: "100%", height: compact ? 120 : 200 }}
        />
      )}

      {!compact && (
        <div className="flex gap-5 py-1.5 font-mono text-sm font-bold">
          <span className="text-danger">
            Long Liqs: {formatVolume(totalLongUsd)}
          </span>
          <span className="text-success">
            Short Liqs: {formatVolume(totalShortUsd)}
          </span>
        </div>
      )}

      {!compact && recent.length > 0 && (
        <div className="max-h-[200px] overflow-y-auto border-t border-border pt-1">
          {recent.slice(0, 20).map((r, i) => (
            <div
              key={`${r.trade_time}-${r.symbol}-${r.side}`}
              className={cn(
                "flex gap-3 items-center py-1 px-2.5 font-mono text-sm rounded-md transition-colors duration-150 ease-in-out hover:bg-bg-3",
                r.side === "SELL" ? "text-danger" : "text-success",
                i % 2 === 0 && "bg-bg-2",
              )}
            >
              <span className="text-faint min-w-[60px]">
                {formatTime(r.trade_time)}
              </span>
              <span className="min-w-[32px] text-strong">
                {r.symbol.split("/")[0]}
              </span>
              <span className="min-w-[44px]">
                {r.side === "SELL" ? "LONG" : "SHORT"}
              </span>
              <span className="min-w-[60px] text-right">
                {formatVolume(r.usd_value)}
              </span>
              <span className="text-muted ml-auto">
                @ ${formatPrice(r.avg_price)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
