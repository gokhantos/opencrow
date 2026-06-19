/**
 * IdeaCard — collapsible card for a single AggregatedIdea in the SIGE Ideas
 * aggregation list. Inline-expands on click to show full description, incentive
 * breakdown, and run metadata.
 */

import { useState } from "react";
import { ChevronDown, ChevronUp, ExternalLink } from "lucide-react";
import { StatusBadge } from "../../components";
import { cn } from "../../lib/cn";
import { breakdownEntries } from "../sige/shared/IdeaRow";
import type { AggregatedIdea, RoundType } from "./types";
import type { Tab } from "../../navigation";

// ─── Constants ────────────────────────────────────────────────────────────────

const ROUND_TYPE_LABELS: Record<RoundType, string> = {
  divergent_generation: "Divergent",
  strategic_interaction: "Strategic",
  evolutionary_tournament: "Evolutionary",
  equilibrium_analysis: "Equilibrium",
};

const SIGE_STATUS_COLOR_MAP: Readonly<Record<string, string>> = {
  completed: "green",
  failed: "red",
  cancelled: "red",
  pending: "gray",
  knowledge_construction: "blue",
  game_formulation: "blue",
  expert_game: "yellow",
  social_simulation: "yellow",
  scoring: "yellow",
  report_generation: "blue",
};

// ─── ScoreBar (adapted from IdeaRow for nullable social score) ────────────────

interface MiniScoreBarProps {
  readonly expertScore: number;
  readonly socialScore: number | null;
  readonly primaryScore: number;
}

function MiniScoreBar({ expertScore, socialScore, primaryScore }: MiniScoreBarProps) {
  const expertPct = Math.round(Math.min(Math.max(expertScore, 0), 1) * 100);
  const socialPct = socialScore !== null
    ? Math.round(Math.min(Math.max(socialScore, 0), 1) * 100)
    : 0;

  return (
    <div className="flex items-center gap-2">
      <div className="w-20 flex gap-0.5 h-1.5 rounded-full overflow-hidden bg-bg-2 shrink-0">
        <div
          className="bg-accent rounded-l-full transition-all"
          style={{ width: `${expertPct}%` }}
          title={`Expert: ${expertPct}%`}
        />
        {socialPct > 0 && (
          <div
            className="bg-warning rounded-r-full transition-all"
            style={{ width: `${socialPct}%` }}
            title={`Social: ${socialPct}%`}
          />
        )}
      </div>
      <span className="text-xs font-mono font-semibold text-strong whitespace-nowrap">
        {primaryScore.toFixed(3)}
      </span>
    </div>
  );
}

// ─── Run chip ─────────────────────────────────────────────────────────────────

function RunChip({ idea }: { readonly idea: AggregatedIdea }) {
  const label = idea.runSeed
    ? idea.runSeed.length > 20
      ? `${idea.runSeed.slice(0, 20)}…`
      : idea.runSeed
    : `Auto ${idea.runId.slice(0, 6)}`;

  return (
    <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-bg-2 border border-border text-xs text-muted font-mono shrink-0 max-w-[160px] truncate">
      {label}
    </span>
  );
}

// ─── Round badge ──────────────────────────────────────────────────────────────

function RoundBadge({ round, roundType }: { readonly round: number; readonly roundType: RoundType }) {
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-bg-3 border border-border text-xs text-faint shrink-0 whitespace-nowrap">
      <span className="text-accent font-semibold">R{round}</span>
      <span>·</span>
      <span>{ROUND_TYPE_LABELS[roundType] ?? roundType}</span>
    </span>
  );
}

// ─── IdeaCard ─────────────────────────────────────────────────────────────────

export interface IdeaCardProps {
  readonly idea: AggregatedIdea;
  readonly rank: number;
  readonly animationDelay?: number;
  readonly navigateTo: (tab: Tab) => void;
}

