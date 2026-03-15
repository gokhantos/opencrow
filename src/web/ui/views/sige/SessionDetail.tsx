import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, X } from "lucide-react";
import { Button, LoadingState } from "../../components";
import { cn } from "../../lib/cn";
import { ProgressBar } from "./ProgressBar";
import { SigeStatusBadge } from "./SigeStatusBadge";
import { ReportTab } from "./ReportTab";
import { IdeasTab } from "./IdeasTab";
import { GameTab } from "./GameTab";
import { PopulationTab } from "./PopulationTab";
import { TERMINAL_STATUSES } from "./statusConfig";
import { fetchSession, cancelSession } from "./api";
import type { SigeSessionDetail } from "./types";

type DetailTab = "report" | "ideas" | "game" | "population";

const DETAIL_TABS: readonly { id: DetailTab; label: string }[] = [
  { id: "report", label: "Report" },
  { id: "ideas", label: "Ranked Ideas" },
  { id: "game", label: "Game Analysis" },
  { id: "population", label: "Population Dynamics" },
];

interface SessionDetailProps {
  readonly sessionId: string;
  readonly onBack: () => void;
}

export function SessionDetail({ sessionId, onBack }: SessionDetailProps) {
  const [session, setSession] = useState<SigeSessionDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [activeTab, setActiveTab] = useState<DetailTab>("report");
  const [cancelling, setCancelling] = useState(false);

  const loadSession = useCallback(async () => {
    try {
      const data = await fetchSession(sessionId);
      setSession(data);
      return data;
    } catch {
      setError("Failed to load session.");
      return null;
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  // Poll for status updates every 3 seconds while session is in progress
  useEffect(() => {
    loadSession();

    const interval = setInterval(async () => {
      try {
        const data = await fetchSession(sessionId);
        if (!data) return;
        setSession(data);
        if (TERMINAL_STATUSES.has(data.status)) {
          clearInterval(interval);
        }
      } catch {
        // silently retry on next interval
      }
    }, 3000);

    return () => clearInterval(interval);
  }, [sessionId, loadSession]);

  async function handleCancel() {
    if (!session || cancelling) return;
    setCancelling(true);
    try {
      await cancelSession(sessionId);
      setSession((prev) => (prev ? { ...prev, status: "cancelled" } : prev));
    } catch {
      // silently ignore — user can retry
    } finally {
      setCancelling(false);
    }
  }

  if (loading) return <LoadingState message="Loading session..." />;

  if (error || !session) {
    return (
      <div>
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-1.5 text-sm text-muted hover:text-foreground transition-colors cursor-pointer bg-transparent border-none p-0 mb-6"
        >
          <ArrowLeft size={14} />
          Back
        </button>
        <div className="text-sm text-danger">{error || "Session not found."}</div>
      </div>
    );
  }

  const isTerminal = TERMINAL_STATUSES.has(session.status);
  const isCompleted = session.status === "completed";
  const canCancel =
    !isTerminal && !cancelling;

  return (
    <div>
      {/* Back + title row */}
      <div className="flex items-center justify-between gap-4 mb-6 flex-wrap">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onBack}
            className="flex items-center gap-1.5 text-sm text-muted hover:text-foreground transition-colors cursor-pointer bg-transparent border-none p-0"
          >
            <ArrowLeft size={14} />
            Back
          </button>
          <span className="text-border-2 text-sm">/</span>
          <SigeStatusBadge status={session.status} />
        </div>

        {canCancel && (
          <Button
            variant="danger"
            size="sm"
            loading={cancelling}
            onClick={handleCancel}
          >
            <X size={13} />
            Cancel
          </Button>
        )}
      </div>

      {/* Seed input */}
      <div className="bg-bg-1 border border-border rounded-xl px-5 py-4 mb-6">
        <p className="text-xs font-semibold text-muted uppercase tracking-wide mb-1.5">
          Seed Input
        </p>
        <p className="text-sm text-foreground leading-relaxed m-0 font-mono whitespace-pre-wrap">
          {session.seedInput}
        </p>
      </div>

      {/* Progress bar — always shown while active, also shown for terminal */}
      <ProgressBar status={session.status} />

      {/* Error message for failed sessions */}
      {session.status === "failed" && session.error && (
        <div className="bg-danger-subtle border border-danger/20 rounded-xl px-5 py-4 mb-6">
          <p className="text-xs font-semibold text-danger uppercase tracking-wide mb-1">
            Error
          </p>
          <p className="text-sm text-danger m-0">{session.error}</p>
        </div>
      )}

      {/* Tabs — only shown when completed */}
      {isCompleted && (
        <>
          <div className="flex gap-1 bg-bg border border-border rounded-lg p-1 mb-6 flex-wrap">
            {DETAIL_TABS.map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={cn(
                  "px-4 py-2 rounded-md text-sm font-medium cursor-pointer bg-transparent border-none transition-colors",
                  activeTab === tab.id
                    ? "bg-bg-1 text-strong shadow-sm border border-border"
                    : "text-muted hover:text-foreground hover:bg-bg-2",
                )}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <div>
            {activeTab === "report" && (
              <ReportTab
                sessionId={sessionId}
                initialReport={session.report}
              />
            )}
            {activeTab === "ideas" && <IdeasTab sessionId={sessionId} />}
            {activeTab === "game" && <GameTab session={session} />}
            {activeTab === "population" && (
              <PopulationTab sessionId={sessionId} />
            )}
          </div>
        </>
      )}

      {/* In-progress: show live status message */}
      {!isTerminal && (
        <div className="bg-bg-1 border border-border rounded-xl px-5 py-6 text-center">
          <div className="flex items-center justify-center gap-3 mb-2">
            <span className="w-4 h-4 border-2 border-border-2 border-t-accent rounded-full animate-spin" />
            <span className="text-sm font-medium text-foreground">
              Session running...
            </span>
          </div>
          <p className="text-xs text-faint m-0">
            Results will appear automatically when the session completes.
          </p>
        </div>
      )}

      {/* Cancelled state */}
      {session.status === "cancelled" && (
        <div className="bg-bg-1 border border-border rounded-xl px-5 py-6 text-center">
          <p className="text-sm text-muted m-0">This session was cancelled.</p>
        </div>
      )}
    </div>
  );
}
