import React, { useCallback, useRef } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  MiniMap,
  Controls,
  BackgroundVariant,
  MarkerType,
} from "@xyflow/react";
import type { NodeChange, EdgeChange, Connection, Node, Edge, IsValidConnection, Viewport } from "@xyflow/react";
import { nodeTypes } from "./nodes";
import type { WorkflowState, WorkflowAction, WorkflowViewport } from "./useWorkflowReducer";
import type { WorkflowNodeData, ExecutionStepMap } from "./types";
import { ValidationProvider } from "./ValidationContext";
import { ExecutionStatusProvider } from "./ExecutionStatusContext";

interface WorkflowCanvasProps {
  readonly state: WorkflowState;
  readonly dispatch: React.Dispatch<WorkflowAction>;
  readonly validationErrors: ReadonlyMap<string, readonly string[]>;
  readonly stepStatuses?: ExecutionStepMap;
  readonly onNodeExecutionClick?: (nodeId: string) => void;
  readonly onViewportChange?: (viewport: WorkflowViewport) => void;
}

const MINIMAP_COLORS: Record<string, string> = {
  trigger: "#14b8a6",
  agent: "#a855f7",
  tool: "#3b82f6",
  skill: "#22c55e",
  condition: "#eab308",
  transform: "#f97316",
  output: "#f43f5e",
};

const DEFAULT_EDGE_OPTIONS = {
  type: "smoothstep" as const,
  markerEnd: { type: MarkerType.ArrowClosed, color: "#4a4a5a" },
  style: { stroke: "#4a4a5a", strokeWidth: 2 },
};

function generateId(): string {
  return `node-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function deriveEdgeStyles(
  edges: readonly Edge[],
  nodes: readonly Node[],
  stepStatuses: ExecutionStepMap,
): Edge[] {
  if (stepStatuses.size === 0) return edges as Edge[];
  return edges.map((edge) => {
    const sourceStatus = stepStatuses.get(edge.source)?.status ?? null;
    const targetStatus = stepStatuses.get(edge.target)?.status ?? null;

    if (sourceStatus === "completed" && targetStatus === "running") {
      return {
        ...edge,
        animated: true,
        style: { stroke: "#3b82f6", strokeWidth: 2 },
        markerEnd: { type: MarkerType.ArrowClosed, color: "#3b82f6" },
      };
    }
    if (sourceStatus === "completed" && targetStatus === "completed") {
      return {
        ...edge,
        animated: false,
        style: { stroke: "#22c55e", strokeWidth: 2 },
        markerEnd: { type: MarkerType.ArrowClosed, color: "#22c55e" },
      };
    }
    return edge as Edge;
  });
  // nodes param used for future extensibility (e.g. node type filtering)
  void nodes;
}

function CanvasInner({ state, dispatch, validationErrors, stepStatuses = new Map(), onNodeExecutionClick, onViewportChange }: WorkflowCanvasProps) {
  const reactFlowWrapper = useRef<HTMLDivElement>(null);

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      dispatch({ type: "NODES_CHANGE", changes: changes as NodeChange<Node<WorkflowNodeData>>[] });
    },
    [dispatch],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      dispatch({ type: "EDGES_CHANGE", changes });
    },
    [dispatch],
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      dispatch({ type: "CONNECT", connection });
    },
    [dispatch],
  );

  const onNodeClick = useCallback(
    (_event: React.MouseEvent, node: Node) => {
      dispatch({ type: "SELECT_NODE", id: node.id });
      const stepInfo = stepStatuses.get(node.id);
      if (
        stepInfo &&
        (stepInfo.status === "completed" || stepInfo.status === "failed") &&
        onNodeExecutionClick
      ) {
        onNodeExecutionClick(node.id);
      }
    },
    [dispatch, stepStatuses, onNodeExecutionClick],
  );

  const onPaneClick = useCallback(() => {
    dispatch({ type: "SELECT_NODE", id: null });
  }, [dispatch]);

  const onMoveEnd = useCallback(
    (_event: MouseEvent | TouchEvent | null, viewport: Viewport) => {
      onViewportChange?.(viewport);
    },
    [onViewportChange],
  );

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();

      const raw = e.dataTransfer.getData("application/workflow-node");
      if (!raw) return;

      let parsed: { type: string; data: WorkflowNodeData };
      try {
        parsed = JSON.parse(raw) as typeof parsed;
      } catch {
        return;
      }

      const wrapper = reactFlowWrapper.current;
      if (!wrapper) return;

      const bounds = wrapper.getBoundingClientRect();
      const position = {
        x: e.clientX - bounds.left - 80,
        y: e.clientY - bounds.top - 30,
      };

      const newNode: Node<WorkflowNodeData> = {
        id: generateId(),
        type: parsed.type,
        position,
        data: parsed.data,
      };

      dispatch({ type: "ADD_NODE", node: newNode });
      dispatch({ type: "SELECT_NODE", id: newNode.id });
    },
    [dispatch],
  );

  const isValidConnection = useCallback<IsValidConnection>(
    (connection: any) => {
      const source = "source" in connection ? connection.source : null;
      const target = "target" in connection ? connection.target : null;
      if (!source || !target) return false;

      // Cannot connect to self
      if (source === target) return false;

      // No duplicate edges
      const duplicate = state.edges.some(
        (e: Edge) => e.source === source && e.target === target,
      );
      if (duplicate) return false;

      // Trigger can only be source (no incoming connections)
      const targetNode = state.nodes.find((n: Node) => n.id === target);
      if (targetNode?.type === "trigger") return false;

      // Output can only be target (no outgoing connections)
      const sourceNode = state.nodes.find((n: Node) => n.id === source);
      if (sourceNode?.type === "output") return false;

      return true;
    },
    [state.edges, state.nodes],
  );

  const styledEdges = deriveEdgeStyles(state.edges, state.nodes, stepStatuses);

  return (
    <div
      ref={reactFlowWrapper}
      className="flex-1 bg-bg"
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <ExecutionStatusProvider stepStatuses={stepStatuses}>
        <ValidationProvider errors={validationErrors}>
        <ReactFlow
          nodes={state.nodes}
          edges={styledEdges}
          nodeTypes={nodeTypes as never}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onNodeClick={onNodeClick}
          onPaneClick={onPaneClick}
          onMoveEnd={onMoveEnd}
          isValidConnection={isValidConnection}
          defaultEdgeOptions={DEFAULT_EDGE_OPTIONS}
          defaultViewport={state.viewport}
          fitView={state.nodes.length === 0}
          deleteKeyCode={null}
          proOptions={{ hideAttribution: true }}
          className="bg-bg"
        >
          <Background variant={BackgroundVariant.Dots} gap={20} size={1} className="opacity-30" />
          <MiniMap
            nodeColor={(node: any) => MINIMAP_COLORS[node.type ?? ""] ?? "#6366f1"}
            maskColor="rgba(0,0,0,0.3)"
            style={{ width: 160, height: 100, right: 16, bottom: 16 }}
            className="!bg-bg-1 !border !border-border !rounded-lg"
          />
          <Controls
            showInteractive={false}
            style={{ left: 16, bottom: 16 }}
            className="!bg-bg-1 !border !border-border !rounded-lg [&>button]:!bg-bg-1 [&>button]:!border-border [&>button]:!fill-foreground [&>button:hover]:!bg-bg-2"
          />
        </ReactFlow>
        </ValidationProvider>
      </ExecutionStatusProvider>
    </div>
  );
}

export function WorkflowCanvas(props: WorkflowCanvasProps) {
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  );
}
