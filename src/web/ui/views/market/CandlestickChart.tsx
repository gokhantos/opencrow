import { useMemo, useRef, useState, useCallback } from "react";
import type { EChartsOption } from "echarts";
import { useECharts } from "./useECharts";
import {
  CHART_COLORS,
  AXIS_DEFAULTS,
  DATA_ZOOM_DEFAULTS,
  CROSSHAIR_DEFAULTS,
} from "./chartTheme";
import {
  formatDateTime,
  formatBinanceDate,
  formatAxisLabel,
  formatPrice,
  formatCompactNumber,
} from "./format";
import { OVERLAY_INDICATORS, OSCILLATOR_GROUPS } from "./types";
import type { OhlcvRow, OverlayData, OscillatorData } from "./types";

const SLIDER_H = 24;
const OSC_H = 90;
/** Empty future slots added to the x-axis only (no series data) for right-scroll headroom */
const RIGHT_PAD = 3;

/** Show ~100 candles initially; compute start% for smart zoom. */
function computeInitialZoomStart(total: number, target = 100): number {
  if (total <= target) return 0;
  return ((total - target) / total) * 100;
}

interface Props {
  readonly data: readonly OhlcvRow[];
  readonly overlays?: OverlayData;
  readonly enabledOverlays: ReadonlySet<string>;
  readonly oscillators?: OscillatorData;
  readonly enabledOscillators: ReadonlySet<string>;
  readonly isLastCandleLive?: boolean;
  readonly resetKey?: string;
  readonly onLoadMore?: () => void;
}

function OhlcOverlay({
  candle,
  enabledOverlays,
  overlays,
  enabledOscillators,
  oscillators,
  dataIndex,
}: {
  candle: OhlcvRow;
  enabledOverlays: ReadonlySet<string>;
  overlays?: OverlayData;
  enabledOscillators: ReadonlySet<string>;
  oscillators?: OscillatorData;
  dataIndex: number;
}) {
  const o = Number(candle.open);
  const h = Number(candle.high);
  const l = Number(candle.low);
  const c = Number(candle.close);
  const v = Number(candle.volume);
  const isUp = c >= o;
  const changeColor = isUp ? "var(--color-success)" : "var(--color-danger)";
  const changePct = o !== 0 ? ((c - o) / o) * 100 : 0;
  const rangePct = l !== 0 ? ((h - l) / l) * 100 : 0;
  const dateStr = formatBinanceDate(Number(candle.open_time));

  const activeOverlays = OVERLAY_INDICATORS.filter((ind) =>
    enabledOverlays.has(ind.key),
  );

  const activeOscGroups = OSCILLATOR_GROUPS.filter((g) =>
    enabledOscillators.has(g.id),
  );

  return (
    <div className="absolute top-1 left-3 z-[5] flex flex-col gap-px pointer-events-none max-[900px]:hidden bg-bg/80 backdrop-blur-sm rounded-md px-2 py-1.5">
      <div className="flex gap-[3px] items-baseline flex-wrap">
        <span className="font-mono text-xs font-medium text-faint mr-1.5">
          {dateStr}
        </span>
        <span
          className="font-mono text-xs font-semibold"
          style={{ color: changeColor }}
        >
          O {formatPrice(o)}
        </span>
        <span className="text-faint/30 text-xs mx-px">&middot;</span>
        <span
          className="font-mono text-xs font-semibold"
          style={{ color: changeColor }}
        >
          H {formatPrice(h)}
        </span>
        <span className="text-faint/30 text-xs mx-px">&middot;</span>
        <span
          className="font-mono text-xs font-semibold"
          style={{ color: changeColor }}
        >
          L {formatPrice(l)}
        </span>
        <span className="text-faint/30 text-xs mx-px">&middot;</span>
        <span
          className="font-mono text-xs font-semibold"
          style={{ color: changeColor }}
        >
          C {formatPrice(c)}
        </span>
        <span className="text-faint/30 text-xs mx-px">&middot;</span>
        <span
          className="font-mono text-xs font-semibold"
          style={{ color: changeColor }}
        >
          {changePct >= 0 ? "+" : ""}
          {changePct.toFixed(2)}%
        </span>
        <span className="text-faint/30 text-xs mx-px">&middot;</span>
        <span className="font-mono text-xs font-semibold text-strong">
          R {rangePct.toFixed(2)}%
        </span>
      </div>

      <div className="flex gap-[3px] items-baseline">
        <span className="font-mono text-xs font-normal text-faint">Vol</span>
        <span className="font-mono text-xs font-semibold text-strong mr-1.5">
          {formatCompactNumber(v)}
        </span>
        <span className="text-faint/30 text-xs mx-px">&middot;</span>
        <span className="font-mono text-xs font-normal text-faint">USD</span>
        <span className="font-mono text-xs font-semibold text-strong mr-1.5">
          {formatCompactNumber(v * c)}
        </span>
      </div>

      {activeOverlays.length > 0 && (
        <div className="flex gap-3 flex-wrap">
          {activeOverlays.map((ind) => {
            const vals = overlays?.[ind.key];
            const val = vals?.[dataIndex];
            if (val == null) return null;
            return (
              <span
                key={ind.key}
                className="inline-flex gap-[3px] font-mono text-xs font-medium"
              >
                <span style={{ color: ind.color }}>{ind.label}</span>
                <span style={{ color: ind.color }}>{formatPrice(val)}</span>
              </span>
            );
          })}
        </div>
      )}

      {activeOscGroups.length > 0 && (
        <div className="flex gap-3 flex-wrap">
          {activeOscGroups.flatMap((group) =>
            group.keys
              .filter((k) => k !== "macdHistogram")
              .map((key, ki) => {
                const vals = oscillators?.[key];
                const val = vals?.[dataIndex];
                if (val == null) return null;
                const color = group.colors[ki] ?? CHART_COLORS.text;
                return (
                  <span
                    key={key}
                    className="inline-flex gap-[3px] font-mono text-xs font-medium"
                  >
                    <span style={{ color }}>{key}</span>
                    <span style={{ color }}>{val.toFixed(2)}</span>
                  </span>
                );
              }),
          )}
        </div>
      )}
    </div>
  );
}

