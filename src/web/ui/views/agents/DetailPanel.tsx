import { useState, useEffect, useRef } from "react";
import { apiFetch, setConfigHash } from "../../api";
import { cn } from "../../lib/cn";
import type {
  AgentInfo,
  AgentDetail,
  AgentDetailResponse,
  ToolInfo,
} from "./types";
import { providerLabel, getInitials } from "./types";
import { Button } from "../../components";

/* ───── Category labels ───── */
const CATEGORY_LABELS: Record<string, string> = {
  core: "Core",
  skills: "Skills",
  agents: "Agents",
  scheduling: "Scheduling",
  memory: "Memory",
  news: "News & Content",
  product_hunt: "Product Hunt",
  hacker_news: "Hacker News",
  reddit: "Reddit",
  x_timeline: "X / Twitter",
  search: "Cross-Source",
  ideas: "Ideas",
  observability: "Observability",
  market: "Market",
  development: "Development",
  system: "System",
};

function ToolList({ tools }: { tools: readonly ToolInfo[] }) {
  // Group by category
  const grouped = new Map<string, ToolInfo[]>();
  for (const t of tools) {
    const cat = t.category || "other";
    const list = grouped.get(cat) ?? [];
    list.push(t);
    grouped.set(cat, list);
  }

  return (
    <div className="flex flex-col gap-2 max-h-[280px] overflow-y-auto">
      {[...grouped.entries()].map(([cat, catTools]) => (
        <div key={cat}>
          <span className="block font-heading text-[0.6rem] font-semibold uppercase tracking-[0.1em] text-faint mb-1">
            {CATEGORY_LABELS[cat] ?? cat.replace(/_/g, " ")}
          </span>
          <div className="flex flex-col gap-px">
            {catTools.map((tool) => (
              <div
                key={tool.name}
                className="flex items-baseline gap-2 px-2.5 py-1.5 rounded-md hover:bg-bg-2 transition-colors"
              >
                <span className="font-mono text-xs text-foreground font-medium shrink-0">
                  {tool.name}
                </span>
                {tool.description && (
                  <span className="text-[11px] text-faint truncate">
                    {tool.description}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ───── Provider-specific style maps ───── */
const AVATAR_STYLE: Record<string, string> = {
  "agent-sdk": "bg-purple/10 text-purple border border-purple/10",
  anthropic: "bg-accent-subtle text-accent border border-accent-subtle",
  openrouter: "bg-blue-400/10 text-blue-400 border border-blue-400/10",
  alibaba: "bg-orange-400/10 text-orange-400 border border-orange-400/10",
};

const PROV_COLOR: Record<string, string> = {
  "agent-sdk": "text-purple",
  anthropic: "text-accent",
  openrouter: "text-blue-400",
  alibaba: "text-orange-400",
};

/* ===============================================
   Detail Panel -- slides in from right
   =============================================== */
export function DetailPanel({
  agent,
  onClose,
  onEdit,
  onDelete,
  onSetDefault,
}: {
  agent: AgentInfo;
  onClose: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onSetDefault?: () => void;
}) {
  const [detail, setDetail] = useState<AgentDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [allTools, setAllTools] = useState<ToolInfo[]>([]);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    apiFetch<{ success: boolean; data: ToolInfo[] }>("/api/tools")
      .then((res) => {
        if (res.success) setAllTools(res.data);
      })
      .catch((err) => console.error("Failed to load tools", err));
  }, []);

  useEffect(() => {
    setLoading(true);
    setDetail(null);
    apiFetch<AgentDetailResponse>(`/api/agents/${agent.id}`)
      .then((res) => {
        if (res.success) {
          setDetail(res.data);
          if (res.configHash) setConfigHash(res.configHash);
        }
      })
      .catch((err) => console.error("Failed to load agent detail", err))
      .finally(() => setLoading(false));
  }, [agent.id]);

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onClose]);

  return (
    <>
      <div
        className="fixed inset-0 bg-black/40 z-[900] animate-[agFadeIn_0.2s_ease]"
        onClick={onClose}
      />
      <div
        className="fixed top-0 right-0 bottom-0 w-[420px] max-w-[calc(100vw-40px)] max-md:w-full max-md:max-w-full bg-bg-1 border-l border-border-2 z-[901] flex flex-col animate-[agPanelIn_0.25s_ease-out]"
        ref={panelRef}
      >
        {/* Panel header */}
        <div className="px-6 pt-6 pb-5 border-b border-border flex flex-col gap-4 shrink-0">
          <Button
            variant="ghost"
            size="sm"
            className="absolute top-4 right-4 z-[1]"
            onClick={onClose}
            aria-label="Close"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            >
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </Button>
          <div className="flex items-center gap-3">
            <div
              className={cn(
                "w-12 h-12 rounded-lg flex items-center justify-center font-heading font-bold text-base shrink-0",
                AVATAR_STYLE[agent.provider] ??
                  "bg-accent-subtle text-accent border border-accent-subtle",
              )}
            >
              {getInitials(agent.name)}
            </div>
            <div>
              <h3 className="font-heading font-semibold text-lg text-strong m-0 tracking-tight flex items-center gap-2">
                {agent.name}
                {agent.isDefault && (
                  <span className="inline-flex items-center px-2 py-px rounded-full bg-accent-subtle text-[0.65rem] font-semibold text-accent tracking-wide uppercase shrink-0">
                    Default
                  </span>
                )}
              </h3>
              <p className="font-mono text-xs text-faint mt-0.5 m-0">
                {agent.id}
              </p>
            </div>
          </div>
          {agent.description && (
            <p className="text-muted text-sm leading-relaxed m-0">
              {agent.description}
            </p>
          )}
        </div>

        {/* Panel body */}
        <div className="flex-1 overflow-y-auto p-6 flex flex-col gap-6">
          {loading ? (
            <div className="flex flex-col items-center justify-center gap-4 py-12 text-faint text-sm">
              <span className="w-4.5 h-4.5 border-2 border-border-2 border-t-accent rounded-full animate-spin inline-block" />
              <span>Loading details...</span>
            </div>
          ) : detail ? (
            <>
              {/* Model Config Section */}
              <div className="flex flex-col gap-3">
                <h4 className="flex items-center font-heading text-xs font-semibold uppercase tracking-widest text-accent m-0 pb-1.5 border-b border-border">
                  Model Configuration
                </h4>
                <div className="grid grid-cols-2 gap-3 max-md:grid-cols-1">
                  <div className="flex flex-col gap-1 px-3 py-2.5 bg-bg-2 border border-border rounded-lg">
                    <span className="font-heading text-[0.65rem] font-semibold uppercase tracking-widest text-faint">
                      Provider
                    </span>
                    <span
                      className={cn(
                        "text-sm break-words",
                        PROV_COLOR[detail.provider] ?? "text-accent",
                      )}
                    >
                      {providerLabel(detail.provider)}
                    </span>
                  </div>
                  <div className="flex flex-col gap-1 px-3 py-2.5 bg-bg-2 border border-border rounded-lg">
                    <span className="font-heading text-[0.65rem] font-semibold uppercase tracking-widest text-faint">
                      Model
                    </span>
                    <span className="text-sm text-foreground break-words font-mono">
                      {detail.model || "Default"}
                    </span>
                  </div>
                  {detail.maxIterations != null && (
                    <div className="flex flex-col gap-1 px-3 py-2.5 bg-bg-2 border border-border rounded-lg">
                      <span className="font-heading text-[0.65rem] font-semibold uppercase tracking-widest text-faint">
                        Max Iterations
                      </span>
                      <span className="text-sm text-foreground break-words">
                        {detail.maxIterations}
                      </span>
                    </div>
                  )}
                  {detail.provider === "agent-sdk" && (
                    <>
                      <div className="flex flex-col gap-1 px-3 py-2.5 bg-bg-2 border border-border rounded-lg">
                        <span className="font-heading text-[0.65rem] font-semibold uppercase tracking-widest text-faint">
                          Thinking Mode
                        </span>
                        <span className="text-sm text-foreground break-words capitalize">
                          {detail.modelParams?.thinkingMode ?? (detail.reasoning ? "adaptive" : "disabled")}
                          {detail.modelParams?.thinkingMode === "enabled" &&
                            detail.modelParams?.thinkingBudget != null &&
                            ` (${(detail.modelParams.thinkingBudget / 1000).toFixed(0)}k)`}
                        </span>
                      </div>
                      <div className="flex flex-col gap-1 px-3 py-2.5 bg-bg-2 border border-border rounded-lg">
                        <span className="font-heading text-[0.65rem] font-semibold uppercase tracking-widest text-faint">
                          Effort
                        </span>
                        <span className="text-sm text-foreground break-words capitalize">
                          {detail.modelParams?.effort ?? "high"}
                        </span>
                      </div>
                    </>
                  )}
                  <div className="flex flex-col gap-1 px-3 py-2.5 bg-bg-2 border border-border rounded-lg">
                    <span className="font-heading text-[0.65rem] font-semibold uppercase tracking-widest text-faint">
                      Stateless
                    </span>
                    <span
                      className={cn(
                        "text-sm break-words",
                        detail.stateless
                          ? "text-success font-semibold"
                          : "text-faint",
                      )}
                    >
                      {detail.stateless ? "Yes" : "No"}
                    </span>
                  </div>
                  {detail.maxInputLength != null && (
                    <div className="flex flex-col gap-1 px-3 py-2.5 bg-bg-2 border border-border rounded-lg">
                      <span className="font-heading text-[0.65rem] font-semibold uppercase tracking-widest text-faint">
                        Max Input Length
                      </span>
                      <span className="text-sm text-foreground break-words">
                        {detail.maxInputLength.toLocaleString()}
                      </span>
                    </div>
                  )}
                </div>
              </div>

              {/* System Prompt */}
              <div className="flex flex-col gap-3">
                <h4 className="flex items-center font-heading text-xs font-semibold uppercase tracking-widest text-accent m-0 pb-1.5 border-b border-border">
                  System Prompt
                </h4>
                {detail.systemPrompt ? (
                  <div className="p-4 bg-bg-2 border border-border rounded-lg font-mono text-xs text-muted whitespace-pre-wrap break-words max-h-[240px] overflow-y-auto leading-relaxed">
                    {detail.systemPrompt}
                  </div>
                ) : (
                  <p className="text-faint text-sm m-0">
                    No system prompt configured
                  </p>
                )}
              </div>

              {/* Tool Filter */}
              <div className="flex flex-col gap-3">
                <h4 className="flex items-center font-heading text-xs font-semibold uppercase tracking-widest text-accent m-0 pb-1.5 border-b border-border">
                  Tool Access
                  <span className="ml-auto font-mono text-[0.65rem] text-faint font-normal normal-case tracking-normal">
                    {detail.toolFilter.mode === "all"
                      ? `${allTools.length} tools`
                      : `${detail.toolFilter.tools.length} ${detail.toolFilter.mode === "allowlist" ? "allowed" : "blocked"}`}
                  </span>
                </h4>
                {detail.toolFilter.mode === "all" ? (
                  allTools.length > 0 ? (
                    <ToolList tools={allTools} />
                  ) : (
                    <p className="text-faint text-sm m-0">
                      All tools available
                    </p>
                  )
                ) : (
                  <>
                    <p className="text-faint text-sm m-0">
                      {detail.toolFilter.mode === "allowlist"
                        ? "Allowed"
                        : "Blocked"}{" "}
                      tools:
                    </p>
                    <ToolList
                      tools={detail.toolFilter.tools.map((name) => {
                        const meta = allTools.find((t) => t.name === name);
                        return {
                          name,
                          category: meta?.category ?? "",
                          description: meta?.description,
                        };
                      })}
                    />
                  </>
                )}
              </div>

              {/* Sub-Agents */}
              <div className="flex flex-col gap-3">
                <h4 className="flex items-center font-heading text-xs font-semibold uppercase tracking-widest text-accent m-0 pb-1.5 border-b border-border">
                  Sub-Agents
                </h4>
                <div className="grid grid-cols-2 gap-3 max-md:grid-cols-1">
                  <div className="flex flex-col gap-1 px-3 py-2.5 bg-bg-2 border border-border rounded-lg">
                    <span className="font-heading text-[0.65rem] font-semibold uppercase tracking-widest text-faint">
                      Allowed
                    </span>
                    <span className="text-sm text-foreground break-words">
                      {detail.subagents.allowAgents.join(", ") || "None"}
                    </span>
                  </div>
                  <div className="flex flex-col gap-1 px-3 py-2.5 bg-bg-2 border border-border rounded-lg">
                    <span className="font-heading text-[0.65rem] font-semibold uppercase tracking-widest text-faint">
                      Max Children
                    </span>
                    <span className="text-sm text-foreground break-words">
                      {detail.subagents.maxChildren}
                    </span>
                  </div>
                </div>
              </div>

              {/* MCP Servers */}
              <div className="flex flex-col gap-3">
                <h4 className="flex items-center font-heading text-xs font-semibold uppercase tracking-widest text-accent m-0 pb-1.5 border-b border-border">
                  MCP Servers
                </h4>
                <div className="grid grid-cols-2 gap-3 max-md:grid-cols-1">
                  <div className="flex flex-col gap-1 px-3 py-2.5 bg-bg-2 border border-border rounded-lg">
                    <span className="font-heading text-[0.65rem] font-semibold uppercase tracking-widest text-faint">
                      Playwright
                    </span>
                    <span
                      className={cn(
                        "text-sm break-words",
                        detail.mcpServers?.browser
                          ? "text-success font-semibold"
                          : "text-faint",
                      )}
                    >
                      {detail.mcpServers?.browser ? "Enabled" : "Off"}
                    </span>
                  </div>
                  <div className="flex flex-col gap-1 px-3 py-2.5 bg-bg-2 border border-border rounded-lg">
                    <span className="font-heading text-[0.65rem] font-semibold uppercase tracking-widest text-faint">
                      GitHub
                    </span>
                    <span
                      className={cn(
                        "text-sm break-words",
                        detail.mcpServers?.github
                          ? "text-success font-semibold"
                          : "text-faint",
                      )}
                    >
                      {detail.mcpServers?.github ? "Enabled" : "Off"}
                    </span>
                  </div>
                  <div className="flex flex-col gap-1 px-3 py-2.5 bg-bg-2 border border-border rounded-lg">
                    <span className="font-heading text-[0.65rem] font-semibold uppercase tracking-widest text-faint">
                      Context7
                    </span>
                    <span
                      className={cn(
                        "text-sm break-words",
                        detail.mcpServers?.context7
                          ? "text-success font-semibold"
                          : "text-faint",
                      )}
                    >
                      {detail.mcpServers?.context7 ? "Enabled" : "Off"}
                    </span>
                  </div>
                  <div className="flex flex-col gap-1 px-3 py-2.5 bg-bg-2 border border-border rounded-lg">
                    <span className="font-heading text-[0.65rem] font-semibold uppercase tracking-widest text-faint">
                      Seq. Thinking
                    </span>
                    <span
                      className={cn(
                        "text-sm break-words",
                        detail.mcpServers?.sequentialThinking
                          ? "text-success font-semibold"
                          : "text-faint",
                      )}
                    >
                      {detail.mcpServers?.sequentialThinking
                        ? "Enabled"
                        : "Off"}
                    </span>
                  </div>
                  <div className="flex flex-col gap-1 px-3 py-2.5 bg-bg-2 border border-border rounded-lg">
                    <span className="font-heading text-[0.65rem] font-semibold uppercase tracking-widest text-faint">
                      DBHub
                    </span>
                    <span
                      className={cn(
                        "text-sm break-words",
                        detail.mcpServers?.dbhub
                          ? "text-success font-semibold"
                          : "text-faint",
                      )}
                    >
                      {detail.mcpServers?.dbhub ? "Enabled" : "Off"}
                    </span>
                  </div>
                  <div className="flex flex-col gap-1 px-3 py-2.5 bg-bg-2 border border-border rounded-lg">
                    <span className="font-heading text-[0.65rem] font-semibold uppercase tracking-widest text-faint">
                      Filesystem
                    </span>
                    <span
                      className={cn(
                        "text-sm break-words",
                        detail.mcpServers?.filesystem
                          ? "text-success font-semibold"
                          : "text-faint",
                      )}
                    >
                      {detail.mcpServers?.filesystem ? "Enabled" : "Off"}
                    </span>
                  </div>
                  <div className="flex flex-col gap-1 px-3 py-2.5 bg-bg-2 border border-border rounded-lg">
                    <span className="font-heading text-[0.65rem] font-semibold uppercase tracking-widest text-faint">
                      Git
                    </span>
                    <span
                      className={cn(
                        "text-sm break-words",
                        detail.mcpServers?.git
                          ? "text-success font-semibold"
                          : "text-faint",
                      )}
                    >
                      {detail.mcpServers?.git ? "Enabled" : "Off"}
                    </span>
                  </div>
                  <div className="flex flex-col gap-1 px-3 py-2.5 bg-bg-2 border border-border rounded-lg">
                    <span className="font-heading text-[0.65rem] font-semibold uppercase tracking-widest text-faint">
                      Qdrant
                    </span>
                    <span
                      className={cn(
                        "text-sm break-words",
                        detail.mcpServers?.qdrant
                          ? "text-success font-semibold"
                          : "text-faint",
                      )}
                    >
                      {detail.mcpServers?.qdrant ? "Enabled" : "Off"}
                    </span>
                  </div>
                  <div className="flex flex-col gap-1 px-3 py-2.5 bg-bg-2 border border-border rounded-lg">
                    <span className="font-heading text-[0.65rem] font-semibold uppercase tracking-widest text-faint">
                      Brave Search
                    </span>
                    <span
                      className={cn(
                        "text-sm break-words",
                        detail.mcpServers?.braveSearch
                          ? "text-success font-semibold"
                          : "text-faint",
                      )}
                    >
                      {detail.mcpServers?.braveSearch ? "Enabled" : "Off"}
                    </span>
                  </div>
                  <div className="flex flex-col gap-1 px-3 py-2.5 bg-bg-2 border border-border rounded-lg">
                    <span className="font-heading text-[0.65rem] font-semibold uppercase tracking-widest text-faint">
                      Firecrawl
                    </span>
                    <span
                      className={cn(
                        "text-sm break-words",
                        detail.mcpServers?.firecrawl
                          ? "text-success font-semibold"
                          : "text-faint",
                      )}
                    >
                      {detail.mcpServers?.firecrawl ? "Enabled" : "Off"}
                    </span>
                  </div>
                  <div className="flex flex-col gap-1 rounded-lg bg-bg-raised p-2.5 border border-border">
                    <span className="text-xs font-semibold text-faint uppercase tracking-widest">
                      Serena
                    </span>
                    <span
                      className={cn(
                        "text-sm break-words",
                        detail.mcpServers?.serena
                          ? "text-success font-semibold"
                          : "text-faint",
                      )}
                    >
                      {detail.mcpServers?.serena ? "Enabled" : "Off"}
                    </span>
                  </div>
                </div>
              </div>

              {/* Hooks */}
              <div className="flex flex-col gap-3">
                <h4 className="flex items-center font-heading text-xs font-semibold uppercase tracking-widest text-accent m-0 pb-1.5 border-b border-border">
                  Hooks
                </h4>
                <div className="grid grid-cols-2 gap-2">
                  <div className="flex flex-col gap-1 rounded-lg bg-bg-raised p-2.5 border border-border">
                    <span className="text-xs font-semibold text-faint uppercase tracking-widest">
                      Audit Log
                    </span>
                    <span
                      className={cn(
                        "text-sm break-words",
                        detail.hooks?.auditLog !== false
                          ? "text-success font-semibold"
                          : "text-faint",
                      )}
                    >
                      {detail.hooks?.auditLog !== false ? "Enabled" : "Off"}
                    </span>
                  </div>
                  <div className="flex flex-col gap-1 rounded-lg bg-bg-raised p-2.5 border border-border">
                    <span className="text-xs font-semibold text-faint uppercase tracking-widest">
                      Notifications
                    </span>
                    <span
                      className={cn(
                        "text-sm break-words",
                        detail.hooks?.notifications !== false
                          ? "text-success font-semibold"
                          : "text-faint",
                      )}
                    >
                      {detail.hooks?.notifications !== false
                        ? "Enabled"
                        : "Off"}
                    </span>
                  </div>
                </div>
              </div>

              {/* Preloaded Skills */}
              {detail.skills && detail.skills.length > 0 && (
                <div className="flex flex-col gap-3">
                  <h4 className="flex items-center font-heading text-xs font-semibold uppercase tracking-widest text-accent m-0 pb-1.5 border-b border-border">
                    Preloaded Skills
                    <span className="inline-flex items-center justify-center min-w-[20px] h-[20px] px-[5px] ml-1.5 text-xs font-semibold rounded-[10px] bg-purple text-white align-middle">
                      {detail.skills.length}
                    </span>
                  </h4>
                  <div className="flex flex-wrap gap-[5px]">
                    {detail.skills.map((skill) => (
                      <span
                        key={skill}
                        className="px-2.5 py-[3px] rounded-full bg-purple/10 border border-purple/25 font-mono text-xs text-foreground transition-colors"
                      >
                        {skill}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className="text-faint text-sm text-center py-8">
              Failed to load agent details
            </div>
          )}
        </div>

        {/* Panel footer with actions */}
        <div className="flex gap-3 px-6 py-5 border-t border-border shrink-0 bg-bg-2">
          {!agent.isDefault && onSetDefault && (
            <Button variant="secondary" size="sm" onClick={onSetDefault}>
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
              </svg>
              Set as Default
            </Button>
          )}
          <Button variant="primary" size="sm" onClick={onEdit}>
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
            </svg>
            Edit Agent
          </Button>
          {!agent.isDefault && (
            <Button variant="danger" size="sm" onClick={onDelete}>
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M3 6h18" />
                <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
                <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
              </svg>
              Delete
            </Button>
          )}
        </div>
      </div>
    </>
  );
}
