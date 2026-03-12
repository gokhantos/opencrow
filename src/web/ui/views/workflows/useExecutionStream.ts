import { useState, useEffect, useRef, useCallback } from "react";
import { apiFetch } from "../../api";
import type { ExecutionStepMap, ExecutionStatus, StepInfo, ExecutionRecord } from "./types";

const TERMINAL_STATUSES: ReadonlySet<ExecutionStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

const POLL_INTERVAL_MS = 2000;

export interface ExecutionStreamState {
  readonly stepStatuses: ExecutionStepMap;
  readonly executionStatus: ExecutionStatus | null;
  readonly isConnected: boolean;
}

interface SnapshotEvent {
  readonly type: "snapshot";
  readonly execution: ExecutionRecord;
  readonly steps: ReadonlyArray<{
    readonly nodeId: string;
    readonly status: StepInfo["status"];
    readonly output?: unknown;
    readonly error?: string;
  }>;
}

interface StepEvent {
  readonly type: "step";
  readonly nodeId: string;
  readonly status: StepInfo["status"];
  readonly output?: unknown;
  readonly error?: string;
}

interface ExecutionEvent {
  readonly type: "execution";
  readonly status: ExecutionStatus;
  readonly error?: string;
}

type StreamEvent = SnapshotEvent | StepEvent | ExecutionEvent;

export function useExecutionStream(
  executionId: string | null,
): ExecutionStreamState {
  const [stepStatuses, setStepStatuses] = useState<ExecutionStepMap>(new Map());
  const [executionStatus, setExecutionStatus] = useState<ExecutionStatus | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const esRef = useRef<EventSource | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const clearPoll = useCallback(() => {
    if (pollRef.current !== null) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const applyStepEvent = useCallback((event: StepEvent) => {
    setStepStatuses((prev) => {
      const next = new Map(prev);
      next.set(event.nodeId, {
        nodeId: event.nodeId,
        status: event.status,
        output: event.output,
        error: event.error,
      });
      return next;
    });
  }, []);

  const startPolling = useCallback(
    (id: string) => {
      clearPoll();
      pollRef.current = setInterval(async () => {
        try {
          const res = await apiFetch<{
            success: boolean;
            data: ExecutionRecord & {
              steps: ReadonlyArray<{
                nodeId: string;
                status: StepInfo["status"];
                output?: unknown;
                error?: string;
              }>;
            };
          }>(`/api/workflow-executions/${id}`);

          const data = res.data;
          setExecutionStatus(data.status);

          const next = new Map<string, StepInfo>();
          for (const step of data.steps ?? []) {
            next.set(step.nodeId, {
              nodeId: step.nodeId,
              status: step.status,
              output: step.output,
              error: step.error,
            });
          }
          setStepStatuses(next);

          if (TERMINAL_STATUSES.has(data.status)) {
            clearPoll();
          }
        } catch {
          clearPoll();
        }
      }, POLL_INTERVAL_MS);
    },
    [clearPoll],
  );

  useEffect(() => {
    if (!executionId) {
      setStepStatuses(new Map());
      setExecutionStatus(null);
      setIsConnected(false);
      return;
    }

    // Close any previous connection
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }
    clearPoll();
    setStepStatuses(new Map());
    setExecutionStatus(null);
    setIsConnected(false);

    let closed = false;

    const es = new EventSource(`/api/workflow-executions/${executionId}/stream`);
    esRef.current = es;

    es.onopen = () => {
      if (!closed) setIsConnected(true);
    };

    es.onmessage = (msg) => {
      if (closed) return;
      let event: StreamEvent;
      try {
        event = JSON.parse(msg.data as string) as StreamEvent;
      } catch {
        return;
      }

      if (event.type === "snapshot") {
        setExecutionStatus(event.execution.status);
        const next = new Map<string, StepInfo>();
        for (const step of event.steps) {
          next.set(step.nodeId, {
            nodeId: step.nodeId,
            status: step.status,
            output: step.output,
            error: step.error,
          });
        }
        setStepStatuses(next);
        if (TERMINAL_STATUSES.has(event.execution.status)) {
          es.close();
          setIsConnected(false);
        }
      } else if (event.type === "step") {
        applyStepEvent(event);
      } else if (event.type === "execution") {
        setExecutionStatus(event.status);
        if (TERMINAL_STATUSES.has(event.status)) {
          es.close();
          setIsConnected(false);
        }
      }
    };

    es.onerror = () => {
      if (closed) return;
      es.close();
      esRef.current = null;
      setIsConnected(false);
      // Fallback to polling
      startPolling(executionId);
    };

    return () => {
      closed = true;
      es.close();
      clearPoll();
      esRef.current = null;
    };
  }, [executionId, applyStepEvent, startPolling, clearPoll]);

  return { stepStatuses, executionStatus, isConnected };
}
