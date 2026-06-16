import { useEffect, useRef } from "react";
import type React from "react";
import * as echarts from "echarts";

/**
 * Mounts an ECharts instance into `ref`, keeps it sized to its container via a
 * ResizeObserver, and re-applies `option` whenever it changes. Disposes the
 * chart and observer on unmount.
 *
 * Extracted from the byte-for-byte duplicate previously living in both
 * AgentMetrics.tsx and SystemMetrics.tsx.
 */
export function useChart(
  ref: React.RefObject<HTMLDivElement | null>,
  option: echarts.EChartsOption,
): void {
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
