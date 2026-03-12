import type { Node, Edge } from "@xyflow/react";
import type { WorkflowNodeData } from "./types";

export function validateWorkflowGraph(
  nodes: Node<WorkflowNodeData>[],
  edges: Edge[],
): ReadonlyMap<string, readonly string[]> {
  const errors = new Map<string, string[]>();

  function addError(nodeId: string, msg: string): void {
    const existing = errors.get(nodeId) ?? [];
    errors.set(nodeId, [...existing, msg]);
  }

  const triggerNodes = nodes.filter((n) => n.type === "trigger");
  const outputNodes = nodes.filter((n) => n.type === "output");

  // No trigger node
  if (triggerNodes.length === 0 && nodes.length > 0) {
    const firstNodeId = nodes[0]!.id;
    addError(firstNodeId, "Workflow has no trigger node");
  }

  // Multiple trigger nodes
  if (triggerNodes.length > 1) {
    for (const n of triggerNodes) {
      addError(n.id, "Only one trigger node is allowed");
    }
  }

  const incomingCount = new Map<string, number>();
  const outgoingCount = new Map<string, number>();
  for (const n of nodes) {
    incomingCount.set(n.id, 0);
    outgoingCount.set(n.id, 0);
  }
  for (const e of edges) {
    incomingCount.set(e.target, (incomingCount.get(e.target) ?? 0) + 1);
    outgoingCount.set(e.source, (outgoingCount.get(e.source) ?? 0) + 1);
  }

  // Orphan and required field checks per node
  for (const node of nodes) {
    const incoming = incomingCount.get(node.id) ?? 0;
    const outgoing = outgoingCount.get(node.id) ?? 0;
    const isTrigger = node.type === "trigger";
    const isOutput = node.type === "output";

    const isOrphan = isTrigger
      ? outgoing === 0 && nodes.length > 1
      : isOutput
        ? incoming === 0 && nodes.length > 1
        : incoming === 0 && outgoing === 0;

    if (isOrphan) {
      addError(node.id, "Node is not connected to the workflow");
    }

    // Required fields
    const data = node.data as WorkflowNodeData;
    if (node.type === "agent" && !("agentId" in data && data.agentId)) {
      addError(node.id, "Agent node requires an agent to be selected");
    }
    if (node.type === "tool" && !("toolName" in data && data.toolName)) {
      addError(node.id, "Tool node requires a tool to be selected");
    }
    if (node.type === "condition" && !("expression" in data && data.expression)) {
      addError(node.id, "Condition node requires an expression");
    }
  }

  // Unreachable nodes from trigger
  if (triggerNodes.length === 1) {
    const triggerId = triggerNodes[0]!.id;
    const reachable = new Set<string>();
    const queue: string[] = [triggerId];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (reachable.has(current)) continue;
      reachable.add(current);
      for (const e of edges) {
        if (e.source === current && !reachable.has(e.target)) {
          queue.push(e.target);
        }
      }
    }
    for (const node of nodes) {
      if (!reachable.has(node.id) && node.type !== "trigger") {
        addError(node.id, "Node is unreachable from the trigger");
      }
    }
  }

  // Ignore output nodes with no source handle check (already covered by orphan)
  void outputNodes;

  return errors as ReadonlyMap<string, readonly string[]>;
}
