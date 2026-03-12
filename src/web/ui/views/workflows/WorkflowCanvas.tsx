import React, { useCallback, useRef } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  MiniMap,
  Controls,
  BackgroundVariant,
} from "@xyflow/react";
import type { NodeChange, EdgeChange, Connection, Node } from "@xyflow/react";
import { nodeTypes } from "./nodes";
import type { WorkflowState, WorkflowAction } from "./useWorkflowReducer";
import type { WorkflowNodeData } from "./types";

interface WorkflowCanvasProps {
  readonly state: WorkflowState;
  readonly dispatch: React.Dispatch<WorkflowAction>;
}

function generateId(): string {
  return `node-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function CanvasInner({ state, dispatch }: WorkflowCanvasProps) {
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
    },
    [dispatch],
  );

  const onPaneClick = useCallback(() => {
    dispatch({ type: "SELECT_NODE", id: null });
  }, [dispatch]);

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

  return (
    <div
      ref={reactFlowWrapper}
      className="flex-1 bg-bg"
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <ReactFlow
        nodes={state.nodes}
        edges={state.edges}
        nodeTypes={nodeTypes as never}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeClick={onNodeClick}
        onPaneClick={onPaneClick}
        fitView
        deleteKeyCode="Delete"
        className="bg-bg"
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} className="opacity-30" />
        <MiniMap
          nodeColor={() => "#6366f1"}
          maskColor="rgba(0,0,0,0.3)"
          className="!bg-bg-1 !border !border-border rounded-lg overflow-hidden"
        />
        <Controls className="!bg-bg-1 !border !border-border rounded-lg overflow-hidden [&>button]:!bg-bg-1 [&>button]:!border-border [&>button]:!text-foreground [&>button:hover]:!bg-bg-2" />
      </ReactFlow>
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

