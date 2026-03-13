import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import {
  X,
  ChevronDown,
  ChevronRight,
  Minimize2,
  Maximize2,
  Check,
  AlertCircle,
  Loader2,
  Clock,
  Circle,
  SkipForward,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { cn } from "../../lib/cn";
import type { ExecutionStatus, ExecutionStepMap, StepStatus, StepInfo } from "./types";
import type { Node } from "@xyflow/react";
import type { WorkflowNodeData } from "./types";

interface ExecutionPanelProps {
  readonly onClose: () => void;
  readonly executionStatus: ExecutionStatus | null;
  readonly stepStatuses: ExecutionStepMap;
  readonly nodes: ReadonlyArray<Node<WorkflowNodeData>>;
  readonly onStepClick?: (nodeId: string) => void;
}

const STEP_ICONS: Record<StepStatus, LucideIcon> = {
  pending: Clock,
  running: Loader2,
  completed: Check,
  failed: AlertCircle,
  skipped: SkipForward,
};

const STEP_COLORS: Record<StepStatus, string> = {
  pending: "text-zinc-500 bg-zinc-500/10 border-zinc-500/30",
  running: "text-blue-400 bg-blue-500/15 border-blue-400/40",
  completed: "text-emerald-400 bg-emerald-500/15 border-emerald-400/40",
  failed: "text-red-400 bg-red-500/15 border-red-400/40",
  skipped: "text-zinc-500 bg-zinc-500/10 border-zinc-500/20",
};

const STEP_LINE_COLORS: Record<StepStatus, string> = {
  pending: "bg-zinc-700",
  running: "bg-blue-500/50",
  completed: "bg-emerald-500/50",
  failed: "bg-red-500/50",
  skipped: "bg-zinc-700/50",
};

const STATUS_HEADER: Record<ExecutionStatus, { label: string; color: string; bg: string }> = {
  pending: { label: "Waiting", color: "text-zinc-400", bg: "bg-zinc-500/10" },
  running: { label: "Running", color: "text-blue-400", bg: "bg-blue-500/10" },
  completed: { label: "Completed", color: "text-emerald-400", bg: "bg-emerald-500/10" },
  failed: { label: "Failed", color: "text-red-400", bg: "bg-red-500/10" },
  cancelled: { label: "Cancelled", color: "text-zinc-400", bg: "bg-zinc-500/10" },
};

function formatOutput(output: unknown): string {
  if (output === null || output === undefined) return "null";
  if (typeof output === "string") {
    try {
      const parsed = JSON.parse(output);
      return JSON.stringify(parsed, null, 2);
    } catch {
      return output;
    }
  }
  return JSON.stringify(output, null, 2);
}

function ElapsedTimer({ running }: { readonly running: boolean }) {
  const [elapsed, setElapsed] = useState(0);
  const startRef = useRef(Date.now());
  const wasRunningRef = useRef(false);

  useEffect(() => {
    if (running && !wasRunningRef.current) {
      startRef.current = Date.now();
      setElapsed(0);
    }
    wasRunningRef.current = running;

    if (!running) return;

    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startRef.current) / 1000));
    }, 1000);

    return () => clearInterval(interval);
  }, [running]);

  if (!running && elapsed === 0) return null;

  const mins = Math.floor(elapsed / 60);
  const secs = elapsed % 60;

  return (
    <span className="text-xs text-muted font-mono tabular-nums">
      {mins > 0 ? `${mins}m ${secs}s` : `${secs}s`}
    </span>
  );
}

