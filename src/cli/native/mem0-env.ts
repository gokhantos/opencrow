import type { NativePaths } from "./paths.ts";

const LLM_BASE_URL =
  "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1";

export function renderMem0Env(
  p: NativePaths,
  secrets: { readonly internalToken: string; readonly llmApiKey: string },
): string {
  const vars: Readonly<Record<string, string>> = {
    QDRANT_HOST: "127.0.0.1",
    QDRANT_PORT: "6333",
    MEM0_API_TOKEN: secrets.internalToken,
    MEM0_GRAPH_PROVIDER: "kuzu",
    MEM0_GRAPH_DB: p.mem0Kuzu,
    MEM0_LLM_PROVIDER: "openai",
    MEM0_LLM_MODEL: "deepseek-v4-flash",
    MEM0_LLM_BASE_URL: LLM_BASE_URL,
    MEM0_LLM_API_KEY: secrets.llmApiKey,
    MEM0_LLM_DISABLE_THINKING: "true",
    OPENAI_API_KEY: secrets.llmApiKey,
    OPENAI_BASE_URL: LLM_BASE_URL,
    OPENAI_API_BASE: LLM_BASE_URL,
    MEM0_OLLAMA_URL: "http://127.0.0.1:11434",
    MEM0_EMBED_MODEL: "nomic-embed-text:latest",
    MEM0_EMBED_DIMS: "768",
    MEM0_COLLECTION: "sige_mem0",
  };
  return `${Object.entries(vars)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n")}\n`;
}
