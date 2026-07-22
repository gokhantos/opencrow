/**
 * KeywordResearch — standalone page (moved out of App Store) showing App
 * Store keyword opportunities, with a button that kicks off the
 * `mobile-app-ideas` ideas pipeline seeded from those keywords.
 */

import { useCallback, useEffect, useState } from "react";
import { Search, ArrowRight } from "lucide-react";
import { apiFetch } from "../api";
import { PageHeader, Button, FilterTabs } from "../components";
import { useToast } from "../components/Toast";
import type { Tab } from "../navigation";
import ConceptsTab from "./appstore/ConceptsTab";
import OpportunitiesTab, { loadWatchlist } from "./appstore/OpportunitiesTab";
import ScreenerTab from "./appstore/ScreenerTab";

// Same custom event `OpportunitiesTab.tsx`'s `saveWatchlist` dispatches on
// every star/unstar — keeps this button's live count in sync without lifting
// watchlist state up through the tab switcher.
const WATCHLIST_CHANGED_EVENT = "opencrow:appstore-watchlist-changed";

// Mirrors `pipelines.ts`'s `MAX_SEED_KEYWORDS` route-side cap — trimmed here
// too so the button label and the actual POST body never disagree about how
// many keywords will really be threaded through.
const MAX_SEED_KEYWORDS = 25;

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

// ─── View toggle (Keywords table vs. Concepts clusters vs. Screener hits) ───

type ResearchView = "keywords" | "concepts" | "screener";

const VIEW_TABS: ReadonlyArray<{ readonly id: ResearchView; readonly label: string }> = [
  { id: "keywords", label: "Keywords" },
  { id: "concepts", label: "Concepts" },
  { id: "screener", label: "Screener" },
];

// ─── KeywordResearch (main) ────────────────────────────────────────────────

export default function KeywordResearch({ navigateTo }: KeywordResearchProps) {
  const toast = useToast();
  const [generating, setGenerating] = useState(false);
  const [lastRunId, setLastRunId] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  // Defaults to the existing Keywords table — Concepts is opt-in.
  const [view, setView] = useState<ResearchView>("keywords");

  // Starred-watchlist count for the button label — read from the same
  // localStorage `OpportunitiesTab.tsx` owns, kept live via its
  // WATCHLIST_CHANGED_EVENT (same-tab; the native `storage` event only fires
  // in OTHER tabs).
  const [watchlistCount, setWatchlistCount] = useState<number>(() => loadWatchlist().size);
  useEffect(() => {
    const refresh = () => setWatchlistCount(loadWatchlist().size);
    window.addEventListener(WATCHLIST_CHANGED_EVENT, refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener(WATCHLIST_CHANGED_EVENT, refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);

  const handleGenerateIdeas = useCallback(async () => {
    setGenerating(true);
    setRunError(null);
    try {
      // Thread the starred watchlist through as a PRIORITY seed allowlist
      // (see `collector-keyword-gaps.ts`'s `selectPriorityGapSeeds`) so a
      // click on this button actually reaches the keywords the user picked,
      // instead of the pipeline silently re-seeding from its own
      // auto-selected top-opportunity query.
      const seedKeywords = Array.from(loadWatchlist()).slice(0, MAX_SEED_KEYWORDS);
      const res = await apiFetch<RunPipelineResponse>(
        `/api/pipelines/${IDEAS_PIPELINE_ID}/run`,
        {
          method: "POST",
          body: JSON.stringify(seedKeywords.length > 0 ? { seedKeywords } : {}),
        },
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
            {generating
              ? "Starting…"
              : watchlistCount > 0
                ? `Generate ideas from ${watchlistCount} starred keyword${watchlistCount === 1 ? "" : "s"}`
                : "Generate ideas from these keywords"}
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

      {view === "keywords" && <OpportunitiesTab />}
      {view === "concepts" && <ConceptsTab />}
      {view === "screener" && <ScreenerTab />}
    </div>
  );
}
