import { useState, useCallback } from "react";
import { Play, ChevronDown, ChevronRight } from "lucide-react";
import { Button } from "../../components";
import { apiFetch } from "../../api";
import { cn } from "../../lib/cn";
import type { ExecutionStatus, ExecutionStepMap } from "./types";

type StepStatus = "pending" | "running" | "completed" | "failed" | "skipped";

interface RunResponse {
  readonly executionId: string;
}

interface RunControlsProps {
  readonly workflowId: string | null;
  readonly isDirty: boolean;
  readonly executionStatus: ExecutionStatus | null;
  readonly stepStatuses: ExecutionStepMap;
  readonly onExecutionStart: (executionId: string) => void;
}

const TERMINAL_STATUSES: ReadonlySet<ExecutionStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

const statusPillStyles: Record<ExecutionStatus, string> = {
  pending: "bg-bg-3 text-muted",
  running: "bg-blue-500/15 text-blue-400",
  completed: "bg-green-500/15 text-green-400",
  failed: "bg-danger-subtle text-danger",
  cancelled: "bg-bg-3 text-muted",
};

const stepStatusStyles: Record<StepStatus, string> = {
  pending: "bg-bg-3 text-muted",
  running: "bg-blue-500/15 text-blue-400",
  completed: "bg-green-500/15 text-green-400",
  failed: "bg-danger-subtle text-danger",
  skipped: "bg-bg-3 text-muted opacity-60",
};

function StatusPill({
  status,
  className,
}: {
  readonly status: ExecutionStatus | StepStatus;
  readonly className?: string;
}) {
  const isExecutionStatus = (s: string): s is ExecutionStatus =>
    ["pending", "running", "completed", "failed", "cancelled"].includes(s);

  const styles = isExecutionStatus(status)
    ? statusPillStyles[status]
    : stepStatusStyles[status as StepStatus];

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-medium",
        styles,
        status === "running" && "animate-pulse",
        className,
      )}
    >
      {status}
    </span>
  );
}

export function RunControls({
  workflowId,
  isDirty,
  executionStatus,
  stepStatuses,
  onExecutionStart,
}: RunControlsProps) {
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [stepsOpen, setStepsOpen] = useState(false);

  const handleRun = useCallback(async () => {
    if (!workflowId || isDirty) return;

    setRunning(true);
    setRunError(null);

    try {
      const res = await apiFetch<{ success: boolean; data: RunResponse }>(
        `/api/workflows/${workflowId}/run`,
        { method: "POST" },
      );
      onExecutionStart(res.data.executionId);
    } catch (err) {
      const message =
        err && typeof err === "object" && "message" in err
          ? String((err as { message: unknown }).message)
          : "Failed to start workflow";
      setRunError(message);
    } finally {
      setRunning(false);
    }
  }, [workflowId, isDirty, onExecutionStart]);

  const isDisabled = !workflowId || isDirty;
  const disabledTitle = !workflowId
    ? "Save the workflow first"
    : isDirty
      ? "Save changes before running"
      : undefined;

  const steps = [...stepStatuses.values()];
  const isTerminal = executionStatus !== null && TERMINAL_STATUSES.has(executionStatus);

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <Button
          variant="primary"
          size="sm"
          disabled={isDisabled}
          loading={running}
          onClick={handleRun}
          title={disabledTitle}
          className={cn(
            !isDisabled &&
              "bg-green-600 hover:bg-green-500",
          )}
        >
          <Play size={13} />
          Run
        </Button>

        {executionStatus && (
          <StatusPill status={executionStatus} />
        )}

        {runError && (
          <span className="text-xs text-danger">{runError}</span>
        )}

        {steps.length > 0 && (
          <button
            className="inline-flex items-center gap-0.5 text-xs text-muted hover:text-foreground transition-colors cursor-pointer"
            onClick={() => setStepsOpen((v) => !v)}
          >
            {stepsOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            {steps.length} step{steps.length !== 1 ? "s" : ""}
          </button>
        )}

        {isTerminal && executionStatus === "failed" && (
          <span className="text-xs text-danger truncate max-w-[200px]">
            Execution failed
          </span>
        )}
      </div>

      {stepsOpen && steps.length > 0 && (
        <div className="mt-1 ml-0.5 border border-border-2 rounded-lg bg-bg-2 overflow-hidden">
          {steps.map((step, idx) => (
            <div
              key={step.nodeId}
              className={cn(
                "flex items-center gap-2 px-3 py-2 text-xs",
                idx !== 0 && "border-t border-border",
              )}
            >
              <span className="text-muted font-mono w-4 shrink-0 text-right">{idx + 1}</span>
              <span className="text-foreground flex-1 truncate">{step.nodeId}</span>
              <StatusPill status={step.status} />
              {step.error && (
                <span className="text-danger truncate max-w-[120px]" title={step.error}>
                  {step.error}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
