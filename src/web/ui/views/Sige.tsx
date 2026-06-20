import { useState, useEffect } from "react";
import { PageHeader, LoadingState, EmptyState, ModelRoutePicker } from "../components";
import { useToast } from "../components/Toast";
import { usePolledFetch } from "../hooks/usePolledFetch";
import { NewSessionForm } from "./sige/NewSessionForm";
import { SessionsTable } from "./sige/SessionsTable";
import { SessionDetail } from "./sige/SessionDetail";
import { createSession } from "./sige/api";
import type { SigeCreateConfig } from "./sige/api";
import type { SigeSession } from "./sige/types";

interface ListSessionsResponse {
  readonly success: boolean;
  readonly data: {
    readonly sessions: readonly SigeSession[];
  };
}

export default function Sige() {
  const toast = useToast();
  const [submitting, setSubmitting] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Deep-link handoff from SIGE Ideas page: if sessionStorage carries a pending
  // run ID (set by IdeaCard's "Open run" button), auto-select that session.
  useEffect(() => {
    const pending = sessionStorage.getItem("sige:pendingRunId");
    if (pending) {
      sessionStorage.removeItem("sige:pendingRunId");
      setSelectedId(pending);
    }
  }, []);

  const {
    data,
    loading,
    refetch,
  } = usePolledFetch<ListSessionsResponse>("/api/sige/sessions", {
    intervalMs: 30000,
  });

  const sessions = data?.data.sessions ?? [];

  async function handleCreateSession(
    seedInput: string,
    config?: SigeCreateConfig,
  ) {
    setSubmitting(true);
    try {
      const result = await createSession(seedInput, config);
      toast.success("Session started successfully.");
      refetch();
      setSelectedId(result.id);
    } catch {
      toast.error("Failed to start session. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  function handleSelectSession(id: string) {
    setSelectedId(id);
  }

  function handleBack() {
    setSelectedId(null);
    // Refresh list when returning from detail (status may have changed)
    refetch();
  }

  // --- Detail view ---
  if (selectedId) {
    return (
      <div>
        <PageHeader
          title="Strategic Idea Generation Engine"
          subtitle="Session Detail"
        />
        <SessionDetail sessionId={selectedId} onBack={handleBack} />
      </div>
    );
  }

  // --- List view ---
  if (loading && sessions.length === 0) {
    return <LoadingState message="Loading sessions..." />;
  }

  return (
    <div>
      <PageHeader
        title="Strategic Idea Generation Engine"
        count={sessions.length}
        subtitle="Game-theoretic multi-agent simulation for strategically robust idea generation"
      />

      <NewSessionForm onSubmit={handleCreateSession} submitting={submitting} />

      {/* Model Configuration */}
      <div className="bg-bg-1 border border-border rounded-xl p-5 mb-6 mt-4 transition-all duration-200 hover:border-border-hover">
        <div className="text-xs font-semibold uppercase tracking-widest text-accent mb-4 pb-2 border-b border-border">
          Model Configuration
        </div>
        <ModelRoutePicker processKey="sige.fast-agent" label="Fast Agent (auto)" />
        <ModelRoutePicker processKey="sige.judge.0" label="Judge 0" />
        <ModelRoutePicker processKey="sige.judge.1" label="Judge 1" />
        <ModelRoutePicker processKey="sige.judge.2" label="Judge 2" />
      </div>

      {sessions.length === 0 ? (
        <EmptyState
          icon="♟"
          title="No sessions yet"
          description="Start a new session by entering a seed input above. The engine will run a multi-agent game simulation and return ranked, strategically robust ideas."
        />
      ) : (
        <SessionsTable
          sessions={sessions}
          selectedId={selectedId}
          onSelect={handleSelectSession}
        />
      )}
    </div>
  );
}
