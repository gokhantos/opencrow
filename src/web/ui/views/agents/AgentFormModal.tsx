import React, { useState, useEffect, useRef, useCallback } from "react";
import { z } from "zod";
import { Controller } from "react-hook-form";
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
import { Button, Input, FormField } from "../../components";
import { useZodForm } from "../../hooks/useZodForm";

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
   Agent Form schema
   =============================================== */
const agentFormSchema = z.object({
  id: z.string(),
  name: z.string().min(1, "Name is required"),
  description: z.string(),
  provider: z.string(),
  model: z.string(),
  maxIterations: z.number().int().min(1).max(500),
  reasoning: z.boolean(),
  thinkingMode: z.enum(["adaptive", "enabled", "disabled"]),
  thinkingBudget: z.number().int(),
  effort: z.enum(["low", "medium", "high", "max"]),
  extendedContext: z.boolean(),
  stateless: z.boolean(),
  maxInputLength: z.coerce.number().int().min(0).default(0),
  systemPrompt: z.string(),
  toolMode: z.enum(["all", "allowlist", "blocklist"]),
  selectedTools: z.array(z.string()),
  allowAgents: z.string(),
  maxChildren: z.number().int().min(1).max(20),
  telegramBotToken: z.string(),
  mcpBrowser: z.boolean(),
  mcpGithub: z.boolean(),
  mcpContext7: z.boolean(),
  mcpSeqThinking: z.boolean(),
  mcpDbhub: z.boolean(),
  mcpFilesystem: z.boolean(),
  mcpGit: z.boolean(),
  mcpQdrant: z.boolean(),
  mcpBraveSearch: z.boolean(),
  mcpFirecrawl: z.boolean(),
  mcpSerena: z.boolean(),
  hookAuditLog: z.boolean(),
  hookNotifications: z.boolean(),
  selectedSkills: z.array(z.string()),
});

