import { useReducer } from "react";
import {
  applyNodeChanges,
  applyEdgeChanges,
  addEdge,
} from "@xyflow/react";
import type { Node, Edge, NodeChange, EdgeChange, Connection } from "@xyflow/react";
import type { WorkflowNodeData } from "./types";

export interface WorkflowViewport {
  readonly x: number;
  readonly y: number;
  readonly zoom: number;
}

export interface WorkflowState {
  readonly id: string | null;
  readonly name: string;
  readonly description: string;
  readonly enabled: boolean;
  readonly nodes: Node<WorkflowNodeData>[];
  readonly edges: Edge[];
  readonly viewport: WorkflowViewport;
  readonly selectedNodeId: string | null;
  readonly isDirty: boolean;
}

interface HistoryState {
  readonly present: WorkflowState;
  readonly past: readonly WorkflowState[];
  readonly future: readonly WorkflowState[];
}

export type WorkflowAction =
  | { type: "ADD_NODE"; node: Node<WorkflowNodeData> }
  | { type: "REMOVE_NODES"; ids: string[] }
  | { type: "UPDATE_NODE_DATA"; id: string; data: Partial<WorkflowNodeData> }
  | { type: "NODES_CHANGE"; changes: NodeChange<Node<WorkflowNodeData>>[] }
  | { type: "EDGES_CHANGE"; changes: EdgeChange[] }
  | { type: "CONNECT"; connection: Connection }
  | { type: "SELECT_NODE"; id: string | null }
  | { type: "SET_NAME"; name: string }
  | { type: "SET_DESCRIPTION"; description: string }
  | { type: "SET_ENABLED"; enabled: boolean }
  | { type: "LOAD_WORKFLOW"; state: Omit<WorkflowState, "isDirty" | "selectedNodeId"> }
  | { type: "SET_VIEWPORT"; viewport: WorkflowViewport }
  | { type: "MARK_SAVED"; id: string }
  | { type: "MARK_DIRTY" }
  | { type: "NEW_WORKFLOW" }
  | { type: "UNDO" }
  | { type: "REDO" };

const HISTORY_LIMIT = 50;

const initialWorkflowState: WorkflowState = {
  id: null,
  name: "Untitled Workflow",
  description: "",
  enabled: false,
  nodes: [],
  edges: [],
  viewport: { x: 0, y: 0, zoom: 1 },
  selectedNodeId: null,
  isDirty: false,
};

const initialHistoryState: HistoryState = {
  present: initialWorkflowState,
  past: [],
  future: [],
};

function pushHistory(history: HistoryState, next: WorkflowState): HistoryState {
  const past = [...history.past, history.present].slice(-HISTORY_LIMIT);
  return { present: next, past, future: [] };
}

function hasPositionChange(changes: NodeChange[]): boolean {
  return changes.some((c) => c.type === "position");
}

function historyReducer(
  history: HistoryState,
  action: WorkflowAction,
): HistoryState {
  const { present } = history;

  switch (action.type) {
    case "ADD_NODE": {
      const next: WorkflowState = {
        ...present,
        nodes: [...present.nodes, action.node],
        isDirty: true,
      };
      return pushHistory(history, next);
    }

    case "REMOVE_NODES": {
      const idSet = new Set(action.ids);
      const next: WorkflowState = {
        ...present,
        nodes: present.nodes.filter((n) => !idSet.has(n.id)),
        edges: present.edges.filter(
          (e) => !idSet.has(e.source) && !idSet.has(e.target),
        ),
        selectedNodeId:
          present.selectedNodeId && idSet.has(present.selectedNodeId)
            ? null
            : present.selectedNodeId,
        isDirty: true,
      };
      return pushHistory(history, next);
    }

    case "UPDATE_NODE_DATA": {
      const next: WorkflowState = {
        ...present,
        nodes: present.nodes.map((n) =>
          n.id === action.id
            ? { ...n, data: { ...n.data, ...action.data } as WorkflowNodeData }
            : n,
        ),
        isDirty: true,
      };
      return pushHistory(history, next);
    }

    case "NODES_CHANGE": {
      const isPositionChange = hasPositionChange(action.changes as NodeChange[]);
      const next: WorkflowState = {
        ...present,
        nodes: applyNodeChanges(action.changes as NodeChange[], present.nodes) as Node<WorkflowNodeData>[],
        isDirty: true,
      };
      return isPositionChange ? pushHistory(history, next) : { ...history, present: next };
    }

    case "EDGES_CHANGE": {
      const next: WorkflowState = {
        ...present,
        edges: applyEdgeChanges(action.changes, present.edges),
        isDirty: true,
      };
      return pushHistory(history, next);
    }

    case "CONNECT": {
      const next: WorkflowState = {
        ...present,
        edges: addEdge(action.connection, present.edges),
        isDirty: true,
      };
      return pushHistory(history, next);
    }

    // Ephemeral — no history
    case "SELECT_NODE":
      return { ...history, present: { ...present, selectedNodeId: action.id } };

    case "SET_NAME":
      return { ...history, present: { ...present, name: action.name, isDirty: true } };

    case "SET_DESCRIPTION":
      return { ...history, present: { ...present, description: action.description, isDirty: true } };

    case "SET_ENABLED":
      return { ...history, present: { ...present, enabled: action.enabled, isDirty: true } };

    // Ephemeral — no history (viewport pan/zoom should not pollute undo stack)
    case "SET_VIEWPORT":
      return { ...history, present: { ...present, viewport: action.viewport } };

    case "LOAD_WORKFLOW":
      return {
        present: {
          ...action.state,
          viewport: action.state.viewport ?? { x: 0, y: 0, zoom: 1 },
          selectedNodeId: null,
          isDirty: false,
        },
        past: [],
        future: [],
      };

    // Ephemeral — no history
    case "MARK_SAVED":
      return { ...history, present: { ...present, id: action.id, isDirty: false } };

    case "MARK_DIRTY":
      return { ...history, present: { ...present, isDirty: true } };

    case "NEW_WORKFLOW":
      return { present: { ...initialWorkflowState }, past: [], future: [] };

    case "UNDO": {
      if (history.past.length === 0) return history;
      const prev = history.past[history.past.length - 1]!;
      return {
        present: prev,
        past: history.past.slice(0, -1),
        future: [present, ...history.future].slice(0, HISTORY_LIMIT),
      };
    }

    case "REDO": {
      if (history.future.length === 0) return history;
      const next = history.future[0]!;
      return {
        present: next,
        past: [...history.past, present].slice(-HISTORY_LIMIT),
        future: history.future.slice(1),
      };
    }

    default:
      return history;
  }
}

export interface WorkflowReducerReturn {
  readonly state: WorkflowState;
  readonly dispatch: React.Dispatch<WorkflowAction>;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
}

export function useWorkflowReducer(): WorkflowReducerReturn {
  const [history, dispatch] = useReducer(historyReducer, initialHistoryState);
  return {
    state: history.present,
    dispatch,
    canUndo: history.past.length > 0,
    canRedo: history.future.length > 0,
  };
}