function StepRow({
  step,
  index,
  label,
  isLast,
  onStepClick,
}: {
  readonly step: StepInfo;
  readonly index: number;
  readonly label: string;
  readonly isLast: boolean;
  readonly onStepClick?: (nodeId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const Icon = STEP_ICONS[step.status];
  const hasOutput = step.output !== null && step.output !== undefined;
  const hasError = !!step.error;
  const isExpandable = hasOutput || hasError;

  const handleToggle = useCallback(() => {
    if (isExpandable) {
      setExpanded((v) => !v);
    }
  }, [isExpandable]);

  const handleNodeClick = useCallback(() => {
    onStepClick?.(step.nodeId);
  }, [step.nodeId, onStepClick]);

  return (
    <div className="flex gap-3">
      {/* Timeline column */}
      <div className="flex flex-col items-center w-7 shrink-0">
        <div
          className={cn(
            "w-7 h-7 rounded-full border flex items-center justify-center shrink-0 transition-all duration-300",
            STEP_COLORS[step.status],
            step.status === "running" && "shadow-[0_0_12px_rgba(59,130,246,0.3)]",
          )}
        >
          <Icon
            size={13}
            className={cn(step.status === "running" && "animate-spin")}
          />
        </div>
        {!isLast && (
          <div
            className={cn(
              "w-0.5 flex-1 min-h-[16px] transition-colors duration-500",
              STEP_LINE_COLORS[step.status],
            )}
          />
        )}
      </div>

      {/* Content column */}
      <div className={cn("flex-1 min-w-0 pb-4", isLast && "pb-1")}>
        <div className="w-full flex items-center gap-2">
          <span className="text-[11px] font-mono text-muted w-4 shrink-0 text-right">
            {index + 1}
          </span>
          <button
            type="button"
            onClick={handleNodeClick}
            className="text-sm font-medium text-foreground truncate hover:text-strong transition-colors cursor-pointer text-left"
            title="Click to highlight node"
          >
            {label}
          </button>
          <span
            className={cn(
              "text-[11px] font-medium uppercase tracking-wider ml-auto shrink-0",
              step.status === "completed" && "text-emerald-400",
              step.status === "failed" && "text-red-400",
              step.status === "running" && "text-blue-400",
              step.status === "pending" && "text-zinc-500",
              step.status === "skipped" && "text-zinc-500",
            )}
          >
            {step.status}
          </span>
          {isExpandable && (
            <button
              type="button"
              onClick={handleToggle}
              className="text-muted shrink-0 hover:text-foreground transition-colors cursor-pointer"
              aria-label={expanded ? "Collapse step output" : "Expand step output"}
            >
              {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            </button>
          )}
        </div>

        {expanded && (
          <div className="mt-2 ml-6 space-y-2">
            {hasError && (
              <div className="p-3 rounded-lg bg-red-500/8 border border-red-500/20">
                <p className="text-[11px] text-red-400 font-semibold mb-1 uppercase tracking-wider">
                  Error
                </p>
                <p className="text-xs text-red-300/90 font-mono break-words leading-relaxed">
                  {step.error}
                </p>
              </div>
            )}
            {hasOutput && (
              <div>
                <p className="text-[11px] text-muted font-semibold mb-1.5 uppercase tracking-wider">
                  {hasError ? "Partial Output" : "Output"}
                </p>
                <pre className="text-xs font-mono text-foreground/80 bg-black/30 rounded-lg p-3 overflow-x-auto whitespace-pre-wrap break-words border border-white/5 max-h-[200px] overflow-y-auto leading-relaxed">
                  {formatOutput(step.output)}
                </pre>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export function ExecutionPanel({
  onClose,
  executionStatus,
  stepStatuses,
  nodes,
  onStepClick,
}: ExecutionPanelProps) {
  const [minimized, setMinimized] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const userScrolledUpRef = useRef(false);

  // Memoize node label lookup map
  const nodeLabelMap = useMemo(
    () => new Map(nodes.map((n) => [n.id, (n.data?.label as string) ?? n.id])),
    [nodes],
  );

  // Auto-expand when new execution starts
  useEffect(() => {
    if (executionStatus === "running") {
      setMinimized(false);
    }
  }, [executionStatus]);

  // Auto-scroll to bottom when new steps appear (unless user scrolled up)
  const stepsContainerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = stepsContainerRef.current;
    if (el && executionStatus === "running" && !userScrolledUpRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [stepStatuses, executionStatus]);

  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    userScrolledUpRef.current =
      el.scrollTop < el.scrollHeight - el.clientHeight - 32;
  }, []);

  const steps = [...stepStatuses.values()];
  const statusInfo = executionStatus ? STATUS_HEADER[executionStatus] : null;
  const completedCount = steps.filter((s) => s.status === "completed").length;
  const totalCount = steps.length;
  const progressPct = totalCount > 0 ? (completedCount / totalCount) * 100 : 0;

  // Minimized bar
  if (minimized) {
    return (
      <div
        ref={panelRef}
        className="border-t border-white/[0.06] bg-bg-1/95 backdrop-blur-sm"
      >
        <div className="flex items-center gap-3 px-4 py-2">
          <button
            type="button"
            onClick={() => setMinimized(false)}
            className="flex items-center gap-2 text-xs text-muted hover:text-foreground transition-colors cursor-pointer"
            aria-label="Expand execution panel"
          >
            <Maximize2 size={12} />
          </button>

          {statusInfo && (
            <span
              className={cn(
                "inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-semibold",
                statusInfo.bg,
                statusInfo.color,
              )}
            >
              {executionStatus === "running" && (
                <Circle size={6} className="fill-current animate-pulse" />
              )}
              {statusInfo.label}
            </span>
          )}

          {totalCount > 0 && (
            <span className="text-xs text-muted">
              {completedCount}/{totalCount} steps
            </span>
          )}

          {/* Mini progress bar */}
          {totalCount > 0 && (
            <div className="flex-1 max-w-[200px] h-1 bg-white/5 rounded-full overflow-hidden">
              <div
                className={cn(
                  "h-full rounded-full transition-all duration-700 ease-out",
                  executionStatus === "failed" ? "bg-red-500" : "bg-emerald-500",
                )}
                style={{ width: `${progressPct}%` }}
              />
            </div>
          )}

          <ElapsedTimer running={executionStatus === "running"} />

          <button
            type="button"
            onClick={onClose}
            className="ml-auto w-5 h-5 flex items-center justify-center rounded text-muted hover:text-foreground hover:bg-white/5 transition-colors cursor-pointer"
            aria-label="Close execution panel"
          >
            <X size={12} />
          </button>
        </div>
      </div>
    );
  }

  // Full panel
  return (
    <div
      ref={panelRef}
      className={cn(
        "border-t border-white/[0.06] bg-bg-1/95 backdrop-blur-sm flex flex-col",
        "animate-in slide-in-from-bottom-2 duration-200",
        steps.length > 4 ? "max-h-[50vh]" : "max-h-[40vh]",
      )}
    >
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-2.5 border-b border-white/[0.04] shrink-0">
        <div className="flex items-center gap-2.5 flex-1 min-w-0">
          {statusInfo && (
            <span
              className={cn(
                "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold tracking-wide",
                statusInfo.bg,
                statusInfo.color,
              )}
            >
              {executionStatus === "running" && (
                <Circle size={6} className="fill-current animate-pulse" />
              )}
              {statusInfo.label}
            </span>
          )}

          {totalCount > 0 && (
            <>
              <span className="text-xs text-muted">
                {completedCount} of {totalCount} steps
              </span>

              {/* Progress bar */}
              <div className="flex-1 max-w-[180px] h-1.5 bg-white/5 rounded-full overflow-hidden">
                <div
                  className={cn(
                    "h-full rounded-full transition-all duration-700 ease-out",
                    executionStatus === "failed"
                      ? "bg-red-500"
                      : executionStatus === "running"
                        ? "bg-blue-500"
                        : "bg-emerald-500",
                  )}
                  style={{ width: `${progressPct}%` }}
                />
              </div>
            </>
          )}

          <ElapsedTimer running={executionStatus === "running"} />
        </div>

        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={() => setMinimized(true)}
            className="w-6 h-6 flex items-center justify-center rounded text-muted hover:text-foreground hover:bg-white/5 transition-colors cursor-pointer"
            aria-label="Minimize execution panel"
          >
            <Minimize2 size={13} />
          </button>
          <button
            type="button"
            onClick={onClose}
            className="w-6 h-6 flex items-center justify-center rounded text-muted hover:text-foreground hover:bg-white/5 transition-colors cursor-pointer"
            aria-label="Close execution panel"
          >
            <X size={13} />
          </button>
        </div>
      </div>

      {/* Steps timeline */}
      <div
        ref={stepsContainerRef}
        className="flex-1 overflow-y-auto min-h-0 px-4 py-3"
        onScroll={handleScroll}
      >
        {steps.length === 0 && (
          <div className="flex items-center justify-center h-full py-8">
            <div className="text-center">
              <Loader2 size={20} className="text-blue-400 animate-spin mx-auto mb-2" />
              <p className="text-xs text-muted">Initializing execution...</p>
            </div>
          </div>
        )}

        {steps.map((step, idx) => (
          <StepRow
            key={step.nodeId}
            step={step}
            index={idx}
            label={nodeLabelMap.get(step.nodeId) ?? step.nodeId}
            isLast={idx === steps.length - 1}
            onStepClick={onStepClick}
          />
        ))}
      </div>
    </div>
  );
}
