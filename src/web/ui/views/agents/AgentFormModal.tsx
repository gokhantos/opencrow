import React, { useState, useEffect, useRef, useCallback } from "react";
import { apiFetch, updateAgent, createAgent, setConfigHash } from "../../api";
import { cn } from "../../lib/cn";
import type {
  AiProvider,
  AgentDetail,
  AgentTemplate,
  SkillInfo,
  ToolInfo,
  MutationResponse,
} from "./types";
import { Button, Input } from "../../components";

/* ===============================================
   Modal Backdrop -- shared overlay component
   =============================================== */
function ModalBackdrop({
  children,
  onClose,
}: {
  children: React.ReactNode;
  onClose: () => void;
}) {
  const overlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-[1000] p-6 animate-[agFadeIn_0.15s_ease]"
      ref={overlayRef}
      onClick={(e) => {
        if (e.target === overlayRef.current) onClose();
      }}
    >
      <div className="bg-bg-1 border border-border-2 rounded-xl w-full max-w-[680px] max-h-[85vh] overflow-hidden animate-[agSlideUp_0.25s_ease-out] flex flex-col">
        {children}
      </div>
    </div>
  );
}

/* ===============================================
   Delete Confirmation Dialog
   =============================================== */
export function DeleteDialog({
  agentName,
  onConfirm,
  onCancel,
}: {
  agentName: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-[1000] p-6 animate-[agFadeIn_0.15s_ease]"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="bg-bg-1 border border-border-2 rounded-xl p-8 max-w-[380px] w-full text-center animate-[agSlideUp_0.25s_ease-out]">
        <div className="inline-flex items-center justify-center w-12 h-12 rounded-lg bg-danger-subtle text-danger mb-5">
          <svg
            width="24"
            height="24"
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
            <line x1="10" y1="11" x2="10" y2="17" />
            <line x1="14" y1="11" x2="14" y2="17" />
          </svg>
        </div>
        <h3 className="font-heading text-lg font-semibold text-strong m-0 mb-2.5">
          Delete Agent
        </h3>
        <p className="text-muted text-sm leading-relaxed m-0 mb-6">
          Are you sure you want to delete{" "}
          <strong className="text-strong">{agentName}</strong>? This action
          cannot be undone.
        </p>
        <div className="flex justify-center gap-3">
          <Button variant="secondary" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="danger" size="sm" onClick={onConfirm}>
            Delete
          </Button>
        </div>
      </div>
    </div>
  );
}

/* ===============================================
   Agent Form (shared between Create & Edit)
   =============================================== */
