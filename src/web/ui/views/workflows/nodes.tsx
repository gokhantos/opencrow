import React from "react";
import { Handle, Position } from "@xyflow/react";
import type { Node, NodeProps } from "@xyflow/react";
import { Play, Bot, Wrench, Zap, GitBranch, ArrowLeftRight, Square, Check, X } from "lucide-react";
import { cn } from "../../lib/cn";
import { useValidationErrors } from "./ValidationContext";
import { useNodeStepInfo } from "./ExecutionStatusContext";
import type {
  WorkflowNodeData,
  TriggerNodeData,
  AgentNodeData,
  ToolNodeData,
  SkillNodeData,
  ConditionNodeData,
  TransformNodeData,
  OutputNodeData,
  StepStatus,
} from "./types";

interface NodeWrapperProps {
  readonly nodeId: string;
  readonly color: string;
  readonly icon: React.ReactNode;
  readonly label: string;
  readonly sublabel?: string;
  readonly selected?: boolean;
  readonly children?: React.ReactNode;
}

function executionOverlayClass(status: StepStatus): string {
  if (status === "pending") return "opacity-60";
  if (status === "running") return "ring-2 ring-blue-400/70 animate-pulse rounded-xl";
  if (status === "completed") return "ring-2 ring-green-400/70 rounded-xl";
  if (status === "failed") return "ring-2 ring-red-400/70 rounded-xl";
  if (status === "skipped") return "opacity-30";
  return "";
}

function ExecutionBadge({ status }: { readonly status: StepStatus }) {
  if (status === "completed") {
    return (
      <span className="absolute -top-1.5 -right-1.5 z-10 flex items-center justify-center w-4 h-4 rounded-full bg-green-500 text-white shadow-sm">
        <Check size={9} strokeWidth={3} />
      </span>
    );
  }
  if (status === "failed") {
    return (
      <span className="absolute -top-1.5 -right-1.5 z-10 flex items-center justify-center w-4 h-4 rounded-full bg-red-500 text-white shadow-sm">
        <X size={9} strokeWidth={3} />
      </span>
    );
  }
  return null;
}

