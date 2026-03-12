import React, { useState, useCallback, useEffect, useRef } from "react";
import "@xyflow/react/dist/style.css";
import { z } from "zod";
import { apiFetch } from "../api";
import { Button } from "../components";
import { Save, FolderOpen, Plus, Undo2, Redo2, Download, Upload, AlertCircle } from "lucide-react";
import { useWorkflowReducer } from "./workflows/useWorkflowReducer";
import { useKeyboardShortcuts } from "./workflows/useKeyboardShortcuts";
import { validateWorkflowGraph } from "./workflows/validation-ui";
import { NodePalette } from "./workflows/NodePalette";
import { WorkflowCanvas } from "./workflows/WorkflowCanvas";
import { PropertiesPanel } from "./workflows/PropertiesPanel";
import { WorkflowList } from "./workflows/WorkflowList";
import { RunControls } from "./workflows/RunControls";
import { ExecutionHistory } from "./workflows/ExecutionHistory";
import { StepOutputPreview } from "./workflows/StepOutputPreview";
import { useExecutionStream } from "./workflows/useExecutionStream";
import type { Node, Edge } from "@xyflow/react";
import type { WorkflowNodeData, ExecutionStepMap } from "./workflows/types";

const importSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional().default(""),
  nodes: z.array(z.unknown()).default([]),
  edges: z.array(z.unknown()).default([]),
});

