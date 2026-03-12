import { useReducer } from "react";
import {
  applyNodeChanges,
  applyEdgeChanges,
  addEdge,
} from "@xyflow/react";
import type { Node, Edge, NodeChange, EdgeChange, Connection } from "@xyflow/react";
import type { WorkflowNodeData } from "./types";

export interface WorkflowState {
  readonly id: string | null;
  readonly name: string;
  readonly description: string;
  readonly nodes: Node<WorkflowNodeData>[];
  readonly edges: Edge[];
  readonly selectedNodeId: string | null;
  readonly isDirty: boolean;
}

type WorkflowAction =
  | { type: "ADD_NODE"; node: Node<WorkflowNodeData> }
  | { type: "REMOVE_NODES"; ids: string[] }
  | { type: "UPDATE_NODE_DATA"; id: string; data: Partial<WorkflowNodeData> }
  | { type: "NODES_CHANGE"; changes: NodeChange<Node<WorkflowNodeData>>[] }
  | { type: "EDGES_CHANGE"; changes: EdgeChange[] }
  | { type: "CONNECT"; connection: Connection }
  | { type: "SELECT_NODE"; id: string | null }
  | { type: "SET_NAME"; name: string }
  | { type: "SET_DESCRIPTION"; description: string }
  | { type: "LOAD_WORKFLOW"; state: Omit<WorkflowState, "isDirty" | "selectedNodeId"> }
  | { type: "MARK_SAVED"; id: string }
  | { type: "MARK_DIRTY" }
  | { type: "NEW_WORKFLOW" };

const initialState: WorkflowState = {
  id: null,
  name: "Untitled Workflow",
  description: "",
  nodes: [],
  edges: [],
  selectedNodeId: null,
  isDirty: false,
};

function workflowReducer(
  state: WorkflowState,
  action: WorkflowAction,
): WorkflowState {
  switch (action.type) {
    case "ADD_NODE":
      return {
        ...state,
        nodes: [...state.nodes, action.node],
        isDirty: true,
      };

    case "REMOVE_NODES": {
      const idSet = new Set(action.ids);
      return {
        ...state,
        nodes: state.nodes.filter((n) => !idSet.has(n.id)),
        edges: state.edges.filter(
          (e) => !idSet.has(e.source) && !idSet.has(e.target),
        ),
        selectedNodeId:
          state.selectedNodeId && idSet.has(state.selectedNodeId)
            ? null
            : state.selectedNodeId,
        isDirty: true,
      };
    }

    case "UPDATE_NODE_DATA":
      return {
        ...state,
        nodes: state.nodes.map((n) =>
          n.id === action.id
            ? { ...n, data: { ...n.data, ...action.data } as WorkflowNodeData }
            : n,
        ),
        isDirty: true,
      };

    case "NODES_CHANGE":
      return {
        ...state,
        nodes: applyNodeChanges(action.changes as NodeChange[], state.nodes) as Node<WorkflowNodeData>[],
        isDirty: true,
      };

    case "EDGES_CHANGE":
      return {
        ...state,
        edges: applyEdgeChanges(action.changes, state.edges),
        isDirty: true,
      };

    case "CONNECT":
      return {
        ...state,
        edges: addEdge(action.connection, state.edges),
        isDirty: true,
      };

    case "SELECT_NODE":
      return { ...state, selectedNodeId: action.id };

    case "SET_NAME":
      return { ...state, name: action.name, isDirty: true };

    case "SET_DESCRIPTION":
      return { ...state, description: action.description, isDirty: true };

    case "LOAD_WORKFLOW":
      return {
        ...action.state,
        selectedNodeId: null,
        isDirty: false,
      };

    case "MARK_SAVED":
      return { ...state, id: action.id, isDirty: false };

    case "MARK_DIRTY":
      return { ...state, isDirty: true };

    case "NEW_WORKFLOW":
      return { ...initialState };

    default:
      return state;
  }
}

export function useWorkflowReducer() {
  return useReducer(workflowReducer, initialState);
}

export type { WorkflowAction };
