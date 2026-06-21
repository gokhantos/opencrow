/** Shared provider model lists, shared between ModelTab and ModelRoutePicker. */

export const ANTHROPIC_MODELS: readonly string[] = [
  "claude-sonnet-4-6",
  "claude-opus-4-6",
  "claude-haiku-4-5",
  "claude-haiku-4-5-20251001",
];

export const AGENT_SDK_MODELS: readonly string[] = [
  "claude-sonnet-4-6",
  "claude-opus-4-6",
  "claude-haiku-4-5",
];

export const ALIBABA_MODEL_GROUPS: readonly {
  readonly label: string;
  readonly models: readonly string[];
}[] = [
  {
    label: "Qwen",
    models: ["qwen3.7-plus", "qwen3.7-max", "qwen3.6-plus", "qwen3.6-flash"],
  },
  {
    label: "DeepSeek",
    models: ["deepseek-v4-pro", "deepseek-v4-flash", "deepseek-v3.2"],
  },
  {
    label: "Zhipu",
    models: ["glm-5.2", "glm-5.1", "glm-5"],
  },
  {
    label: "MiniMax",
    models: ["MiniMax-M2.5"],
  },
  {
    label: "Moonshot",
    models: ["kimi-k2.7-code", "kimi-k2.6", "kimi-k2.5"],
  },
];

export const OPENCODE_MODELS: readonly string[] = [
  "deepseek-v4-flash",
  "deepseek-v4-pro",
  "glm-5",
  "glm-5.1",
  "glm-5.2",
  "kimi-k2.5",
  "kimi-k2.6",
  "kimi-k2.7-code",
  "qwen3.5-plus",
  "qwen3.6-plus",
  "qwen3.7-max",
  "qwen3.7-plus",
  "minimax-m2.5",
  "minimax-m2.7",
  "minimax-m3",
  "mimo-v2-omni",
  "mimo-v2-pro",
  "mimo-v2.5",
  "mimo-v2.5-pro",
  "hy3-preview",
];

export const PROVIDER_LABELS: Readonly<Record<string, string>> = {
  "agent-sdk": "Agent SDK",
  anthropic: "Anthropic (OAuth)",
  openrouter: "OpenRouter",
  alibaba: "Alibaba ModelStudio",
  opencode: "OpenCode",
};
