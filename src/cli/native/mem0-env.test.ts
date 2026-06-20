import { test, expect } from "bun:test";
import { renderMem0Env } from "./mem0-env.ts";
import { nativePaths } from "./paths.ts";

const env = renderMem0Env(nativePaths("/Users/test"), {
  internalToken: "tok-123",
  llmApiKey: "sk-llm",
  neo4jPassword: "neo-pw",
});
const map = Object.fromEntries(
  env.trim().split("\n").map((l) => {
    const i = l.indexOf("=");
    return [l.slice(0, i), l.slice(i + 1)];
  }),
);

test("points qdrant + ollama at loopback", () => {
  expect(map.QDRANT_HOST).toBe("127.0.0.1");
  expect(map.QDRANT_PORT).toBe("6333");
  expect(map.MEM0_OLLAMA_URL).toBe("http://127.0.0.1:11434");
});

test("configures neo4j graph backend on loopback Bolt", () => {
  expect(map.MEM0_GRAPH_PROVIDER).toBe("neo4j");
  expect(map.NEO4J_URL).toBe("bolt://127.0.0.1:7687");
  expect(map.NEO4J_USER).toBe("neo4j");
  expect(map.NEO4J_PASSWORD).toBe("neo-pw");
});

test("no longer emits kuzu graph vars", () => {
  expect(map.MEM0_GRAPH_DB).toBeUndefined();
  expect(map.MEM0_GRAPH_PROVIDER).not.toBe("kuzu");
});

test("injects secrets and keeps hosted-DeepSeek extraction config", () => {
  expect(map.MEM0_API_TOKEN).toBe("tok-123");
  expect(map.MEM0_LLM_API_KEY).toBe("sk-llm");
  expect(map.OPENAI_API_KEY).toBe("sk-llm");
  expect(map.MEM0_LLM_MODEL).toBe("deepseek-v4-flash");
  expect(map.MEM0_LLM_DISABLE_THINKING).toBe("true");
  expect(map.MEM0_EMBED_MODEL).toBe("nomic-embed-text:latest");
  expect(map.MEM0_EMBED_DIMS).toBe("768");
});

test("raises embedder context window so dense chunks don't 500 on embed", () => {
  expect(map.MEM0_EMBED_NUM_CTX).toBe("8192");
});
