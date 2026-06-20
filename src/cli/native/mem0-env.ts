import type { NativePaths } from "./paths.ts";

const LLM_BASE_URL =
  "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1";

export function renderMem0Env(
  _p: NativePaths,
  secrets: {
    readonly internalToken: string;
    readonly llmApiKey: string;
    readonly neo4jPassword: string;
  },
): string {
  const vars: Readonly<Record<string, string>> = {
    QDRANT_HOST: "127.0.0.1",
    QDRANT_PORT: "6333",
    MEM0_API_TOKEN: secrets.internalToken,
    // Graph backend: native Neo4j (Community) on loopback. app.py's
    // _build_graph_config() reads NEO4J_URL / NEO4J_USER / NEO4J_PASSWORD when
    // MEM0_GRAPH_PROVIDER=neo4j. NEO4J_PASSWORD is REQUIRED (KeyError if unset).
    MEM0_GRAPH_PROVIDER: "neo4j",
    NEO4J_URL: "bolt://127.0.0.1:7687",
    NEO4J_USER: "neo4j",
    NEO4J_PASSWORD: secrets.neo4jPassword,
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
