import React, { useState, useEffect } from "react";
import { Modal } from "../../components";
import { apiFetch } from "../../api";
import type { SavedWorkflow } from "./types";
import type { WorkflowAction } from "./useWorkflowReducer";
import type { WorkflowNodeData } from "./types";
import { Trash2, FolderOpen } from "lucide-react";

interface WorkflowListProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly dispatch: React.Dispatch<WorkflowAction>;
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

export function WorkflowList({ open, onClose, dispatch }: WorkflowListProps) {
  const [workflows, setWorkflows] = useState<SavedWorkflow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [deleting, setDeleting] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setError("");
    apiFetch<{ data: SavedWorkflow[] }>("/api/workflows")
      .then((res) => setWorkflows(res.data))
      .catch(() => setError("Failed to load workflows"))
      .finally(() => setLoading(false));
  }, [open]);

  function handleLoad(wf: SavedWorkflow) {
    dispatch({
      type: "LOAD_WORKFLOW",
      state: {
        id: wf.id,
        name: wf.name,
        description: wf.description,
        nodes: wf.nodes,
        edges: wf.edges,
      },
    });
    onClose();
  }

  async function handleDelete(wf: SavedWorkflow) {
    setDeleting(wf.id);
    try {
      await apiFetch(`/api/workflows/${wf.id}`, { method: "DELETE" });
      setWorkflows((prev) => prev.filter((w) => w.id !== wf.id));
    } catch {
      setError("Failed to delete workflow");
    } finally {
      setDeleting(null);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Saved Workflows">
      {error && (
        <div className="bg-danger-subtle border border-danger/20 rounded-lg px-4 py-3 text-danger text-sm mb-4">
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <span className="w-6 h-6 border-2 border-border-2 border-t-accent rounded-full animate-spin" />
        </div>
      ) : workflows.length === 0 ? (
        <div className="text-center py-12 text-muted">
          <FolderOpen size={32} className="mx-auto mb-3 opacity-40" />
          <p className="text-sm">No saved workflows yet.</p>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {workflows.map((wf) => (
            <div
              key={wf.id}
              className="flex items-center gap-3 px-4 py-3 bg-bg border border-border rounded-lg hover:border-border-hover hover:bg-bg-2 transition-colors group"
            >
              <button
                type="button"
                className="flex-1 text-left bg-transparent border-none cursor-pointer p-0 min-w-0"
                onClick={() => handleLoad(wf)}
              >
                <div className="font-semibold text-sm text-strong truncate">
                  {wf.name}
                </div>
                {wf.description && (
                  <div className="text-xs text-muted truncate mt-0.5">
                    {wf.description}
                  </div>
                )}
                <div className="text-[11px] text-faint mt-1">
                  {formatDate(wf.updatedAt || wf.createdAt)}
                </div>
              </button>
              <button
                type="button"
                disabled={deleting === wf.id}
                onClick={() => handleDelete(wf)}
                className="w-8 h-8 flex items-center justify-center rounded-md border border-transparent text-faint hover:text-danger hover:border-danger/30 hover:bg-danger-subtle transition-colors cursor-pointer bg-transparent shrink-0 disabled:opacity-50"
                aria-label="Delete workflow"
              >
                {deleting === wf.id ? (
                  <span className="w-3.5 h-3.5 border-2 border-current/30 border-t-current rounded-full animate-spin" />
                ) : (
                  <Trash2 size={14} />
                )}
              </button>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}
