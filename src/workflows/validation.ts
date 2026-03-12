import type { WorkflowNode, WorkflowEdge } from "../store/workflows";

export interface ValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

/**
 * Validate a workflow graph for execution readiness.
 * Checks: exactly one trigger node, all edge endpoints exist, graph is
 * connected from the trigger, and there are no cycles.
 */
export function validateWorkflowForExecution(
  nodes: readonly WorkflowNode[],
  edges: readonly WorkflowEdge[],
): ValidationResult {
  const errors: string[] = [];

  const nodeIds = new Set(nodes.map((n) => n.id));

  // Exactly one trigger
  const triggers = nodes.filter((n) => n.type === "trigger");
  if (triggers.length === 0) {
    errors.push("Workflow must have exactly one trigger node");
  } else if (triggers.length > 1) {
    errors.push(`Workflow has ${triggers.length} trigger nodes — only one is allowed`);
  }

  // All edge endpoints must exist
  for (const edge of edges) {
    if (!nodeIds.has(edge.source)) {
      errors.push(`Edge "${edge.id}" references unknown source node "${edge.source}"`);
    }
    if (!nodeIds.has(edge.target)) {
      errors.push(`Edge "${edge.id}" references unknown target node "${edge.target}"`);
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  const trigger = triggers[0]!;

  // Build adjacency list (forward)
  const adj = new Map<string, string[]>();
  for (const node of nodes) {
    adj.set(node.id, []);
  }
  for (const edge of edges) {
    adj.get(edge.source)?.push(edge.target);
  }

  // BFS from trigger to find reachable nodes
  const reachable = new Set<string>();
  const queue: string[] = [trigger.id];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (reachable.has(current)) continue;
    reachable.add(current);
    for (const neighbor of adj.get(current) ?? []) {
      queue.push(neighbor);
    }
  }

  // All nodes must be reachable
  for (const node of nodes) {
    if (!reachable.has(node.id)) {
      errors.push(`Node "${node.id}" (${node.type}) is not reachable from the trigger`);
    }
  }

  // Cycle detection via Kahn's algorithm
  const inDegree = new Map<string, number>();
  for (const node of nodes) {
    inDegree.set(node.id, 0);
  }
  for (const edge of edges) {
    inDegree.set(edge.target, (inDegree.get(edge.target) ?? 0) + 1);
  }

  const kahnQueue = [...nodes.filter((n) => inDegree.get(n.id) === 0).map((n) => n.id)];
  let visited = 0;
  while (kahnQueue.length > 0) {
    const nodeId = kahnQueue.shift()!;
    visited++;
    for (const neighbor of adj.get(nodeId) ?? []) {
      const deg = (inDegree.get(neighbor) ?? 0) - 1;
      inDegree.set(neighbor, deg);
      if (deg === 0) {
        kahnQueue.push(neighbor);
      }
    }
  }

  if (visited < nodes.length) {
    errors.push("Workflow contains a cycle — execution is not possible");
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Return nodes in topological order starting from the trigger.
 * Throws if a cycle is detected.
 */
export function topologicalSort(
  nodes: readonly WorkflowNode[],
  edges: readonly WorkflowEdge[],
  triggerId: string,
): WorkflowNode[] {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));

  // Build adjacency and in-degree maps
  const adj = new Map<string, string[]>();
  const inDegree = new Map<string, number>();
  for (const node of nodes) {
    adj.set(node.id, []);
    inDegree.set(node.id, 0);
  }
  for (const edge of edges) {
    adj.get(edge.source)?.push(edge.target);
    inDegree.set(edge.target, (inDegree.get(edge.target) ?? 0) + 1);
  }

  // Start from the trigger node only — use Kahn's with BFS from trigger
  const queue: string[] = [triggerId];
  const result: WorkflowNode[] = [];
  const visited = new Set<string>();

  while (queue.length > 0) {
    const nodeId = queue.shift()!;
    if (visited.has(nodeId)) continue;
    visited.add(nodeId);

    const node = nodeMap.get(nodeId);
    if (node) result.push(node);

    for (const neighbor of adj.get(nodeId) ?? []) {
      const deg = (inDegree.get(neighbor) ?? 0) - 1;
      inDegree.set(neighbor, deg);
      if (deg === 0) {
        queue.push(neighbor);
      }
    }
  }

  // If not all reachable nodes were visited, there's a cycle
  if (result.length !== nodes.length && result.length < nodes.length) {
    // Only check reachability — unreachable nodes are not a cycle issue here
    // Count nodes reachable from trigger
    const reachable = new Set<string>();
    const bfsQ = [triggerId];
    while (bfsQ.length > 0) {
      const id = bfsQ.shift()!;
      if (reachable.has(id)) continue;
      reachable.add(id);
      for (const neighbor of (adj.get(id) ?? [])) {
        bfsQ.push(neighbor);
      }
    }
    if (result.length < reachable.size) {
      throw new Error("Workflow contains a cycle — cannot topologically sort");
    }
  }

  return result;
}