export function IdeaCard({ idea, rank, animationDelay = 0, navigateTo }: IdeaCardProps) {
  const [expanded, setExpanded] = useState(false);

  const primaryScore = idea.fusedScore ?? idea.expertScore;

  // Rank bubble intensity: top 3 get accent shades, rest are muted
  const rankBubbleClass = cn(
    "w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold shrink-0",
    rank === 1
      ? "bg-accent text-white"
      : rank === 2
        ? "bg-accent/60 text-white"
        : rank === 3
          ? "bg-accent/30 text-accent"
          : "bg-bg-2 text-muted",
  );

  function handleOpenRun() {
    // Store the run ID in sessionStorage so Sige.tsx can pick it up on mount.
    // Sige.tsx uses internal selectedId state; we pass it via sessionStorage
    // as a handoff key, then navigate to the sige tab.
    sessionStorage.setItem("sige:pendingRunId", idea.runId);
    navigateTo("sige");
  }

  return (
    <div
      className={cn(
        "bg-bg-1 rounded-lg border overflow-hidden transition-all",
        expanded ? "border-border-2" : "border-border hover:border-border-2",
        rank === 1 && "border-accent/30 hover:border-accent/50",
      )}
      style={{ animationDelay: `${animationDelay}ms` }}
    >
      {/* Collapsed row */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full text-left px-4 py-3 flex items-center gap-3 bg-transparent border-none cursor-pointer hover:bg-bg-2/40 transition-colors"
        aria-expanded={expanded}
        aria-label={`Idea ${rank}: ${idea.title} — ${expanded ? "collapse" : "expand"} details`}
      >
        {/* Rank bubble */}
        <span className={rankBubbleClass} aria-hidden="true">
          {rank}
        </span>

        {/* Title */}
        <span className="flex-1 min-w-0 font-semibold text-sm text-strong truncate">
          {idea.title}
        </span>

        {/* Score bar */}
        <div className="hidden sm:block shrink-0">
          <MiniScoreBar
            expertScore={idea.expertScore}
            socialScore={idea.socialScore}
            primaryScore={primaryScore}
          />
        </div>

        {/* Round badge */}
        <div className="hidden md:block">
          <RoundBadge round={idea.round} roundType={idea.roundType} />
        </div>

        {/* Run chip + status */}
        <div className="hidden lg:flex items-center gap-1.5 shrink-0">
          <RunChip idea={idea} />
          <StatusBadge status={idea.runStatus} colorMap={SIGE_STATUS_COLOR_MAP} />
        </div>

        {/* Final marker */}
        {idea.isFinal && (
          <span
            className="hidden sm:inline-flex items-center px-2 py-0.5 rounded bg-success-subtle text-success text-xs font-semibold shrink-0"
            title="Received a fused score — final idea"
          >
            Final
          </span>
        )}

        {/* Expand chevron */}
        <span className="text-faint shrink-0 ml-1" aria-hidden="true">
          {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </span>
      </button>

      {/* Mobile score row */}
      <div className="sm:hidden px-4 pb-2 flex items-center gap-2">
        <MiniScoreBar
          expertScore={idea.expertScore}
          socialScore={idea.socialScore}
          primaryScore={primaryScore}
        />
        <RoundBadge round={idea.round} roundType={idea.roundType} />
      </div>

      {/* Expanded detail */}
      {expanded && (
        <div className="border-t border-border/60 bg-bg px-4 pt-4 pb-5 space-y-5">
          {/* Description */}
          <div>
            <p className="text-xs font-semibold text-faint uppercase tracking-wide mb-1.5">
              Description
            </p>
            <p className="text-sm text-muted leading-relaxed">{idea.description}</p>
          </div>

          {/* Score detail */}
          <div>
            <p className="text-xs font-semibold text-faint uppercase tracking-wide mb-2">
              Scores
            </p>
            <div className="flex flex-wrap gap-3">
              <div className="flex items-center gap-1.5 text-xs font-mono">
                <span className="text-faint">Expert</span>
                <span className="text-accent font-semibold">{idea.expertScore.toFixed(3)}</span>
              </div>
              {idea.socialScore !== null && (
                <div className="flex items-center gap-1.5 text-xs font-mono">
                  <span className="text-faint">Social</span>
                  <span className="text-warning font-semibold">{idea.socialScore.toFixed(3)}</span>
                </div>
              )}
              {idea.fusedScore !== null && (
                <div className="flex items-center gap-1.5 text-xs font-mono">
                  <span className="text-faint">Fused</span>
                  <span className="text-strong font-semibold">{idea.fusedScore.toFixed(3)}</span>
                </div>
              )}
            </div>
          </div>

          {/* Incentive breakdown */}
          {idea.breakdown !== null ? (
            <div>
              <p className="text-xs font-semibold text-faint uppercase tracking-wide mb-2">
                Incentive Breakdown
              </p>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {breakdownEntries(idea.breakdown).map(({ label, value, positive }) => (
                  <div
                    key={label}
                    className="bg-bg-1 border border-border rounded-lg px-3 py-2"
                  >
                    <div className="text-xs text-faint mb-0.5">{label}</div>
                    <div
                      className={cn(
                        "text-sm font-semibold font-mono",
                        positive ? "text-success" : "text-danger",
                      )}
                    >
                      {positive ? "+" : "−"}
                      {Math.abs(value).toFixed(3)}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div>
              <p className="text-xs font-semibold text-faint uppercase tracking-wide mb-1.5">
                Incentive Breakdown
              </p>
              <p className="text-sm text-faint italic">
                — Not available for non-final ideas
              </p>
            </div>
          )}

          {/* Run metadata */}
          <div>
            <p className="text-xs font-semibold text-faint uppercase tracking-wide mb-2">
              Run Metadata
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1.5 text-sm">
              <div className="flex items-start gap-2">
                <span className="text-faint w-20 shrink-0">Proposed by</span>
                <span className="text-muted">{idea.proposedBy}</span>
              </div>
              <div className="flex items-start gap-2">
                <span className="text-faint w-20 shrink-0">Origin</span>
                <span className="text-muted capitalize">{idea.runOrigin}</span>
              </div>
              {idea.runSeed && (
                <div className="flex items-start gap-2">
                  <span className="text-faint w-20 shrink-0">Seed</span>
                  <span className="text-muted break-all">{idea.runSeed}</span>
                </div>
              )}
              <div className="flex items-start gap-2">
                <span className="text-faint w-20 shrink-0">Run date</span>
                <span className="text-muted">
                  {new Date(idea.runCreatedAt).toLocaleString()}
                </span>
              </div>
              <div className="flex items-start gap-2 sm:col-span-2">
                <span className="text-faint w-20 shrink-0">Idea ID</span>
                <span className="text-muted font-mono text-xs break-all">{idea.ideaId}</span>
              </div>
              <div className="flex items-start gap-2 sm:col-span-2">
                <span className="text-faint w-20 shrink-0">Run ID</span>
                <span className="text-muted font-mono text-xs break-all">{idea.runId}</span>
              </div>
            </div>
          </div>

          {/* Open run button */}
          <div className="pt-1">
            <button
              type="button"
              onClick={handleOpenRun}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-transparent border border-border text-sm text-muted font-medium cursor-pointer transition-colors hover:border-accent hover:text-accent"
            >
              <ExternalLink size={13} />
              Open run in SIGE
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
