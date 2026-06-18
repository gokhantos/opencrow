/**
 * Shared IdeaRow + ScoreBar components used by both IdeasTab and
 * ScoredIdeasStage.  Extracted to eliminate verbatim duplication between
 * the two consumer files.
 *
 * Canonical behavior (reconciling the two prior divergences):
 *  - ScoreBar clamps both scores to [0, 1] via Math.min(Math.max(score, 0), 1)
 *    (IdeasTab previously omitted Math.max; ScoredIdeasStage had it).
 *  - IdeaRow button carries aria-label identifying the idea
 *    (IdeasTab previously omitted it; ScoredIdeasStage had it).
 */
import { useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { cn } from "../../../lib/cn";
import type { FusedScore, IncentiveBreakdown } from "../types";

// ─── ScoreBar ─────────────────────────────────────────────────────────────────

export interface ScoreBarProps {
  readonly expertScore: number;
  readonly socialScore: number;
  readonly fusedScore: number;
}

export function ScoreBar({ expertScore, socialScore, fusedScore }: ScoreBarProps) {
  const expertPct = Math.round(Math.min(Math.max(expertScore, 0), 1) * 100);
  const socialPct = Math.round(Math.min(Math.max(socialScore, 0), 1) * 100);

  return (
    <div className="flex items-center gap-3">
      <div className="flex-1 flex gap-0.5 h-2 rounded-full overflow-hidden bg-bg-2">
        <div
          className="bg-accent rounded-l-full transition-all"
          style={{ width: `${expertPct}%` }}
          title={`Expert: ${expertPct}%`}
        />
        <div
          className="bg-warning rounded-r-full transition-all"
          style={{ width: `${socialPct}%` }}
          title={`Social: ${socialPct}%`}
        />
      </div>
      <span className="text-xs font-mono font-semibold text-strong whitespace-nowrap">
        {fusedScore.toFixed(3)}
      </span>
    </div>
  );
}

// ─── breakdownEntries ─────────────────────────────────────────────────────────

export interface BreakdownEntry {
  readonly label: string;
  readonly value: number;
  readonly positive: boolean;
}

export function breakdownEntries(
  bd: IncentiveBreakdown,
): readonly BreakdownEntry[] {
  return [
    { label: "Diversity bonus", value: bd.diversityBonus, positive: true },
    { label: "Building bonus", value: bd.buildingBonus, positive: true },
    { label: "Surprise bonus", value: bd.surpriseBonus, positive: true },
    { label: "Memory reward", value: bd.memoryReward, positive: true },
    { label: "Coalition stability", value: bd.coalitionStability, positive: true },
    { label: "Signal credibility", value: bd.signalCredibility, positive: true },
    { label: "Social viability", value: bd.socialViability, positive: true },
    { label: "Accuracy penalty", value: bd.accuracyPenalty, positive: false },
  ];
}

// ─── IdeaRow ──────────────────────────────────────────────────────────────────

export interface IdeaRowProps {
  readonly idea: FusedScore;
  readonly rank: number;
}

export function IdeaRow({ idea, rank }: IdeaRowProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div
      className={cn(
        "border-b border-border last:border-b-0 transition-colors",
        rank === 1 && "bg-accent-subtle/40",
      )}
    >
      {/* Main row */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full text-left px-5 py-3.5 flex items-center gap-4 bg-transparent border-none cursor-pointer hover:bg-bg-2 transition-colors"
        aria-expanded={expanded}
        aria-label={`Idea ${rank}: ${idea.ideaId.slice(0, 8)} — expand for breakdown`}
      >
        {/* Rank bubble */}
        <span
          className={cn(
            "w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold shrink-0",
            rank === 1
              ? "bg-accent text-white"
              : rank === 2
              ? "bg-accent/60 text-white"
              : rank === 3
              ? "bg-accent/30 text-accent"
              : "bg-bg-2 text-muted",
          )}
        >
          {rank}
        </span>

        {/* ID (truncated) */}
        <span className="text-xs font-mono text-muted w-20 truncate shrink-0">
          {idea.ideaId.slice(0, 8)}
        </span>

        {/* Score bar */}
        <div className="flex-1 min-w-0">
          <ScoreBar
            expertScore={idea.expertScore}
            socialScore={idea.socialScore}
            fusedScore={idea.fusedScore}
          />
        </div>

        {/* Expert / Social labels */}
        <div className="hidden sm:flex items-center gap-3 shrink-0 text-xs text-muted font-mono">
          <span className="text-accent">{idea.expertScore.toFixed(3)} E</span>
          <span className="text-warning">{idea.socialScore.toFixed(3)} S</span>
        </div>

        {/* Expand toggle */}
        <span className="text-faint shrink-0">
          {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </span>
      </button>

      {/* Expanded: incentive breakdown */}
      {expanded && (
        <div className="px-5 pb-4 pt-1 bg-bg border-t border-border/50">
          <p className="text-xs font-semibold text-muted uppercase tracking-wide mb-3">
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
      )}
    </div>
  );
}
