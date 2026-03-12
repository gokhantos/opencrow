import type { WorkflowNode, WorkflowEdge } from "../store/workflows";
import type { AgentRegistry } from "../agents/registry";
import type { ToolRegistry } from "../tools/registry";

export type ExecutionStatus = "pending" | "running" | "completed" | "failed";
export type StepStatus = "pending" | "running" | "completed" | "failed" | "skipped";

export interface WorkflowExecution {
  readonly id: string;
  readonly workflowId: string;
  readonly status: ExecutionStatus;
  readonly triggerInput: Record<string, unknown>;
  readonly result: unknown | null;
  readonly error: string | null;
  readonly startedAt: number | null;
  readonly finishedAt: number | null;
  readonly createdAt: number;
}

export interface WorkflowExecutionStep {
  readonly id: string;
  readonly executionId: string;
  readonly nodeId: string;
  readonly nodeType: string;
  readonly status: StepStatus;
  readonly input: unknown | null;
  readonly output: unknown | null;
  readonly error: string | null;
  readonly startedAt: number | null;
  readonly finishedAt: number | null;
}

export interface ExecutionContext {
  readonly executionId: string;
  readonly workflowId: string;
  readonly triggerInput: Record<string, unknown>;
  readonly outputs: ReadonlyMap<string, unknown>;
  readonly abortSignal: AbortSignal;
}

export interface EngineDeps {
  readonly agentRegistry: AgentRegistry;
  readonly toolRegistry: ToolRegistry | null;
  readonly buildAgentOptions?: (
    agent: import("../agents/types").ResolvedAgent,
    onProgress?: (event: import("../agent/types").ProgressEvent) => void,
  ) => Promise<import("../agent/types").AgentOptions>;
}

export type { WorkflowNode, WorkflowEdge };
