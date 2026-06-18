import { useEffect, useState } from "react";
import { LoadingState } from "../../components";
import { fetchSessionIdeas } from "./api";
import { IdeaRow } from "./shared/IdeaRow";
import type { FusedScore } from "./types";

interface IdeasTabProps {
  readonly sessionId: string;
}

export function IdeasTab({ sessionId }: IdeasTabProps) {
  const [ideas, setIdeas] = useState<readonly FusedScore[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchSessionIdeas(sessionId)
      .then((data) => {
        if (!cancelled) setIdeas(data);
      })
      .catch(() => {
        if (!cancelled) setError("Failed to load ideas.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
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
