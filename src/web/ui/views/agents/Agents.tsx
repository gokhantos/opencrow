import { useState, useEffect, useCallback } from "react";
import { useLocalStorage } from "../../lib/useLocalStorage";
import { apiFetch, deleteAgent, updateAgent, setConfigHash } from "../../api";
import type {
  AgentInfo,
  AgentDetail,
  AgentsResponse,
  AgentDetailResponse,
  MutationResponse,
  ProviderFilter,
} from "./types";
import { AgentCard } from "./AgentCard";
import { AgentFormModal, DeleteDialog } from "./AgentFormModal";
import { DetailPanel } from "./DetailPanel";
import {
  Button,
  PageHeader,
  LoadingState,
  EmptyState,
  SearchBar,
  FilterTabs,
} from "../../components";
import { useToast } from "../../components/Toast";

/* ───── Constants ───── */
const PROVIDER_TABS = [
  { id: "all", label: "All" },
  { id: "agent-sdk", label: "Agent SDK" },
  { id: "openrouter", label: "OpenRouter" },
  { id: "alibaba", label: "Alibaba" },
] as const;

/* ===============================================
   Main Page Component
   =============================================== */
export default function Agents() {
  const toast = useToast();
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  const [providerFilter, setProviderFilter] = useLocalStorage<ProviderFilter>("agents:providerFilter", "all");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  /* Modal state */
  const [showCreate, setShowCreate] = useState(false);
  const [editingAgent, setEditingAgent] = useState<AgentDetail | null>(null);
  const [deletingAgent, setDeletingAgent] = useState<AgentInfo | null>(null);

  const loadAgents = useCallback(async () => {
    try {
      const res = await apiFetch<AgentsResponse>("/api/agents");
      if (res.success) {
        setAgents(res.data);
        if (res.configHash) setConfigHash(res.configHash);
      } else {
        setError("Failed to load agents");
      }
    } catch {
      setError("Failed to load agents");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAgents();
  }, [loadAgents]);

  async function handleDelete(agentId: string) {
    try {
      const res = (await deleteAgent(agentId)) as MutationResponse;
      if (res.configHash) setConfigHash(res.configHash);
      setDeletingAgent(null);
      setSelectedId(null);
      await loadAgents();
    } catch (err) {
      const apiErr = err as { status?: number };
      if (apiErr.status === 409) {
        await loadAgents();
      } else {
        toast.error("Failed to delete agent");
      }
      setDeletingAgent(null);
    }
  }

  async function handleSetDefault(agentId: string) {
    try {
      const res = (await updateAgent(agentId, { default: true })) as MutationResponse;
      if (res.configHash) setConfigHash(res.configHash);
      toast.success("Default agent updated");
      await loadAgents();
    } catch (err) {
      const apiErr = err as { status?: number };
      if (apiErr.status === 409) {
        await loadAgents();
      } else {
        toast.error("Failed to set default agent");
      }
    }
  }

  async function handleEditClick(agent: AgentInfo) {
    try {
      const res = await apiFetch<AgentDetailResponse>(
        `/api/agents/${agent.id}`,
      );
      if (res.success) {
        setEditingAgent(res.data);
        if (res.configHash) setConfigHash(res.configHash);
      }
    } catch {
      toast.error("Failed to load agent details");
    }
  }

  /* Filtering */
  const filtered = agents.filter((a) => {
    const matchesSearch =
      a.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      a.id.toLowerCase().includes(searchTerm.toLowerCase()) ||
      a.description.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesProvider =
      providerFilter === "all" || a.provider === providerFilter;
    return matchesSearch && matchesProvider;
  });

  /* Provider counts for filter tabs */
  const providerCounts: Record<ProviderFilter, number> = {
    all: agents.length,
    "agent-sdk": agents.filter((a) => a.provider === "agent-sdk").length,
    openrouter: agents.filter((a) => a.provider === "openrouter").length,
    alibaba: agents.filter((a) => a.provider === "alibaba").length,
  };

  const selectedAgent = selectedId
    ? agents.find((a) => a.id === selectedId)
    : null;

  /* ───── Loading ───── */
  if (loading) {
    return <LoadingState message="Loading agents..." />;
  }

  /* ───── Error ───── */
  if (error) {
    return (
      <div className="flex flex-col items-center gap-4 px-8 py-16 text-danger text-center">
        <p>{error}</p>
        <Button variant="primary" size="sm" onClick={loadAgents}>
          Retry
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col min-h-0">
      {/* --- Header --- */}
      <PageHeader
        title="Agents"
        subtitle="Manage your AI agents and their configurations"
        count={agents.length}
        actions={
          <Button onClick={() => setShowCreate(true)}>
            <svg
              width="13"
              height="13"
              viewBox="0 0 14 14"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            >
              <path d="M7 1v12M1 7h12" />
            </svg>
            New Agent
          </Button>
        }
      />

      {/* --- Toolbar: Filter tabs + Search --- */}
      <div className="flex items-center justify-between gap-4 mb-6 pb-4 border-b border-border flex-wrap">
        <FilterTabs
          tabs={PROVIDER_TABS.map((t) => ({
            id: t.id,
            label: t.label,
            count: providerCounts[t.id],
          }))}
          active={providerFilter}
          onChange={(id) => setProviderFilter(id as ProviderFilter)}
        />
        <div className="min-w-[200px] max-w-[260px] shrink-0">
          <SearchBar
            value={searchTerm}
            onChange={setSearchTerm}
            placeholder="Search agents..."
          />
        </div>
      </div>

      {/* --- Main content area --- */}
      <div className="relative">
        {/* Cards Grid */}
        {filtered.length === 0 ? (
          <EmptyState
            title={
              searchTerm || providerFilter !== "all"
                ? "No agents match your filters"
                : "No agents yet"
            }
            description={
              searchTerm || providerFilter !== "all"
                ? "Try adjusting your search or filter criteria."
                : "Create your first agent to get started."
            }
          />
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(320px,1fr))] gap-4">
            {filtered.map((agent) => (
              <AgentCard
                key={agent.id}
                agent={agent}
                isSelected={selectedId === agent.id}
                onSelect={() =>
                  setSelectedId(selectedId === agent.id ? null : agent.id)
                }
                onEdit={() => handleEditClick(agent)}
                onDelete={() => setDeletingAgent(agent)}
                onSetDefault={() => handleSetDefault(agent.id)}
              />
            ))}
          </div>
        )}

        {/* Detail Panel */}
        {selectedAgent && (
          <DetailPanel
            agent={selectedAgent}
            onClose={() => setSelectedId(null)}
            onEdit={() => handleEditClick(selectedAgent)}
            onDelete={() => setDeletingAgent(selectedAgent)}
            onSetDefault={() => handleSetDefault(selectedAgent.id)}
          />
        )}
      </div>

      {/* --- Modals --- */}
      {showCreate && (
        <AgentFormModal
          mode="create"
          onDone={() => {
            setShowCreate(false);
            loadAgents();
          }}
          onCancel={() => setShowCreate(false)}
        />
      )}

      {editingAgent && (
        <AgentFormModal
          mode="edit"
          initial={editingAgent}
          onDone={() => {
            setEditingAgent(null);
            loadAgents();
          }}
          onCancel={() => setEditingAgent(null)}
        />
      )}

      {deletingAgent && (
        <DeleteDialog
          agentName={deletingAgent.name}
          onConfirm={() => handleDelete(deletingAgent.id)}
          onCancel={() => setDeletingAgent(null)}
        />
      )}
    </div>
  );
}
