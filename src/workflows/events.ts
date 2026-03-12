import type { ExecutionStatus, StepStatus } from "./types";

export interface StepEvent {
  readonly type: "step";
  readonly nodeId: string;
  readonly status: StepStatus;
  readonly output?: unknown;
  readonly error?: string;
}

export interface ExecutionEvent {
  readonly type: "execution";
  readonly status: ExecutionStatus;
  readonly error?: string;
  readonly result?: unknown;
}

export interface AgentProgressEvent {
  readonly type: "agent_progress";
  readonly nodeId: string;
  readonly agentId: string;
  readonly progressType: import("../agent/types").ProgressEvent["type"];
  readonly detail?: string;
}

export type ExecutionStreamEvent = StepEvent | ExecutionEvent | AgentProgressEvent;

type Callback = (event: ExecutionStreamEvent) => void;

class ExecutionEventBus {
  private readonly subscribers = new Map<string, Set<Callback>>();

  emit(executionId: string, event: ExecutionStreamEvent): void {
    const callbacks = this.subscribers.get(executionId);
    if (!callbacks) return;
    for (const cb of callbacks) {
      cb(event);
    }
  }

  subscribe(executionId: string, callback: Callback): () => void {
    const existing = this.subscribers.get(executionId) ?? new Set<Callback>();
    const updated = new Set(existing);
    updated.add(callback);
    this.subscribers.set(executionId, updated);

    return () => {
      const current = this.subscribers.get(executionId);
      if (!current) return;
      const next = new Set(current);
      next.delete(callback);
      if (next.size === 0) {
        this.subscribers.delete(executionId);
      } else {
        this.subscribers.set(executionId, next);
      }
    };
  }
}

export const executionEvents = new ExecutionEventBus();
