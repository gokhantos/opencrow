import { useRef } from "react";
import { useChart } from "../../lib/useChart";
import {
  buildTimelineOption,
  buildGaugeOption,
  buildPieOption,
  buildLoadOption,
} from "./chart-options";

// ============================================================================
// Chart wrapper components — each wraps a pure option builder
// ============================================================================

export function TimelineChart({
  data,
}: {
  readonly data: readonly { time: string; cpu: number; memory: number }[];
}) {
  const ref = useRef<HTMLDivElement>(null);
  useChart(ref, buildTimelineOption(data));
  return <div ref={ref} style={{ width: "100%", height: 320 }} />;
}

export function GaugeChart({ value }: { readonly value: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useChart(ref, buildGaugeOption(value));
  return <div ref={ref} style={{ width: "100%", height: 160 }} />;
}

export function MemoryPieChart({
  usedGB,
  availableGB,
}: {
  readonly usedGB: number;
  readonly availableGB: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useChart(ref, buildPieOption(usedGB, availableGB));
  return <div ref={ref} style={{ width: "100%", height: 160 }} />;
}

export function LoadChart({
  data,
}: {
  readonly data: readonly { time: string; load1m: number; load5m: number; load15m: number }[];
}) {
  const ref = useRef<HTMLDivElement>(null);
  useChart(ref, buildLoadOption(data));
  return <div ref={ref} style={{ width: "100%", height: 240 }} />;
}
