import React, { useCallback } from "react";
import { X, AlertCircle } from "lucide-react";
import { cn } from "../../lib/cn";
import type { StepInfo } from "./types";

interface StepOutputPreviewProps {
  readonly step: StepInfo | null;
  readonly nodeId: string | null;
  readonly onClose: () => void;
}

function formatOutput(output: unknown): string {
  if (output === null || output === undefined) return "null";
  if (typeof output === "string") {
    try {
      const parsed = JSON.parse(output);
      return JSON.stringify(parsed, null, 2);
    } catch {
      return output;
    }
  }
  return JSON.stringify(output, null, 2);
}

export function StepOutputPreview({ step, nodeId, onClose }: StepOutputPreviewProps) {
  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) onClose();
    },
    [onClose],
  );

  if (!step || !nodeId) return null;

  const isFailed = step.status === "failed";

  return (
    <div
      className="absolute inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={handleBackdropClick}
    >
      <div className="bg-bg-1 border border-border-2 rounded-xl shadow-2xl w-full max-w-lg mx-4 flex flex-col max-h-[80vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <div className="flex items-center gap-2">
            {isFailed && <AlertCircle size={14} className="text-danger shrink-0" />}
            <span className="text-sm font-semibold text-strong truncate">
              {isFailed ? "Step Failed" : "Step Output"}
            </span>
            <span className="text-xs text-muted font-mono truncate max-w-[200px]">{nodeId}</span>
          </div>
          <button
            onClick={onClose}
            className={cn(
              "w-6 h-6 flex items-center justify-center rounded text-muted",
              "hover:text-foreground hover:bg-bg-2 transition-colors cursor-pointer",
            )}
          >
            <X size={14} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-4 min-h-0">
          {isFailed && step.error && (
            <div className="mb-3 p-3 rounded-lg bg-danger-subtle border border-danger/20">
              <p className="text-xs text-danger font-medium mb-1">Error</p>
              <p className="text-xs text-danger/80 font-mono break-words">{step.error}</p>
            </div>
          )}

          {!isFailed && (
            <div>
              <p className="text-xs text-muted font-medium mb-2 uppercase tracking-wide">Output</p>
              <pre className="text-xs font-mono text-foreground bg-bg rounded-lg p-3 overflow-x-auto whitespace-pre-wrap break-words border border-border">
                {formatOutput(step.output)}
              </pre>
            </div>
          )}

          {isFailed && step.output !== undefined && step.output !== null && (
            <div className="mt-3">
              <p className="text-xs text-muted font-medium mb-2 uppercase tracking-wide">Output (partial)</p>
              <pre className="text-xs font-mono text-foreground bg-bg rounded-lg p-3 overflow-x-auto whitespace-pre-wrap break-words border border-border">
                {formatOutput(step.output)}
              </pre>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
