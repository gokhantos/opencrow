/**
 * StagePanel — generic shell for one stage in the SIGE Process Theater.
 *
 * States:
 *   "waiting"  — stage has not started; shows skeleton placeholder.
 *   "running"  — stage is in progress; shows glow ring + children (if any).
 *   "done"     — stage finished; shows children with fade-in reveal.
 *   "error"    — terminal failure; shows error indicator.
 *
 * Purely presentational: no data fetching.
 */
import type React from "react";
import { cn } from "../../../lib/cn";
import {
  CheckCircle2,
  Circle,
  Loader2,
  AlertCircle,
} from "lucide-react";

export type StageStatus = "waiting" | "running" | "done" | "error";

export interface StagePanelProps {
  readonly index: number;
  readonly title: string;
  readonly status: StageStatus;
  /** Optional summary statistic shown in the panel header (e.g. "12 entities"). */
  readonly summaryStat?: string;
  readonly children?: React.ReactNode;
}

const STATUS_ICON: Record<StageStatus, React.ReactNode> = {
  waiting: <Circle size={16} className="text-border-2" />,
  running: <Loader2 size={16} className="text-accent animate-spin" />,
  done: <CheckCircle2 size={16} className="text-success" />,
  error: <AlertCircle size={16} className="text-danger" />,
};

const HEADER_STYLES: Record<StageStatus, string> = {
  waiting: "border-border bg-bg-1",
  running: "border-accent/40 bg-accent-subtle/20",
  done: "border-border bg-bg-1",
  error: "border-danger/30 bg-danger-subtle/20",
};

const PANEL_STYLES: Record<StageStatus, string> = {
  waiting: "border-border opacity-60",
  running: "border-accent/40 shadow-[0_0_0_2px_var(--color-accent,#6366f1)22]",
  done: "border-border",
  error: "border-danger/30",
};

export function StagePanel({
  index,
  title,
  status,
  summaryStat,
  children,
}: StagePanelProps) {
  return (
    <div
      className={cn(
        "rounded-xl border overflow-hidden transition-all duration-500",
        PANEL_STYLES[status],
      )}
      aria-label={`Stage ${index}: ${title} — ${status}`}
    >
      {/* Header */}
      <div
        className={cn(
          "flex items-center gap-3 px-5 py-3.5 border-b transition-colors",
          HEADER_STYLES[status],
        )}
      >
        {/* Stage index */}
        <span
          className={cn(
            "w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold shrink-0",
            status === "done"
              ? "bg-success/15 text-success"
              : status === "running"
              ? "bg-accent/15 text-accent"
              : status === "error"
              ? "bg-danger/15 text-danger"
              : "bg-bg-3 text-muted",
          )}
        >
          {index}
        </span>

        {/* Title */}
        <span
          className={cn(
            "text-sm font-semibold flex-1",
            status === "waiting" ? "text-muted" : "text-strong",
          )}
        >
          {title}
        </span>

        {/* Summary stat */}
        {summaryStat && status !== "waiting" && (
          <span className="text-xs text-faint font-mono">{summaryStat}</span>
        )}

        {/* Status icon */}
        {STATUS_ICON[status]}
      </div>

      {/* Body */}
      <div
        className={cn(
          "transition-all duration-500",
          status === "done" && "animate-[fadeSlideIn_0.4s_ease-out]",
        )}
      >
        {status === "waiting" ? (
          <SkeletonPlaceholder />
        ) : (
          <div>{children}</div>
        )}
      </div>
    </div>
  );
}

function SkeletonPlaceholder() {
  return (
    <div className="px-5 py-6 space-y-3" aria-hidden="true">
      <div className="h-3 bg-bg-3 rounded-full w-3/4 animate-pulse" />
      <div className="h-3 bg-bg-3 rounded-full w-1/2 animate-pulse" />
      <div className="h-3 bg-bg-3 rounded-full w-2/3 animate-pulse" />
      <div className="h-12 bg-bg-3 rounded-lg w-full animate-pulse mt-4" />
    </div>
  );
}
