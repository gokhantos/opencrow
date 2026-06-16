import { useState, useEffect, useRef, useCallback } from "react";
import { apiFetch, updateAgent, createAgent, setConfigHash } from "../../../api";
import type {
  AiProvider,
  AgentDetail,
  AgentTemplate,
  SkillInfo,
  ToolInfo,
  MutationResponse,
} from "../types";
import { useZodForm } from "../../../hooks/useZodForm";
import { agentFormSchema, type AgentFormValues } from "./schema";
import { PROVIDER_MODEL_DEFAULTS } from "./constants";

interface UseAgentFormArgs {
  readonly mode: "create" | "edit";
  readonly initial?: AgentDetail;
  readonly onDone: () => void;
}

/**
 * Encapsulates all AgentFormModal logic: react-hook-form setup with zod
 * validation, provider→model reset, template application, reference-data
 * fetching, and the create/edit submit. The returned object is consumed by the
 * orchestrator and the per-tab field components.
 */
export function useAgentForm({ mode, initial, onDone }: UseAgentFormArgs) {
  /* ── Reference data + transient API error (not form data) ── */
  const [templates, setTemplates] = useState<readonly AgentTemplate[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState<string | null>(null);
  const [availableTools, setAvailableTools] = useState<ToolInfo[]>([]);
  const [availableSkills, setAvailableSkills] = useState<SkillInfo[]>([]);
  const [apiError, setApiError] = useState("");

  /* ── Form ── */
  const form = useZodForm(agentFormSchema, {
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

  const { watch, setValue } = form;

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
    setValue("model", PROVIDER_MODEL_DEFAULTS[provider as AiProvider] ?? "");
  }, [provider, setValue]);

  /* ── Template application ── */
  const applyTemplate = useCallback(
    (tpl: AgentTemplate) => {
      setSelectedTemplate(tpl.templateId);
      setValue("provider", tpl.config.provider as AiProvider);
      setValue("model", tpl.config.model);
      setValue("maxIterations", tpl.config.maxIterations);
      setValue("stateless", tpl.config.stateless);
      setValue("reasoning", tpl.config.reasoning);
      setValue(
        "toolMode",
        tpl.config.toolFilter.mode as "all" | "allowlist" | "blocklist",
      );
      setValue("selectedTools", [...tpl.config.toolFilter.tools]);
      const mp = tpl.config.modelParams as Record<string, unknown>;
      setValue(
        "thinkingMode",
        (mp.thinkingMode as "adaptive" | "enabled" | "disabled") ?? "adaptive",
      );
      setValue("effort", (mp.effort as "low" | "medium" | "high" | "max") ?? "high");
    },
    [setValue],
  );

  /* ── Data fetching ── */
  useEffect(() => {
    apiFetch<{ success: boolean; data: SkillInfo[] }>("/api/skills")
      .then((res) => {
        if (res.success) setAvailableSkills(res.data);
      })
      .catch((err) => console.error("Failed to load skills", err));
    apiFetch<{ success: boolean; data: ToolInfo[] }>("/api/tools")
      .then((res) => {
        if (res.success) setAvailableTools(res.data);
      })
      .catch((err) => console.error("Failed to load tools", err));
    if (mode === "create") {
      apiFetch<{ success: boolean; data: readonly AgentTemplate[] }>(
        "/api/agents/templates",
      )
        .then((res) => {
          if (res.success) setTemplates(res.data);
        })
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
            values.mcpBrowser ||
            values.mcpGithub ||
            values.mcpContext7 ||
            values.mcpSeqThinking ||
            values.mcpDbhub ||
            values.mcpFilesystem ||
            values.mcpGit ||
            values.mcpQdrant ||
            values.mcpBraveSearch ||
            values.mcpFirecrawl ||
            values.mcpSerena
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
          hooks: {
            auditLog: values.hookAuditLog,
            notifications: values.hookNotifications,
          },
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
          hooks: {
            auditLog: values.hookAuditLog,
            notifications: values.hookNotifications,
          },
          telegramBotToken: values.telegramBotToken.trim() || undefined,
          skills:
            values.selectedSkills.length > 0 ? values.selectedSkills : undefined,
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
      const msg =
        err instanceof Error ? err.message : (apiErr.message ?? `Failed to ${mode}`);
      setApiError(msg);
    }
  }

  return {
    mode,
    initial,
    form,
    /* watched values */
    provider,
    model,
    isOpus,
    thinkingMode,
    toolMode,
    selectedTools,
    selectedSkills,
    /* reference data */
    templates,
    availableTools,
    availableSkills,
    selectedTemplate,
    applyTemplate,
    /* submit */
    apiError,
    onSubmit,
  };
}

export type UseAgentFormReturn = ReturnType<typeof useAgentForm>;