function NodeWrapper({ nodeId, color, icon, label, sublabel, selected, children }: NodeWrapperProps) {
  const errors = useValidationErrors(nodeId);
  const stepInfo = useNodeStepInfo(nodeId);
  const hasErrors = errors.length > 0;

  return (
    <div className={cn("relative", stepInfo && executionOverlayClass(stepInfo.status))}>
      {stepInfo && <ExecutionBadge status={stepInfo.status} />}
      <div
        className={cn(
          "bg-bg-1 border border-t-[3px] border-border-2 rounded-xl min-w-[160px] max-w-[240px] shadow-lg shadow-black/15 transition-all",
          color,
          selected && "border-accent ring-1 ring-accent/40",
          hasErrors && "border-red-500 ring-1 ring-red-500/30",
        )}
      >
        <div className="px-3 py-2.5 flex items-center gap-2">
          <span className="shrink-0">{icon}</span>
          <div className="min-w-0">
            <div className="text-sm font-semibold text-strong truncate leading-tight">{label}</div>
            {sublabel && (
              <div className="text-[11px] text-muted truncate mt-0.5">{sublabel}</div>
            )}
          </div>
        </div>
        {children && <div className="px-3 pb-2.5 pt-0">{children}</div>}
      </div>

      {hasErrors && (
        <div
          className="absolute -top-2 -right-2 group/badge"
          title={errors.join("\n")}
        >
          <div className="w-5 h-5 rounded-full bg-red-500 text-white text-[10px] font-bold flex items-center justify-center shadow-md cursor-default">
            {errors.length}
          </div>
          <div className="absolute right-0 top-6 z-50 hidden group-hover/badge:block bg-bg-1 border border-border rounded-lg p-2 shadow-xl min-w-[180px] max-w-[260px]">
            {errors.map((err, i) => (
              <div key={i} className="text-[11px] text-danger leading-tight py-0.5">
                {err}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function TriggerNode({ id, data, selected }: NodeProps<Node<TriggerNodeData>>) {
  return (
    <>
      <NodeWrapper
        nodeId={id}
        color="border-t-teal-500"
        icon={<Play size={14} className="text-teal-500" />}
        label={data.label || "Trigger"}
        sublabel={data.triggerType}
        selected={selected}
      />
      <Handle type="source" position={Position.Right} />
    </>
  );
}

export function AgentNode({ id, data, selected }: NodeProps<Node<AgentNodeData>>) {
  return (
    <>
      <Handle type="target" position={Position.Left} />
      <NodeWrapper
        nodeId={id}
        color="border-t-purple-500"
        icon={<Bot size={14} className="text-purple-500" />}
        label={data.label || "Agent"}
        sublabel={data.agentName || undefined}
        selected={selected}
      />
      <Handle type="source" position={Position.Right} />
    </>
  );
}

export function ToolNode({ id, data, selected }: NodeProps<Node<ToolNodeData>>) {
  return (
    <>
      <Handle type="target" position={Position.Left} />
      <NodeWrapper
        nodeId={id}
        color="border-t-blue-500"
        icon={<Wrench size={14} className="text-blue-500" />}
        label={data.label || "Tool"}
        sublabel={data.toolName || undefined}
        selected={selected}
      />
      <Handle type="source" position={Position.Right} />
    </>
  );
}

export function SkillNode({ id, data, selected }: NodeProps<Node<SkillNodeData>>) {
  return (
    <>
      <Handle type="target" position={Position.Left} />
      <NodeWrapper
        nodeId={id}
        color="border-t-green-500"
        icon={<Zap size={14} className="text-green-500" />}
        label={data.label || "Skill"}
        sublabel={data.skillName || undefined}
        selected={selected}
      />
      <Handle type="source" position={Position.Right} />
    </>
  );
}

export function ConditionNode({ id, data, selected }: NodeProps<Node<ConditionNodeData>>) {
  return (
    <>
      <Handle type="target" position={Position.Left} />
      <NodeWrapper
        nodeId={id}
        color="border-t-yellow-500"
        icon={<GitBranch size={14} className="text-yellow-500" />}
        label={data.label || "Condition"}
        sublabel={data.expression ? String(data.expression).slice(0, 24) : undefined}
        selected={selected}
      />
      <Handle
        type="source"
        position={Position.Right}
        id="true"
        style={{ top: "35%" }}
      />
      <Handle
        type="source"
        position={Position.Right}
        id="false"
        style={{ top: "65%" }}
      />
    </>
  );
}

export function TransformNode({ id, data, selected }: NodeProps<Node<TransformNodeData>>) {
  return (
    <>
      <Handle type="target" position={Position.Left} />
      <NodeWrapper
        nodeId={id}
        color="border-t-orange-500"
        icon={<ArrowLeftRight size={14} className="text-orange-500" />}
        label={data.label || "Transform"}
        sublabel={data.template ? String(data.template).slice(0, 24) : undefined}
        selected={selected}
      />
      <Handle type="source" position={Position.Right} />
    </>
  );
}

export function OutputNode({ id, data, selected }: NodeProps<Node<OutputNodeData>>) {
  return (
    <>
      <Handle type="target" position={Position.Left} />
      <NodeWrapper
        nodeId={id}
        color="border-t-rose-500"
        icon={<Square size={14} className="text-rose-500" />}
        label={data.label || "Output"}
        sublabel={data.action ? String(data.action) : undefined}
        selected={selected}
      />
    </>
  );
}

export const nodeTypes = {
  trigger: TriggerNode,
  agent: AgentNode,
  tool: ToolNode,
  skill: SkillNode,
  condition: ConditionNode,
  transform: TransformNode,
  output: OutputNode,
} as const;

// Re-export for use in other files
export type { WorkflowNodeData };
