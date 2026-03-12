import { useEffect } from "react";
import type { Dispatch } from "react";
import type { WorkflowAction } from "./useWorkflowReducer";

interface UseKeyboardShortcutsParams {
  readonly dispatch: Dispatch<WorkflowAction>;
  readonly onSave: () => void;
  readonly selectedNodeId: string | null;
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || target.isContentEditable;
}

export function useKeyboardShortcuts({
  dispatch,
  onSave,
  selectedNodeId,
}: UseKeyboardShortcutsParams): void {
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent): void {
      const meta = e.metaKey || e.ctrlKey;

      if (meta && e.key === "z" && !e.shiftKey) {
        e.preventDefault();
        dispatch({ type: "UNDO" });
        return;
      }

      if ((meta && e.shiftKey && e.key === "z") || (meta && e.key === "y")) {
        e.preventDefault();
        dispatch({ type: "REDO" });
        return;
      }

      if (meta && e.key === "s") {
        e.preventDefault();
        onSave();
        return;
      }

      if ((e.key === "Delete" || e.key === "Backspace") && !isEditableTarget(e.target)) {
        if (selectedNodeId) {
          dispatch({ type: "REMOVE_NODES", ids: [selectedNodeId] });
        }
        return;
      }

      if (e.key === "Escape") {
        dispatch({ type: "SELECT_NODE", id: null });
        return;
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [dispatch, onSave, selectedNodeId]);
}
