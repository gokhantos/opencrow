import { useEffect, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { LoadingState } from "../../components";
import { cn } from "../../lib/cn";
import { fetchSessionIdeas } from "./api";
import type { FusedScore } from "./types";

interface IdeasTabProps {
  readonly sessionId: string;
}

function ScoreBar({
  expertScore,
  socialScore,
  fusedScore,
}: {
  readonly expertScore: number;
  readonly socialScore: number;
  readonly fusedScore: number;
}) {
  const expertPct = Math.round(Math.min(expertScore, 1) * 100);
  const socialPct = Math.round(Math.min(socialScore, 1) * 100);

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

function breakdownEntries(
  bd: FusedScore["breakdown"],
): Array<{ label: string; value: number; positive: boolean }> {
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

function IdeaRow({
  idea,
  rank,
}: {
  readonly idea: FusedScore;
  readonly rank: number;
}) {
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
      >
        {/* Rank */}
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

      {/* Expanded breakdown */}
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

export function IdeasTab({ sessionId }: IdeasTabProps) {
  const [ideas, setIdeas] = useState<readonly FusedScore[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    setLoading(true);
    fetchSessionIdeas(sessionId)
      .then(setIdeas)
      .catch(() => setError("Failed to load ideas."))
      .finally(() => setLoading(false));
  }, [sessionId]);

  if (loading) return <LoadingState message="Loading ideas..." />;

  if (error) {
    return <div className="py-8 text-sm text-danger">{error}</div>;
  }

  if (ideas.length === 0) {
    return (
      <div className="py-8 text-sm text-muted italic">
        No scored ideas yet.
      </div>
    );
  }

  return (
    <div className="bg-bg-1 border border-border rounded-xl overflow-hidden">
      {/* Header */}
      <div className="px-5 py-3 border-b border-border flex items-center gap-4 text-xs font-semibold text-muted uppercase tracking-wide">
        <span className="w-6 shrink-0">#</span>
        <span className="w-20 shrink-0">ID</span>
        <span className="flex-1">Score (Expert / Social)</span>
        <span className="hidden sm:block w-28 text-right shrink-0">
          E / S
        </span>
        <span className="w-4 shrink-0" />
      </div>

      {/* Rows */}
      {ideas.map((idea, idx) => (
        <IdeaRow key={idea.ideaId} idea={idea} rank={idx + 1} />
      ))}

      {/* Legend */}
      <div className="px-5 py-3 border-t border-border flex items-center gap-4 text-xs text-faint">
        <span className="flex items-center gap-1.5">
          <span className="w-3 h-1.5 rounded-full bg-accent inline-block" />
          Expert
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-3 h-1.5 rounded-full bg-warning inline-block" />
          Social
        </span>
      </div>
    </div>
  );
}