export default function Workflows() {
  const { state, dispatch, canUndo, canRedo } = useWorkflowReducer();
  const [showList, setShowList] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [validationErrors, setValidationErrors] = useState<ReadonlyMap<string, readonly string[]>>(new Map());
  const [activeExecutionId, setActiveExecutionId] = useState<string | null>(null);
  const [historyStepStatuses, setHistoryStepStatuses] = useState<ExecutionStepMap | null>(null);
  const [previewNodeId, setPreviewNodeId] = useState<string | null>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const validationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { stepStatuses: liveStepStatuses, executionStatus } = useExecutionStream(activeExecutionId);

  // History overrides live statuses when user clicks a past execution
  const stepStatuses: ExecutionStepMap = historyStepStatuses ?? liveStepStatuses;

  const handleLoadHistoryExecution = useCallback((statuses: ExecutionStepMap) => {
    setHistoryStepStatuses(statuses);
    setActiveExecutionId(null);
  }, []);

  const handleExecutionStart = useCallback((executionId: string) => {
    setHistoryStepStatuses(null);
    setActiveExecutionId(executionId);
  }, []);

  const selectedNode = state.selectedNodeId
    ? (state.nodes.find((n) => n.id === state.selectedNodeId) as
        | Node<WorkflowNodeData>
        | undefined)
    : undefined;

  // Debounced validation
  useEffect(() => {
    if (validationTimerRef.current) clearTimeout(validationTimerRef.current);
    validationTimerRef.current = setTimeout(() => {
      setValidationErrors(validateWorkflowGraph(state.nodes, state.edges));
    }, 500);
    return () => {
      if (validationTimerRef.current) clearTimeout(validationTimerRef.current);
    };
  }, [state.nodes, state.edges]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setSaveError("");
    try {
      const payload = {
        name: state.name,
        description: state.description,
        enabled: state.enabled,
        nodes: state.nodes,
        edges: state.edges,
        viewport: state.viewport,
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

  useKeyboardShortcuts({
    dispatch,
    onSave: handleSave,
    selectedNodeId: state.selectedNodeId,
  });

  function handleNew() {
    dispatch({ type: "NEW_WORKFLOW" });
  }

  function handleExport() {
    const payload = {
      name: state.name,
      description: state.description,
      nodes: state.nodes,
      edges: state.edges,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${state.name.replace(/[^a-z0-9]/gi, "-").toLowerCase()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function handleImportClick() {
    importRef.current?.click();
  }

  function handleImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const raw = JSON.parse(ev.target?.result as string);
        const parsed = importSchema.parse(raw);
        dispatch({
          type: "LOAD_WORKFLOW",
          state: {
            id: null,
            name: parsed.name,
            description: parsed.description,
            enabled: false,
            nodes: parsed.nodes as Node<WorkflowNodeData>[],
            edges: parsed.edges as Edge[],
            viewport: { x: 0, y: 0, zoom: 1 },
          },
        });
      } catch {
        setSaveError("Invalid workflow JSON file");
      }
    };
    reader.readAsText(file);
    // Reset so same file can be re-imported
    e.target.value = "";
  }

  const totalErrors = Array.from(validationErrors.values()).reduce(
    (sum, errs) => sum + errs.length,
    0,
  );

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

          {totalErrors > 0 && (
            <span className="flex items-center gap-1 text-xs text-orange-400 font-medium">
              <AlertCircle size={13} />
              {totalErrors} error{totalErrors !== 1 ? "s" : ""}
            </span>
          )}

          <div className="flex items-center gap-1">
            <button
              type="button"
              disabled={!canUndo}
              onClick={() => dispatch({ type: "UNDO" })}
              title="Undo (Cmd+Z)"
              className="w-7 h-7 flex items-center justify-center rounded text-muted hover:text-foreground hover:bg-bg-2 transition-colors disabled:opacity-30 disabled:cursor-not-allowed bg-transparent border-none cursor-pointer"
            >
              <Undo2 size={14} />
            </button>
            <button
              type="button"
              disabled={!canRedo}
              onClick={() => dispatch({ type: "REDO" })}
              title="Redo (Cmd+Shift+Z)"
              className="w-7 h-7 flex items-center justify-center rounded text-muted hover:text-foreground hover:bg-bg-2 transition-colors disabled:opacity-30 disabled:cursor-not-allowed bg-transparent border-none cursor-pointer"
            >
              <Redo2 size={14} />
            </button>
          </div>

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
          <Button variant="ghost" size="sm" onClick={handleImportClick}>
            <Upload size={14} />
            Import
          </Button>
          <Button variant="ghost" size="sm" onClick={handleExport}>
            <Download size={14} />
            Export
          </Button>
          <button
            type="button"
            onClick={() => dispatch({ type: "SET_ENABLED", enabled: !state.enabled })}
            title={state.enabled ? "Click to disable workflow trigger" : "Click to enable workflow trigger"}
            className={`px-3 py-1.5 text-xs font-semibold rounded-md border transition-colors cursor-pointer ${state.enabled ? "bg-green-500/15 border-green-500/40 text-green-500 hover:bg-green-500/25" : "bg-bg border-border-2 text-muted hover:text-foreground hover:border-border-hover"}`}
          >
            {state.enabled ? "Enabled" : "Disabled"}
          </button>
          <Button
            variant="primary"
            size="sm"
            loading={saving}
            onClick={handleSave}
          >
            <Save size={14} />
            Save
          </Button>
          <RunControls
            workflowId={state.id}
            isDirty={state.isDirty}
            executionStatus={executionStatus}
            stepStatuses={stepStatuses}
            onExecutionStart={handleExecutionStart}
          />
        </div>
      </div>

      {/* Main area */}
      <div className="flex flex-1 min-h-0">
        <NodePalette />

        <div className="flex flex-col flex-1 min-w-0 relative">
          <WorkflowCanvas
            state={state}
            dispatch={dispatch}
            validationErrors={validationErrors}
            stepStatuses={stepStatuses}
            onNodeExecutionClick={setPreviewNodeId}
            onViewportChange={(viewport) => dispatch({ type: "SET_VIEWPORT", viewport })}
          />

          <ExecutionHistory
            workflowId={state.id}
            onLoadExecution={handleLoadHistoryExecution}
          />

          {previewNodeId && (
            <StepOutputPreview
              nodeId={previewNodeId}
              step={stepStatuses.get(previewNodeId) ?? null}
              onClose={() => setPreviewNodeId(null)}
            />
          )}
        </div>

        {selectedNode && (
          <PropertiesPanel node={selectedNode} dispatch={dispatch} />
        )}
      </div>

      <input
        ref={importRef}
        type="file"
        accept=".json,application/json"
        className="hidden"
        onChange={handleImportFile}
      />

      <WorkflowList
        open={showList}
        onClose={() => setShowList(false)}
        dispatch={dispatch}
      />
    </div>
  );
}
