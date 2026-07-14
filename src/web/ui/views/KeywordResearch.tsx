/**
 * KeywordResearch — standalone page (moved out of App Store) showing App
 * Store keyword opportunities, with a button that kicks off the
 * `mobile-app-ideas` ideas pipeline seeded from those keywords.
 */

import { useCallback, useState } from "react";
import { Search, ArrowRight } from "lucide-react";
import { apiFetch } from "../api";
import { PageHeader, Button, FilterTabs } from "../components";
import { useToast } from "../components/Toast";
import type { Tab } from "../navigation";
import ConceptsTab from "./appstore/ConceptsTab";
import OpportunitiesTab from "./appstore/OpportunitiesTab";

// ─── Props ───────────────────────────────────────────────────────────────────

interface KeywordResearchProps {
  readonly navigateTo?: (tab: Tab) => void;
}

// ─── Run pipeline response ──────────────────────────────────────────────────

interface RunPipelineResponse {
  readonly success: boolean;
  readonly message?: string;
  readonly runId?: string;
  readonly error?: string;
}

const IDEAS_PIPELINE_ID = "mobile-app-ideas";

// ─── View toggle (Keywords table vs. Concepts clusters) ─────────────────────

type ResearchView = "keywords" | "concepts";

const VIEW_TABS: ReadonlyArray<{ readonly id: ResearchView; readonly label: string }> = [
  { id: "keywords", label: "Keywords" },
  { id: "concepts", label: "Concepts" },
];

// ─── KeywordResearch (main) ────────────────────────────────────────────────

export default function KeywordResearch({ navigateTo }: KeywordResearchProps) {
  const toast = useToast();
  const [generating, setGenerating] = useState(false);
  const [lastRunId, setLastRunId] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  // Defaults to the existing Keywords table — Concepts is opt-in.
  const [view, setView] = useState<ResearchView>("keywords");

  const handleGenerateIdeas = useCallback(async () => {
    setGenerating(true);
    setRunError(null);
    try {
      const res = await apiFetch<RunPipelineResponse>(
        `/api/pipelines/${IDEAS_PIPELINE_ID}/run`,
        { method: "POST" },
      );
      if (res.success && res.runId) {
        setLastRunId(res.runId);
        toast.success(`Idea generation started (run ${res.runId})`);
      } else {
        const message = res.error ?? "Failed to start idea generation";
        setRunError(message);
        toast.error(message);
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to start idea generation";
      setRunError(message);
      toast.error(message);
    } finally {
      setGenerating(false);
    }
  }, [toast]);

  return (
    <div>
      <PageHeader
        title="Keyword Research"
        subtitle="App Store keyword opportunities — feed the strongest ones into the ideas pipeline."
        actions={
          <Button size="sm" onClick={handleGenerateIdeas} disabled={generating}>
            <Search size={14} />
            {generating ? "Starting…" : "Generate ideas from these keywords"}
          </Button>
        }
      />

      {lastRunId && (
        <div className="flex items-center gap-2 mb-4 px-4 py-3 rounded-lg border border-success/20 bg-success-subtle text-sm text-success">
          <span>
            Idea generation started — run <span className="font-mono">{lastRunId}</span>.
          </span>
          {navigateTo && (
            <button
              type="button"
              onClick={() => navigateTo("pipeline-ideas")}
              className="ml-auto inline-flex items-center gap-1 font-medium underline decoration-dotted underline-offset-2 cursor-pointer bg-transparent border-none text-success hover:text-success/80"
            >
              View Pipeline Ideas
              <ArrowRight size={13} />
            </button>
          )}
        </div>
      )}

      {runError && (
        <div className="mb-4 px-4 py-3 rounded-lg border border-danger/20 bg-danger-subtle text-sm text-danger">
          {runError}
        </div>
      )}

      <FilterTabs
        tabs={VIEW_TABS}
        active={view}
        onChange={(id) => setView(id as ResearchView)}
      />

      {view === "keywords" ? <OpportunitiesTab /> : <ConceptsTab />}
    </div>
  );
}
