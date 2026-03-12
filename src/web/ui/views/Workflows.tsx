import React, { useState, useCallback } from "react";
import "@xyflow/react/dist/style.css";
import { apiFetch } from "../api";
import { Button } from "../components";
import { Save, FolderOpen, Plus } from "lucide-react";
import { useWorkflowReducer } from "./workflows/useWorkflowReducer";
import { NodePalette } from "./workflows/NodePalette";
import { WorkflowCanvas } from "./workflows/WorkflowCanvas";
import { PropertiesPanel } from "./workflows/PropertiesPanel";
import { WorkflowList } from "./workflows/WorkflowList";
import type { Node } from "@xyflow/react";
import type { WorkflowNodeData } from "./workflows/types";

export default function Workflows() {
  const [state, dispatch] = useWorkflowReducer();
  const [showList, setShowList] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");

  const selectedNode = state.selectedNodeId
    ? (state.nodes.find((n) => n.id === state.selectedNodeId) as
        | Node<WorkflowNodeData>
        | undefined)
    : undefined;

  const handleSave = useCallback(async () => {
    setSaving(true);
    setSaveError("");
    try {
      const payload = {
        name: state.name,
        description: state.description,
        nodes: state.nodes,
        edges: state.edges,
      };

      if (state.id) {
        await apiFetch(`/api/workflows/${state.id}`, {
          method: "PUT",
          body: JSON.stringify(payload),
        });
        dispatch({ type: "MARK_SAVED", id: state.id });
      } else {
        const res = await apiFetch<{ data: { id: string } }>("/api/workflows", {
          method: "POST",
          body: JSON.stringify(payload),
        });
        dispatch({ type: "MARK_SAVED", id: res.data.id });
      }
    } catch {
      setSaveError("Failed to save workflow");
    } finally {
      setSaving(false);
    }
  }, [state, dispatch]);

  function handleNew() {
    dispatch({ type: "NEW_WORKFLOW" });
  }

  return (
    <div className="flex flex-col h-[calc(100vh-56px)] max-md:h-[calc(100vh-108px)] -mx-8 -my-7 max-lg:-mx-6 max-lg:-my-6 max-md:-mx-4 max-md:-my-5">
      {/* Top bar */}
      <div className="flex items-center gap-3 px-4 py-3 bg-bg-1 border-b border-border shrink-0">
        <div className="flex items-center gap-1.5 mr-2">
          <span
            className={`w-2 h-2 rounded-full ${state.isDirty ? "bg-yellow-400" : "bg-green-400"}`}
            title={state.isDirty ? "Unsaved changes" : "Saved"}
          />
        </div>

        <input
          type="text"
          value={state.name}
          onChange={(e) =>
            dispatch({ type: "SET_NAME", name: e.target.value })
          }
          className="flex-1 max-w-[260px] px-3 py-1.5 bg-bg border border-border-2 rounded-md text-sm font-semibold text-strong outline-none focus:border-accent transition-colors"
          placeholder="Workflow name..."
        />

        <input
          type="text"
          value={state.description}
          onChange={(e) =>
            dispatch({ type: "SET_DESCRIPTION", description: e.target.value })
          }
          className="flex-1 max-w-[360px] max-lg:hidden px-3 py-1.5 bg-bg border border-border-2 rounded-md text-sm text-muted outline-none focus:border-accent transition-colors"
          placeholder="Description (optional)..."
        />

        <div className="ml-auto flex items-center gap-2">
          {saveError && (
            <span className="text-xs text-danger">{saveError}</span>
          )}
          <Button variant="ghost" size="sm" onClick={handleNew}>
            <Plus size={14} />
            New
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setShowList(true)}
          >
            <FolderOpen size={14} />
            Load
          </Button>
          <Button
            variant="primary"
            size="sm"
            loading={saving}
            onClick={handleSave}
          >
            <Save size={14} />
            Save
          </Button>
        </div>
      </div>

      {/* Main area */}
      <div className="flex flex-1 min-h-0">
        <NodePalette />

        <WorkflowCanvas state={state} dispatch={dispatch} />

        {selectedNode && (
          <PropertiesPanel node={selectedNode} dispatch={dispatch} />
        )}
      </div>

      <WorkflowList
        open={showList}
        onClose={() => setShowList(false)}
        dispatch={dispatch}
      />
    </div>
  );
}
