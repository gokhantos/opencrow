import React from "react";
import { Play, Bot, Wrench, Zap, GitBranch, ArrowLeftRight, Square } from "lucide-react";
import type { WorkflowNodeType, WorkflowNodeData } from "./types";

interface PaletteItem {
  readonly type: WorkflowNodeType;
  readonly label: string;
  readonly description: string;
  readonly icon: React.ReactNode;
  readonly color: string;
  readonly defaultData: WorkflowNodeData;
}

const PALETTE_ITEMS: readonly PaletteItem[] = [
  {
    type: "trigger",
    label: "Trigger",
    description: "Start the workflow",
    icon: <Play size={14} />,
    color: "text-teal-500 bg-teal-500/10 border-teal-500/20",
    defaultData: {
      nodeType: "trigger",
      label: "Trigger",
      triggerType: "manual",
    },
  },
  {
    type: "agent",
    label: "Agent",
    description: "Run an AI agent",
    icon: <Bot size={14} />,
    color: "text-purple-500 bg-purple-500/10 border-purple-500/20",
    defaultData: {
      nodeType: "agent",
      label: "Agent",
      agentId: "",
      agentName: "",
    },
  },
  {
    type: "tool",
    label: "Tool",
    description: "Execute a tool",
    icon: <Wrench size={14} />,
    color: "text-blue-500 bg-blue-500/10 border-blue-500/20",
    defaultData: {
      nodeType: "tool",
      label: "Tool",
      toolName: "",
    },
  },
  {
    type: "skill",
    label: "Skill",
    description: "Apply a skill",
    icon: <Zap size={14} />,
    color: "text-green-500 bg-green-500/10 border-green-500/20",
    defaultData: {
      nodeType: "skill",
      label: "Skill",
      skillId: "",
      skillName: "",
    },
  },
  {
    type: "condition",
    label: "Condition",
    description: "Branch on expression",
    icon: <GitBranch size={14} />,
    color: "text-yellow-500 bg-yellow-500/10 border-yellow-500/20",
    defaultData: {
      nodeType: "condition",
      label: "Condition",
      expression: "",
    },
  },
  {
    type: "transform",
    label: "Transform",
    description: "Map / reshape data",
    icon: <ArrowLeftRight size={14} />,
    color: "text-orange-500 bg-orange-500/10 border-orange-500/20",
    defaultData: {
      nodeType: "transform",
      label: "Transform",
      template: "",
    },
  },
  {
    type: "output",
    label: "Output",
    description: "Return or send result",
    icon: <Square size={14} />,
    color: "text-rose-500 bg-rose-500/10 border-rose-500/20",
    defaultData: {
      nodeType: "output",
      label: "Output",
      action: "return",
    },
  },
];

export function NodePalette() {
  function handleDragStart(
    e: React.DragEvent,
    item: PaletteItem,
  ) {
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData(
      "application/workflow-node",
      JSON.stringify({ type: item.type, data: item.defaultData }),
    );
  }

  return (
    <aside className="w-56 shrink-0 bg-bg-1 border-r border-border flex flex-col overflow-y-auto">
      <div className="px-4 py-3 border-b border-border">
        <h3 className="text-xs font-semibold text-muted uppercase tracking-wider m-0">
          Nodes
        </h3>
      </div>
      <div className="p-3 flex flex-col gap-2">
        {PALETTE_ITEMS.map((item) => (
          <div
            key={item.type}
            draggable
            onDragStart={(e) => handleDragStart(e, item)}
            className="flex items-center gap-3 px-3 py-2.5 rounded-lg border border-border cursor-grab active:cursor-grabbing bg-bg hover:bg-bg-2 hover:border-border-hover transition-colors select-none"
          >
            <span
              className={`w-7 h-7 rounded-md border flex items-center justify-center shrink-0 ${item.color}`}
            >
              {item.icon}
            </span>
            <div className="min-w-0">
              <div className="text-sm font-semibold text-strong leading-tight">
                {item.label}
              </div>
              <div className="text-[11px] text-muted leading-tight mt-0.5 truncate">
                {item.description}
              </div>
            </div>
          </div>
        ))}
      </div>
    </aside>
  );
}