type AgentFormValues = z.infer<typeof agentFormSchema>;

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
  /* ── UI-only state (not form data) ── */
  const [formTab, setFormTab] = useState<"basic" | "model" | "tools" | "advanced">("basic");
  const [templates, setTemplates] = useState<readonly AgentTemplate[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState<string | null>(null);
  const [availableTools, setAvailableTools] = useState<ToolInfo[]>([]);
  const [availableSkills, setAvailableSkills] = useState<SkillInfo[]>([]);
  const [skillSearch, setSkillSearch] = useState("");
  const [apiError, setApiError] = useState("");

  /* ── Form ── */
  const {
    register,
    handleSubmit,
    watch,
    setValue,
    control,
    formState: { errors, isSubmitting },
  } = useZodForm(agentFormSchema, {
    defaultValues: {
      id: initial?.id ?? "",
      name: initial?.name ?? "",
      description: initial?.description ?? "",
      provider: initial?.provider ?? "agent-sdk",
      model: initial?.model ?? "",
      maxIterations: initial?.maxIterations ?? 100,
      reasoning: initial?.reasoning ?? false,
      thinkingMode: (initial as any)?.modelParams?.thinkingMode ?? "adaptive",
      thinkingBudget: (initial as any)?.modelParams?.thinkingBudget ?? 32000,
      effort: (initial as any)?.modelParams?.effort ?? "high",
      extendedContext: (initial as any)?.modelParams?.extendedContext ?? false,
      stateless: initial?.stateless ?? false,
      maxInputLength: initial?.maxInputLength ?? 0,
      systemPrompt: initial?.systemPrompt ?? "",
      toolMode: initial?.toolFilter?.mode ?? "all",
      selectedTools: initial?.toolFilter?.tools ?? [],
      allowAgents: initial?.subagents?.allowAgents?.join(", ") ?? "*",
      maxChildren: initial?.subagents?.maxChildren ?? 5,
      telegramBotToken: initial?.telegramBotToken ?? "",
      mcpBrowser: initial?.mcpServers?.browser ?? false,
      mcpGithub: initial?.mcpServers?.github ?? false,
      mcpContext7: initial?.mcpServers?.context7 ?? false,
      mcpSeqThinking: initial?.mcpServers?.sequentialThinking ?? false,
      mcpDbhub: initial?.mcpServers?.dbhub ?? false,
      mcpFilesystem: initial?.mcpServers?.filesystem ?? false,
      mcpGit: initial?.mcpServers?.git ?? false,
      mcpQdrant: initial?.mcpServers?.qdrant ?? false,
      mcpBraveSearch: initial?.mcpServers?.braveSearch ?? false,
      mcpFirecrawl: initial?.mcpServers?.firecrawl ?? false,
      mcpSerena: initial?.mcpServers?.serena ?? false,
      hookAuditLog: initial?.hooks?.auditLog !== false,
      hookNotifications: initial?.hooks?.notifications !== false,
      selectedSkills: initial?.skills ?? [],
    },
  });

  /* ── Watched values for conditional rendering ── */
  const thinkingMode = watch("thinkingMode");
  const toolMode = watch("toolMode");
  const selectedTools = watch("selectedTools");
  const selectedSkills = watch("selectedSkills");
  const provider = watch("provider");
  const model = watch("model");
  const isOpus = model?.toLowerCase().includes("opus") ?? false;

  /* ── Reset model when provider changes ── */
  const prevProviderRef = useRef(provider);
  useEffect(() => {
    if (prevProviderRef.current === provider) return;
    prevProviderRef.current = provider;

    const defaults: Record<AiProvider, string> = {
      "agent-sdk": "claude-sonnet-4-6",
      alibaba: "qwen3.5-plus",
      openrouter: "",
    };
    setValue("model", defaults[provider as AiProvider] ?? "");
  }, [provider, setValue]);

  /* ── Template application ── */
  const applyTemplate = useCallback((tpl: AgentTemplate) => {
    setSelectedTemplate(tpl.templateId);
    setValue("provider", tpl.config.provider as AiProvider);
    setValue("model", tpl.config.model);
    setValue("maxIterations", tpl.config.maxIterations);
    setValue("stateless", tpl.config.stateless);
    setValue("reasoning", tpl.config.reasoning);
    setValue("toolMode", tpl.config.toolFilter.mode as "all" | "allowlist" | "blocklist");
    setValue("selectedTools", [...tpl.config.toolFilter.tools]);
    const mp = tpl.config.modelParams as Record<string, unknown>;
    setValue("thinkingMode", (mp.thinkingMode as "adaptive" | "enabled" | "disabled") ?? "adaptive");
    setValue("effort", (mp.effort as "low" | "medium" | "high" | "max") ?? "high");
  }, [setValue]);

  /* ── Data fetching ── */
  useEffect(() => {
    apiFetch<{ success: boolean; data: SkillInfo[] }>("/api/skills")
      .then((res) => { if (res.success) setAvailableSkills(res.data); })
      .catch((err) => console.error("Failed to load skills", err));
    apiFetch<{ success: boolean; data: ToolInfo[] }>("/api/tools")
      .then((res) => { if (res.success) setAvailableTools(res.data); })
      .catch((err) => console.error("Failed to load tools", err));
    if (mode === "create") {
      apiFetch<{ success: boolean; data: readonly AgentTemplate[] }>("/api/agents/templates")
        .then((res) => { if (res.success) setTemplates(res.data); })
        .catch((err) => console.error("Failed to load templates", err));
    }
  }, []);

  /* ── Submit ── */
  async function onSubmit(values: AgentFormValues) {
    if (mode === "create" && !values.id.trim()) {
      setApiError("ID is required");
      return;
    }
    setApiError("");

    const tools = [...values.selectedTools];
    const agents = values.allowAgents
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    const modelParams = {
      thinkingMode: values.thinkingMode,
      thinkingBudget: values.thinkingBudget,
      effort: values.effort,
      extendedContext: values.extendedContext || undefined,
    };

    try {
      if (mode === "create") {
        const res = (await createAgent({
          id: values.id.trim(),
          name: values.name.trim(),
          description: values.description.trim() || undefined,
          provider: values.provider as AiProvider,
          model: values.model.trim() || undefined,
          maxIterations: values.maxIterations,
          reasoning: values.reasoning || undefined,
          stateless: values.stateless || undefined,
          maxInputLength: values.maxInputLength || undefined,
          systemPrompt: values.systemPrompt.trim() || undefined,
          modelParams,
          mcpServers:
            values.mcpBrowser || values.mcpGithub || values.mcpContext7 ||
            values.mcpSeqThinking || values.mcpDbhub || values.mcpFilesystem ||
            values.mcpGit || values.mcpQdrant || values.mcpBraveSearch ||
            values.mcpFirecrawl || values.mcpSerena
              ? {
                  browser: values.mcpBrowser || undefined,
                  github: values.mcpGithub || undefined,
                  context7: values.mcpContext7 || undefined,
                  sequentialThinking: values.mcpSeqThinking || undefined,
                  dbhub: values.mcpDbhub || undefined,
                  filesystem: values.mcpFilesystem || undefined,
                  git: values.mcpGit || undefined,
                  qdrant: values.mcpQdrant || undefined,
                  braveSearch: values.mcpBraveSearch || undefined,
                  firecrawl: values.mcpFirecrawl || undefined,
                  serena: values.mcpSerena || undefined,
                }
              : undefined,
          hooks: { auditLog: values.hookAuditLog, notifications: values.hookNotifications },
        })) as MutationResponse;
        if (res.configHash) setConfigHash(res.configHash);
      } else {
        const res = (await updateAgent(initial!.id, {
          name: values.name,
          description: values.description,
          provider: values.provider as AiProvider,
          model: values.model,
          maxIterations: values.maxIterations,
          reasoning: values.reasoning || undefined,
          stateless: values.stateless || undefined,
          maxInputLength: values.maxInputLength || undefined,
          modelParams,
          systemPrompt: values.systemPrompt,
          toolFilter: { mode: values.toolMode, tools },
          subagents: { allowAgents: agents, maxChildren: values.maxChildren },
          mcpServers: {
            browser: values.mcpBrowser || undefined,
            github: values.mcpGithub || undefined,
            context7: values.mcpContext7 || undefined,
            sequentialThinking: values.mcpSeqThinking || undefined,
            dbhub: values.mcpDbhub || undefined,
            filesystem: values.mcpFilesystem || undefined,
            git: values.mcpGit || undefined,
            qdrant: values.mcpQdrant || undefined,
            braveSearch: values.mcpBraveSearch || undefined,
            firecrawl: values.mcpFirecrawl || undefined,
            serena: values.mcpSerena || undefined,
          },
          hooks: { auditLog: values.hookAuditLog, notifications: values.hookNotifications },
          telegramBotToken: values.telegramBotToken.trim() || undefined,
          skills: values.selectedSkills.length > 0 ? values.selectedSkills : undefined,
        })) as MutationResponse;
        if (res.configHash) setConfigHash(res.configHash);
      }
      onDone();
    } catch (err: unknown) {
      const apiErr = err as { status?: number; message?: string };
      if (apiErr.status === 409) {
        setApiError("Config changed externally. Refreshing...");
        setTimeout(() => onDone(), 500);
        return;
      }
      const msg = err instanceof Error ? err.message : (apiErr.message ?? `Failed to ${mode}`);
      setApiError(msg);
    }
  }

  /* ── Shared select class ── */
  const selectCls =
    "w-full px-4 py-2.5 bg-bg border border-border rounded-lg text-foreground text-sm outline-none transition-colors duration-150 focus:border-accent";

  return (
    <ModalBackdrop onClose={onCancel}>
      <form
        className="flex flex-col h-full max-h-[85vh]"
        onSubmit={handleSubmit(onSubmit)}
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

        {/* Tab Nav */}
        <div className="flex border-b border-border px-6 shrink-0">
          {(["basic", "model", "tools", "advanced"] as const).map((t) => (
            <button
              key={t}
              type="button"
              className={cn(
                "px-4 py-3 text-sm font-medium capitalize border-b-2 -mb-px transition-colors",
                formTab === t
                  ? "border-accent text-accent"
                  : "border-transparent text-muted hover:text-foreground",
              )}
              onClick={() => setFormTab(t)}
            >
              {t === "tools" ? "Tools & Skills" : t.charAt(0).toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto px-6 py-6 flex flex-col gap-6">
          {(apiError || errors.name || errors.id) && (
            <div className="bg-danger-subtle border border-danger/20 rounded-lg px-4 py-2.5 text-danger text-sm animate-[agSlideIn_0.2s_ease-out]">
              {apiError || errors.name?.message || errors.id?.message}
            </div>
          )}

          {/* Basic Tab: Identity */}
          {formTab === "basic" && (<>

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
                <FormField error={errors.id} className="mb-5">
                  <Input
                    label="ID (kebab-case)"
                    type="text"
                    placeholder="my-agent"
                    pattern="^[a-z0-9][a-z0-9-]*$"
                    required
                    {...register("id", {
                      onChange: (e) => {
                        e.target.value = e.target.value.toLowerCase();
                      },
                    })}
                  />
                </FormField>
              )}
              <FormField error={errors.name} className="mb-5">
                <Input
                  label="Name"
                  type="text"
                  placeholder="My Agent"
                  required
                  {...register("name")}
                />
              </FormField>
              <div className="mb-5 col-span-full">
                <Input
                  label="Description"
                  type="text"
                  placeholder="Short description of this agent's role"
                  {...register("description")}
                />
              </div>
            </div>
          </fieldset>

          </>)}

          {/* Model Tab: Model config + System Prompt */}
          {formTab === "model" && (<>

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
                <Controller
                  control={control}
                  name="provider"
                  render={({ field }) => (
                    <select className={selectCls} {...field}>
                      <option value="agent-sdk">Agent SDK</option>
                      <option value="openrouter">OpenRouter</option>
                      <option value="alibaba">Alibaba ModelStudio</option>
                    </select>
                  )}
                />
              </div>
              <div className="mb-5">
                <label className="block text-xs font-semibold text-muted uppercase tracking-wide mb-2">
                  Model
                </label>
                {provider === "agent-sdk" ? (
                  <select className={selectCls} {...register("model")}>
                    <option value="claude-sonnet-4-6">claude-sonnet-4-6</option>
                    <option value="claude-opus-4-6">claude-opus-4-6</option>
                    <option value="claude-haiku-4-5">claude-haiku-4-5</option>
                  </select>
                ) : provider === "alibaba" ? (
                  <select className={selectCls} {...register("model")}>
                    <optgroup label="Qwen">
                      <option value="qwen3.5-plus">qwen3.5-plus</option>
                      <option value="qwen3-max-2026-01-23">qwen3-max-2026-01-23</option>
                      <option value="qwen3-coder-next">qwen3-coder-next</option>
                      <option value="qwen3-coder-plus">qwen3-coder-plus</option>
                    </optgroup>
                    <optgroup label="Zhipu">
                      <option value="glm-5">glm-5</option>
                      <option value="glm-4.7">glm-4.7</option>
                    </optgroup>
                    <optgroup label="Kimi">
                      <option value="kimi-k2.5">kimi-k2.5</option>
                    </optgroup>
                    <optgroup label="MiniMax">
                      <option value="MiniMax-M2.5">MiniMax-M2.5</option>
                    </optgroup>
                  </select>
                ) : (
                  <Input
                    type="text"
                    placeholder="e.g. stepfun/step-3.5-flash:free"
                    {...register("model")}
                  />
                )}
              </div>
              <div className="mb-5">
                <Input
                  label="Max Iterations"
                  type="number"
                  min={1}
                  max={500}
                  {...register("maxIterations", { valueAsNumber: true })}
                />
              </div>
              <div className="mb-5">
                <Input
                  label="Max Input Length (0 = no limit)"
                  type="number"
                  min={0}
                  placeholder="0"
                  {...register("maxInputLength", { valueAsNumber: true })}
                />
              </div>
              {/* -- Agent SDK-specific: Thinking & Effort Controls -- */}
              {provider === "agent-sdk" && (
                <>
                  <div className="flex items-center mb-5">
                    <label className="flex items-center gap-2 cursor-pointer text-sm text-foreground">
                      <input
                        type="checkbox"
                        className="w-4 h-4 accent-accent cursor-pointer"
                        {...register("reasoning")}
                      />
                      <span className="select-none">Extended Thinking</span>
                    </label>
                  </div>
                  <div className="mb-5">
                    <label className="block text-xs font-semibold text-muted uppercase tracking-wide mb-2">
                      Thinking Mode
                    </label>
                    <Controller
                      control={control}
                      name="thinkingMode"
                      render={({ field }) => (
                        <select className={selectCls} {...field}>
                          <option value="adaptive">Adaptive (model decides)</option>
                          <option value="enabled">Fixed budget</option>
                          <option value="disabled">Disabled</option>
                        </select>
                      )}
                    />
                  </div>
                  {thinkingMode === "enabled" && (
                    <div className="mb-5">
                      <Input
                        label="Thinking Budget (tokens)"
                        type="number"
                        min={1024}
                        max={128000}
                        step={1024}
                        {...register("thinkingBudget", { valueAsNumber: true })}
                      />
                    </div>
                  )}
                  <div className="mb-5">
                    <label className="block text-xs font-semibold text-muted uppercase tracking-wide mb-2">
                      Effort Level
                    </label>
                    <Controller
                      control={control}
                      name="effort"
                      render={({ field }) => (
                        <select className={selectCls} {...field}>
                          <option value="low">Low (fast, minimal thinking)</option>
                          <option value="medium">Medium</option>
                          <option value="high">High (deep reasoning)</option>
                          <option value="max" disabled={!isOpus}>Max (Opus only)</option>
                        </select>
                      )}
                    />
                  </div>
                  <div className="flex items-center mb-5">
                    <label className="flex items-center gap-2 cursor-pointer text-sm text-foreground">
                      <input
                        type="checkbox"
                        className="w-4 h-4 accent-accent cursor-pointer"
                        {...register("extendedContext")}
                      />
                      <span className="select-none">1M Context Window (beta)</span>
                    </label>
                  </div>
                </>
              )}
              <div className="flex items-center mb-5">
                <label className="flex items-center gap-2 cursor-pointer text-sm text-foreground">
                  <input
                    type="checkbox"
                    className="w-4 h-4 accent-accent cursor-pointer"
                    {...register("stateless")}
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
            </legend>
              <textarea
                rows={6}
                className="w-full px-4 py-3 bg-bg border border-border rounded-lg text-foreground font-mono text-sm leading-relaxed outline-none transition-colors duration-150 resize-y min-h-[120px] focus:border-accent"
                placeholder="Uses global default if empty"
                {...register("systemPrompt")}
              />
          </fieldset>

          </>)}

          {/* Tools Tab: Tool Access + Skills */}
          {formTab === "tools" && (
            <div className="flex flex-col gap-6">
              {/* Tool Access */}
              <div className="flex flex-col gap-2.5">
                <h4 className="font-heading text-xs font-semibold uppercase tracking-widest text-accent mb-1 pb-2 border-b border-border">
                  Tool Access
                </h4>
                <div className="mb-5">
                  <label className="block text-xs font-semibold text-muted uppercase tracking-wide mb-2">
                    Mode
                  </label>
                  <Controller
                    control={control}
                    name="toolMode"
                    render={({ field }) => (
                      <select className={selectCls} {...field}>
                        <option value="all">All tools</option>
                        <option value="allowlist">Allowlist</option>
                        <option value="blocklist">Blocklist</option>
                      </select>
                    )}
                  />
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
                                  setValue(
                                    "selectedTools",
                                    isSelected
                                      ? selectedTools.filter((t) => t !== tool.name)
                                      : [...selectedTools, tool.name],
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
                        onClick={() => setValue("selectedTools", availableTools.map((t) => t.name))}
                      >
                        Select all
                      </Button>
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        onClick={() => setValue("selectedTools", [])}
                      >
                        Clear all
                      </Button>
                    </div>
                  </div>
                )}
              </div>

              {/* Preloaded Skills */}
              <div className="flex flex-col gap-2.5">
                <h4 className="font-heading text-xs font-semibold uppercase tracking-widest text-accent mb-1 pb-2 border-b border-border">
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
                              setValue(
                                "selectedSkills",
                                active
                                  ? selectedSkills.filter((s) => s !== skill.id)
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
            </div>
          )}

          {/* Advanced Tab: Sub-Agents + MCP + Hooks + Telegram */}
          {formTab === "advanced" && (
            <div className="flex flex-col gap-6">
              {/* Sub-Agents */}
              <div className="flex flex-col gap-2.5">
                <h4 className="font-heading text-xs font-semibold uppercase tracking-widest text-accent mb-1 pb-2 border-b border-border">
                  Sub-Agents
                </h4>
                <div className="grid grid-cols-3 gap-4 max-md:grid-cols-1">
                  <div className="mb-5">
                    <Input
                      label="Allowed Agents"
                      type="text"
                      placeholder="* for all, or specific IDs"
                      {...register("allowAgents")}
                    />
                  </div>
                  <div className="mb-5">
                    <Input
                      label="Max Children"
                      type="number"
                      min={1}
                      max={20}
                      {...register("maxChildren", { valueAsNumber: true })}
                    />
                  </div>
                </div>
              </div>

              {/* MCP Servers */}
              <div className="flex flex-col gap-2.5">
                <h4 className="font-heading text-xs font-semibold uppercase tracking-widest text-accent mb-1 pb-2 border-b border-border">
                  MCP Servers
                </h4>
                <div className="grid grid-cols-2 gap-4 max-md:grid-cols-1">
                  {(
                    [
                      { name: "mcpBrowser", label: "Playwright (Browser)" },
                      { name: "mcpGithub", label: "GitHub" },
                      { name: "mcpContext7", label: "Context7 (Docs)" },
                      { name: "mcpSeqThinking", label: "Sequential Thinking" },
                      { name: "mcpDbhub", label: "DBHub (Database)" },
                      { name: "mcpFilesystem", label: "Filesystem" },
                      { name: "mcpGit", label: "Git" },
                      { name: "mcpQdrant", label: "Qdrant (Vector DB)" },
                      { name: "mcpBraveSearch", label: "Brave Search" },
                      { name: "mcpFirecrawl", label: "Firecrawl (Scraping)" },
                      { name: "mcpSerena", label: "Serena (Code Navigation)" },
                    ] as const
                  ).map(({ name, label }) => (
                    <div key={name} className="flex items-center mb-5">
                      <label className="flex items-center gap-2 cursor-pointer text-sm text-foreground">
                        <input
                          type="checkbox"
                          className="w-4 h-4 accent-accent cursor-pointer"
                          {...register(name)}
                        />
                        <span className="select-none">{label}</span>
                      </label>
                    </div>
                  ))}
                </div>
              </div>

              {/* Hooks */}
              <div className="flex flex-col gap-2.5">
                <h4 className="font-heading text-xs font-semibold uppercase tracking-widest text-accent mb-1 pb-2 border-b border-border">
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
                        {...register("hookAuditLog")}
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
                        {...register("hookNotifications")}
                      />
                      <span className="select-none">
                        Notification Forwarding
                      </span>
                    </label>
                  </div>
                </div>
              </div>

              {/* Telegram */}
              <div className="flex flex-col gap-2.5">
                <h4 className="font-heading text-xs font-semibold uppercase tracking-widest text-accent mb-1 pb-2 border-b border-border">
                  Telegram
                </h4>
                <div className="mb-5">
                  <Input
                    label="Bot Token"
                    type="password"
                    placeholder="Leave empty to disable dedicated bot"
                    autoComplete="off"
                    {...register("telegramBotToken")}
                  />
                </div>
              </div>
            </div>
          )}
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
          <Button type="submit" variant="primary" size="sm" loading={isSubmitting}>
            {isSubmitting
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
