import { useState } from "react";
import { cn } from "../../lib/cn";
import type { AgentDetail } from "./types";
import { Button } from "../../components";
import { useAgentForm } from "./agent-form/useAgentForm";
import { FormModalShell } from "./agent-form/FormModalShell";
import { BasicTab } from "./agent-form/BasicTab";
import { ModelTab } from "./agent-form/ModelTab";
import { ToolsTab } from "./agent-form/ToolsTab";
import { AdvancedTab } from "./agent-form/AdvancedTab";

// Re-exported for existing importers (e.g. views/agents/Agents.tsx).
export { DeleteDialog } from "./DeleteDialog";

const TABS = ["basic", "model", "tools", "advanced"] as const;
type FormTab = (typeof TABS)[number];

/* ===============================================
   Agent Form (shared between Create & Edit)
   =============================================== */
export function AgentFormModal({
  mode,
  initial,
  onDone,
  onCancel,
}: {
  mode: "create" | "edit";
  initial?: AgentDetail;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [formTab, setFormTab] = useState<FormTab>("basic");
  const form = useAgentForm({ mode, initial, onDone });
  const {
    handleSubmit,
    formState: { errors, isSubmitting },
  } = form.form;

  return (
    <FormModalShell onClose={onCancel} labelledBy="agent-form-title">
      <form
        className="flex flex-col h-full max-h-[85vh]"
        onSubmit={handleSubmit(form.onSubmit)}
      >
        {/* Header */}
        <div className="flex justify-between items-start px-6 py-6 border-b border-border shrink-0">
          <div>
            <h3
              id="agent-form-title"
              className="font-heading text-lg font-semibold text-strong m-0 tracking-tight"
            >
              {mode === "create" ? "New Agent" : `Edit ${initial?.name}`}
            </h3>
            <p className="text-sm text-faint mt-0.5 m-0">
              {mode === "create"
                ? "Configure a new AI agent"
                : "Update agent configuration"}
            </p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onCancel}
            aria-label="Close"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            >
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </Button>
        </div>

        {/* Tab Nav */}
        <div className="flex border-b border-border px-6 shrink-0">
          {TABS.map((t) => (
            <button
              key={t}
              type="button"
              className={cn(
                "px-4 py-3 text-sm font-medium capitalize border-b-2 -mb-px transition-colors",
                formTab === t
                  ? "border-accent text-accent"
                  : "border-transparent text-muted hover:text-foreground",
              )}
              onClick={() => setFormTab(t)}
            >
              {t === "tools" ? "Tools & Skills" : t.charAt(0).toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto px-6 py-6 flex flex-col gap-6">
          {(form.apiError || errors.name || errors.id) && (
            <div className="bg-danger-subtle border border-danger/20 rounded-lg px-4 py-2.5 text-danger text-sm animate-[agSlideIn_0.2s_ease-out]">
              {form.apiError || errors.name?.message || errors.id?.message}
            </div>
          )}

          {formTab === "basic" && <BasicTab form={form} />}
          {formTab === "model" && <ModelTab form={form} />}
          {formTab === "tools" && <ToolsTab form={form} />}
          {formTab === "advanced" && <AdvancedTab form={form} />}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-3 px-6 py-5 border-t border-border shrink-0 bg-bg-1">
          <Button type="button" variant="secondary" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" size="sm" loading={isSubmitting}>
            {isSubmitting
              ? mode === "create"
                ? "Creating..."
                : "Saving..."
              : mode === "create"
                ? "Create Agent"
                : "Save Changes"}
          </Button>
        </div>
      </form>
    </FormModalShell>
  );
}