export default function CandlestickChart({
  data,
  overlays,
  enabledOverlays,
  oscillators,
  enabledOscillators,
  isLastCandleLive = false,
  resetKey,
  onLoadMore,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);

  const handleHover = useCallback((index: number | null) => {
    setHoveredIndex(index);
  }, []);

  const displayIndex =
    hoveredIndex !== null && hoveredIndex < data.length
      ? hoveredIndex
      : data.length - 1;
  const displayCandle = data[displayIndex] ?? null;

  const activeGroups = useMemo(
    () => OSCILLATOR_GROUPS.filter((g) => enabledOscillators.has(g.id)),
    [enabledOscillators],
  );

  const option = useMemo((): EChartsOption => {
    const timestamps = data.map((d) => Number(d.open_time));
    const dates = data.map((d) => formatDateTime(Number(d.open_time)));

    // Append a few empty future slots so the user can scroll right past the last candle.
    // Only the x-axis gets these — series data stays real-data-only.
    const interval =
      data.length >= 2
        ? Number(data[data.length - 1]!.open_time) -
          Number(data[data.length - 2]!.open_time)
        : 3_600_000;
    const lastTs =
      data.length > 0 ? Number(data[data.length - 1]!.open_time) : 0;
    for (let i = 1; i <= RIGHT_PAD; i++) {
      timestamps.push(lastTs + i * interval);
      dates.push(formatDateTime(lastTs + i * interval));
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ohlcData: any[] = data.map((d, i) => {
      const value = [
        Number(d.open),
        Number(d.close),
        Number(d.low),
        Number(d.high),
      ];
      if (isLastCandleLive && i === data.length - 1) {
        return { value, itemStyle: { opacity: 0.6, borderWidth: 1 } };
      }
      return value;
    });

    const maxVol = data.reduce((max, d) => Math.max(max, Number(d.volume)), 0);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const volumeData: any[] = data.map((d) => {
      const open = Number(d.open);
      const close = Number(d.close);
      return {
        value: Number(d.volume),
        itemStyle: {
          color:
            close >= open ? CHART_COLORS.volumeUp : CHART_COLORS.volumeDown,
        },
      };
    });

    const overlayLines = OVERLAY_INDICATORS.filter((o) =>
      enabledOverlays.has(o.key),
    ).map((o) => ({
      type: "line" as const,
      name: o.label,
      data: [...(overlays?.[o.key] ?? [])],
      xAxisIndex: 0,
      yAxisIndex: 0,
      smooth: true,
      symbol: "none",
      lineStyle: { width: 1.2, color: o.color },
      itemStyle: { color: o.color },
      connectNulls: false,
      animation: false,
      z: 3,
    }));

    const oscCount = activeGroups.length;
    const xAxisIndices = Array.from({ length: 1 + oscCount }, (_, i) => i);

    // Grid[0] = price+volume, Grid[1..n] = oscillators stacked bottom-up
    // Price grid uses right:84 to leave room for the y-axis slider (18px) + gap (6px) + labels
    const PRICE_RIGHT = 84;
    const OSC_RIGHT = 60;
    const grids = [
      {
        left: 12,
        right: PRICE_RIGHT,
        top: 8,
        bottom: SLIDER_H + oscCount * OSC_H,
        containLabel: false,
      },
      ...activeGroups.map((_, i) => ({
        left: 12,
        right: OSC_RIGHT,
        bottom: SLIDER_H + i * OSC_H,
        height: OSC_H - 4,
        containLabel: false,
      })),
    ];

    // One x-axis per grid, all sharing the same dates array
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const xAxes: any[] = [
      {
        type: "category",
        data: dates,
        gridIndex: 0,
        ...AXIS_DEFAULTS,
        boundaryGap: false,
        axisLabel: {
          ...AXIS_DEFAULTS.axisLabel,
          show: oscCount === 0,
          formatter: (_value: string, index: number) => {
            const ts = timestamps[index];
            if (ts == null) return "";
            return formatAxisLabel(ts);
          },
        },
      },
      ...activeGroups.map((_, i) => ({
        type: "category",
        data: dates,
        gridIndex: i + 1,
        ...AXIS_DEFAULTS,
        boundaryGap: false,
        axisLabel: {
          ...AXIS_DEFAULTS.axisLabel,
          show: i === 0,
          formatter: (_value: string, index: number) => {
            const ts = timestamps[index];
            if (ts == null) return "";
            return formatAxisLabel(ts);
          },
        },
      })),
    ];

    // Y-axes: [0]=price, [1]=volume (hidden), [2+i]=oscillator i
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const yAxes: any[] = [
      {
        scale: true,
        gridIndex: 0,
        ...AXIS_DEFAULTS,
        position: "right",
        axisLabel: {
          ...AXIS_DEFAULTS.axisLabel,
          formatter: (v: number) => formatPrice(v),
        },
      },
      {
        scale: false,
        gridIndex: 0,
        show: false,
        min: 0,
        max: maxVol * 5,
        position: "left",
      },
      ...activeGroups.map((_, i) => ({
        scale: true,
        gridIndex: i + 1,
        ...AXIS_DEFAULTS,
        position: "right",
        axisLabel: { ...AXIS_DEFAULTS.axisLabel, fontSize: 10 },
        splitLine: { show: false },
      })),
    ];

    // Oscillator series: bar (MACD histogram) + lines, each bound to their grid
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const oscSeries: any[] = activeGroups.flatMap((group, i) => {
      const xIdx = i + 1;
      const yIdx = i + 2;
      const isMacd = group.id === "macd";
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const series: any[] = [];

      const markLineData = group.referenceLines.map((ref) => ({
        yAxis: ref.value,
        label: { show: false },
        lineStyle: {
          color: CHART_COLORS.text,
          type: "dashed" as const,
          opacity: 0.4,
        },
      }));

      if (isMacd) {
        const histData = (oscillators?.macdHistogram ?? []).map((v) => ({
          value: v,
          itemStyle: {
            color:
              (v ?? 0) >= 0
                ? "rgba(45, 212, 191, 0.4)"
                : "rgba(248, 113, 113, 0.4)",
          },
        }));
        series.push({
          type: "bar",
          data: histData,
          xAxisIndex: xIdx,
          yAxisIndex: yIdx,
          barMaxWidth: 3,
          animation: false,
          ...(markLineData.length > 0
            ? { markLine: { silent: true, data: markLineData } }
            : {}),
        });
      }

      const lineKeys = group.keys.filter((k) => k !== "macdHistogram");
      lineKeys.forEach((key, ki) => {
        const color = group.colors[ki] ?? CHART_COLORS.text;
        const addMarkLine = !isMacd && ki === 0 && markLineData.length > 0;
        series.push({
          type: "line",
          name: key,
          data: [...(oscillators?.[key] ?? [])],
          xAxisIndex: xIdx,
          yAxisIndex: yIdx,
          smooth: true,
          symbol: "none",
          lineStyle: { width: 1.2, color },
          itemStyle: { color },
          connectNulls: false,
          animation: false,
          ...(addMarkLine
            ? { markLine: { silent: true, data: markLineData } }
            : {}),
        });
      });

      return series;
    });

    // Current price line
    const lastCandle = data[data.length - 1];
    const lastClose = lastCandle ? Number(lastCandle.close) : 0;
    const lastOpen = lastCandle ? Number(lastCandle.open) : 0;
    const priceUp = lastClose >= lastOpen;
    const priceLineColor = priceUp ? CHART_COLORS.green : CHART_COLORS.red;

    return {
      animation: false,
      // Top-level axisPointer links crosshairs across all grids
      axisPointer: {
        link: [{ xAxisIndex: "all" }],
      },
      grid: grids,
      xAxis: xAxes,
      yAxis: yAxes,
      dataZoom: [
        // X-axis: scroll-wheel zoom, all grids linked
        {
          type: "inside",
          xAxisIndex: xAxisIndices,
          start: computeInitialZoomStart(data.length + RIGHT_PAD),
          end: 100,
          throttle: 50,
          moveOnMouseMove: true,
          moveOnMouseWheel: false,
        },
        // Y-axis: Ctrl+scroll zoom on price grid only
        {
          type: "inside",
          yAxisIndex: [0],
          filterMode: "none",
          zoomOnMouseWheel: "ctrl",
          moveOnMouseMove: false,
          moveOnMouseWheel: false,
        },
        // X-axis slider (horizontal scrubber at bottom)
        {
          type: "slider",
          xAxisIndex: xAxisIndices,
          bottom: 4,
          height: 18,
          ...DATA_ZOOM_DEFAULTS,
        },
        // Y-axis slider (vertical handle on the right side of the price chart)
        {
          type: "slider",
          yAxisIndex: [0],
          filterMode: "none",
          right: 4,
          width: 18,
          top: 8,
          bottom: SLIDER_H + oscCount * OSC_H + 4,
          ...DATA_ZOOM_DEFAULTS,
        },
      ],
      tooltip: {
        show: false,
        trigger: "axis",
        axisPointer: {
          ...CROSSHAIR_DEFAULTS,
          label: {
            ...CROSSHAIR_DEFAULTS.label,
            padding: [4, 8],
            borderRadius: 3,
          },
        },
      },
      series: [
        {
          type: "bar",
          data: volumeData,
          xAxisIndex: 0,
          yAxisIndex: 1,
          barWidth: "75%",
          barMinWidth: 1,
          z: 1,
          silent: true,
        },
        {
          type: "candlestick",
          data: ohlcData,
          xAxisIndex: 0,
          yAxisIndex: 0,
          barWidth: "75%",
          barMinWidth: 2,
          z: 2,
          itemStyle: {
            color: CHART_COLORS.green,
            color0: CHART_COLORS.red,
            borderColor: CHART_COLORS.green,
            borderColor0: CHART_COLORS.red,
          },
          markLine: lastCandle
            ? {
                silent: true,
                symbol: "none",
                data: [
                  {
                    yAxis: lastClose,
                    lineStyle: {
                      color: priceLineColor,
                      type: "dashed",
                      width: 1,
                    },
                    label: {
                      position: "end",
                      formatter: () => formatPrice(lastClose),
                      backgroundColor: priceLineColor,
                      color: "#000000",
                      padding: [3, 6],
                      borderRadius: 2,
                      fontSize: 11,
                      fontFamily: "'JetBrains Mono', monospace",
                      fontWeight: 600,
                    },
                  },
                ],
              }
            : undefined,
        },
        ...overlayLines,
        ...oscSeries,
      ],
    } as EChartsOption;
  }, [
    data,
    overlays,
    enabledOverlays,
    oscillators,
    enabledOscillators,
    isLastCandleLive,
    activeGroups,
  ]);

  const handleBoundary = useMemo(() => {
    if (!onLoadMore) return undefined;
    return (direction: "left" | "right") => {
      if (direction === "left") onLoadMore();
    };
  }, [onLoadMore]);

  useECharts(containerRef, option, resetKey, handleBoundary, handleHover);

  return (
    <div className="relative flex-1 min-h-0">
      {displayCandle && (
        <OhlcOverlay
          candle={displayCandle}
          enabledOverlays={enabledOverlays}
          overlays={overlays}
          enabledOscillators={enabledOscillators}
          oscillators={oscillators}
          dataIndex={displayIndex}
        />
      )}
      <div ref={containerRef} className="w-full h-full" />
    </div>
  );
}
