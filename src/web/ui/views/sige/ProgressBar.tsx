import { cn } from "../../lib/cn";
import { STATUS_LABELS, STATUS_ORDER, statusProgress } from "./statusConfig";
import type { SigeSessionStatus } from "./types";

interface ProgressBarProps {
  readonly status: SigeSessionStatus;
}

export function ProgressBar({ status }: ProgressBarProps) {
  const progress = statusProgress(status);
  const progressPct = Math.round(progress * 100);

  return (
    <div className="bg-bg-1 border border-border rounded-xl p-5 mb-6">
      {/* Phase label row */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2.5">
          {/* Pulsing dot for active statuses */}
          {status !== "completed" && status !== "failed" && status !== "cancelled" && (
            <span className="relative flex h-2.5 w-2.5 shrink-0">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-accent opacity-60" />
              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-accent" />
            </span>
          )}
          {status === "completed" && (
            <span className="h-2.5 w-2.5 rounded-full bg-success shrink-0" />
          )}
          {(status === "failed" || status === "cancelled") && (
            <span className="h-2.5 w-2.5 rounded-full bg-danger shrink-0" />
          )}
          <span className="text-sm font-semibold text-strong">
            {STATUS_LABELS[status]}
          </span>
        </div>
        <span className="text-xs font-mono text-muted">{progressPct}%</span>
      </div>

      {/* Track */}
      <div className="w-full h-1.5 bg-bg-2 rounded-full overflow-hidden">
        <div
          className={cn(
            "h-full rounded-full transition-all duration-700",
            status === "failed" || status === "cancelled"
              ? "bg-danger"
              : status === "completed"
              ? "bg-success"
              : "bg-accent",
          )}
          style={{ width: `${progressPct}%` }}
        />
      </div>

      {/* Phase steps */}
      <div className="flex items-center gap-0.5 mt-3">
        {STATUS_ORDER.map((s, i) => {
          const currentIdx = STATUS_ORDER.indexOf(status);
          const done = i < currentIdx;
          const active = s === status;
          return (
            <div
              key={s}
              title={STATUS_LABELS[s]}
              className={cn(
                "flex-1 h-1 rounded-sm transition-colors",
                done ? "bg-accent/60" : active ? "bg-accent" : "bg-bg-3",
              )}
            />
          );
        })}
      </div>
    </div>
  );
}
