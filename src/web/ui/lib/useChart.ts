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
 *
 * CALLER CONTRACT — memoize the option object.
 *
 * `setOption` is called on every render where `option` has a new reference
 * (React.Object.is comparison). To avoid continuous full chart redraws,
 * callers MUST wrap the option in useMemo keyed on the primitive values that
 * feed it:
 *
 *   const option = useMemo(() => buildMyOption(data), [data]);
 *   useChart(ref, option);
 *
 * Passing `buildMyOption(data)` directly (a new object literal each render)
 * will cause setOption to fire on every render — even when the underlying data
 * is unchanged — producing flicker and unnecessary ECharts DOM work.
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
