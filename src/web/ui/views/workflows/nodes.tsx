import React from "react";
import { Handle, Position } from "@xyflow/react";
import type { Node, NodeProps } from "@xyflow/react";
import { Play, Bot, Wrench, Zap, GitBranch, ArrowLeftRight, Square } from "lucide-react";
import { cn } from "../../lib/cn";
import type {
  WorkflowNodeData,
  TriggerNodeData,
  AgentNodeData,
  ToolNodeData,
  SkillNodeData,
  ConditionNodeData,
  TransformNodeData,
  OutputNodeData,
} from "./types";

interface NodeWrapperProps {
  readonly color: string;
  readonly icon: React.ReactNode;
  readonly label: string;
  readonly sublabel?: string;
  readonly selected?: boolean;
  readonly children?: React.ReactNode;
}

function NodeWrapper({ color, icon, label, sublabel, selected, children }: NodeWrapperProps) {
  return (
    <div
      className={cn(
        "bg-bg-1 border border-t-[4px] border-border-2 rounded-lg min-w-[160px] max-w-[240px] shadow-md transition-colors",
        color,
        selected && "border-accent ring-1 ring-accent/40",
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
  );
}

export function TriggerNode({ data, selected }: NodeProps<Node<TriggerNodeData>>) {
  return (
    <>
      <NodeWrapper
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

export function AgentNode({ data, selected }: NodeProps<Node<AgentNodeData>>) {
  return (
    <>
      <Handle type="target" position={Position.Left} />
      <NodeWrapper
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

export function ToolNode({ data, selected }: NodeProps<Node<ToolNodeData>>) {
  return (
    <>
      <Handle type="target" position={Position.Left} />
      <NodeWrapper
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

export function SkillNode({ data, selected }: NodeProps<Node<SkillNodeData>>) {
  return (
    <>
      <Handle type="target" position={Position.Left} />
      <NodeWrapper
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

export function ConditionNode({ data, selected }: NodeProps<Node<ConditionNodeData>>) {
  return (
    <>
      <Handle type="target" position={Position.Left} />
      <NodeWrapper
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

export function TransformNode({ data, selected }: NodeProps<Node<TransformNodeData>>) {
  return (
    <>
      <Handle type="target" position={Position.Left} />
      <NodeWrapper
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

export function OutputNode({ data, selected }: NodeProps<Node<OutputNodeData>>) {
  return (
    <>
      <Handle type="target" position={Position.Left} />
      <NodeWrapper
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
