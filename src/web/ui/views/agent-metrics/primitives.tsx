import React from "react";
import { cn } from "../../lib/cn";

// ============================================================================
// ChartCard — generic card wrapper for charts
// ============================================================================

export function ChartCard({
  title,
  right,
  children,
  className,
}: {
  readonly title: string;
  readonly right?: React.ReactNode;
  readonly children: React.ReactNode;
  readonly className?: string;
}) {
  return (
    <div className={cn("bg-bg-1 border border-border rounded-lg p-5", className)}>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-xs font-semibold text-muted uppercase tracking-[0.1em]">
          {title}
        </h3>
        {right && (
          <span className="text-[11px] font-mono text-faint">{right}</span>
        )}
      </div>
      {children}
    </div>
  );
}

// ============================================================================
// StatCard — summary stat with optional progress bar
// ============================================================================

export function StatCard({
  label,
  value,
  sub,
  accentColor,
  progress,
}: {
  readonly label: string;
  readonly value: string;
  readonly sub?: string;
  readonly accentColor?: string;
  readonly progress?: number;
}) {
  return (
    <div className="relative bg-bg-1 border border-border rounded-lg px-5 py-4 overflow-hidden">
      {accentColor && (
        <div
          className="absolute top-0 left-0 w-full h-[2px]"
          style={{
            background: `linear-gradient(90deg, ${accentColor}, transparent)`,
          }}
        />
      )}
      <div className="text-[10px] font-semibold text-faint uppercase tracking-[0.12em] mb-2">
        {label}
      </div>
      <div className="text-2xl font-bold font-mono leading-none text-strong tabular-nums">
        {value}
      </div>
      {progress !== undefined && (
        <div className="w-full h-1 rounded-full bg-bg-3 mt-3 overflow-hidden">
          <div
            className="h-full rounded-full transition-all duration-500"
            style={{
              width: `${Math.min(progress, 100)}%`,
              backgroundColor: accentColor ?? "#a78bfa",
            }}
          />
        </div>
      )}
      {sub && (
        <div className="text-[11px] text-faint mt-2 leading-relaxed">{sub}</div>
      )}
    </div>
  );
}

// ============================================================================
// CacheBar — inline progress bar for cache hit rate
// ============================================================================

export function CacheBar({ total, cached }: { readonly total: number; readonly cached: number }) {
  if (total === 0) return <span className="text-faint">{"—"}</span>;
  const pct = Math.round((cached / total) * 100);
  const barColor =
    pct >= 80
      ? "bg-success/60"
      : pct >= 40
        ? "bg-accent/60"
        : "bg-warning/60";
  return (
    <div className="flex items-center gap-2">
      <div className="w-14 h-1.5 rounded-full bg-bg-3 overflow-hidden">
        <div
          className={cn("h-full rounded-full transition-all", barColor)}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-xs font-mono text-faint w-8 text-right">
        {pct}%
      </span>
    </div>
  );
}

// ============================================================================
// Table header cell class constant
// ============================================================================

export const TH =
  "text-[10px] font-semibold text-faint uppercase tracking-[0.1em] px-4 py-2.5";
