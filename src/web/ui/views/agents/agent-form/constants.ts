import type { AiProvider } from "../types";
import type { AgentFormValues } from "./schema";

/** Shared <select> class used across the model/tools tabs. */
export const SELECT_CLS =
  "w-full px-4 py-2.5 bg-bg border border-border rounded-lg text-foreground text-sm outline-none transition-colors duration-150 focus:border-accent";

/** Default model applied when the provider changes. */
export const PROVIDER_MODEL_DEFAULTS: Record<AiProvider, string> = {
  "agent-sdk": "claude-sonnet-4-6",
  alibaba: "qwen3.5-plus",
  anthropic: "claude-sonnet-4-6",
  openrouter: "",
  opencode: "deepseek-v4-flash",
};

/** MCP server toggles rendered on the Advanced tab. */
export const MCP_SERVERS: readonly {
  readonly name: Extract<keyof AgentFormValues, `mcp${string}`>;
  readonly label: string;
}[] = [
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
] as const;
