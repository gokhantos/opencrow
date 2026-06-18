import React from "react";
import { TrendingUp } from "lucide-react";
import { cn } from "../../lib/cn";
import { C, rgba } from "./types";

// ============================================================================
// GlassCard — shared container with optional accent bar
// ============================================================================

export function GlassCard({
  children,
  className,
  accentColor,
}: {
  readonly children: React.ReactNode;
  readonly className?: string;
  readonly accentColor?: string;
}) {
  return (
    <div
      className={cn(
        "relative rounded-xl overflow-hidden border border-border bg-bg-1 transition-all duration-300",
        "hover:border-border-hover",
        className,
      )}
    >
      {accentColor && (
        <div
          className="absolute top-0 left-0 right-0 h-[2px]"
          style={{
            background: `linear-gradient(90deg, ${accentColor}, ${rgba(accentColor, 0.2)}, transparent)`,
          }}
        />
      )}
      {children}
    </div>
  );
}

// ============================================================================
// MetricCard — premium stat card with icon, glow, and trend badge
// ============================================================================

export function MetricCard({
  title,
  value,
  detail,
  icon: Icon,
  color,
  trend,
}: {
  readonly title: string;
  readonly value: string;
  readonly detail?: string;
  readonly icon: React.ElementType;
  readonly color: string;
  readonly trend?: number;
}) {
  return (
    <GlassCard accentColor={color} className="p-6 group">
      <div className="flex items-center gap-4 mb-4">
        {/* Icon with glow */}
        <div className="relative">
          <div
            className="absolute inset-[-4px] rounded-xl blur-xl opacity-25 transition-opacity duration-300 group-hover:opacity-40"
            style={{ backgroundColor: color }}
          />
          <div
            className="relative w-10 h-10 rounded-xl flex items-center justify-center"
            style={{ backgroundColor: rgba(color, 0.12) }}
          >
            <Icon size={20} style={{ color }} />
          </div>
        </div>
        <h3 className="text-[10px] font-semibold text-faint uppercase tracking-[0.12em]">
          {title}
        </h3>
      </div>

      {/* Value with glow */}
      <div
        className="font-mono text-[2rem] font-bold text-strong mb-1 tabular-nums tracking-tight leading-none"
        style={{ textShadow: `0 0 40px ${rgba(color, 0.25)}` }}
      >
        {value}
      </div>
      {detail && (
        <div className="font-mono text-sm text-faint mt-2">{detail}</div>
      )}

      {/* Trend badge */}
      {trend !== undefined && Math.abs(trend) > 0.1 && (
        <div
          className="absolute top-5 right-5 flex items-center gap-1.5 font-mono text-xs font-semibold px-2.5 py-1 rounded-full"
          style={{
            color: trend > 0 ? C.red : C.teal,
            backgroundColor: rgba(trend > 0 ? C.red : C.teal, 0.1),
            border: `1px solid ${rgba(trend > 0 ? C.red : C.teal, 0.2)}`,
          }}
        >
          <TrendingUp
            size={14}
            style={{ transform: trend < 0 ? "scaleY(-1)" : "none" }}
          />
          <span>{Math.abs(trend).toFixed(1)}%</span>
        </div>
      )}
    </GlassCard>
  );
}

// ============================================================================
// ChartSection — GlassCard wrapper for chart panels
// ============================================================================

export function ChartSection({
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
    <GlassCard className={cn("p-6", className)}>
      <div className="flex justify-between items-center mb-5">
        <h3 className="text-sm font-semibold m-0 text-strong tracking-tight">
          {title}
        </h3>
        {right}
      </div>
      {children}
    </GlassCard>
  );
}
