export type WorkflowNodeType =
  | "trigger"
  | "agent"
  | "tool"
  | "skill"
  | "condition"
  | "transform"
  | "output";

// Index signature needed to satisfy @xyflow/react's Record<string, unknown> constraint
interface BaseNodeData {
  readonly nodeType: WorkflowNodeType;
  readonly label: string;
  [key: string]: unknown;
}

export interface TriggerNodeData extends BaseNodeData {
  readonly nodeType: "trigger";
  readonly triggerType: "cron" | "webhook" | "manual";
  readonly cronExpression?: string;
  readonly webhookPath?: string;
}

export interface AgentNodeData extends BaseNodeData {
  readonly nodeType: "agent";
  readonly agentId: string;
  readonly agentName: string;
  readonly prompt?: string;
}

export interface ToolNodeData extends BaseNodeData {
  readonly nodeType: "tool";
  readonly toolName: string;
  readonly inputMapping?: string;
}

export interface SkillNodeData extends BaseNodeData {
  readonly nodeType: "skill";
  readonly skillId: string;
  readonly skillName: string;
}

export interface ConditionNodeData extends BaseNodeData {
  readonly nodeType: "condition";
  readonly expression: string;
}

export interface TransformNodeData extends BaseNodeData {
  readonly nodeType: "transform";
  readonly template: string;
}

export interface OutputNodeData extends BaseNodeData {
  readonly nodeType: "output";
  readonly action: "return" | "send_channel";
  readonly channelId?: string;
}

export type WorkflowNodeData =
  | TriggerNodeData
  | AgentNodeData
  | ToolNodeData
  | SkillNodeData
  | ConditionNodeData
  | TransformNodeData
  | OutputNodeData;

import type { Node, Edge } from "@xyflow/react";

export interface SavedWorkflow {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly nodes: Node<WorkflowNodeData>[];
  readonly edges: Edge[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AgentOption {
  readonly id: string;
  readonly name: string;
}

export interface SkillOption {
  readonly id: string;
  readonly name: string;
}

export interface ToolOption {
  readonly name: string;
  readonly description: string;
}
