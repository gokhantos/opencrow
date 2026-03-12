import { useState, useEffect, useCallback } from "react";
import { apiFetch } from "../../api";
import { cn } from "../../lib/cn";
import type { ExecutionRecord, ExecutionStepMap, StepInfo } from "./types";

interface ExecutionHistoryProps {
  readonly workflowId: string | null;
  readonly onLoadExecution: (stepStatuses: ExecutionStepMap) => void;
}

interface ExecutionWithSteps extends ExecutionRecord {
  readonly steps?: ReadonlyArray<{
    readonly nodeId: string;
    readonly status: StepInfo["status"];
    readonly output?: unknown;
    readonly error?: string;
  }>;
}

const statusPillStyles: Record<string, string> = {
  pending: "bg-bg-3 text-muted",
  running: "bg-blue-500/10 text-blue-300",
  completed: "bg-green-500/10 text-green-300",
  failed: "bg-danger-subtle text-danger",
  cancelled: "bg-bg-3 text-muted",
};

function formatDuration(startedAt: number | null | undefined, finishedAt: number | null | undefined): string {
  if (!startedAt || !finishedAt) return "—";
  const secs = finishedAt - startedAt;
  if (secs < 60) return `${secs}s`;
  return `${Math.floor(secs / 60)}m ${secs % 60}s`;
}

function formatTimestamp(createdAt: number): string {
  const date = new Date(createdAt * 1000);
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function ExecutionHistory({ workflowId, onLoadExecution }: ExecutionHistoryProps) {
  const [executions, setExecutions] = useState<ExecutionRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingId, setLoadingId] = useState<string | null>(null);

  useEffect(() => {
    if (!workflowId) {
      setExecutions([]);
      return;
    }

    setLoading(true);
    apiFetch<{ success: boolean; data: ExecutionRecord[] }>(
      `/api/workflows/${workflowId}/executions?limit=20`,
    )
      .then((res) => setExecutions(res.data))
      .catch(() => setExecutions([]))
      .finally(() => setLoading(false));
  }, [workflowId]);

  const handleLoadExecution = useCallback(
    async (executionId: string) => {
      setLoadingId(executionId);
      try {
        const res = await apiFetch<{ success: boolean; data: ExecutionWithSteps }>(
          `/api/workflow-executions/${executionId}`,
        );
        const data = res.data;
        const map = new Map<string, StepInfo>();
        for (const step of data.steps ?? []) {
          map.set(step.nodeId, {
            nodeId: step.nodeId,
            status: step.status,
            output: step.output,
            error: step.error,
          });
        }
        onLoadExecution(map);
      } catch {
        // silently fail — the canvas just won't show execution state
      } finally {
        setLoadingId(null);
      }
    },
    [onLoadExecution],
  );

  if (!workflowId) return null;

  return (
    <div className="border-t border-border bg-bg-1">
      <div className="px-4 py-2 text-xs font-semibold text-muted uppercase tracking-wide">
        Execution History
      </div>

      {loading && (
        <div className="px-4 pb-3 text-xs text-muted">Loading...</div>
      )}

      {!loading && executions.length === 0 && (
        <div className="px-4 pb-3 text-xs text-muted">No executions yet</div>
      )}

      {!loading && executions.length > 0 && (
        <div className="max-h-48 overflow-y-auto">
          {executions.map((exec, idx) => (
            <button
              key={exec.id}
              onClick={() => handleLoadExecution(exec.id)}
              disabled={loadingId === exec.id}
              className={cn(
                "w-full flex items-center gap-3 px-4 py-2 text-xs text-left hover:bg-bg-2 transition-colors cursor-pointer",
                idx !== 0 && "border-t border-border",
                loadingId === exec.id && "opacity-60",
              )}
            >
              <span
                className={cn(
                  "inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium shrink-0",
                  statusPillStyles[exec.status] ?? "bg-bg-3 text-muted",
                )}
              >
                {exec.status}
              </span>
              <span className="text-muted flex-1 truncate">
                {formatTimestamp(exec.createdAt)}
              </span>
              <span className="text-muted shrink-0">
                {formatDuration(exec.startedAt, exec.finishedAt)}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
