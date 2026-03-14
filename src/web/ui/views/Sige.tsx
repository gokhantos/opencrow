import { useCallback, useEffect, useState } from "react";
import { PageHeader, LoadingState, EmptyState } from "../components";
import { useToast } from "../components/Toast";
import { NewSessionForm } from "./sige/NewSessionForm";
import { SessionsTable } from "./sige/SessionsTable";
import { SessionDetail } from "./sige/SessionDetail";
import { fetchSessions, createSession } from "./sige/api";
import type { SigeCreateConfig } from "./sige/api";
import type { SigeSession } from "./sige/types";

export default function Sige() {
  const toast = useToast();
  const [sessions, setSessions] = useState<readonly SigeSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const loadSessions = useCallback(async () => {
    try {
      const data = await fetchSessions();
      setSessions(data);
    } catch {
      toast.error("Failed to load SIGE sessions.");
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    loadSessions();
  }, [loadSessions]);

  async function handleCreateSession(
    seedInput: string,
    config?: SigeCreateConfig,
  ) {
    setSubmitting(true);
    try {
      const result = await createSession(seedInput, config);
      toast.success("Session started successfully.");
      // Reload list then navigate to the new session
      await loadSessions();
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
    // Reload sessions when returning from detail (status may have changed)
    loadSessions();
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
  if (loading) {
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