export function AgentFormModal({
  mode,
  initial,
  onDone,
  onCancel,
}: {
  mode: "create" | "edit";
  initial?: AgentDetail;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [id, setId] = useState(initial?.id ?? "");
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [provider, setProvider] = useState<AiProvider>(
    initial?.provider ?? "agent-sdk",
  );
  const [model, setModel] = useState(initial?.model ?? "");
  const [maxIterations, setMaxIterations] = useState(
    initial?.maxIterations ?? 100,
  );
  const [reasoning, setReasoning] = useState(initial?.reasoning ?? false);
  const [thinkingMode, setThinkingMode] = useState<
    "adaptive" | "enabled" | "disabled"
  >((initial as any)?.modelParams?.thinkingMode ?? "adaptive");
  const [thinkingBudget, setThinkingBudget] = useState(
    (initial as any)?.modelParams?.thinkingBudget ?? 32000,
  );
  const [effort, setEffort] = useState<"low" | "medium" | "high" | "max">(
    (initial as any)?.modelParams?.effort ?? "high",
  );
  const [extendedContext, setExtendedContext] = useState(
    (initial as any)?.modelParams?.extendedContext ?? false,
  );
  const [stateless, setStateless] = useState(initial?.stateless ?? false);
  const [maxInputLength, setMaxInputLength] = useState<number | "">(
    initial?.maxInputLength ?? "",
  );
  const [systemPrompt, setSystemPrompt] = useState(initial?.systemPrompt ?? "");
  const [toolMode, setToolMode] = useState<"all" | "allowlist" | "blocklist">(
    initial?.toolFilter?.mode ?? "all",
  );
  const [selectedTools, setSelectedTools] = useState<string[]>(
    initial?.toolFilter?.tools ?? [],
  );
  const [availableTools, setAvailableTools] = useState<ToolInfo[]>([]);
  const [allowAgents, setAllowAgents] = useState(
    initial?.subagents?.allowAgents?.join(", ") ?? "*",
  );
  const [maxChildren, setMaxChildren] = useState(
    initial?.subagents?.maxChildren ?? 5,
  );
  const [telegramBotToken, setTelegramBotToken] = useState(
    initial?.telegramBotToken ?? "",
  );
  const [mcpBrowser, setMcpBrowser] = useState(
    initial?.mcpServers?.browser ?? false,
  );
  const [mcpGithub, setMcpGithub] = useState(
    initial?.mcpServers?.github ?? false,
  );
  const [mcpContext7, setMcpContext7] = useState(
    initial?.mcpServers?.context7 ?? false,
  );
  const [mcpSeqThinking, setMcpSeqThinking] = useState(
    initial?.mcpServers?.sequentialThinking ?? false,
  );
  const [mcpDbhub, setMcpDbhub] = useState(initial?.mcpServers?.dbhub ?? false);
  const [mcpFilesystem, setMcpFilesystem] = useState(
    initial?.mcpServers?.filesystem ?? false,
  );
  const [mcpGit, setMcpGit] = useState(initial?.mcpServers?.git ?? false);
  const [mcpQdrant, setMcpQdrant] = useState(
    initial?.mcpServers?.qdrant ?? false,
  );
  const [mcpBraveSearch, setMcpBraveSearch] = useState(
    initial?.mcpServers?.braveSearch ?? false,
  );
  const [mcpFirecrawl, setMcpFirecrawl] = useState(
    initial?.mcpServers?.firecrawl ?? false,
  );
  const [mcpSerena, setMcpSerena] = useState(
    initial?.mcpServers?.serena ?? false,
  );
  const [hookAuditLog, setHookAuditLog] = useState(
    initial?.hooks?.auditLog !== false,
  );
  const [hookNotifications, setHookNotifications] = useState(
    initial?.hooks?.notifications !== false,
  );
  const [selectedSkills, setSelectedSkills] = useState<string[]>(
    initial?.skills ?? [],
  );
  const [availableSkills, setAvailableSkills] = useState<SkillInfo[]>([]);
  const [skillSearch, setSkillSearch] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  /* Section collapse state */
  const [showAdvanced, setShowAdvanced] = useState(mode === "edit");

  /* Template picker state (create mode only) */
  const [templates, setTemplates] = useState<readonly AgentTemplate[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState<string | null>(null);

  const applyTemplate = useCallback((tpl: AgentTemplate) => {
    setSelectedTemplate(tpl.templateId);
    setProvider(tpl.config.provider as AiProvider);
    setModel(tpl.config.model);
    setMaxIterations(tpl.config.maxIterations);
    setStateless(tpl.config.stateless);
    setReasoning(tpl.config.reasoning);
    setToolMode(
      tpl.config.toolFilter.mode as "all" | "allowlist" | "blocklist",
    );
    setSelectedTools([...tpl.config.toolFilter.tools]);
    const mp = tpl.config.modelParams as Record<string, unknown>;
    setThinkingMode(
      (mp.thinkingMode as "adaptive" | "enabled" | "disabled") ?? "adaptive",
    );
    setEffort((mp.effort as "low" | "medium" | "high" | "max") ?? "high");
  }, []);

  useEffect(() => {
    apiFetch<{ success: boolean; data: SkillInfo[] }>("/api/skills")
      .then((res) => {
        if (res.success) setAvailableSkills(res.data);
      })
      .catch(() => {});
    apiFetch<{ success: boolean; data: ToolInfo[] }>("/api/tools")
      .then((res) => {
        if (res.success) setAvailableTools(res.data);
      })
      .catch(() => {});
    if (mode === "create") {
      apiFetch<{ success: boolean; data: readonly AgentTemplate[] }>(
        "/api/agents/templates",
      )
        .then((res) => {
          if (res.success) setTemplates(res.data);
        })
        .catch(() => {});
    }
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (mode === "create" && (!id.trim() || !name.trim())) {
      setError("ID and Name are required");
      return;
    }
    if (mode === "edit" && !name.trim()) {
      setError("Name is required");
      return;
    }
    setSaving(true);
    setError("");

    const tools = [...selectedTools];
    const agents = allowAgents
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    const modelParams = {
      thinkingMode,
      thinkingBudget,
      effort,
      extendedContext: extendedContext || undefined,
    };

    try {
      if (mode === "create") {
        const res = (await createAgent({
          id: id.trim(),
          name: name.trim(),
          description: description.trim() || undefined,
          provider,
          model: model.trim() || undefined,
          maxIterations,
          reasoning: reasoning || undefined,
          stateless: stateless || undefined,
          maxInputLength: maxInputLength || undefined,
          systemPrompt: systemPrompt.trim() || undefined,
          modelParams,
          mcpServers:
            mcpBrowser ||
            mcpGithub ||
            mcpContext7 ||
            mcpSeqThinking ||
            mcpDbhub ||
            mcpFilesystem ||
            mcpGit ||
            mcpQdrant ||
            mcpBraveSearch ||
            mcpFirecrawl ||
            mcpSerena
              ? {
                  browser: mcpBrowser || undefined,
                  github: mcpGithub || undefined,
                  context7: mcpContext7 || undefined,
                  sequentialThinking: mcpSeqThinking || undefined,
                  dbhub: mcpDbhub || undefined,
                  filesystem: mcpFilesystem || undefined,
                  git: mcpGit || undefined,
                  qdrant: mcpQdrant || undefined,
                  braveSearch: mcpBraveSearch || undefined,
                  firecrawl: mcpFirecrawl || undefined,
                  serena: mcpSerena || undefined,
                }
              : undefined,
          hooks: { auditLog: hookAuditLog, notifications: hookNotifications },
        })) as MutationResponse;
        if (res.configHash) setConfigHash(res.configHash);
      } else {
        const res = (await updateAgent(initial!.id, {
          name,
          description,
          provider,
          model,
          maxIterations,
          reasoning: reasoning || undefined,
          stateless: stateless || undefined,
          maxInputLength: maxInputLength || undefined,
          modelParams,
          systemPrompt,
          toolFilter: { mode: toolMode, tools },
          subagents: { allowAgents: agents, maxChildren },
          mcpServers: {
            browser: mcpBrowser || undefined,
            github: mcpGithub || undefined,
            context7: mcpContext7 || undefined,
            sequentialThinking: mcpSeqThinking || undefined,
            dbhub: mcpDbhub || undefined,
            filesystem: mcpFilesystem || undefined,
            git: mcpGit || undefined,
            qdrant: mcpQdrant || undefined,
            braveSearch: mcpBraveSearch || undefined,
            firecrawl: mcpFirecrawl || undefined,
            serena: mcpSerena || undefined,
          },
          hooks: { auditLog: hookAuditLog, notifications: hookNotifications },
          telegramBotToken: telegramBotToken.trim() || undefined,
          skills: selectedSkills.length > 0 ? selectedSkills : undefined,
        })) as MutationResponse;
        if (res.configHash) setConfigHash(res.configHash);
      }
      onDone();
    } catch (err: unknown) {
      const apiErr = err as { status?: number; message?: string };
      if (apiErr.status === 409) {
        setError("Config changed externally. Refreshing...");
        setTimeout(() => onDone(), 500);
        return;
      }
      const msg =
        err instanceof Error
          ? err.message
          : (apiErr.message ?? `Failed to ${mode}`);
      setError(msg);
    } finally {
      setSaving(false);
    }
  }

  /* ───── Shared select class ───── */
  const selectCls =
    "w-full px-4 py-2.5 bg-bg border border-border rounded-lg text-foreground text-sm outline-none transition-colors duration-150 focus:border-accent";

  return (
    <ModalBackdrop onClose={onCancel}>
      <form
        className="flex flex-col h-full max-h-[85vh]"
        onSubmit={handleSubmit}
      >
        {/* Header */}
        <div className="flex justify-between items-start px-6 py-6 border-b border-border shrink-0">
          <div>
            <h3 className="font-heading text-lg font-semibold text-strong m-0 tracking-tight">
              {mode === "create" ? "New Agent" : `Edit ${initial?.name}`}
            </h3>
            <p className="text-sm text-faint mt-0.5 m-0">
              {mode === "create"
                ? "Configure a new AI agent"
                : "Update agent configuration"}
            </p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onCancel}
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
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto px-6 py-6 flex flex-col gap-6">
          {error && (
            <div className="bg-danger-subtle border border-danger/20 rounded-lg px-4 py-2.5 text-danger text-sm animate-[agSlideIn_0.2s_ease-out]">
              {error}
            </div>
          )}

          {/* Template Picker (create mode only) */}
          {mode === "create" && templates.length > 0 && (
            <fieldset className="border-none p-0 m-0">
              <legend className="font-heading text-xs font-semibold uppercase tracking-widest text-accent mb-4 pb-2 border-b border-border w-full">
                Start from Template
              </legend>
              <div className="flex gap-2.5 overflow-x-auto pb-1">
                {templates.map((tpl) => (
                  <button
                    key={tpl.templateId}
                    type="button"
                    className={cn(
                      "flex flex-col gap-1 px-4 py-3 rounded-lg border text-left cursor-pointer transition-colors min-w-[130px] shrink-0",
                      selectedTemplate === tpl.templateId
                        ? "bg-accent-subtle border-accent"
                        : "bg-bg-2 border-border hover:border-border-2 hover:bg-bg-3",
                    )}
                    onClick={() => applyTemplate(tpl)}
                  >
                    <span
                      className={cn(
                        "text-sm font-semibold",
                        selectedTemplate === tpl.templateId
                          ? "text-accent"
                          : "text-strong",
                      )}
                    >
                      {tpl.name}
                    </span>
                    <span className="text-xs text-muted leading-snug line-clamp-2">
                      {tpl.description}
                    </span>
                  </button>
                ))}
              </div>
            </fieldset>
          )}

          {/* Section: Identity */}
          <fieldset className="border-none p-0 m-0">
            <legend className="font-heading text-xs font-semibold uppercase tracking-widest text-accent mb-4 pb-2 border-b border-border w-full flex items-center justify-between">
              Identity
            </legend>
            <div className="grid grid-cols-2 gap-4 max-md:grid-cols-1">
              {mode === "create" && (
                <div className="mb-5">
                  <Input
                    label="ID (kebab-case)"
                    type="text"
                    value={id}
                    onChange={(e) => setId(e.target.value.toLowerCase())}
                    placeholder="my-agent"
                    pattern="^[a-z0-9][a-z0-9-]*$"
                    required
                  />
                </div>
              )}
              <div className="mb-5">
                <Input
                  label="Name"
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="My Agent"
                  required
                />
              </div>
              <div className="mb-5 col-span-full">
                <Input
                  label="Description"
                  type="text"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Short description of this agent's role"
                />
              </div>
            </div>
          </fieldset>

          {/* Section: Model */}
          <fieldset className="border-none p-0 m-0">
            <legend className="font-heading text-xs font-semibold uppercase tracking-widest text-accent mb-4 pb-2 border-b border-border w-full flex items-center justify-between">
              Model Configuration
            </legend>
            <div className="grid grid-cols-2 gap-4 max-md:grid-cols-1">
              <div className="mb-5">
                <label className="block text-xs font-semibold text-muted uppercase tracking-wide mb-2">
                  Provider
                </label>
                <select
                  className={selectCls}
                  value={provider}
                  onChange={(e) => setProvider(e.target.value as AiProvider)}
                >
                  <option value="agent-sdk">Agent SDK</option>
                  <option value="openrouter">OpenRouter</option>
                  <option value="alibaba">Alibaba ModelStudio</option>
                </select>
              </div>
              <div className="mb-5">
                <Input
                  label="Model"
                  type="text"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder={
                    provider === "openrouter"
                      ? "e.g. arcee-ai/trinity-large-preview:free"
                      : provider === "alibaba"
                        ? "e.g. qwen3-coder-plus"
                        : "e.g. claude-sonnet-4-6"
                  }
                />
              </div>
              <div className="mb-5">
                <Input
                  label="Max Iterations"
                  type="number"
                  value={maxIterations}
                  onChange={(e) => setMaxIterations(Number(e.target.value))}
                  min={1}
                  max={100}
                />
              </div>
              <div className="mb-5">
                <Input
                  label="Max Input Length"
                  type="number"
                  value={maxInputLength}
                  onChange={(e) =>
                    setMaxInputLength(
                      e.target.value ? Number(e.target.value) : "",
                    )
                  }
                  min={1}
                  placeholder="No limit"
                />
              </div>
              <div className="flex items-center mb-5">
                <label className="flex items-center gap-2 cursor-pointer text-sm text-foreground">
                  <input
                    type="checkbox"
                    className="w-4 h-4 accent-accent cursor-pointer"
                    checked={reasoning}
                    onChange={(e) => setReasoning(e.target.checked)}
                  />
                  <span className="select-none">Extended Thinking</span>
                </label>
              </div>

              {/* -- Thinking & Effort Controls -- */}
              <div className="mb-5">
                <label className="block text-xs font-semibold text-muted uppercase tracking-wide mb-2">
                  Thinking Mode
                </label>
                <select
                  className={selectCls}
                  value={thinkingMode}
                  onChange={(e) =>
                    setThinkingMode(
                      e.target.value as "adaptive" | "enabled" | "disabled",
                    )
                  }
                >
                  <option value="adaptive">Adaptive (model decides)</option>
                  <option value="enabled">Fixed budget</option>
                  <option value="disabled">Disabled</option>
                </select>
              </div>
              {thinkingMode === "enabled" && (
                <div className="mb-5">
                  <Input
                    label="Thinking Budget (tokens)"
                    type="number"
                    value={thinkingBudget}
                    onChange={(e) => setThinkingBudget(Number(e.target.value))}
                    min={1024}
                    max={128000}
                    step={1024}
                  />
                </div>
              )}
              <div className="mb-5">
                <label className="block text-xs font-semibold text-muted uppercase tracking-wide mb-2">
                  Effort Level
                </label>
                <select
                  className={selectCls}
                  value={effort}
                  onChange={(e) =>
                    setEffort(
                      e.target.value as "low" | "medium" | "high" | "max",
                    )
                  }
                >
                  <option value="low">Low (fast, minimal thinking)</option>
                  <option value="medium">Medium</option>
                  <option value="high">High (deep reasoning)</option>
                  <option value="max">Max (Opus only)</option>
                </select>
              </div>
              <div className="flex items-center mb-5">
                <label className="flex items-center gap-2 cursor-pointer text-sm text-foreground">
                  <input
                    type="checkbox"
                    className="w-4 h-4 accent-accent cursor-pointer"
                    checked={extendedContext}
                    onChange={(e) => setExtendedContext(e.target.checked)}
                  />
                  <span className="select-none">1M Context Window (beta)</span>
                </label>
              </div>
              <div className="flex items-center mb-5">
                <label className="flex items-center gap-2 cursor-pointer text-sm text-foreground">
                  <input
                    type="checkbox"
                    className="w-4 h-4 accent-accent cursor-pointer"
                    checked={stateless}
                    onChange={(e) => setStateless(e.target.checked)}
                  />
                  <span className="select-none">Stateless</span>
                </label>
              </div>
            </div>
          </fieldset>

          {/* Section: System Prompt */}
          <fieldset className="border-none p-0 m-0">
            <legend className="font-heading text-xs font-semibold uppercase tracking-widest text-accent mb-4 pb-2 border-b border-border w-full flex items-center justify-between">
              System Prompt
              {initial?.promptSource === "file" && (
                <span className="inline-flex items-center gap-1 ml-auto text-[0.65rem] font-semibold uppercase tracking-wide text-success px-2 py-0.5 rounded-full bg-success-subtle border border-success-subtle">
                  <svg
                    width="10"
                    height="10"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                    <polyline points="14 2 14 8 20 8" />
                  </svg>
                  From files
                </span>
              )}
            </legend>
            {initial?.promptSource === "file" ? (
              <div className="flex flex-col gap-2.5">
                <div className="flex items-center gap-2 px-4 py-2.5 bg-success-subtle border border-success-subtle rounded-lg text-muted text-sm leading-[1.4]">
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="text-success shrink-0"
                  >
                    <circle cx="12" cy="12" r="10" />
                    <line x1="12" y1="16" x2="12" y2="12" />
                    <line x1="12" y1="8" x2="12.01" y2="8" />
                  </svg>
                  <span>
                    Prompt loaded from markdown files. Edit the files directly
                    in{" "}
                    <code className="font-mono text-xs px-1 py-px bg-bg-3 rounded-sm text-foreground">
                      prompts/
                    </code>
                  </span>
                </div>
                {initial.promptFiles && initial.promptFiles.length > 0 && (
                  <div className="flex flex-wrap gap-[5px]">
                    {initial.promptFiles.map((f) => (
                      <span
                        key={f}
                        className="inline-flex items-center gap-1 px-2.5 py-[3px] rounded-full bg-success-subtle border border-success-subtle font-mono text-xs text-success transition-colors"
                      >
                        <svg
                          width="10"
                          height="10"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          className="opacity-70 shrink-0"
                        >
                          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                          <polyline points="14 2 14 8 20 8" />
                        </svg>
                        prompts/{f}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <textarea
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
                rows={6}
                className="w-full px-4 py-3 bg-bg border border-border rounded-lg text-foreground font-mono text-sm leading-relaxed outline-none transition-colors duration-150 resize-y min-h-[120px] focus:border-accent"
                placeholder="Uses global default if empty"
              />
            )}
          </fieldset>

          {/* Section: Advanced (collapsible) */}
          <fieldset className="border-none p-0 m-0">
            <legend
              className="font-heading text-xs font-semibold uppercase tracking-widest text-accent mb-4 pb-2 border-b border-border w-full flex items-center justify-between cursor-pointer select-none hover:text-accent"
              onClick={() => setShowAdvanced(!showAdvanced)}
            >
              Advanced Settings
              <span
                className={cn(
                  "inline-flex items-center transition-transform duration-150",
                  showAdvanced && "rotate-90",
                )}
              >
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 12 12"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                >
                  <path d="M4.5 3l3 3-3 3" />
                </svg>
              </span>
            </legend>

            {showAdvanced && (
              <div className="flex flex-col gap-4.5 animate-[agSlideIn_0.2s_ease-out]">
                {/* Tool Access */}
                <div className="flex flex-col gap-2.5">
                  <h4 className="font-heading text-xs font-semibold uppercase tracking-wide text-muted m-0">
                    Tool Access
                  </h4>
                  <div className="mb-5">
                    <label className="block text-xs font-semibold text-muted uppercase tracking-wide mb-2">
                      Mode
                    </label>
                    <select
                      className={selectCls}
                      value={toolMode}
                      onChange={(e) =>
                        setToolMode(
                          e.target.value as "all" | "allowlist" | "blocklist",
                        )
                      }
                    >
                      <option value="all">All tools</option>
                      <option value="allowlist">Allowlist</option>
                      <option value="blocklist">Blocklist</option>
                    </select>
                  </div>
                  {toolMode !== "all" && availableTools.length > 0 && (
                    <div className="mt-2">
                      <p className="text-xs text-faint mb-3 flex items-center justify-between">
                        {toolMode === "allowlist"
                          ? "Select tools this agent can use:"
                          : "Select tools to block from this agent:"}
                        <span className="font-mono text-xs font-semibold text-accent px-2 py-0.5 bg-accent-subtle rounded-full">
                          {selectedTools.length} selected
                        </span>
                      </p>
                      {Object.entries(
                        availableTools.reduce<Record<string, ToolInfo[]>>(
                          (acc, tool) => ({
                            ...acc,
                            [tool.category]: [
                              ...(acc[tool.category] ?? []),
                              tool,
                            ],
                          }),
                          {},
                        ),
                      ).map(([category, tools]) => (
                        <div key={category} className="mb-2.5">
                          <span className="block font-heading text-[0.68rem] font-semibold uppercase tracking-[0.08em] text-faint mb-2">
                            {category.replace(/_/g, " ")}
                          </span>
                          <div className="flex flex-wrap gap-1">
                            {tools.map((tool) => {
                              const isSelected = selectedTools.includes(
                                tool.name,
                              );
                              return (
                                <button
                                  key={tool.name}
                                  type="button"
                                  title={tool.description ?? tool.name}
                                  className={cn(
                                    "px-2.5 py-1 rounded-full border font-mono text-xs font-medium cursor-pointer transition-colors",
                                    isSelected
                                      ? "bg-accent-subtle border-accent text-accent font-semibold"
                                      : "bg-bg-2 border-border text-muted hover:bg-bg-3 hover:border-border-2 hover:text-strong",
                                  )}
                                  onClick={() =>
                                    setSelectedTools((prev) =>
                                      isSelected
                                        ? prev.filter((t) => t !== tool.name)
                                        : [...prev, tool.name],
                                    )
                                  }
                                >
                                  {tool.name}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      ))}
                      <div className="flex gap-1.5 mt-2">
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          onClick={() =>
                            setSelectedTools(availableTools.map((t) => t.name))
                          }
                        >
                          Select all
                        </Button>
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          onClick={() => setSelectedTools([])}
                        >
                          Clear all
                        </Button>
                      </div>
                    </div>
                  )}
                </div>

                {/* Sub-Agents */}
                <div className="flex flex-col gap-2.5">
                  <h4 className="font-heading text-xs font-semibold uppercase tracking-wide text-muted m-0">
                    Sub-Agents
                  </h4>
                  <div className="grid grid-cols-3 gap-4 max-md:grid-cols-1">
                    <div className="mb-5">
                      <Input
                        label="Allowed Agents"
                        type="text"
                        value={allowAgents}
                        onChange={(e) => setAllowAgents(e.target.value)}
                        placeholder="* for all, or specific IDs"
                      />
                    </div>
                    <div className="mb-5">
                      <Input
                        label="Max Children"
                        type="number"
                        value={maxChildren}
                        onChange={(e) => setMaxChildren(Number(e.target.value))}
                        min={1}
                        max={20}
                      />
                    </div>
                  </div>
                </div>

                {/* MCP Servers */}
                <div className="flex flex-col gap-2.5">
                  <h4 className="font-heading text-xs font-semibold uppercase tracking-wide text-muted m-0">
                    MCP Servers
                  </h4>
                  <div className="grid grid-cols-2 gap-4 max-md:grid-cols-1">
                    <div className="flex items-center mb-5">
                      <label className="flex items-center gap-2 cursor-pointer text-sm text-foreground">
                        <input
                          type="checkbox"
                          className="w-4 h-4 accent-accent cursor-pointer"
                          checked={mcpBrowser}
                          onChange={(e) => setMcpBrowser(e.target.checked)}
                        />
                        <span className="select-none">
                          Playwright (Browser)
                        </span>
                      </label>
                    </div>
                    <div className="flex items-center mb-5">
                      <label className="flex items-center gap-2 cursor-pointer text-sm text-foreground">
                        <input
                          type="checkbox"
                          className="w-4 h-4 accent-accent cursor-pointer"
                          checked={mcpGithub}
                          onChange={(e) => setMcpGithub(e.target.checked)}
                        />
                        <span className="select-none">GitHub</span>
                      </label>
                    </div>
                    <div className="flex items-center mb-5">
                      <label className="flex items-center gap-2 cursor-pointer text-sm text-foreground">
                        <input
                          type="checkbox"
                          className="w-4 h-4 accent-accent cursor-pointer"
                          checked={mcpContext7}
                          onChange={(e) => setMcpContext7(e.target.checked)}
                        />
                        <span className="select-none">Context7 (Docs)</span>
                      </label>
                    </div>
                    <div className="flex items-center mb-5">
                      <label className="flex items-center gap-2 cursor-pointer text-sm text-foreground">
                        <input
                          type="checkbox"
                          className="w-4 h-4 accent-accent cursor-pointer"
                          checked={mcpSeqThinking}
                          onChange={(e) => setMcpSeqThinking(e.target.checked)}
                        />
                        <span className="select-none">Sequential Thinking</span>
                      </label>
                    </div>
                    <div className="flex items-center mb-5">
                      <label className="flex items-center gap-2 cursor-pointer text-sm text-foreground">
                        <input
                          type="checkbox"
                          className="w-4 h-4 accent-accent cursor-pointer"
                          checked={mcpDbhub}
                          onChange={(e) => setMcpDbhub(e.target.checked)}
                        />
                        <span className="select-none">DBHub (Database)</span>
                      </label>
                    </div>
                    <div className="flex items-center mb-5">
                      <label className="flex items-center gap-2 cursor-pointer text-sm text-foreground">
                        <input
                          type="checkbox"
                          className="w-4 h-4 accent-accent cursor-pointer"
                          checked={mcpFilesystem}
                          onChange={(e) => setMcpFilesystem(e.target.checked)}
                        />
                        <span className="select-none">Filesystem</span>
                      </label>
                    </div>
                    <div className="flex items-center mb-5">
                      <label className="flex items-center gap-2 cursor-pointer text-sm text-foreground">
                        <input
                          type="checkbox"
                          className="w-4 h-4 accent-accent cursor-pointer"
                          checked={mcpGit}
                          onChange={(e) => setMcpGit(e.target.checked)}
                        />
                        <span className="select-none">Git</span>
                      </label>
                    </div>
                    <div className="flex items-center mb-5">
                      <label className="flex items-center gap-2 cursor-pointer text-sm text-foreground">
                        <input
                          type="checkbox"
                          className="w-4 h-4 accent-accent cursor-pointer"
                          checked={mcpQdrant}
                          onChange={(e) => setMcpQdrant(e.target.checked)}
                        />
                        <span className="select-none">Qdrant (Vector DB)</span>
                      </label>
                    </div>
                    <div className="flex items-center mb-5">
                      <label className="flex items-center gap-2 cursor-pointer text-sm text-foreground">
                        <input
                          type="checkbox"
                          className="w-4 h-4 accent-accent cursor-pointer"
                          checked={mcpBraveSearch}
                          onChange={(e) => setMcpBraveSearch(e.target.checked)}
                        />
                        <span className="select-none">Brave Search</span>
                      </label>
                    </div>
                    <div className="flex items-center mb-5">
                      <label className="flex items-center gap-2 cursor-pointer text-sm text-foreground">
                        <input
                          type="checkbox"
                          className="w-4 h-4 accent-accent cursor-pointer"
                          checked={mcpFirecrawl}
                          onChange={(e) => setMcpFirecrawl(e.target.checked)}
                        />
                        <span className="select-none">
                          Firecrawl (Scraping)
                        </span>
                      </label>
                    </div>
                    <div className="flex items-center mb-5">
                      <label className="flex items-center gap-2 cursor-pointer text-sm text-foreground">
                        <input
                          type="checkbox"
                          className="w-4 h-4 accent-accent cursor-pointer"
                          checked={mcpSerena}
                          onChange={(e) => setMcpSerena(e.target.checked)}
                        />
                        <span className="select-none">
                          Serena (Code Navigation)
                        </span>
                      </label>
                    </div>
                  </div>
                </div>

                {/* Hooks */}
                <div className="flex flex-col gap-2.5">
                  <h4 className="font-heading text-xs font-semibold uppercase tracking-wide text-muted m-0">
                    Hooks
                  </h4>
                  <p className="text-sm text-faint m-0 mb-2.5 leading-[1.4]">
                    Hooks run during agent execution for auditing and
                    notifications. All hooks are on by default.
                  </p>
                  <div className="ml-1">
                    <div className="flex items-center mb-5">
                      <label className="flex items-center gap-2 cursor-pointer text-sm text-foreground">
                        <input
                          type="checkbox"
                          className="w-4 h-4 accent-accent cursor-pointer"
                          checked={hookAuditLog}
                          onChange={(e) => setHookAuditLog(e.target.checked)}
                        />
                        <span className="select-none">
                          Audit Log (tool calls to DB)
                        </span>
                      </label>
                    </div>
                    <div className="flex items-center mb-5">
                      <label className="flex items-center gap-2 cursor-pointer text-sm text-foreground">
                        <input
                          type="checkbox"
                          className="w-4 h-4 accent-accent cursor-pointer"
                          checked={hookNotifications}
                          onChange={(e) =>
                            setHookNotifications(e.target.checked)
                          }
                        />
                        <span className="select-none">
                          Notification Forwarding
                        </span>
                      </label>
                    </div>
                  </div>
                </div>

                {/* Preloaded Skills */}
                <div className="flex flex-col gap-2.5">
                  <h4 className="font-heading text-xs font-semibold uppercase tracking-wide text-muted m-0">
                    Preloaded Skills
                    {selectedSkills.length > 0 && (
                      <span className="inline-flex items-center justify-center min-w-[20px] h-[20px] px-[5px] ml-1.5 text-xs font-semibold rounded-[10px] bg-purple text-white align-middle">
                        {selectedSkills.length}
                      </span>
                    )}
                  </h4>
                  <p className="text-sm text-faint m-0 mb-2.5 leading-[1.4]">
                    Skills are injected into the agent's system prompt
                    automatically on every turn.
                  </p>
                  {availableSkills.length > 0 && (
                    <Input
                      type="text"
                      value={skillSearch}
                      onChange={(e) => setSkillSearch(e.target.value)}
                      placeholder="Filter skills..."
                      className="mb-2"
                    />
                  )}
                  <div className="flex flex-wrap gap-1.5 max-h-[200px] overflow-y-auto py-0.5">
                    {availableSkills
                      .filter(
                        (s) =>
                          !skillSearch ||
                          s.name
                            .toLowerCase()
                            .includes(skillSearch.toLowerCase()) ||
                          s.id
                            .toLowerCase()
                            .includes(skillSearch.toLowerCase()) ||
                          s.description
                            .toLowerCase()
                            .includes(skillSearch.toLowerCase()),
                      )
                      .map((skill) => {
                        const active = selectedSkills.includes(skill.id);
                        return (
                          <label
                            key={skill.id}
                            className={cn(
                              "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-xl text-xs cursor-pointer border transition-colors select-none max-w-full",
                              active
                                ? "bg-purple/15 border-purple text-foreground"
                                : "bg-bg-2 border-border text-muted hover:border-purple hover:text-foreground",
                            )}
                          >
                            <input
                              type="checkbox"
                              className="hidden"
                              checked={active}
                              onChange={() =>
                                setSelectedSkills(
                                  active
                                    ? selectedSkills.filter(
                                        (s) => s !== skill.id,
                                      )
                                    : [...selectedSkills, skill.id],
                                )
                              }
                            />
                            <span className="font-medium whitespace-nowrap">
                              {skill.name}
                            </span>
                            {skill.description && (
                              <span
                                className="text-xs text-faint overflow-hidden text-ellipsis whitespace-nowrap max-w-[200px]"
                                title={skill.description}
                              >
                                {skill.description}
                              </span>
                            )}
                          </label>
                        );
                      })}
                    {availableSkills.length === 0 && (
                      <p className="text-faint text-sm m-0">
                        No skills available
                      </p>
                    )}
                  </div>
                </div>

                {/* Telegram */}
                <div className="flex flex-col gap-2.5">
                  <h4 className="font-heading text-xs font-semibold uppercase tracking-wide text-muted m-0">
                    Telegram
                  </h4>
                  <div className="mb-5">
                    <Input
                      label="Bot Token"
                      type="password"
                      value={telegramBotToken}
                      onChange={(e) => setTelegramBotToken(e.target.value)}
                      placeholder="Leave empty to disable dedicated bot"
                      autoComplete="off"
                    />
                  </div>
                </div>
              </div>
            )}
          </fieldset>
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-3 px-6 py-5 border-t border-border shrink-0 bg-bg-1">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={onCancel}
          >
            Cancel
          </Button>
          <Button type="submit" variant="primary" size="sm" loading={saving}>
            {saving
              ? mode === "create"
                ? "Creating..."
                : "Saving..."
              : mode === "create"
                ? "Create Agent"
                : "Save Changes"}
          </Button>
        </div>
      </form>
    </ModalBackdrop>
  );
}
