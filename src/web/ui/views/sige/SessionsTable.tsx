import { ChevronRight } from "lucide-react";
import { cn } from "../../lib/cn";
import { SigeStatusBadge } from "./SigeStatusBadge";
import type { SigeSession } from "./types";

function formatDate(isoString: string): string {
  const d = new Date(isoString);
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen).trimEnd() + "…";
}

interface SessionsTableProps {
  readonly sessions: readonly SigeSession[];
  readonly selectedId: string | null;
  readonly onSelect: (id: string) => void;
}

export function SessionsTable({
  sessions,
  selectedId,
  onSelect,
}: SessionsTableProps) {
  if (sessions.length === 0) return null;

  return (
    <div className="bg-bg-1 border border-border rounded-xl overflow-hidden">
      <div className="px-5 py-3.5 border-b border-border flex items-center justify-between">
        <h3 className="text-sm font-semibold text-strong m-0">
          Recent Sessions
        </h3>
        <span className="text-xs font-mono text-muted bg-bg-2 px-2 py-0.5 rounded">
          {sessions.length}
        </span>
      </div>

      <div className="divide-y divide-border">
        {sessions.map((session) => (
          <button
            key={session.id}
            type="button"
            onClick={() => onSelect(session.id)}
            className={cn(
              "w-full text-left px-5 py-4 flex items-center gap-4 transition-colors cursor-pointer bg-transparent border-none",
              "hover:bg-bg-2",
              selectedId === session.id && "bg-accent-subtle",
            )}
          >
            {/* Seed input preview */}
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-strong leading-snug m-0 truncate">
                {truncate(session.seedInput, 120)}
              </p>
              <p className="text-xs text-faint mt-1 m-0 font-mono">
                {session.id.slice(0, 8)}
                {"…"}
                {"  ·  "}
                {formatDate(session.createdAt)}
              </p>
            </div>

            {/* Status badge */}
            <div className="shrink-0">
              <SigeStatusBadge status={session.status} />
            </div>

            {/* Arrow */}
            <ChevronRight
              size={15}
              className={cn(
                "shrink-0 text-faint transition-colors",
                selectedId === session.id && "text-accent",
              )}
            />
          </button>
        ))}
      </div>
    </div>
  );
}
